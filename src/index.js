import {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers
} from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import pino from 'pino';
import fs from 'fs';
import readline from 'readline';

import {
  ALLOWED_JIDS,
  PUBLIC_MODE,
  LOG_LEVEL,
  validateConfig
} from './config.js';
import { humanDelay } from './utils/delay.js';
import { logger } from './utils/logger.js';
import { messageQueue } from './queue.js';
import { extractTikTokCommentMedia, getQuotaStatus, addDynamicApiKey } from './services/tiktokService.js';
import { createStickerFromUrl } from './services/stickerService.js';
import { stateService } from './services/stateService.js';
import { catalogService } from './services/catalogService.js';

// Logger que escribe simultáneamente en consola y en bot.log
function logConsole(...args) {
  const line = `[${new Date().toLocaleTimeString()}] ${args.map(a => (typeof a === 'object' ? JSON.stringify(a) : a)).join(' ')}`;
  console.log(line);
  try {
    fs.appendFileSync('bot.log', line + '\n');
  } catch (_) {}
}

// Conjunto de chats activos (usuarios que enviaron "iniciar-bot" o enviaron un enlace)
const activeChats = new Set();

/**
 * Extrae el texto real del mensaje, soportando mensajes temporales (ephemeral) y multimedia.
 */
function extractMessageBody(msg) {
  if (!msg || !msg.message) return '';
  const m =
    msg.message.ephemeralMessage?.message ||
    msg.message.viewOnceMessage?.message ||
    msg.message.viewOnceMessageV2?.message ||
    msg.message.documentWithCaptionMessage?.message ||
    msg.message;

  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    m.templateButtonReplyMessage?.selectedId ||
    m.buttonsResponseMessage?.selectedButtonId ||
    m.listResponseMessage?.singleSelectReply?.selectedRowId ||
    ''
  );
}

/**
 * Procesa un enlace individual de TikTok aplicando simulación de comportamiento humano y rate-limiting.
 */
