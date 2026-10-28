import dotenv from 'dotenv';
import { StickerTypes } from 'wa-sticker-formatter';

dotenv.config();

/**
 * Normaliza un JID de WhatsApp.
 */
function normalizeJid(rawJid) {
  if (!rawJid) return '';
  const cleaned = rawJid.trim().replace(/[\s+\-()]/g, '');
  if (!cleaned) return '';
  if (!cleaned.includes('@')) {
    return `${cleaned}@s.whatsapp.net`;
  }
  return cleaned;
}

/**
 * Parsea una lista de números permitidos separados por comas.
 * Si no hay números o se deja vacío, activa el MODO PÚBLICO (abierto para amigos mediante "iniciar-bot").
 */
const rawAllowed = process.env.ALLOWED_JID || '';
export const ALLOWED_JIDS = rawAllowed
  .split(',')
  .map((s) => normalizeJid(s))
  .filter(Boolean);

// Si no se define ningún número específico, el bot permite a cualquiera que use el comando "iniciar-bot"
export const PUBLIC_MODE = ALLOWED_JIDS.length === 0;

// Lista de llaves de RapidAPI (para rotación automática y failover)
const rawKeys = process.env.RAPIDAPI_KEYS || process.env.RAPIDAPI_KEY || '';
export const RAPIDAPI_KEYS = rawKeys
  .split(',')
  .map((k) => k.trim())
  .filter(Boolean);

export const RAPIDAPI_KEY = RAPIDAPI_KEYS[0] || '';
export const RAPIDAPI_HOST = process.env.RAPIDAPI_HOST || 'scraptik.p.rapidapi.com';
export const RAPIDAPI_ENDPOINT =
  process.env.RAPIDAPI_ENDPOINT ||
  (RAPIDAPI_HOST.includes('scraptik')
    ? `https://${RAPIDAPI_HOST}/list-comments`
    : `https://${RAPIDAPI_HOST}/comment/list`);

export const STICKER_PACK = process.env.STICKER_PACK || 'Stoky Stickers';
export const STICKER_AUTHOR = process.env.STICKER_AUTHOR || 'Stoky Bot';
export const STICKER_QUALITY = parseInt(process.env.STICKER_QUALITY, 10) || 75;

// Mapeo de tipos de sticker para wa-sticker-formatter
const typeMapping = {
  full: StickerTypes.FULL,
  cropped: StickerTypes.CROPPED,
  circle: StickerTypes.CIRCLE,
  rounded: StickerTypes.ROUNDED
};

const configuredType = (process.env.STICKER_TYPE || 'full').toLowerCase();
export const STICKER_TYPE = typeMapping[configuredType] || StickerTypes.FULL;

export const COOLDOWN_MS = (parseInt(process.env.COOLDOWN_SECONDS, 10) || 5) * 1000;

export const LOG_LEVEL = process.env.LOG_LEVEL || 'info';

/**
 * Valida la presencia de las configuraciones críticas.
 */
export function validateConfig() {
  const missing = [];
  if (RAPIDAPI_KEYS.length === 0) {
    missing.push('RAPIDAPI_KEYS o RAPIDAPI_KEY (Tu clave o claves de RapidAPI)');
  }
  return {
    isValid: missing.length === 0,
    missing
  };
}
