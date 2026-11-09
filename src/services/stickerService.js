import fs from 'fs';
import path from 'path';
import os from 'os';
import axios from 'axios';
import ffmpeg from 'fluent-ffmpeg';
import webpmux from 'node-webpmux';
import { STICKER_PACK, STICKER_AUTHOR, STICKER_QUALITY } from '../config.js';
import { logger } from '../utils/logger.js';

// Configurar binario de FFmpeg según plataforma (Windows / Linux / Android Termux)
(async () => {
  try {
    if (process.platform !== 'android') {
      const ffmpegInstaller = (await import('@ffmpeg-installer/ffmpeg')).default;
      if (ffmpegInstaller?.path && fs.existsSync(ffmpegInstaller.path)) {
        process.env.FFMPEG_PATH = ffmpegInstaller.path;
        ffmpeg.setFfmpegPath(ffmpegInstaller.path);
        logger.debug({ ffmpegPath: ffmpegInstaller.path }, 'FFmpeg configurado desde instalador');
        return;
      }
    }
  } catch (_) {
    // Fallback a FFmpeg del PATH del sistema
  }
  logger.debug('Usando FFmpeg nativo del sistema (PATH)');
})();

/**
 * Detecta el formato binario del archivo descargado.
 * @param {Buffer} buf 
 * @returns {'video' | 'gif' | 'webp_anim' | 'webp_static' | 'image' | 'unknown'}
 */
export function detectBufferType(buf) {
  if (!buf || buf.length < 12) return 'unknown';
  // MP4 / MOV (caja ftyp)
  if (buf.toString('ascii', 4, 8) === 'ftyp') return 'video';
  // WebM / Matroska (\x1A\x45\xDF\xA3)
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return 'video';
  // GIF (GIF87a / GIF89a)
  if (buf.toString('ascii', 0, 3) === 'GIF') return 'gif';
  // WebP (RIFF .... WEBP)
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const isAnim = Boolean(buf.readUInt32LE(20) & 2);
    return isAnim ? 'webp_anim' : 'webp_static';
  }
  // JPEG / PNG
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image';
  if (buf[0] === 0x89 && buf.toString('ascii', 1, 4) === 'PNG') return 'image';
  return 'unknown';
}

/**
 * Genera el payload binario EXIF requerido por WhatsApp para identificar el paquete de stickers.
 */
function buildExifPayload(metadata = {}) {
  const pack = metadata.pack || STICKER_PACK || 'Stoky Stickers';
  const author = metadata.author || STICKER_AUTHOR || 'Stoky Bot';
  const data = JSON.stringify({
    'sticker-pack-id': 'stoky-bot',
    'sticker-pack-name': pack,
    'sticker-pack-publisher': author,
    'emojis': metadata.categories || ['✨', '🤖']
  });
  const dataBuf = Buffer.from(data, 'utf-8');
  const exifHeader = Buffer.from([
    0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00,
    0x01, 0x00, 0x41, 0x57, 0x07, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x16, 0x00, 0x00, 0x00
  ]);
  exifHeader.writeUIntLE(dataBuf.length, 14, 4);
  return Buffer.concat([exifHeader, dataBuf]);
}

/**
 * Inyecta metadatos EXIF en un WebP animado preservando y forzando hasAlpha = 1 (bit 4).
 * Corrige el bug crítico donde Chromium/WhatsApp Web asume fondo opaco y dibuja bloques blancos.
 */
export function injectExifToAnimatedWebp(webpBuffer, metadata = {}) {
  const exifPayload = buildExifPayload(metadata);
  const exifChunkHeader = Buffer.from('EXIF');
  const exifChunkLen = Buffer.alloc(4);
  exifChunkLen.writeUInt32LE(exifPayload.length, 0);
  const padByte = (exifPayload.length % 2 === 1) ? Buffer.from([0x00]) : Buffer.alloc(0);
  const fullExifChunk = Buffer.concat([exifChunkHeader, exifChunkLen, exifPayload, padByte]);

  const newBuffer = Buffer.from(webpBuffer);

  if (newBuffer.toString('ascii', 12, 16) === 'VP8X') {
    let flags = newBuffer.readUInt32LE(20);
    flags = (flags | 0x08 | 0x10) >>> 0; // bit 3 = EXIF, bit 4 = Alpha transparente
    newBuffer.writeUInt32LE(flags, 20);
  }

  const finalBuffer = Buffer.concat([newBuffer, fullExifChunk]);
  finalBuffer.writeUInt32LE(finalBuffer.length - 8, 4); // Actualizar tamaño total en header RIFF
  return finalBuffer;
}

/**
 * Inyecta metadatos EXIF en un WebP estático asegurando soporte de alpha y metadatos limpios.
 */
export async function injectExifToStaticWebp(webpBuffer, metadata = {}) {
  const exifPayload = buildExifPayload(metadata);
  const img = new webpmux.Image();
  await img.load(webpBuffer);
  img.exif = exifPayload;
  const saved = await img.save(null);

  if (saved.toString('ascii', 12, 16) === 'VP8X') {
    const buf = Buffer.from(saved);
    let flags = buf.readUInt32LE(20);
    flags = (flags | 0x10) >>> 0;
    buf.writeUInt32LE(flags, 20);
    return buf;
  }
  return saved;
}

/**
 * Convierte un video o GIF directamente a WebP animado de 512x512 con transparencia real y 15 FPS usando FFmpeg nativo.
 */
