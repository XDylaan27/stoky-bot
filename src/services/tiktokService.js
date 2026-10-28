import axios from 'axios';
import { RAPIDAPI_KEYS, RAPIDAPI_HOST, RAPIDAPI_ENDPOINT } from '../config.js';
import { logger } from '../utils/logger.js';

// Pool de llaves para rotación automática y failover
const keyPool = RAPIDAPI_KEYS.map((key, index) => ({
  index: index + 1,
  key,
  masked: key.slice(0, 6) + '...' + key.slice(-4),
  limit: 50,
  remaining: 50,
  resetSeconds: 2600000,
  isExhausted: false,
  lastUsed: 0
}));

// Valores iniciales conocidos de las cuentas en vivo (5 cuentas en rotación):
if (keyPool[0]) keyPool[0].remaining = 8;
if (keyPool[1]) keyPool[1].remaining = 49;
if (keyPool[2]) keyPool[2].remaining = 49;
if (keyPool[3]) keyPool[3].remaining = 49;
if (keyPool[4]) keyPool[4].remaining = 49;

let currentKeyIndex = 0;

/**
 * Formatea segundos restantes en días, horas y minutos legibles.
 * @param {number|string} seconds 
 * @returns {string}
 */
export function formatResetTime(seconds) {
  if (!seconds || isNaN(seconds)) return 'en el próximo ciclo mensual';
  const sec = parseInt(seconds, 10);
  const days = Math.floor(sec / (3600 * 24));
  const hours = Math.floor((sec % (3600 * 24)) / 3600);
  const minutes = Math.floor((sec % 3600) / 60);

  const parts = [];
  if (days > 0) parts.push(`${days} día${days > 1 ? 's' : ''}`);
  if (hours > 0) parts.push(`${hours} hora${hours > 1 ? 's' : ''}`);
  if (minutes > 0 || parts.length === 0) parts.push(`${minutes} minuto${minutes !== 1 ? 's' : ''}`);

  return parts.join(', ');
}

/**
 * Obtiene la llave actualmente activa, o busca la siguiente disponible no agotada.
 */
function getActiveKey() {
  if (keyPool.length === 0) return null;

  if (!keyPool[currentKeyIndex].isExhausted && keyPool[currentKeyIndex].remaining > 0) {
    return keyPool[currentKeyIndex];
  }

  for (let i = 0; i < keyPool.length; i++) {
    const candidateIdx = (currentKeyIndex + i) % keyPool.length;
    const candidate = keyPool[candidateIdx];
    if (!candidate.isExhausted && candidate.remaining > 0) {
      currentKeyIndex = candidateIdx;
      return candidate;
    }
  }

  return null;
}

/**
 * Rota a la siguiente llave disponible en el pool.
 */
function rotateToNextKey(reason = '') {
  const prevIdx = currentKeyIndex;
  keyPool[prevIdx].isExhausted = true;
  keyPool[prevIdx].remaining = 0;

  for (let i = 1; i <= keyPool.length; i++) {
    const nextIdx = (prevIdx + i) % keyPool.length;
    const next = keyPool[nextIdx];
    if (!next.isExhausted && next.remaining > 0) {
      currentKeyIndex = nextIdx;
      console.log(`\n[Stoky Quota] 🔄 ${reason}. Rotando automáticamente: Cuenta #${keyPool[prevIdx].index} -> Cuenta #${next.index} (${next.remaining} disponibles).\n`);
      return next;
    }
  }

  console.warn('\n[Stoky Quota] ⚠️ Todas las cuentas del pool han agotado sus peticiones.\n');
  return null;
}

/**
 * Retorna el texto del reset más cercano entre las llaves.
 */
function getShortestResetText() {
  const activeKeys = keyPool.filter((k) => k.resetSeconds);
  if (activeKeys.length === 0) return 'en el próximo ciclo mensual';
  const minSeconds = Math.min(...activeKeys.map((k) => k.resetSeconds));
  return formatResetTime(minSeconds);
}

/**
 * Actualiza la información de cuota de una llave específica con base en sus cabeceras HTTP.
 */
function updateKeyQuotaFromHeaders(keyObj, headers) {
  if (!keyObj || !headers) return;
  const limit = headers['x-ratelimit-requests-limit'] || headers['x-ratelimit-scraping-api-limit'];
  const remaining = headers['x-ratelimit-requests-remaining'] || headers['x-ratelimit-scraping-api-remaining'];
  const reset = headers['x-ratelimit-requests-reset'] || headers['x-ratelimit-scraping-api-reset'];

  if (limit) keyObj.limit = parseInt(limit, 10);
  if (reset) keyObj.resetSeconds = parseInt(reset, 10);

  if (remaining !== undefined) {
    keyObj.remaining = parseInt(remaining, 10);
    if (keyObj.remaining <= 0) {
      keyObj.isExhausted = true;
    }
  }
  keyObj.lastUsed = Date.now();
}

