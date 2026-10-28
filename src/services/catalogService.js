import fs from 'fs';
import path from 'path';

const DATA_DIR = path.resolve('data');
const CACHE_DIR = path.join(DATA_DIR, 'stickers_cache');
const CATALOG_INDEX = path.join(DATA_DIR, 'catalog.json');

class CatalogService {
  constructor() {
    this.ensureDirs();
    this.catalog = this.loadCatalog();
  }

  ensureDirs() {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    if (!fs.existsSync(CACHE_DIR)) {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
    }
  }

  loadCatalog() {
    try {
      if (fs.existsSync(CATALOG_INDEX)) {
        const raw = fs.readFileSync(CATALOG_INDEX, 'utf-8');
        return JSON.parse(raw);
      }
    } catch (err) {
      console.error('[CatalogService] Error al cargar catálogo:', err.message);
    }
    const initial = {
      nextId: 1,
      items: [] // { code: 'A1', cid: '...', filename: 'A1.webp', title: '...', createdAt: '...' }
    };
    this.saveCatalog(initial);
    return initial;
  }

  saveCatalog(catalogToSave = this.catalog) {
    try {
      fs.writeFileSync(CATALOG_INDEX, JSON.stringify(catalogToSave, null, 2), 'utf-8');
    } catch (err) {
      console.error('[CatalogService] Error al guardar catálogo:', err.message);
    }
  }

  // Genera un código legible estilo libro/álbum (ej: A1, A2, ... B1, B2)
  generateNextCode(index) {
    const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
    const letterIndex = Math.floor((index - 1) / 10) % letters.length;
    const number = ((index - 1) % 10) + 1;
    return `${letters[letterIndex]}${number}`;
  }

  // Comprueba si un sticker ya está en el catálogo por su CID de TikTok
  getByCid(cid) {
    if (!cid) return null;
    const item = this.catalog.items.find((i) => String(i.cid) === String(cid));
    if (!item) return null;
    const filePath = path.join(CACHE_DIR, item.filename);
    if (fs.existsSync(filePath)) {
      return {
        ...item,
        buffer: fs.readFileSync(filePath)
      };
    }
    return null;
  }

  // Obtiene un sticker por su código de catálogo (ej: A1, B3)
  getByCode(rawCode) {
    if (!rawCode) return null;
    const code = rawCode.trim().toUpperCase().replace(/^#/, '');
    const item = this.catalog.items.find((i) => i.code === code);
    if (!item) return null;
    const filePath = path.join(CACHE_DIR, item.filename);
    if (fs.existsSync(filePath)) {
      return {
        ...item,
        buffer: fs.readFileSync(filePath)
      };
    }
    return null;
  }

  // Guarda un nuevo sticker en el catálogo
  saveSticker(cid, buffer, title = '') {
    if (!buffer) return null;

    // Si ya existe por cid, retornarlo
    const existing = this.getByCid(cid);
    if (existing) return existing;

    const code = this.generateNextCode(this.catalog.nextId);
    const filename = `${code}.webp`;
    const filePath = path.join(CACHE_DIR, filename);

    try {
      fs.writeFileSync(filePath, buffer);

      const newItem = {
        code,
        cid: String(cid || `local_${Date.now()}`),
        filename,
        title: (title || 'Sticker viral de TikTok').slice(0, 60),
        createdAt: new Date().toISOString()
      };

      this.catalog.items.push(newItem);
      this.catalog.nextId++;
      this.saveCatalog();

      return {
        ...newItem,
        buffer
      };
    } catch (err) {
      console.error('[CatalogService] Error al guardar sticker en caché:', err.message);
      return null;
    }
  }

  // Obtiene múltiples stickers para un pedido en lote (ej: ['A1', 'B3'])
  getMultipleByCodes(codesArray) {
    if (!Array.isArray(codesArray)) return [];
    const results = [];
    for (const raw of codesArray) {
      const found = this.getByCode(raw);
      if (found) {
        results.push(found);
      }
    }
    return results;
  }

  // Resumen del catálogo
  getAllItems() {
    return this.catalog.items;
  }
}

export const catalogService = new CatalogService();
