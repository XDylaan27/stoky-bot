import { trace, withTikTokTrace } from '../utils/tiktokTrace.js';
import fs from 'node:fs';
import { detectCommentMedia } from './commentMedia.js';
export { detectCommentMedia } from './commentMedia.js';
import axios from 'axios';
import { catalogService } from './catalogService.js';
import { RAPIDAPI_KEYS, RAPIDAPI_HOST, RAPIDAPI_ENDPOINT } from '../config.js';
import { logger } from '../utils/logger.js';
import { cloudStore } from './cloudStore.js';

// Pool de llaves para rotación automática y failover
const keyPool = RAPIDAPI_KEYS.map((key, index) => ({
  index: index + 1,
  key,
  masked: key.slice(0, 6) + '...' + key.slice(-4),
  limit: null,
  remaining: null,
  resetSeconds: null,
  resetAt: null,
  isExhausted: false,
  lastUsed: 0
}));

let currentKeyIndex = 0;

export function assertProviderSuccess(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('RAPIDAPI_INVALID_RESPONSE: El proveedor no devolvio un objeto JSON valido');
  }
  const code = data.status_code ?? data.code;
  if (code !== undefined && Number(code) !== 0) {
    throw new Error(`RAPIDAPI_PROVIDER_ERROR (${code}): ${data.status_msg || data.msg || data.message || 'El proveedor rechazo la consulta'}`);
  }
}

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
  for (const k of keyPool) if (k.resetAt && Date.now() >= k.resetAt) { k.isExhausted = false; k.remaining = null; k.resetAt = null; }
  if (keyPool.length === 0) return null;

  if (!keyPool[currentKeyIndex].isExhausted && keyPool[currentKeyIndex].remaining !== 0) {
    return keyPool[currentKeyIndex];
  }

  for (let i = 0; i < keyPool.length; i++) {
    const candidateIdx = (currentKeyIndex + i) % keyPool.length;
    const candidate = keyPool[candidateIdx];
    if (!candidate.isExhausted && candidate.remaining !== 0) {
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
  keyPool[prevIdx].resetAt ||= Date.now() + 60000;
  keyPool[prevIdx].remaining = 0;

  for (let i = 1; i <= keyPool.length; i++) {
    const nextIdx = (prevIdx + i) % keyPool.length;
    const next = keyPool[nextIdx];
    if (!next.isExhausted && next.remaining !== 0) {
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
  const remaining = headers['x-ratelimit-requests-remaining'] ?? headers['x-ratelimit-scraping-api-remaining'];
  const reset = headers['x-ratelimit-requests-reset'] || headers['x-ratelimit-scraping-api-reset'];

  if (limit) keyObj.limit = parseInt(limit, 10);
  if (reset) { keyObj.resetSeconds = parseInt(reset, 10); keyObj.resetAt = Date.now() + keyObj.resetSeconds * 1000; }

  if (remaining !== undefined) {
    keyObj.remaining = parseInt(remaining, 10);
    if (keyObj.remaining === 0) {
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
      trace('api.request', { provider: RAPIDAPI_HOST, endpoint: RAPIDAPI_ENDPOINT, account: activeKey.index, attempt: attempts, params });
      const response = await axios.get(RAPIDAPI_ENDPOINT, {
        params,
        headers: {
          'x-rapidapi-key': activeKey.key,
          'x-rapidapi-host': RAPIDAPI_HOST
        },
        timeout: 15000
      });

      trace('api.response', { status: response.status, code: response.data?.status_code ?? response.data?.code, message: response.data?.status_msg || response.data?.msg, fields: Object.keys(response.data || {}), dataFields: Object.keys(response.data?.data || {}), remaining: response.headers['x-ratelimit-requests-remaining'] });
      updateKeyQuotaFromHeaders(activeKey, response.headers);
      assertProviderSuccess(response.data);

      if (activeKey.remaining === 0) {
        rotateToNextKey(`Cuenta #${activeKey.index} consumió su última petición (0 restantes)`);
      }

      return response;
    } catch (err) {
      if (err.response?.headers) {
        updateKeyQuotaFromHeaders(activeKey, err.response.headers);
      }

      trace('api.error', { account: activeKey.index, status: err.response?.status, message: err.message });
      const status = err.response?.status;
      const errorMsg = err.response?.data?.message || err.message || '';

      trace('api.failure_classified', { status, providerMessage: errorMsg, transportCode: err.code });
      const isQuotaExceeded =
        status === 429 ||
        errorMsg.toLowerCase().includes('rate limit') ||
        errorMsg.toLowerCase().includes('quota') ||
        activeKey.remaining === 0;

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
    totalRemaining: keyPool.some(k => k.remaining === null) ? "pendiente de consultar" : totalRemaining,
    totalLimit: keyPool.some(k => k.limit === null) ? "desconocido" : totalLimit,
    activeKeyIndex: activeKey ? activeKey.index : null,
    totalKeys: keyPool.length,
    keys: keyPool.map((k) => ({
      index: k.index,
      masked: k.masked,
      remaining: k.remaining,
      limit: k.limit,
      isExhausted: k.isExhausted || k.remaining === 0,
      isActive: activeKey && activeKey.index === k.index,
      resetText: formatResetTime(k.resetAt ? Math.max(0, (k.resetAt - Date.now()) / 1000) : k.resetSeconds)
    })),
    isExceeded: keyPool.length === 0 || keyPool.every(k => k.isExhausted),
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
      params: { url: '7697665394248600848', aweme_id: '7697665394248600848', count: 1 },
      headers: {
        'x-rapidapi-key': cleanKey,
        'x-rapidapi-host': RAPIDAPI_HOST
      },
      timeout: 10000
    });

    assertProviderSuccess(testRes.data);
    const numberHeader = name => {
      const value = Number.parseInt(testRes.headers[name], 10);
      return Number.isFinite(value) && value >= 0 ? value : null;
    };
    const limit = numberHeader('x-ratelimit-requests-limit');
    const remaining = numberHeader('x-ratelimit-requests-remaining');
    const reset = numberHeader('x-ratelimit-requests-reset');

    const newIndex = keyPool.length + 1;
    const newEntry = {
      index: newIndex,
      key: cleanKey,
      masked: cleanKey.slice(0, 6) + '...' + cleanKey.slice(-4),
      limit,
      remaining,
      resetSeconds: reset,
      resetAt: reset === null ? null : Date.now() + reset * 1000,
      isExhausted: remaining === 0,
      lastUsed: Date.now()
    };

    keyPool.push(newEntry);

    // Persistir en .env
    try {
      if (cloudStore) {
        await cloudStore.put('keys', keyPool.map(k => k.key));
      } else {
      const fs = await import('fs');
      const envPath = '.env';
      let content = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
      const line = 'RAPIDAPI_KEYS=' + keyPool.map(k => k.key).join(',');
      content = /^RAPIDAPI_KEYS=.*$/m.test(content) ? content.replace(/^RAPIDAPI_KEYS=.*$/m, line) : content + '\n' + line + '\n';
      fs.writeFileSync(envPath + '.tmp', content, 'utf8');
      fs.renameSync(envPath + '.tmp', envPath);
      }
    } catch (fsErr) {
      return { success: false, message: "Clave activada solo en memoria; no se pudo guardar .env: " + fsErr.message };
    }

    return {
      success: true,
      message: `Cuenta #${newIndex} conectada exitosamente (${remaining ?? 'desconocidas'}/${limit ?? 'desconocido'} peticiones disponibles).`,
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
        timeout: 15000,
        maxContentLength: 2 * 1024 * 1024,
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
  const maxPages = Math.min(100, Math.max(1, Number(process.env.MAX_COMMENT_PAGES) || 10));
  let page = 0;

  while (page < maxPages) {
    page++;
    logger.debug({ videoId, cid, page, cursor }, 'Consultando comentarios en RapidAPI...');

    const response = await executeRapidApiRequest({
      video_id: videoId,
      aweme_id: videoId,
      url: RAPIDAPI_HOST.includes("tiktok-scraper7") ? videoId : originalResolvedUrl,
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

    trace('comments.page', { videoId, cid, page, cursor, count: Array.isArray(comments) ? comments.length : null, withImages: Array.isArray(comments) ? comments.filter(c => c.images?.length || c.image_list?.length).length : 0, withStickers: Array.isArray(comments) ? comments.filter(c => c.sticker || c.cmt_sticker_struct || c.sticker_info).length : 0 });
    if (!Array.isArray(comments) || comments.length === 0) {
      trace('comments.search_end', { reason: 'empty_page', page, videoId, cid, total: data?.total ?? data?.data?.total, filtered: data?.has_filtered_comments, folded: data?.has_fold_comment });
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
      trace('comment.matched', { expectedCid: cid, expectedVideoId: videoId, fields: Object.keys(foundComment), comment: foundComment });
      return { comment: foundComment, pagesUsed: page };
    }

    // Comprobar si hay más páginas
    const hasMore = data?.data?.hasMore ?? data?.data?.has_more ?? data?.hasMore ?? data?.has_more;
    const nextCursor = data?.data?.cursor ?? data?.cursor;

    if (!hasMore || nextCursor === undefined || nextCursor === cursor) {
      trace('comments.search_end', { reason: 'pagination_end', page, videoId, cid, hasMore, nextCursor, filtered: data?.has_filtered_comments, folded: data?.has_fold_comment });
      break;
    }

    cursor = nextCursor;
  }

  throw new Error(`NOT_FOUND_IN_API: No se encontro el comentario (cid: ${cid}) en las primeras páginas del video.`);
}

/**
 * Detecta qué tipo de contenido multimedia tiene el comentario:
 * 1. Foto adjunta (comment.images o comment.image_list)
 * 2. Sticker nativo estático o animado (comment.sticker)
 * 3. Sin multimedia (solo texto)
 * @param {object} comment 
 * @returns {{ hasMedia: boolean, type: string, isAnimated: boolean, url: string | null, commentText: string }}
 */
/**
 * Orquestador principal del servicio de TikTok.
 * Recibe un enlace compartido, resuelve la URL, extrae IDs, consulta la API y analiza el contenido.
 * @param {string} rawUrl 
 */
export async function extractTikTokCommentMedia(rawUrl) {
  return withTikTokTrace(rawUrl, () => extractMedia(rawUrl));
}
async function extractMedia(rawUrl) {
  const resolvedUrl = await resolveFinalUrl(rawUrl);
  const { videoId, cid } = extractTikTokIds(resolvedUrl);
  trace('link.resolved', { resolvedUrl, videoId, cid });

  if (!videoId) {
    throw new Error('NO_VIDEO_ID: No se pudo extraer el ID del video de TikTok en la URL.');
  }

  if (!cid) {
    throw new Error('NO_CID: El enlace corresponde al video, pero no contiene el ID de ningún comentario. Asegúrate de copiar el enlace desde la opción "Compartir comentario".');
  }

  const cached = catalogService.getByCid(cid);
  if (cached) return { cachedBuffer: cached.buffer, cid, pagesUsed: 0, hasMedia: true };
  const { comment, pagesUsed } = await fetchTikTokCommentByCid(videoId, cid, resolvedUrl);
  const mediaResult = detectCommentMedia(comment);
  trace('media.detected', { ...mediaResult, reason: mediaResult.hasMedia ? 'recognized_url' : 'no_supported_media_url', fields: Object.keys(comment) });
  if (!mediaResult.hasMedia && process.env.TIKTOK_DEBUG === 'true') {
    try {
      fs.mkdirSync('scratch', { recursive: true });
      const media = Object.fromEntries(Object.entries(comment).filter(([key]) => /image|sticker|media|attach/i.test(key)));
      fs.writeFileSync('scratch/last-comment-media.json', JSON.stringify({ provider: RAPIDAPI_HOST, videoId, cid, fields: Object.keys(comment), text: comment.text, media }, null, 2));
    } catch (err) { logger.warn({ message: err.message }, 'No se pudo guardar diagnostico multimedia'); }
  }

  return {
    videoId,
    cid,
    resolvedUrl,
    pagesUsed,
    ...mediaResult
  };
}
