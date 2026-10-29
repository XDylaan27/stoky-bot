import fs from 'fs';
import path from 'path';
import axios from 'axios';

const DATA_DIR = path.resolve('data');
const CACHE_DIR = path.join(DATA_DIR, 'stickers_cache');
const CATALOG_INDEX = path.join(DATA_DIR, 'catalog.json');

// Sincronización asíncrona con la base de datos y CDN de Supabase
async function syncToSupabase(code, buffer, cid, title) {
  const supabaseUrl = process.env.SUPABASE_URL || 'https://mpltesmsnwsxfkdmybbm.supabase.co';
  const supabaseKey = process.env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1wbHRlc21zbndzeGZrZG15YmJtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjQ4Mjk4MjksImV4cCI6MjA4MDQwNTgyOX0.e-tCPjGGviHKVXCxyfdS04gqmCMX67N1PVkQ6hfskOM';

  if (!supabaseUrl || !supabaseKey) return;

  try {
    const filename = `${code}.webp`;
    // 1. Subir el WebP a Supabase Storage (bucket público stoky-stickers)
    const storageUrl = `${supabaseUrl}/storage/v1/object/stoky-stickers/${filename}`;
    await axios.post(storageUrl, buffer, {
      headers: {
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
        'Content-Type': 'image/webp',
        'x-upsert': 'true'
      },
      timeout: 15000
    });

    const publicUrl = `${supabaseUrl}/storage/v1/object/public/stoky-stickers/${filename}`;

    // 2. Insertar en la tabla stoky_stickers
    const restUrl = `${supabaseUrl}/rest/v1/stoky_stickers`;
    await axios.post(
      restUrl,
      {
        code,
        title: title || `Sticker ${code}`,
        preview_url: publicUrl,
        cid: String(cid || '')
      },
      {
        headers: {
          apikey: supabaseKey,
          Authorization: `Bearer ${supabaseKey}`,
          'Content-Type': 'application/json',
          Prefer: 'resolution=merge-duplicates'
        },
        timeout: 10000
      }
    );

    console.log(`[SupabaseSync] 🚀 Sticker ${code} sincronizado en vivo con Supabase y la web.`);
  } catch (err) {
    const errMsg = err.response?.data?.message || err.message;
    console.warn(`[SupabaseSync] Aviso: No se pudo sincronizar ${code} con Supabase (${errMsg})`);
  }
}

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

      // Sincronizar en segundo plano con la base de datos de Supabase
      syncToSupabase(code, buffer, cid, title).catch(() => {});

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
