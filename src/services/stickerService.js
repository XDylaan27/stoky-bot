import fs from 'fs';
import axios from 'axios';
import { Sticker, StickerTypes } from 'wa-sticker-formatter';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import ffmpeg from 'fluent-ffmpeg';
import { STICKER_PACK, STICKER_AUTHOR, STICKER_TYPE, STICKER_QUALITY } from '../config.js';
import { logger } from '../utils/logger.js';

// Configurar ruta del binario de FFmpeg (compatible con Windows, Linux y Android/Termux)
try {
  if (ffmpegInstaller?.path && fs.existsSync(ffmpegInstaller.path)) {
    process.env.FFMPEG_PATH = ffmpegInstaller.path;
    ffmpeg.setFfmpegPath(ffmpegInstaller.path);
    logger.debug({ ffmpegPath: ffmpegInstaller.path }, 'FFmpeg configurado desde instalador');
  } else {
    logger.debug('Usando FFmpeg nativo del sistema (PATH)');
  }
} catch (_) {
  logger.debug('Usando FFmpeg nativo del sistema por fallback');
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
  logger.info({ mediaUrl }, 'Iniciando descarga y conversión a sticker...');
  const mediaBuffer = await downloadMediaBuffer(mediaUrl);

  const options = {
    pack: customOptions.pack || STICKER_PACK,
    author: customOptions.author || STICKER_AUTHOR,
    type: customOptions.type || STICKER_TYPE,
    quality: customOptions.quality || STICKER_QUALITY,
    background: '#00000000' // Fondo transparente
  };

  try {
    const sticker = new Sticker(mediaBuffer, options);
    const stickerBuffer = await sticker.toBuffer();
    logger.info({ bytes: stickerBuffer.length }, 'Sticker generado con éxito');
    return stickerBuffer;
  } catch (error) {
    logger.error({ error: error.message }, 'Error al formatear el sticker');
    throw new Error(`Error en wa-sticker-formatter: ${error.message}`);
  }
}
