import { normalizeAnimatedWebp } from './animatedWebpService.js';
import fs from 'fs';
import path from 'path';
import os from 'os';
import axios from 'axios';
import ffmpeg from 'fluent-ffmpeg';
import webpmux from 'node-webpmux';
import { STICKER_PACK, STICKER_AUTHOR, STICKER_QUALITY } from '../config.js';
import { logger } from '../utils/logger.js';
import { trace } from '../utils/tiktokTrace.js';

// Configurar binario de FFmpeg según plataforma (Windows / Linux / Android Termux)
const ffmpegReady = (async () => {
  if (process.env.FFMPEG_PATH) { ffmpeg.setFfmpegPath(process.env.FFMPEG_PATH); return; }
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
    const isAnim = buf.length >= 30 && buf.toString('ascii', 12, 16) === 'VP8X' && Boolean(buf[20] & 2);
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
  if (webpBuffer.length < 30 || webpBuffer.toString('ascii', 0, 4) !== 'RIFF' || webpBuffer.toString('ascii', 8, 12) !== 'WEBP') throw new Error('WebP invalido');
  const chunks = [];
  let extended = false;
  for (let offset = 12; offset < webpBuffer.length;) {
    if (offset + 8 > webpBuffer.length) throw new Error('WebP truncado');
    const length = webpBuffer.readUInt32LE(offset + 4);
    const end = offset + 8 + length + (length % 2);
    if (end > webpBuffer.length) throw new Error('WebP truncado');
    const tag = webpBuffer.toString('ascii', offset, offset + 4);
    const chunk = Buffer.from(webpBuffer.subarray(offset, end));
    if (tag === 'VP8X') {
      if (length !== 10) throw new Error('Cabecera VP8X invalida');
      chunk[8] |= 0x08; // EXIF only: never invent alpha or alter animation flags.
      extended = true;
    }
    // A sticker has a transparent canvas. White ANIM backgrounds create patches
    // when a partial frame is disposed to the background in desktop decoders.
    if (tag === 'ANIM' && length >= 6) chunk.fill(0, 8, 12);
    if (tag !== 'EXIF') chunks.push(chunk);
    offset = end;
  }
  if (!extended) throw new Error('Animacion sin VP8X');
  const payload = buildExifPayload(metadata);
  const exif = Buffer.alloc(8 + payload.length + payload.length % 2);
  exif.write('EXIF'); exif.writeUInt32LE(payload.length, 4); payload.copy(exif, 8);
  const result = Buffer.concat([webpBuffer.subarray(0, 12), ...chunks, exif]);
  result.writeUInt32LE(result.length - 8, 4);
  return result;
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

  return saved;
}

/**
 * Convierte un video o GIF directamente a WebP animado de 512x512 con transparencia real y 15 FPS usando FFmpeg nativo.
 */
async function withConversionFiles(buffer, ext, task) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new Error('Archivo multimedia vacio o invalido');
  if (!['png', 'jpg', 'webp', 'mp4', 'gif', 'webm'].includes(ext)) throw new Error('Extension multimedia no permitida');
  await ffmpegReady;
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'stoky-convert-'));
  const inputPath = path.join(directory, 'input.' + ext);
  const outputPath = path.join(directory, 'output.webp');
  try {
    await fs.promises.writeFile(inputPath, buffer);
    return await task(inputPath, outputPath);
  } finally {
    // Remove only the fixed filenames we created, without recursive directory deletion.
    await Promise.all([inputPath, outputPath].map(file => fs.promises.unlink(file).catch(() => {})));
    await fs.promises.rmdir(directory).catch(() => {});
  }
}

function runFfmpeg(inputPath, outputPath, outputOptions, inputOptions = []) {
  if (path.resolve(inputPath).toLowerCase() === path.resolve(outputPath).toLowerCase()) throw new Error('Entrada y salida de FFmpeg deben ser diferentes');
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath, { timeout: 60 })
      .inputOptions(inputOptions)
      .outputOptions(outputOptions)
      .toFormat('webp')
      .on('start', command => trace('conversion.ffmpeg.start', { inputPath, outputPath, command }))
      .on('end', resolve)
      .on('error', (error, stdout, stderr) => {
        trace('conversion.ffmpeg.error', { message: error.message, stderr });
        reject(error);
      })
      .save(outputPath);
  }).then(() => fs.promises.readFile(outputPath));
}

export async function convertAnimatedToWebp(inputBuffer, ext = 'mp4', quality = 55) {
  return withConversionFiles(inputBuffer, ext, async (inputPath, outputPath) => {
    const encode = (q, duration) => runFfmpeg(inputPath, outputPath, [
      '-vcodec', 'libwebp',
      '-vf', 'fps=15,format=rgba,scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(512-iw)/2:(512-ih)/2:color=0x00000000',
      '-lossless', '0', '-q:v', String(q), '-preset', 'default', '-loop', '0', '-an', '-vsync', '0'
    ], ['-t', String(duration)]);
    let result = await encode(quality, 6);
    if (result.length > 480 * 1024) {
      trace('conversion.compress', { bytes: result.length, duration: 4 });
      result = await encode(Math.max(25, quality - 15), 4);
    }
    if (result.length > 480 * 1024) throw new Error('La animacion supera el tamano permitido tras comprimir');
    return result;
  });
}

