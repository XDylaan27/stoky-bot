import fs from 'fs';
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
    const buffer = await downloadMediaBuffer(mediaUrl);

    const type = customOptions.type || (STICKER_TYPE === 'cropped' ? StickerTypes.CROPPED : StickerTypes.FULL);
    const quality = customOptions.quality || STICKER_QUALITY || 75;

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
