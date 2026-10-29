import fs from 'fs';
import path from 'path';
import os from 'os';
import axios from 'axios';
import { Sticker, StickerTypes } from 'wa-sticker-formatter';
import ffmpeg from 'fluent-ffmpeg';
import { STICKER_PACK, STICKER_AUTHOR, STICKER_TYPE, STICKER_QUALITY } from '../config.js';
import { logger } from '../utils/logger.js';

// Configurar ruta del binario de FFmpeg (compatible con Windows, Linux y Android/Termux)
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
    // Fallback a FFmpeg nativo
  }
  logger.debug('Usando FFmpeg nativo del sistema (PATH)');
})();

/**
 * Detecta si un buffer corresponde a un archivo de video (MP4, WebM, AVI).
 * @param {Buffer} buf 
 * @returns {boolean}
 */
function isVideoBuffer(buf) {
  if (!buf || buf.length < 12) return false;
  // MP4 (caja ftyp)
  if (buf.toString('ascii', 4, 8) === 'ftyp') return true;
  // WebM / Matroska (\x1A\x45\xDF\xA3)
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return true;
  // AVI
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'AVI ') return true;
  return false;
}

/**
 * Convierte un video directamente a WebP animado de 512x512 con transparencia real.
 * Evita la conversión intermedia a GIF de 256 colores que rompe los negros y genera
 * bloques blancos y ruido magenta en WhatsApp Web y navegadores basados en Chromium.
 * @param {Buffer} inputBuffer 
 * @param {number} quality 
 * @returns {Promise<Buffer>}
 */
async function convertVideoToWebp(inputBuffer, quality = 65) {
  const tmpDir = os.tmpdir();
  const id = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const inputPath = path.join(tmpDir, `stk_${id}.mp4`);
  const outputPath = path.join(tmpDir, `stk_${id}.webp`);

  fs.writeFileSync(inputPath, inputBuffer);

  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .outputOptions([
        '-vcodec', 'libwebp',
        '-vf', 'scale=512:512:force_original_aspect_ratio=decrease,format=rgba,pad=512:512:(512-iw)/2:(512-ih)/2:color=#00000000,fps=15',
        '-loop', '0',
        '-lossless', '0',
        '-qscale', String(Math.max(40, Math.min(80, quality))),
        '-preset', 'default',
        '-an',
        '-vsync', '0'
      ])
      .toFormat('webp')
      .save(outputPath)
      .on('end', () => {
        try {
          const res = fs.readFileSync(outputPath);
          try { fs.unlinkSync(inputPath); } catch (_) {}
          try { fs.unlinkSync(outputPath); } catch (_) {}
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
 * Convierte una imagen o sticker (estático o animado) a formato WebP compatible con WhatsApp (512x512).
 * @param {string} mediaUrl 
 * @param {object} [customOptions] 
 * @returns {Promise<Buffer>} Buffer del sticker WebP final
 */
export async function createStickerFromUrl(mediaUrl, customOptions = {}) {
  try {
    let buffer = await downloadMediaBuffer(mediaUrl);

    const type = customOptions.type || (STICKER_TYPE === 'cropped' ? StickerTypes.CROPPED : StickerTypes.FULL);
    const quality = customOptions.quality || STICKER_QUALITY || 70;

    // Si es un archivo de video, convertirlo con FFmpeg directamente a WebP
    // para preservar colores puros de 24 bits y evitar corrupción de alpha
    if (isVideoBuffer(buffer)) {
      try {
        buffer = await convertVideoToWebp(buffer, quality);
      } catch (err) {
        logger.warn({ err: err.message }, 'Fallo conversión directa a WebP con FFmpeg, usando fallback');
      }
    }

    const sticker = new Sticker(buffer, {
      pack: customOptions.pack || STICKER_PACK || 'Stoky Stickers',
      author: customOptions.author || STICKER_AUTHOR || 'Stoky Bot',
      type: type,
      quality: quality,
      categories: ['✨', '🤖']
    });

    return await sticker.toBuffer();
  } catch (error) {
    logger.error({ error: error.message, mediaUrl }, 'Error al convertir recurso a WebP');
    throw new Error(`Error en el procesamiento del sticker: ${error.message}`);
  }
}