/**
 * Ejecuta una petición HTTP a RapidAPI con balanceo y rotación automática de llaves.
 */
export async function executeRapidApiRequest(params) {
  if (keyPool.length === 0) {
    throw new Error('RAPIDAPI_KEY_MISSING: Configura tus claves de RapidAPI en el archivo .env.');
  }

  const maxAttempts = keyPool.length;
  let attempts = 0;

  while (attempts < maxAttempts) {
    attempts++;
    const activeKey = getActiveKey();

    if (!activeKey) {
      const quotaError = new Error('RAPIDAPI_QUOTA_EXCEEDED');
      quotaError.resetText = getShortestResetText();
      throw quotaError;
    }

    try {
      const response = await axios.get(RAPIDAPI_ENDPOINT, {
        params,
        headers: {
          'x-rapidapi-key': activeKey.key,
          'x-rapidapi-host': RAPIDAPI_HOST
        },
        timeout: 15000
      });

      updateKeyQuotaFromHeaders(activeKey, response.headers);

      if (activeKey.remaining <= 0) {
        rotateToNextKey(`Cuenta #${activeKey.index} consumió su última petición (0 restantes)`);
      }

      return response;
    } catch (err) {
      if (err.response?.headers) {
        updateKeyQuotaFromHeaders(activeKey, err.response.headers);
      }

      const status = err.response?.status;
      const errorMsg = err.response?.data?.message || err.message || '';

      const isQuotaExceeded =
        status === 429 ||
        errorMsg.toLowerCase().includes('rate limit') ||
        errorMsg.toLowerCase().includes('quota') ||
        errorMsg.toLowerCase().includes('exceeded') ||
        activeKey.remaining <= 0;

      if (isQuotaExceeded) {
        logger.warn(
          { keyIndex: activeKey.index, status, errorMsg },
          'Cuota agotada en la cuenta actual de RapidAPI, rotando automáticamente a la siguiente...'
        );
        const next = rotateToNextKey(`Cuenta #${activeKey.index} agotó cuota (${status || errorMsg})`);
        if (next) {
          continue;
        } else {
          const quotaError = new Error('RAPIDAPI_QUOTA_EXCEEDED');
          quotaError.resetText = getShortestResetText();
          throw quotaError;
        }
      }

      logger.error({ err: err.message, status }, 'Error en petición a RapidAPI');
      throw new Error(`Error en la API de TikTok: ${errorMsg || err.message}`);
    }
  }

  const finalError = new Error('RAPIDAPI_QUOTA_EXCEEDED');
  finalError.resetText = getShortestResetText();
  throw finalError;
}

/**
 * Obtiene el estado actual de la cuota de peticiones de todas las cuentas del pool.
 * @param {boolean} [forceFetch=false] 
 * @returns {Promise<object>}
 */
export async function getQuotaStatus(forceFetch = false) {
  const activeKey = getActiveKey();
  const totalRemaining = keyPool.reduce(
    (acc, k) => acc + (k.isExhausted ? 0 : Math.max(0, k.remaining)),
    0
  );
  const totalLimit = keyPool.reduce((acc, k) => acc + k.limit, 0);

  return {
    totalRemaining,
    totalLimit,
    activeKeyIndex: activeKey ? activeKey.index : null,
    totalKeys: keyPool.length,
    keys: keyPool.map((k) => ({
      index: k.index,
      masked: k.masked,
      remaining: k.remaining,
      limit: k.limit,
      isExhausted: k.isExhausted || k.remaining <= 0,
      isActive: activeKey && activeKey.index === k.index,
      resetText: formatResetTime(k.resetSeconds)
    })),
    isExceeded: totalRemaining <= 0,
    resetText: getShortestResetText()
  };
}

/**
 * Registra y activa una nueva API Key en caliente (sin reiniciar).
 * También persiste la clave en el archivo .env para que no se pierda al reiniciar.
 * @param {string} rawKey
 * @returns {Promise<{ success: boolean, message: string, keyInfo?: object }>}
 */
