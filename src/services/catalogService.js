import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import axios from 'axios';

const DATA_DIR = path.resolve(process.env.STOKY_DATA_DIR || 'data');
const CACHE_DIR = path.join(DATA_DIR, 'stickers_cache');
const CATALOG_INDEX = path.join(DATA_DIR, 'catalog.json');
const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const validCode = code => typeof code === 'string' && /^[A-Z]+(?:[1-9]|10)$/.test(code);
export const compareCatalogCodes = (a, b) => {
  const prefix = code => code.match(/^[A-Z]+/)?.[0] || '';
  const left = prefix(a.code), right = prefix(b.code);
  return left.length - right.length || left.localeCompare(right, 'en') || a.code.localeCompare(b.code, 'en', { numeric: true });
};

function settings() {
  const url = process.env.SUPABASE_URL || '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || '';
  return { url, headers: { apikey: key, Authorization: `Bearer ${key}` }, enabled: Boolean(url && key) };
}

class CatalogService {
  constructor() {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    this.catalog = this.loadCatalog();
    this.remoteRows = [];
    this.syncTimer = setInterval(() => this.retrySync().catch(error => console.warn('[SupabaseSync]', error.message)), 60000);
    this.syncTimer.unref();
  }

  loadCatalog() {
    if (!fs.existsSync(CATALOG_INDEX)) return { nextId: 1, items: [] };
    try {
      const catalog = JSON.parse(fs.readFileSync(CATALOG_INDEX, 'utf8'));
      if (!Array.isArray(catalog.items) || !Number.isInteger(catalog.nextId) || catalog.nextId < 1) throw new Error('Indice invalido');
      return catalog;
    } catch (error) { throw new Error('Catalogo corrupto: restaura una copia antes de iniciar. ' + error.message); }
  }

  saveCatalog() {
    this.catalog.items.sort(compareCatalogCodes);
    fs.writeFileSync(CATALOG_INDEX + '.tmp', JSON.stringify(this.catalog, null, 2), 'utf8');
    fs.renameSync(CATALOG_INDEX + '.tmp', CATALOG_INDEX);
  }

  generateNextCode(index) {
    let letterIndex = Math.floor((index - 1) / 10), prefix = '';
    do { prefix = LETTERS[letterIndex % LETTERS.length] + prefix; letterIndex = Math.floor(letterIndex / LETTERS.length) - 1; } while (letterIndex >= 0);
    return prefix + (((index - 1) % 10) + 1);
  }

  nextFreeCode() {
    let code;
    do { code = this.generateNextCode(this.catalog.nextId++); }
    while (this.catalog.items.some(item => item.code === code) || this.remoteRows.some(item => item.code === code) || fs.existsSync(path.join(CACHE_DIR, code + '.webp')));
    return code;
  }

  getByCid(cid) {
    if (!cid) return null;
    const item = this.catalog.items.find(item => String(item.cid) === String(cid));
    return item ? this.getByCode(item.code) : null;
  }