export async function convertStaticToWebp(inputBuffer, ext = 'png', quality = 75) {
  return withConversionFiles(inputBuffer, ext, (inputPath, outputPath) => runFfmpeg(inputPath, outputPath, [
    '-vframes', '1',
    '-vf', 'format=rgba,scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(512-iw)/2:(512-ih)/2:color=0x00000000',
    '-vcodec', 'libwebp', '-lossless', '0', '-q:v', String(quality), '-preset', 'default'
  ]));
}

export async function downloadMediaBuffer(url) {
  try {
    trace('media.download.start', { url });
    const response = await axios.get(url, {
      responseType: 'arraybuffer',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
        'Referer': 'https://www.tiktok.com/',
        'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8'
      },
      maxContentLength: 20 * 1024 * 1024,
      timeout: 25000
    });

    const buffer = Buffer.from(response.data);
    if (!buffer.length) throw new Error('El servidor devolvio un archivo vacio');
    trace('media.download.complete', { url, bytes: buffer.length, contentType: response.headers?.['content-type'], detectedType: detectBufferType(buffer) });
    if (process.env.TIKTOK_DEBUG === 'true') {
      try {
        await fs.promises.mkdir('scratch', { recursive: true });
        await fs.promises.writeFile('scratch/last-media-download.bin', buffer);
      } catch (error) { logger.warn({ message: error.message }, 'No se pudo conservar muestra de diagnostico'); }
    }
    return buffer;
  } catch (error) {
    trace('media.download.error', { url, message: error.message, status: error.response?.status });
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
  const candidates = [...new Set((Array.isArray(mediaUrl) ? mediaUrl : [mediaUrl]).filter(url => typeof url === 'string' && url.length))].slice(0, 6);
  if (!candidates.length) throw new Error('No se recibio ninguna URL multimedia');
  let lastError;
  for (const [index, url] of candidates.entries()) {
    try {
      const buffer = await downloadMediaBuffer(url);
      const result = await createStickerFromBuffer(buffer, customOptions);
      trace('media.candidate.success', { candidate: index + 1, candidates: candidates.length });
      return result;
    } catch (error) {
      lastError = error;
      trace('media.candidate.failed', { candidate: index + 1, candidates: candidates.length, url, message: error.message });
    }
  }
  throw lastError;
}

export async function createStickerFromBuffer(buffer, customOptions = {}) {
  try {
    if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('Archivo multimedia vacio o invalido');
    const type = detectBufferType(buffer);
    const rawQuality = Number(customOptions.quality ?? STICKER_QUALITY);
    const quality = Number.isFinite(rawQuality) ? Math.min(100, Math.max(1, rawQuality)) : 75;

    logger.debug({ detectedType: type, size: buffer.length }, 'Procesando sticker con motor FFmpeg nativo');

    if (type === 'video' || type === 'gif') {
      const ext = type === 'gif' ? 'gif' : 'mp4';
      const webp = await convertAnimatedToWebp(buffer, ext, quality);
      return await finalizeSticker(webp, customOptions);
    } else if (type === 'webp_anim') {
      const webp = await normalizeAnimatedWebp(buffer, quality);
      return await finalizeSticker(webp, customOptions);
    } else if (type === "image" || type === "webp_static") {
      const ext = type === "image" ? (buffer[0] === 0xff ? "jpg" : "png") : "webp";
      for (const q of [...new Set([quality, Math.min(quality, 55), Math.min(quality, 35), Math.min(quality, 20)])]) {
        const webp = await convertStaticToWebp(buffer, ext, q);
        const final = await injectExifToStaticWebp(webp, customOptions);
        if (final.length <= 100 * 1024) {
          await validateStickerBuffer(final);
          return final;
        }
        trace('conversion.compress', { type, quality: q, bytes: final.length });
      }
      throw new Error('El sticker estatico supera el tamano permitido tras comprimir');
    }
    throw new Error("Formato multimedia no reconocido");
  } catch (error) {
    logger.error({ error: error.message, stack: error.stack }, 'Error al generar sticker de WhatsApp');
    throw new Error(`Error en el procesamiento del sticker: ${error.message}`);
  }
}

async function finalizeSticker(webp, metadata) {
  // A GIF/video with just one frame can encode as a static WebP.
  const result = detectBufferType(webp) === 'webp_anim'
    ? injectExifToAnimatedWebp(webp, metadata)
    : await injectExifToStaticWebp(webp, metadata);
  await validateStickerBuffer(result);
  return result;
}

export async function validateStickerBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) throw new Error('La conversion no produjo un WebP valido');
  const image = new webpmux.Image();
  await image.load(buffer);
  if (image.width !== 512 || image.height !== 512) throw new Error('El sticker no tiene dimensiones 512x512');
  if (buffer.length > (image.hasAnim ? 500 : 100) * 1024) throw new Error('El sticker supera el tamano permitido');
  if (!image.exif?.length) throw new Error('El sticker no contiene metadatos del paquete');
  trace('conversion.complete', { bytes: buffer.length, width: image.width, height: image.height, animated: image.hasAnim, frames: image.hasAnim ? image.frames.length : 1 });
  return { animated: image.hasAnim, width: image.width, height: image.height, bytes: buffer.length };
}

export function buildStickerMessage(buffer) {
  const type = detectBufferType(buffer);
  if (!Buffer.isBuffer(buffer) || !['webp_static', 'webp_anim'].includes(type)) {
    throw new Error('No se puede enviar un sticker sin un archivo WebP valido');
  }
  return { sticker: buffer, mimetype: 'image/webp', isAnimated: type === 'webp_anim' };
}