export async function addDynamicApiKey(rawKey) {
  if (!rawKey) return { success: false, message: 'La clave no puede estar vacía.' };
  const cleanKey = rawKey.trim();

  // Validar si ya existe en el pool
  const exists = keyPool.some((k) => k.key === cleanKey);
  if (exists) {
    return { success: false, message: 'Esa API Key ya se encuentra registrada en el pool de Stoky.' };
  }

  // Verificar en vivo contra RapidAPI / ScrapTik
  try {
    const testRes = await axios.get(RAPIDAPI_ENDPOINT, {
      params: { aweme_id: '7697665394248600848', count: 1 },
      headers: {
        'x-rapidapi-key': cleanKey,
        'x-rapidapi-host': RAPIDAPI_HOST
      },
      timeout: 10000
    });

    const limit = parseInt(testRes.headers['x-ratelimit-requests-limit'] || '50', 10);
    const remaining = parseInt(testRes.headers['x-ratelimit-requests-remaining'] || '50', 10);
    const reset = parseInt(testRes.headers['x-ratelimit-requests-reset'] || '2600000', 10);

    const newIndex = keyPool.length + 1;
    const newEntry = {
      index: newIndex,
      key: cleanKey,
      masked: cleanKey.slice(0, 6) + '...' + cleanKey.slice(-4),
      limit,
      remaining,
      resetSeconds: reset,
      isExhausted: remaining <= 0,
      lastUsed: Date.now()
    };

    keyPool.push(newEntry);

    // Persistir en .env
    try {
      const fs = await import('fs');
      const envPath = '.env';
      if (fs.existsSync(envPath)) {
        let envContent = fs.readFileSync(envPath, 'utf-8');
        const match = envContent.match(/RAPIDAPI_KEYS=([^\r\n]+)/);
        if (match) {
          const updatedKeys = `${match[1]},${cleanKey}`;
          envContent = envContent.replace(match[0], `RAPIDAPI_KEYS=${updatedKeys}`);
          fs.writeFileSync(envPath, envContent, 'utf-8');
        }
      }
    } catch (fsErr) {
      console.error('[TiktokService] No se pudo escribir en .env:', fsErr.message);
    }

    return {
      success: true,
      message: `Cuenta #${newIndex} conectada exitosamente (${remaining}/${limit} peticiones disponibles).`,
      keyInfo: newEntry
    };
  } catch (err) {
    const status = err.response?.status;
    const msg = err.response?.data?.message || err.message;
    return {
      success: false,
      message: `Error al validar la clave en RapidAPI (Status ${status || 'desconocido'}: ${msg})`
    };
  }
}

/**
 * Resuelve la URL final siguiendo redirecciones HTTP de enlaces cortos de TikTok (ej. vm.tiktok.com o vt.tiktok.com).
 * @param {string} inputUrl 
 * @returns {Promise<string>} URL final resuelta
 */
export async function resolveFinalUrl(inputUrl) {
  let currentUrl = inputUrl.trim();
  const maxHops = 10;
  let hops = 0;

  while (hops < maxHops) {
    try {
      const response = await axios.get(currentUrl, {
        maxRedirects: 5,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
          'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8'
        },
        validateStatus: (status) => status >= 200 && status < 400
      });

      const responseUrl = response.request?.res?.responseUrl;
      if (responseUrl && responseUrl !== currentUrl) {
        currentUrl = responseUrl;
      }

      const location = response.headers?.location;
      if (location) {
        currentUrl = new URL(location, currentUrl).toString();
        hops++;
        continue;
      }

      break;
    } catch (err) {
      if (err.response?.headers?.location) {
        currentUrl = new URL(err.response.headers.location, currentUrl).toString();
        hops++;
        continue;
      }
      logger.error({ err, currentUrl }, 'Error en redirección de TikTok');
      throw new Error(`No se pudo resolver el enlace de TikTok: ${err.message}`);
    }
  }

  logger.info({ inputUrl, resolvedUrl: currentUrl }, 'Enlace de TikTok resuelto exitosamente');
  return currentUrl;
}

/**
 * Normaliza y decodifica un ID de comentario de TikTok.
 * En enlaces móviles compartidos, el ID puede venir codificado en Base64 (ej: NzM0NTY3...).
 * @param {string|null} raw 
 * @returns {string|null}
 */
export function normalizeCommentId(raw) {
  if (!raw) return null;
  const str = String(raw).trim();
  // Si ya es puramente numérico (longitud típica de snowflake ID de TikTok: 15-22 dígitos)
  if (/^\d{15,22}$/.test(str)) {
    return str;
  }
  // Intentar decodificar Base64
  try {
    const decoded = Buffer.from(str, 'base64').toString('utf-8');
    if (/^\d{15,22}$/.test(decoded)) {
      return decoded;
    }
    const match = decoded.match(/\d{15,22}/);
    if (match) return match[0];
  } catch (_) {}
  return str;
}