  getByCode(rawCode) {
    const code = String(rawCode || '').trim().toUpperCase().replace(/^#/, '');
    if (!validCode(code)) return null;
    const item = this.catalog.items.find(item => item.code === code);
    if (!item || path.basename(item.filename) !== item.filename) return null;
    const file = path.join(CACHE_DIR, item.filename);
    return fs.existsSync(file) ? { ...item, buffer: fs.readFileSync(file) } : null;
  }

  mergeRemote(rows) {
    this.remoteRows = rows.filter(item => validCode(item.code));
    // Reserve all remote codes before allocating a replacement for a collision.
    while (this.remoteRows.some(item => item.code === this.generateNextCode(this.catalog.nextId))) this.catalog.nextId++;
    for (const remote of this.remoteRows) {
      const local = this.catalog.items.find(item => item.code === remote.code);
      if (local && local.cid && remote.cid && String(local.cid) !== String(remote.cid)) {
        const old = local.code, replacement = this.nextFreeCode();
        const cached = this.getByCode(old);
        if (!cached) throw new Error(`No se puede preservar el sticker local ${old}`);
        fs.writeFileSync(path.join(CACHE_DIR, replacement + '.webp'), cached.buffer, { flag: 'wx' });
        fs.unlinkSync(path.join(CACHE_DIR, local.filename));
        Object.assign(local, { code: replacement, filename: replacement + '.webp', synced: false, previewUrl: null });
        console.log(`[SupabaseSync] Colision preservada: ${old} local pasa a ${replacement}; ${old} publicado se conserva.`);
      }
      const match = this.catalog.items.find(item => item.code === remote.code);
      const values = { code: remote.code, cid: remote.cid || null, title: remote.title || `Sticker ${remote.code}`, previewUrl: remote.preview_url, createdAt: remote.created_at, synced: true, filename: remote.code + '.webp' };
      if (match) Object.assign(match, values);
      else this.catalog.items.push(values);
    }
    this.saveCatalog();
  }

  async refreshRemoteCatalog() {
    if (this.refreshing) return this.refreshing;
    const config = settings();
    if (!config.enabled) return;
    this.refreshing = (async () => {
      const { data } = await axios.get(config.url + '/rest/v1/stoky_stickers', { params: { select: 'code,cid,title,preview_url,created_at', limit: 10000 }, headers: config.headers, timeout: 10000 });
      if (!Array.isArray(data)) throw new Error('Respuesta de catalogo invalida');
      this.mergeRemote(data);
      let cursor = 0;
      const rows = this.remoteRows.filter(item => item.preview_url?.startsWith(config.url + '/storage/v1/object/public/stoky-stickers/') || /^\/stickers\/[a-zA-Z0-9_-]+\.webp$/.test(item.preview_url || ''));
      const worker = async () => {
        while (cursor < rows.length) {
          const row = rows[cursor++];
          if (this.getByCode(row.code)?.cachedPreviewUrl === row.preview_url) continue;
          try {
            const url = new URL(row.preview_url, process.env.CATALOG_URL || 'https://portafoliowebdylan.vercel.app').href;
            const response = await axios.get(url, { responseType: 'arraybuffer', maxContentLength: 20 * 1024 * 1024, timeout: 15000 });
            const buffer = Buffer.from(response.data);
            if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WEBP') throw new Error('Archivo no WebP');
            const file = path.join(CACHE_DIR, row.code + '.webp');
            fs.writeFileSync(file + '.tmp', buffer);
            fs.renameSync(file + '.tmp', file);
            this.catalog.items.find(item => item.code === row.code).cachedPreviewUrl = row.preview_url;
          } catch (error) { console.warn(`[SupabaseSync] No se pudo recuperar ${row.code}: ${error.message}`); }
        }
      };
      await Promise.all([worker(), worker()]);
      this.saveCatalog();
    })();
    try { return await this.refreshing; } finally { this.refreshing = null; }
  }

  async initialize() {
    try { await this.refreshRemoteCatalog(); }
    catch (error) { console.warn('[SupabaseSync] Catalogo remoto pendiente:', error.message); }
  }

  async syncItem(item) {
    const config = settings();
    if (!config.enabled) return false;
    const cached = this.getByCode(item.code);
    if (!cached) throw new Error(`Archivo local no disponible: ${item.code}`);
    // Immutable filenames make retries safe without public UPDATE permissions.
    const hash = crypto.createHash('sha256').update(cached.buffer).digest('hex').slice(0, 16);
    const filename = `${item.code}-${hash}.webp`;
    const publicUrl = config.url + '/storage/v1/object/public/stoky-stickers/' + filename;
    try {
      await axios.post(config.url + '/storage/v1/object/stoky-stickers/' + filename, cached.buffer, { headers: { ...config.headers, 'Content-Type': 'image/webp', 'x-upsert': 'false' }, timeout: 15000 });
    } catch (error) {
      if (error.response?.status !== 409 && error.response?.data?.error !== 'Duplicate') throw error;
      const existing = await axios.get(publicUrl, { responseType: 'arraybuffer', timeout: 10000 });
      if (!Buffer.from(existing.data).equals(cached.buffer)) throw new Error('Conflicto de contenido remoto');
    }
    await axios.post(config.url + '/rest/v1/stoky_stickers', { code: item.code, cid: item.cid, title: item.title, preview_url: publicUrl }, { headers: { ...config.headers, 'Content-Type': 'application/json' }, timeout: 10000 });
    Object.assign(item, { synced: true, previewUrl: publicUrl, cachedPreviewUrl: publicUrl });
    this.saveCatalog();
    console.log(`[SupabaseSync] ${item.code} sincronizado.`);
    return true;
  }

  async retrySync() {
    if (this.syncing || !settings().enabled) return;
    this.syncing = true;
    try {
      await this.refreshRemoteCatalog();
      for (const item of this.catalog.items.filter(item => item.synced === false)) {
        try { await this.syncItem(item); }
        catch (error) { console.warn(`[SupabaseSync] ${item.code} pendiente: ${error.response?.data?.message || error.message}`); }
      }
    } finally { this.syncing = false; }
  }

  saveSticker(cid, buffer, title = '') {
    if (!Buffer.isBuffer(buffer) || !buffer.length) return null;
    const existing = this.getByCid(cid);
    if (existing) return existing;
    const code = this.nextFreeCode(), filename = code + '.webp';
    fs.writeFileSync(path.join(CACHE_DIR, filename), buffer, { flag: 'wx' });
    const item = { code, filename, cid: cid ? String(cid) : null, title: (title || 'Sticker de TikTok').slice(0, 60), createdAt: new Date().toISOString(), synced: false };
    this.catalog.items.push(item);
    this.saveCatalog();
    this.retrySync().catch(error => console.warn('[SupabaseSync]', error.message));
    return { ...item, buffer };
  }

  getMultipleByCodes(codes) { return Array.isArray(codes) ? codes.map(code => this.getByCode(code)).filter(Boolean) : []; }
  getAllItems() { return [...this.catalog.items].sort(compareCatalogCodes); }
}

export const catalogService = new CatalogService();