async function handleTikTokMessage(sock, msg, rawUrl, remoteJid) {
  try {
    logConsole(`[Stoky] Iniciando proceso para ${remoteJid} con URL: ${rawUrl}`);

    // 1. Simulación humana: Delay inicial (600 - 1500 ms) antes de leer
    await humanDelay(600, 1500);

    // 2. Marcar mensaje como leído
    await sock.readMessages([msg.key]);

    // 3. Reacción visual de espera ⏳
    await sock.sendMessage(remoteJid, {
      react: { text: '⏳', key: msg.key }
    });

    // 4. Estado "Escribiendo..." (composing)
    await sock.sendPresenceUpdate('composing', remoteJid);

    // 5. Simular tiempo de procesamiento humano (1500 - 3000 ms)
    await humanDelay(1500, 3000);

    // 5.1 Verificar si el CID ya está guardado en el Catálogo local (0 Peticiones a RapidAPI)
    const preliminaryMatch = rawUrl.match(/[?&#](?:cid|comment_id|share_comment_id)=([^&%#\s]+)/i);
    if (preliminaryMatch) {
      const cached = catalogService.getByCid(preliminaryMatch[1]);
      if (cached && cached.buffer) {
        logConsole(`[Stoky] ⚡ Sticker encontrado en Catálogo Local (${cached.code}). Enviando sin consultar API de TikTok...`);
        await sock.sendMessage(
          remoteJid,
          { sticker: cached.buffer },
          { quoted: msg }
        );
        await sock.sendMessage(remoteJid, {
          react: { text: '✅', key: msg.key }
        });
        stateService.recordStickerUsage(remoteJid, rawUrl, 0, cached.cid);
        logConsole(`[Stoky] ✅ Sticker local (${cached.code}) entregado con 0 peticiones gastadas.`);
        return;
      }
    }

    // 6. Extracción del comentario multimedia en TikTok
    logConsole(`[Stoky] Consultando comentario en TikTok API...`);
    const result = await extractTikTokCommentMedia(rawUrl);
    logConsole(`[Stoky] Resultado de TikTok:`, { hasMedia: result.hasMedia, type: result.type, cid: result.cid, pagesUsed: result.pagesUsed });

    // Caso 1: Comentario sin imagen ni sticker (solo texto)
    if (!result.hasMedia) {
      let warningText = '⚠️ *Stoky:* Ese comentario solo tiene texto, no contiene ningún sticker ni foto.';
      if (result.type === 'native_sticker_tag') {
        warningText = `⚠️ *Stoky:* Este comentario usa un emoji o sticker del catálogo nativo de TikTok (${result.commentText}).\n\nTikTok no proporciona el archivo de imagen de sus stickers internos en su API pública. ¡Pero sí convierte cualquier *foto, meme o sticker personalizado* que suban los usuarios!`;
      }

      await sock.sendMessage(
        remoteJid,
        { text: warningText },
        { quoted: msg }
      );

      await sock.sendMessage(remoteJid, {
        react: { text: '❌', key: msg.key }
      });
      logConsole(`[Stoky] Comentario sin multimedia enviado aviso a ${remoteJid}`);
      return;
    }

    // Caso 2: Comentario con imagen o sticker nativo (mantiene silueta y transparencia)
    logConsole(`[Stoky] Convirtiendo recurso a sticker WebP 512x512...`);
    const stickerBuffer = await createStickerFromUrl(result.url);

    // Guardar en el catálogo local para futuras consultas con 0 peticiones
    const savedInCatalog = catalogService.saveSticker(result.cid, stickerBuffer, result.commentText);
    const codeTag = savedInCatalog ? ` [Código: ${savedInCatalog.code}]` : '';

    // Enviar sticker generado
    await sock.sendMessage(
      remoteJid,
      { sticker: stickerBuffer },
      { quoted: msg }
    );

    // Actualizar reacción a éxito ✅
    await sock.sendMessage(remoteJid, {
      react: { text: '✅', key: msg.key }
    });

    // Registrar en historial de métricas
    stateService.recordStickerUsage(remoteJid, rawUrl, result.pagesUsed || 1, result.cid);

    logConsole(`[Stoky] ✅ Sticker enviado exitosamente a ${remoteJid}${codeTag} (Páginas usadas: ${result.pagesUsed || 1})`);
  } catch (error) {
    logConsole(`[Stoky Error]: ${error.message}`);

    let replyMessage = `❌ *Stoky:* Ocurrió un problema (${error.message.replace(/^Error:\s*/, '')})`;

    if (error.message.includes('RAPIDAPI_QUOTA_EXCEEDED')) {
      const resetText = error.resetText || 'el próximo ciclo mensual';
      replyMessage =
        `⚠️ *Stoky: Cuota agotada.*\n\n` +
        `Se ha alcanzado el límite de cuota (por minuto o mensual) de la API de comentarios de TikTok.\n` +
        `⏳ *Renovación estimada:* ${resetText}.\n\n` +
        `_Escribe *stoky-quota* para consultar los detalles de la cuota._`;
    } else if (error.message.includes('NO_CID')) {
      replyMessage = '⚠️ *Stoky:* El enlace corresponde al video completo, pero no a un comentario específico.\n\n👉 Para obtener el sticker: ve al comentario en TikTok, manténlo pulsado (o toca Compartir) y selecciona *"Copiar enlace"*.';
    } else if (error.message.includes('RAPIDAPI_KEY_MISSING')) {
      replyMessage = '⚙️ *Stoky:* Falta configurar `RAPIDAPI_KEY` en el archivo `.env`.';
    } else if (error.message.includes('NOT_FOUND_IN_API')) {
      replyMessage = '⚠️ *Stoky:* No se encontró el comentario con ese ID en la API de TikTok. Podría haber sido eliminado recientemente o ser muy antiguo.';
    } else if (error.code === 'ECONNABORTED' || error.message.includes('timeout')) {
      replyMessage = '⚠️ *Stoky:* La conexión con los servidores de TikTok tardó demasiado. Por favor, intenta de nuevo en unos segundos.';
    }

    await sock.sendMessage(
      remoteJid,
      { text: replyMessage },
      { quoted: msg }
    );

    await sock.sendMessage(remoteJid, {
      react: { text: '❌', key: msg.key }
    });
  } finally {
    // 7. Restablecer presencia a pausado
    try {
      await sock.sendPresenceUpdate('paused', remoteJid);
    } catch (_) {}
  }
}

/**
 * Función principal de arranque del Socket de Baileys
 */
async function startBot() {
  const configStatus = validateConfig();
  if (!configStatus.isValid) {
    console.warn('\n⚠️ [ADVERTENCIA DE CONFIGURACIÓN] Faltan variables en tu archivo .env:');
    configStatus.missing.forEach((item) => console.warn(`   - ${item}`));
    console.warn('Configura tu archivo .env antes de procesar enlaces.\n');
  }

  // 1. Cargar estado de sesión persistente en auth_info_baileys
  const { state, saveCreds } = await useMultiFileAuthState('./auth_info_baileys');

  // 2. Obtener la última versión oficial de WhatsApp Web según Baileys
  const { version, isLatest } = await fetchLatestBaileysVersion();
  logger.info({ version: version.join('.'), isLatest }, 'Iniciando WhatsApp Socket con Baileys');

  // 3. Crear socket con protecciones y emulación estándar de navegador Desktop
  const sock = makeWASocket({
    version,
    logger: pino({ level: LOG_LEVEL === 'silent' ? 'silent' : 'warn' }),
    auth: state,
    browser: Browsers.macOS('Desktop'),
    printQRInTerminal: false,
    syncFullHistory: false,
    generateHighQualityLinkPreview: true
  });

  // Escuchar actualización de credenciales para persistir la sesión
  sock.ev.on('creds.update', saveCreds);

  // Soporte para vinculación mediante Código de Emparejamiento (Pairing Code)
  let usePairing = Boolean(process.env.PAIRING_NUMBER || process.argv.includes('--pairing'));
  let pairingNumber = (process.env.PAIRING_NUMBER || '').trim().replace(/[^0-9]/g, '');

  if (!sock.authState.creds.registered) {
    if (!pairingNumber && process.stdin.isTTY) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const question = (query) => new Promise((resolve) => rl.question(query, resolve));

      console.log('\n======================================================');
      console.log('📱 ¿CÓMO DESEAS VINCULAR EL BOT A WHATSAPP?');
      console.log('1. Código de Emparejamiento de 8 dígitos (Recomendado para Celular / Termux)');
      console.log('2. Código QR en pantalla');
      console.log('======================================================');
      const answer = await question('👉 Escribe tu número con código de país (ej: 573115040555) o presiona ENTER para QR: ');
      rl.close();

      const cleaned = answer.trim().replace(/[^0-9]/g, '');
      if (cleaned.length >= 8) {
        pairingNumber = cleaned;
        usePairing = true;
      }
    }

    if (usePairing && pairingNumber) {
      setTimeout(async () => {
        try {
          const code = await sock.requestPairingCode(pairingNumber);
          const formattedCode = code?.match(/.{1,4}/g)?.join('-') || code;
          console.log('\n╔══════════════════════════════════════════════════════════╗');
          console.log(`║  🔑 CÓDIGO DE VINCULACIÓN:  ${formattedCode.padEnd(27)} ║`);
          console.log('╠══════════════════════════════════════════════════════════╣');
          console.log('║  Pasos en WhatsApp:                                     ║');
          console.log('║  1. Abre WhatsApp en tu celular                          ║');
          console.log('║  2. Toca Ajustes (o ⋮) > Dispositivos vinculados         ║');
          console.log('║  3. Toca "Vincular un dispositivo"                       ║');
          console.log('║  4. Toca abajo: "Vincular con el número de teléfono"     ║');
          console.log(`║  5. Ingresa el código: ${formattedCode.padEnd(31)} ║`);
          console.log('╚══════════════════════════════════════════════════════════╝\n');
        } catch (err) {
          console.error('❌ Error al generar código de emparejamiento:', err.message);
        }
      }, 3000);
    }
  }

  // Escuchar estado de conexión y código QR
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr && !usePairing) {
      console.log('\n======================================================');
      console.log('📱 ESCANEA EL CÓDIGO QR CON TU WHATSAPP (NÚMERO SECUNDARIO)');
      console.log('WhatsApp > Dispositivos Vinculados > Vincular un dispositivo');
      console.log('======================================================\n');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode || lastDisconnect?.error?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      logger.warn({ statusCode, shouldReconnect }, 'Conexión cerrada con los servidores de WhatsApp');

      if (shouldReconnect) {
        console.log('🔄 Reconectando en 3 segundos...');
        setTimeout(() => startBot(), 3000);
      } else {
        console.error('❌ Sesión finalizada (Logged Out). Elimina la carpeta "auth_info_baileys" y reinicia para generar un nuevo QR.');
      }
    } else if (connection === 'open') {
      console.log('\n======================================================');
      console.log('🚀 [BOT STOKY ACTIVO Y CONECTADO A WHATSAPP]');
      if (PUBLIC_MODE) {
        console.log('🌐 Modo Amigos/Abierto: Cualquier chat privado puede activar a Stoky con "iniciar-bot".');
      } else {
        console.log(`🔒 Modo Restringido: Solo permitido para los números: ${ALLOWED_JIDS.join(', ')}`);
      }
      console.log('======================================================\n');
    }
  });

  // Escuchar mensajes entrantes
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify' && type !== 'append') return;

    for (const msg of messages) {
      if (!msg.message) continue;

      const remoteJid = msg.key.remoteJid;

      // 1. Regla Anti-Ban: Ignorar completamente grupos y estados
      if (!remoteJid || remoteJid.endsWith('@g.us') || remoteJid === 'status@broadcast') {
        continue;
      }

      // 2. Control de Acceso y Modo Privado
      const isFromMe = Boolean(msg.key.fromMe);
      const isStaticAllowed = ALLOWED_JIDS.some((jid) => remoteJid === jid);
      const isAllowed = isFromMe || isStaticAllowed || stateService.isUserAllowed(remoteJid, isFromMe);

      // 3. Extraer texto del mensaje (soporta mensajes normales, temporales, con vista única o multimedia)
      const body = extractMessageBody(msg);
      if (!body) continue;

      logConsole(`[Mensaje Recibido de ${remoteJid}]: "${body}"`);

      const cleanText = body.trim();
      const lowerText = cleanText.toLowerCase();

      // 3.1 Manejo especial de "unirme <codigo>" (Permitido incluso en modo privado)
      if (lowerText.startsWith('unirme ') || lowerText.startsWith('!unirme ')) {
        const code = cleanText.split(/\s+/)[1];
        const redeem = stateService.redeemInviteCode(code, remoteJid);

        if (redeem.success) {
          activeChats.add(remoteJid);
          await humanDelay(500, 1000);
          await sock.readMessages([msg.key]);
          await sock.sendMessage(
            remoteJid,
            {
              text: '🟢 *¡Bienvenido a Stoky!*\nTu código de invitación ha sido aceptado y estás en la lista autorizada.\n\nPuedes enviarme enlaces de TikTok para crear stickers o pedir stickers del catálogo.'
            },
            { quoted: msg }
          );
        } else {
          // Si el código no existe o ya fue usado, ignorar en silencio si está en modo privado
          if (!stateService.isPrivateMode()) {
            await sock.sendMessage(
              remoteJid,
              { text: '❌ *Stoky:* El código de invitación no existe o ya fue utilizado.' },
              { quoted: msg }
            );
          }
        }
        continue;
      }

      // Si está en Modo Privado y el usuario NO está autorizado, ignorar completamente en silencio
      if (stateService.isPrivateMode() && !isAllowed) {
        continue;
      }

      // 4. Manejo de Comandos

      // 4.1 Menú de Ayuda (stoky -h / stoky ayuda)
      if (lowerText === 'stoky -h' || lowerText === 'stoky ayuda' || lowerText === '!help' || lowerText === 'stoky help') {
        await humanDelay(400, 800);
        await sock.readMessages([msg.key]);

        const adminSection = isFromMe
          ? `\n\n👑 *Comandos de Administrador:*\n` +
            `• *stoky private* → Activa el modo privado (ignora a no invitados).\n` +
            `• *stoky public* → Regresa a modo público/amigos.\n` +
            `• *stoky invite* → Genera un código de invitación de 1 solo uso.\n` +
            `• *stoky kick <número>* → Remueve a alguien de la lista blanca.\n` +
            `• *stoky newkey <clave>* → Agrega una nueva API Key en caliente.\n` +
            `• *stoky historia* → Métricas y stickers con alto gasto de peticiones.`
          : '';

        const helpMsg =
          `🤖 *Menú de Comandos de Stoky:*\n\n` +
          `• *iniciar-bot* → Activa a Stoky en este chat.\n` +
          `• *pausar-bot* → Pausa a Stoky en este chat.\n` +
          `• *stoky estado* → Revisa si Stoky está activo para ti.\n` +
          `• *stoky-quota* → Consulta el balance de peticiones mensuales disponibles.\n` +
          `• *stoky catalogo* → Muestra el enlace web al catálogo de stickers.\n` +
          `• *sticker <código>* → Pide un sticker específico (ej: *sticker A1*).\n` +
          `• *stickers <código1> <código2>...* → Pide varios stickers a la vez (ej: *stickers A1 B3 C2*).${adminSection}\n\n` +
          `_✨ Recuerda que pedir stickers del catálogo consume 0 peticiones de API._`;

        await sock.sendMessage(remoteJid, { text: helpMsg }, { quoted: msg });
        continue;
      }

      // 4.2 Comandos Administrativos (Solo para el dueño / fromMe)
      if (isFromMe) {
        if (lowerText === 'stoky private' || lowerText === 'stoky privado') {
          stateService.setPrivateMode(true);
          await humanDelay(400, 800);
          await sock.sendMessage(
            remoteJid,
            { text: '🔒 *Stoky: Modo Privado ACTIVADO.*\nA partir de ahora, cualquier persona fuera de la lista blanca será ignorada en silencio absoluto.' },
            { quoted: msg }
          );
          continue;
        }

        if (lowerText === 'stoky public' || lowerText === 'stoky publico') {
          stateService.setPrivateMode(false);
          await humanDelay(400, 800);
          await sock.sendMessage(
            remoteJid,
            { text: '🌐 *Stoky: Modo Público ACTIVADO.*\nAhora cualquier chat privado puede interactuar con el bot.' },
            { quoted: msg }
          );
          continue;
        }

        if (lowerText === 'stoky invite' || lowerText === 'stoky invitar') {
          const code = stateService.generateInviteCode();
          await humanDelay(400, 800);
          await sock.sendMessage(
            remoteJid,
            {
              text: `🎟️ *Código de Invitación Generado:*\n\n👉 \`unirme ${code}\`\n\nComparte este texto con tu amigo. Al enviármelo, quedará autorizado permanentemente (código de un solo uso sin caducidad).`
            },
            { quoted: msg }
          );
          continue;
        }

        if (lowerText.startsWith('stoky kick ') || lowerText.startsWith('!kick ')) {
          const target = cleanText.split(/\s+/)[2] || cleanText.split(/\s+/)[1];
          const removed = stateService.kickUser(target);
          await humanDelay(400, 800);
          const kickMsg = removed
            ? `🚫 *Usuario eliminado:* El número \`${target}\` fue removido de la lista blanca.`
            : `⚠️ *No encontrado:* No se encontró el número \`${target}\` en la lista blanca.`;
          await sock.sendMessage(remoteJid, { text: kickMsg }, { quoted: msg });
          continue;
        }

        if (lowerText.startsWith('stoky newkey ') || lowerText.startsWith('stoky key ')) {
          const rawKey = cleanText.split(/\s+/)[2] || cleanText.split(/\s+/)[1];
          await humanDelay(400, 800);
          await sock.sendMessage(remoteJid, { react: { text: '⏳', key: msg.key } });

          const res = await addDynamicApiKey(rawKey);
          if (res.success) {
            await sock.sendMessage(
              remoteJid,
              { text: `🔑 *Nueva Clave Añadida Exitosamente:*\n\n${res.message}\n\n_La rotación automática ya incluye esta cuenta sin reiniciar el bot._` },
              { quoted: msg }
            );
            await sock.sendMessage(remoteJid, { react: { text: '✅', key: msg.key } });
          } else {
            await sock.sendMessage(
              remoteJid,
              { text: `❌ *Error al agregar clave:*\n${res.message}` },
              { quoted: msg }
            );
            await sock.sendMessage(remoteJid, { react: { text: '❌', key: msg.key } });
          }
          continue;
        }

        if (lowerText === 'stoky historia' || lowerText === 'stoky history') {
          await humanDelay(400, 800);
          const history = stateService.getHistorySummary();

          let userDetails = '';
          if (history.users.length === 0) {
            userDetails = '_Aún no hay usuarios registrados en el historial._\n';
          } else {
            history.users.slice(0, 10).forEach((u, i) => {
              userDetails += `  ${i + 1}. +${u.phone}: *${u.count}* stickers (${u.heavyCount} pesados)\n`;
            });
          }

          let heavyDetails = '';
          if (history.heavyStickers.length === 0) {
            heavyDetails = '_Ningún sticker ha consumido más de 1 petición._\n';
          } else {
            history.heavyStickers.slice(-5).forEach((h) => {
              heavyDetails += `  • +${h.requester}: Consumió *${h.pagesUsed} páginas* (CID: ${h.cid || 'N/A'})\n    🔗 ${h.url.slice(0, 45)}...\n`;
            });
          }

          const historyMsg =
            `📊 *Historial de Consumo y Auditoría de Stoky:*\n\n` +
            `• 📦 *Total de stickers creados:* ${history.totalStickers}\n` +
            `• 👥 *Usuarios únicos:* ${history.totalUsers}\n\n` +
            `*Top Usuarios:*\n${userDetails}\n` +
            `*Auditoría de Stickers Pesados (>1 petición):*\n${heavyDetails}`;

          await sock.sendMessage(remoteJid, { text: historyMsg }, { quoted: msg });
          continue;
        }
      }

      // 4.3 Comandos de Catálogo y Pedido de Stickers
      if (lowerText === 'stoky catalogo' || lowerText === 'catalogo' || lowerText === 'stoky catálogo') {
        await humanDelay(400, 800);
        await sock.readMessages([msg.key]);

        const catalogItems = catalogService.getAllItems();
        const total = catalogItems.length;

        const catalogMsg =
          `📖 *Catálogo Web de Stickers Stoky:*\n\n` +
          `Puedes ver todos los stickers con vista previa animada y agregarlos a tu carrito en:\n` +
          `🌐 *https://portafoliowebdylan.vercel.app/lab/stoky-catalogo*\n\n` +
          `• 📦 *Stickers disponibles:* ${total}\n\n` +
          `*¿Cómo pedir?*\n` +
          `1. Entra a la web, agrega los stickers que te gusten a tu carrito y presiona *"Pedir Carrito a Stoky"*.\n` +
          `2. O pide cualquiera directamente aquí escribiendo:\n` +
          `   👉 *sticker A1* (para uno solo)\n` +
          `   👉 *stickers A1 B3 C2* (para pedir varios juntos)\n\n` +
          `_✨ ¡Pedir stickers del catálogo gasta 0 peticiones de API!_`;

        await sock.sendMessage(remoteJid, { text: catalogMsg }, { quoted: msg });
        continue;
      }

      // 4.4 Pedido individual: "sticker <código>"
      if (lowerText.startsWith('sticker ') && !lowerText.startsWith('stickers ')) {
        const code = cleanText.split(/\s+/)[1];
        const item = catalogService.getByCode(code);

        await humanDelay(400, 800);
        await sock.readMessages([msg.key]);

        if (item && item.buffer) {
          await sock.sendMessage(remoteJid, { react: { text: '⏳', key: msg.key } });
          await sock.sendMessage(remoteJid, { sticker: item.buffer }, { quoted: msg });
          await sock.sendMessage(remoteJid, { react: { text: '✅', key: msg.key } });
          stateService.recordStickerUsage(remoteJid, `catalog://${item.code}`, 0, item.cid);
          logConsole(`[Stoky] ✅ Sticker individual ${item.code} entregado desde catálogo.`);
        } else {
          await sock.sendMessage(
            remoteJid,
            { text: `⚠️ *Stoky:* No encontré el sticker con código *${code?.toUpperCase()}* en el catálogo. Escribe *stoky catalogo* para ver los disponibles.` },
            { quoted: msg }
          );
        }
        continue;
      }

      // 4.5 Pedido en lote / Carrito: "stickers <cod1> <cod2> ..."
      if (lowerText.startsWith('stickers ') || lowerText.startsWith('carrito ')) {
        const rawCodes = cleanText.split(/\s+/).slice(1);
        const uniqueCodes = [...new Set(rawCodes.map(c => c.trim().toUpperCase()))].filter(Boolean);

        await humanDelay(400, 800);
        await sock.readMessages([msg.key]);

        if (uniqueCodes.length === 0) {
          await sock.sendMessage(
            remoteJid,
            { text: '⚠️ *Stoky:* Debes indicar los códigos que quieres recibir. Ejemplo: *stickers A1 B2 C3*' },
            { quoted: msg }
          );
          continue;
        }

        // Limitar lote a máximo 10 stickers por mensaje para evitar bloqueos
        const batchCodes = uniqueCodes.slice(0, 10);
        await sock.sendMessage(remoteJid, { react: { text: '⏳', key: msg.key } });

        let sentCount = 0;
        for (const code of batchCodes) {
          const item = catalogService.getByCode(code);
          if (item && item.buffer) {
            await sock.sendMessage(remoteJid, { sticker: item.buffer });
            sentCount++;
            stateService.recordStickerUsage(remoteJid, `catalog://${item.code}`, 0, item.cid);
            // Delay de 1.2 a 1.8 segundos entre cada sticker del lote
            await humanDelay(1200, 1800);
          }
        }

        if (sentCount > 0) {
          await sock.sendMessage(remoteJid, { react: { text: '✅', key: msg.key } });
          logConsole(`[Stoky] ✅ Lote de ${sentCount} stickers entregado a ${remoteJid}`);
        } else {
          await sock.sendMessage(
            remoteJid,
            { text: '⚠️ *Stoky:* Ninguno de los códigos solicitados fue encontrado en el catálogo. Escribe *stoky catalogo* para ver los disponibles.' },
            { quoted: msg }
          );
          await sock.sendMessage(remoteJid, { react: { text: '❌', key: msg.key } });
        }
        continue;
      }

      // 4. Manejo de Comandos
      if (cleanText === 'iniciar-bot' || cleanText === 'stoky on' || cleanText === '!stoky on') {
        activeChats.add(remoteJid);
        await humanDelay(500, 1000);
        await sock.readMessages([msg.key]);
        await sock.sendMessage(
          remoteJid,
          {
            text: '🟢 *¡Hola! Soy Stoky.*\nHe activado el modo de stickers para ti.\n\nEnvíame cualquier enlace de comentario de TikTok (con foto o sticker) y te lo convertiré en sticker de WhatsApp.\n\n_Para pausar cuando quieras, escribe: *pausar-bot*_'
          },
          { quoted: msg }
        );
        continue;
      }

      if (cleanText === 'pausar-bot' || cleanText === 'stoky off' || cleanText === '!stoky off') {
        activeChats.delete(remoteJid);
        await humanDelay(500, 1000);
        await sock.readMessages([msg.key]);
        await sock.sendMessage(
          remoteJid,
          { text: '🔴 *Stoky pausado.* Ya no procesaré enlaces en este chat hasta que envíes *iniciar-bot*.' },
          { quoted: msg }
        );
        continue;
      }

      if (cleanText === 'stoky estado' || cleanText === 'stoky status' || cleanText === 'stoky') {
        await humanDelay(400, 800);
        await sock.readMessages([msg.key]);
        const isCurrentActive = isFromMe || activeChats.has(remoteJid);
        const statusMsg = isCurrentActive
          ? '🟢 *Stoky está ACTIVO para ti.* Mándame enlaces de comentarios de TikTok.\n\n• Para pausarme: *pausar-bot*\n• Para ver tu cuota: *stoky-quota*'
          : '🔴 *Stoky está en REPOSO.* Escribe *iniciar-bot* para comenzar a crear stickers.\n\n• Para ver tu cuota: *stoky-quota*';
        await sock.sendMessage(remoteJid, { text: statusMsg }, { quoted: msg });
        continue;
      }

      // Comando de consulta de cuota restante de RapidAPI
      if (
        cleanText === 'stoky-quota' ||
        cleanText === 'stoky quota' ||
        cleanText === 'cuota' ||
        cleanText === 'stoky cuota' ||
        cleanText === '!quota'
      ) {
        await humanDelay(400, 800);
        await sock.readMessages([msg.key]);

        const quota = await getQuotaStatus(false);
        const statusIcon = quota.isExceeded ? '🔴 Cuotas Agotadas' : '🟢 Activo y Listo';

        let keysDetail = '';
        quota.keys.forEach((k) => {
          const statusTag = k.isActive
            ? '⚡ *Activa*'
            : k.isExhausted
            ? '❌ *Agotada*'
            : '⏳ *En espera*';
          keysDetail += `  • Cuenta #${k.index} (${k.masked}): ${k.remaining}/${k.limit} [${statusTag}]\n`;
        });

        const quotaMsg =
          `📊 *Estado de Cuota de Stoky (Multi-Cuenta):*\n\n` +
          `• 🎟️ *Total disponible:* ${quota.totalRemaining} stickers de ${quota.totalLimit}\n` +
          `• 🔄 *Cuentas conectadas:* ${quota.totalKeys} cuentas en rotación automática\n` +
          `• 📈 *Estado:* ${statusIcon}\n\n` +
          `*Detalle por cuenta:*\n${keysDetail}\n` +
          `_💡 Cuando la cuenta activa agote sus peticiones, Stoky cambiará a la siguiente automáticamente sin interrumpir tus stickers._`;

        await sock.sendMessage(remoteJid, { text: quotaMsg }, { quoted: msg });
        continue;
      }

      // 5. Buscar enlaces de TikTok (soporta tiktok.com, vt.tiktok.com, vm.tiktok.com, etc.)
      const tiktokRegex = /https?:\/\/(?:[a-zA-Z0-9-]+\.)?tiktok\.com\/[^\s]+/gi;
      const rawUrls = body.match(tiktokRegex) || [];
      const urlsFound = rawUrls
        .map((u) => u.replace(/[.,;!?)"'>]+$/, '').trim())
        .filter(Boolean);

      if (urlsFound.length > 0) {
        logConsole(`[Stoky] Enlace de TikTok detectado de ${remoteJid}:`, urlsFound);
        // Si el usuario envió un enlace de TikTok, activamos automáticamente el chat
        activeChats.add(remoteJid);

        for (const tiktokUrl of urlsFound) {
          messageQueue.enqueue(() => handleTikTokMessage(sock, msg, tiktokUrl, remoteJid));
        }
        continue;
      }

      // 7. Encolar las peticiones en la cola secuencial con rate limiting / cooldown
      for (const tiktokUrl of urlsFound) {
        messageQueue.enqueue(() => handleTikTokMessage(sock, msg, tiktokUrl, remoteJid));
      }
    }
  });
}

// Iniciar bot
startBot().catch((err) => {
  logger.fatal({ err }, 'Error crítico fatal al iniciar el bot Stoky');
  process.exit(1);
});