/**
 * Extrae el ID del video y el ID del comentario (cid) de la URL resuelta.
 * Soporta parámetros cid, comment_id y share_comment_id en formato numérico o Base64.
 * @param {string} resolvedUrl 
 * @returns {{ videoId: string | null, cid: string | null }}
 */
export function extractTikTokIds(resolvedUrl) {
  try {
    const parsed = new URL(resolvedUrl);

    // 1. Extraer ID del video (video / photo / v / query param)
    let videoId = null;
    const pathMatch = parsed.pathname.match(/\/(?:video|photo|v)\/(\d+)/i);
    if (pathMatch) {
      videoId = pathMatch[1];
    } else {
      videoId = parsed.searchParams.get('aweme_id') ||
                parsed.searchParams.get('video_id') ||
                parsed.searchParams.get('item_id');
    }

    // 2. Extraer ID del comentario (cid, comment_id, share_comment_id)
    let rawCid =
      parsed.searchParams.get('cid') ||
      parsed.searchParams.get('comment_id') ||
      parsed.searchParams.get('share_comment_id');

    if (!rawCid) {
      const matchCid = resolvedUrl.match(/[?&#](?:cid|comment_id|share_comment_id)=([^&%#\s]+)/i);
      if (matchCid) {
        rawCid = matchCid[1];
      }
    }

    const cid = normalizeCommentId(rawCid);

    return { videoId, cid };
  } catch (error) {
    logger.error({ error, resolvedUrl }, 'Error al parsear URL de TikTok');
    return { videoId: null, cid: null };
  }
}

/**
 * Consulta la API de comentarios de TikTok en RapidAPI y busca el comentario por su cid exacto.
 * Soporta paginación básica (hasta 3 páginas) si el comentario no está en el primer lote.
 * Maneja de forma estricta el control de cuotas y límite de peticiones.
 * @param {string} videoId 
 * @param {string} cid 
 * @param {string} originalResolvedUrl 
 * @returns {Promise<object>} Objeto JSON del comentario
 */
export async function fetchTikTokCommentByCid(videoId, cid, originalResolvedUrl) {
  let cursor = 0;
  const maxPages = 3;
  let page = 0;

  while (page < maxPages) {
    page++;
    logger.info({ videoId, cid, page, cursor }, 'Consultando comentarios en RapidAPI...');

    const response = await executeRapidApiRequest({
      video_id: videoId,
      aweme_id: videoId,
      url: originalResolvedUrl,
      count: 50,
      cursor: cursor
    });

    const data = response.data;

    // Normalizar lista de comentarios según la estructura del proveedor en RapidAPI
    const comments =
      data?.data?.comments ||
      data?.comments ||
      (Array.isArray(data?.data) ? data.data : []) ||
      [];

    if (!Array.isArray(comments) || comments.length === 0) {
      break;
    }

    // Aplanar comentarios principales y respuestas anidadas (reply_comment)
    const allComments = [];
    for (const c of comments) {
      allComments.push(c);
      if (Array.isArray(c.reply_comment)) {
        for (const r of c.reply_comment) {
          allComments.push(r);
        }
      }
    }

    // Filtrar por cid exacto (probando tanto numérico como decodificado)
    const targetCid = String(cid);
    const decodedCid = normalizeCommentId(targetCid);
    const foundComment = allComments.find((c) => {
      const currentCid = String(c.cid || c.id || c.comment_id || '');
      return currentCid === targetCid || (decodedCid && currentCid === decodedCid);
    });

    if (foundComment) {
      logger.info({ cid, found: true, pagesUsed: page }, 'Comentario encontrado en RapidAPI');
      console.log('\n[DEBUG_TIKTOK_COMMENT]:', JSON.stringify({
        id: foundComment.id || foundComment.cid,
        text: foundComment.text,
        images: foundComment.images || foundComment.image_list,
        cmt_sticker: foundComment.cmt_sticker_struct || foundComment.sticker,
        pagesUsed: page,
        keys: Object.keys(foundComment)
      }, null, 2), '\n');
      return { comment: foundComment, pagesUsed: page };
    }

    // Comprobar si hay más páginas
    const hasMore = data?.data?.hasMore ?? data?.data?.has_more ?? data?.hasMore ?? data?.has_more;
    const nextCursor = data?.data?.cursor ?? data?.cursor;

    if (!hasMore || nextCursor === undefined || nextCursor === cursor) {
      break;
    }

    cursor = nextCursor;
  }

  throw new Error(`NOT_FOUND_IN_API: No se encontró el comentario (cid: ${cid}) en las primeras páginas del video.`);
}

/**
 * Detecta qué tipo de contenido multimedia tiene el comentario:
 * 1. Foto adjunta (comment.images o comment.image_list)
 * 2. Sticker nativo estático o animado (comment.sticker)
 * 3. Sin multimedia (solo texto)
 * @param {object} comment 
 * @returns {{ hasMedia: boolean, type: string, isAnimated: boolean, url: string | null, commentText: string }}
 */
export function detectCommentMedia(comment) {
  // 1. Fotos adjuntas en el comentario (images: string[] o image_list: object[])
  const images = comment.images || comment.image_list || [];
  if (Array.isArray(images) && images.length > 0) {
    const firstImg = images[0];
    let imageUrl = null;

    if (typeof firstImg === 'string') {
      imageUrl = firstImg;
    } else if (typeof firstImg === 'object' && firstImg !== null) {
      imageUrl =
        firstImg.display_image?.url_list?.[0] ||
        firstImg.origin_url_list?.[0] ||
        firstImg.image_url?.url_list?.[0] ||
        firstImg.url_list?.[0] ||
        firstImg.download_url_list?.[0] ||
        firstImg.url;
    }

    if (imageUrl) {
      return {
        hasMedia: true,
        type: 'photo',
        isAnimated: false,
        url: imageUrl,
        commentText: comment.text || ''
      };
    }
  }

  // 2. Sticker nativo de TikTok (cmt_sticker_struct, sticker, sticker_info o interaction_sticker)
  const sticker =
    comment.cmt_sticker_struct ||
    comment.sticker ||
    comment.sticker_info ||
    comment.interaction_sticker ||
    (Array.isArray(comment.stickers) ? comment.stickers[0] : null);

  if (sticker) {
    let animateUrl = null;
    let staticUrl = null;

    if (typeof sticker === 'string') {
      staticUrl = sticker;
    } else if (typeof sticker === 'object' && sticker !== null) {
      // Formato móvil de TikTok (cmt_sticker_struct)
      const anim = sticker.animated_url || sticker.animate_url;
      if (anim) {
        animateUrl =
          anim.high_resolution_url?.url_list?.[0] ||
          anim.mid_resolution_url?.url_list?.[0] ||
          anim.low_resolution_url?.url_list?.[0] ||
          anim.url_list?.[0] ||
          anim.url;
      }

      const stat = sticker.static_url;
      if (stat) {
        staticUrl =
          stat.high_resolution_url?.url_list?.[0] ||
          stat.mid_resolution_url?.url_list?.[0] ||
          stat.low_resolution_url?.url_list?.[0] ||
          stat.url_list?.[0] ||
          stat.url;
      }
    }

    if (animateUrl) {
      return {
        hasMedia: true,
        type: 'sticker_animated',
        isAnimated: true,
        url: animateUrl,
        commentText: comment.text || ''
      };
    }

    if (staticUrl) {
      return {
        hasMedia: true,
        type: 'sticker_static',
        isAnimated: false,
        url: staticUrl,
        commentText: comment.text || ''
      };
    }
  }

  // 3. Detección de sticker nativo integrado en texto (ej. [Sticker], [Laugh approved], etc.)
  const isNativeStickerTag = /\[(sticker|emoji|[a-záéíóú0-9\s_-]+)\]/i.test(comment.text || '');

  return {
    hasMedia: false,
    type: isNativeStickerTag ? 'native_sticker_tag' : 'text_only',
    isAnimated: false,
    url: null,
    commentText: comment.text || ''
  };
}

/**
 * Orquestador principal del servicio de TikTok.
 * Recibe un enlace compartido, resuelve la URL, extrae IDs, consulta la API y analiza el contenido.
 * @param {string} rawUrl 
 */
export async function extractTikTokCommentMedia(rawUrl) {
  const resolvedUrl = await resolveFinalUrl(rawUrl);
  const { videoId, cid } = extractTikTokIds(resolvedUrl);

  if (!videoId) {
    throw new Error('NO_VIDEO_ID: No se pudo extraer el ID del video de TikTok en la URL.');
  }

  if (!cid) {
    throw new Error('NO_CID: El enlace corresponde al video, pero no contiene el ID de ningún comentario. Asegúrate de copiar el enlace desde la opción "Compartir comentario".');
  }

  const { comment, pagesUsed } = await fetchTikTokCommentByCid(videoId, cid, resolvedUrl);
  const mediaResult = detectCommentMedia(comment);

  return {
    videoId,
    cid,
    resolvedUrl,
    pagesUsed,
    ...mediaResult
  };
}