export async function convertAnimatedToWebp(inputBuffer, ext = 'mp4', quality = 55) {
  const tmpDir = os.tmpdir();
  const id = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const inputPath = path.join(tmpDir, `input_${id}.${ext}`);
  const outputPath = path.join(tmpDir, `output_${id}.webp`);

  fs.writeFileSync(inputPath, inputBuffer);

  const runFfmpeg = (q, maxDuration = 6) =>
    new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .inputOptions(['-t', String(maxDuration)])
        .outputOptions([
          '-vcodec', 'libwebp',
          '-vf', 'fps=15,scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(512-iw)/2:(512-ih)/2:color=0x00000000',
          '-lossless', '0',
          '-q:v', String(q),
          '-preset', 'default',
          '-loop', '0',
          '-an',
          '-vsync', '0'
        ])
        .toFormat('webp')
        .save(outputPath)
        .on('end', () => {
          try {
            const res = fs.readFileSync(outputPath);
            resolve(res);
          } catch (e) {
            reject(e);
          }
        })
        .on('error', reject);
    });

  try {
    let result = await runFfmpeg(quality, 6);
    // Límite estricto de WhatsApp para stickers animados: 500 KB (512,000 bytes)
    if (result.length > 480 * 1024) {
      logger.info({ size: result.length }, 'Sticker > 480KB, optimizando compresión a 4 segundos...');
      result = await runFfmpeg(Math.max(35, quality - 15), 4);
    }
    return result;
  } finally {
    try { if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath); } catch (_) {}
    try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch (_) {}
  }
}

/**
 * Convierte una imagen estática a WebP 512x512 con fondo transparente usando FFmpeg nativo (sin dependencias binarias externas como sharp).
 */
export async function convertStaticToWebp(inputBuffer, ext = 'png', quality = 75) {
  const tmpDir = os.tmpdir();
  const id = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const inputPath = path.join(tmpDir, `static_${id}.${ext}`);
  const outputPath = path.join(tmpDir, `static_${id}.webp`);

  fs.writeFileSync(inputPath, inputBuffer);

  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .outputOptions([
        '-vframes', '1',
        '-vf', 'scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(512-iw)/2:(512-ih)/2:color=0x00000000',
        '-vcodec', 'libwebp',
        '-lossless', '0',
        '-q:v', String(quality),
        '-preset', 'default'
      ])
      .toFormat('webp')
      .save(outputPath)
      .on('end', () => {
        try {
          const res = fs.readFileSync(outputPath);
          try { if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath); } catch (_) {}
          try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch (_) {}
          resolve(res);
        } catch (e) {
          reject(e);
        }
      })
      .on('error', (err) => {
        try { if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath); } catch (_) {}
        try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch (_) {}
        reject(err);
      });
  });
}

/**
 * Descarga el archivo multimedia desde una URL y lo retorna en un Buffer binario.
 * @param {string} url 
 * @returns {Promise<Buffer>}
 */
export async function downloadMediaBuffer(url) {
  try {
    const response = await axios.get(url, {
      responseType: 'arraybuffer',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
        'Referer': 'https://www.tiktok.com/',
        'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8'
      },
      timeout: 25000
    });

    return Buffer.from(response.data);
  } catch (error) {
    logger.error({ error: error.message, url }, 'Error al descargar imagen o sticker de TikTok');
    throw new Error(`No se pudo descargar el archivo multimedia: ${error.message}`);
  }
}

/**
 * Convierte cualquier recurso (video, gif, webp animado o foto) a un sticker WebP de WhatsApp perfecto (512x512).
 * 100% compatible con Android Termux sin requerir sharp ni dependencias nativas complejas.
 * @param {string} mediaUrl 
 * @param {object} [customOptions] 
 * @returns {Promise<Buffer>} Buffer del sticker WebP final con EXIF y transparencia impecable
 */
export async function createStickerFromUrl(mediaUrl, customOptions = {}) {
  try {
    const buffer = await downloadMediaBuffer(mediaUrl);
    const type = detectBufferType(buffer);
    const quality = customOptions.quality || STICKER_QUALITY || 55;

    logger.info({ mediaUrl: mediaUrl.slice(0, 80), detectedType: type, size: buffer.length }, 'Procesando sticker con motor FFmpeg nativo');

    if (type === 'video' || type === 'gif') {
      const ext = type === 'gif' ? 'gif' : 'mp4';
      const webp = await convertAnimatedToWebp(buffer, ext, quality);
      return injectExifToAnimatedWebp(webp, customOptions);
    } else if (type === 'webp_anim') {
      let webp = buffer;
      // Si el WebP animado original excede el límite de WhatsApp de 500 KB, re-comprimirlo
      if (buffer.length > 480 * 1024) {
        webp = await convertAnimatedToWebp(buffer, 'webp', 45);
      }
      return injectExifToAnimatedWebp(webp, customOptions);
    } else {
      // Estático (PNG, JPG, WebP estático)
      const ext = type === 'image' ? (buffer[0] === 0xff ? 'jpg' : 'png') : 'webp';
      const webp = await convertStaticToWebp(buffer, ext, 75);
      return await injectExifToStaticWebp(webp, customOptions);
    }
  } catch (error) {
    logger.error({ error: error.message, mediaUrl }, 'Error al generar sticker de WhatsApp');
    throw new Error(`Error en el procesamiento del sticker: ${error.message}`);
  }
}
