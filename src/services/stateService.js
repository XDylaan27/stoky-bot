import fs from 'fs';
import path from 'path';

const DATA_DIR = path.resolve('data');
const STATE_FILE = path.join(DATA_DIR, 'bot_state.json');

// Estado inicial por defecto
const DEFAULT_STATE = {
  isPrivate: false,
  adminJids: [], // Admins identificados
  whitelist: [], // Números/JIDs autorizados
  pendingInvites: {}, // { [code]: { createdAt, used: false, usedBy: null } }
  history: {
    totalStickersCreated: 0,
    users: {}, // { [jid]: { count: 0, phone: '', lastActive: null, heavyRequests: [] } }
    heavyStickers: [] // { url, cid, requester, pagesUsed, timestamp }
  }
};

class StateService {
  constructor() {
    this.state = this.loadState();
  }

  loadState() {
    try {
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }
      if (fs.existsSync(STATE_FILE)) {
        const raw = fs.readFileSync(STATE_FILE, 'utf-8');
        return { ...DEFAULT_STATE, ...JSON.parse(raw) };
      }
    } catch (err) {
      console.error('[StateService] Error al cargar estado, usando default:', err.message);
    }
    const state = { ...DEFAULT_STATE };
    this.saveState(state);
    return state;
  }

  saveState(stateToSave = this.state) {
    try {
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }
      fs.writeFileSync(STATE_FILE, JSON.stringify(stateToSave, null, 2), 'utf-8');
    } catch (err) {
      console.error('[StateService] Error al guardar estado:', err.message);
    }
  }

  // Comprobar si el modo privado está activo
  isPrivateMode() {
    return Boolean(this.state.isPrivate);
  }

  // Activar o desactivar modo privado
  setPrivateMode(enabled) {
    this.state.isPrivate = Boolean(enabled);
    this.saveState();
    return this.state.isPrivate;
  }

  // Comprobar si un usuario está autorizado
  isUserAllowed(jid, isFromMe = false) {
    if (isFromMe) return true;
    if (!this.state.isPrivate) return true; // Modo público: todos permitidos
    return this.state.whitelist.includes(jid);
  }

  // Generar código de invitación único (ej: STK-8A3F)
  generateInviteCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let randomPart = '';
    for (let i = 0; i < 4; i++) {
      randomPart += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    const code = `STK-${randomPart}`;

    this.state.pendingInvites[code] = {
      code,
      createdAt: new Date().toISOString(),
      used: false,
      usedBy: null
    };

    this.saveState();
    return code;
  }

  // Canjear código de invitación sin límite de tiempo
  redeemInviteCode(rawCode, jid) {
    if (!rawCode) return { success: false, reason: 'EMPTY_CODE' };
    const code = rawCode.trim().toUpperCase();

    const invite = this.state.pendingInvites[code];
    if (!invite) {
      return { success: false, reason: 'NOT_FOUND' };
    }
    if (invite.used) {
      return { success: false, reason: 'ALREADY_USED', usedBy: invite.usedBy };
    }

    // Marcar como usado inmediatamente
    invite.used = true;
    invite.usedBy = jid;
    invite.usedAt = new Date().toISOString();

    // Añadir a la whitelist si no estaba
    if (!this.state.whitelist.includes(jid)) {
      this.state.whitelist.push(jid);
    }

    this.saveState();
    return { success: true, code };
  }

  // Expulsar o remover un usuario de la whitelist
  kickUser(targetIdentifier) {
    const clean = String(targetIdentifier).trim().replace(/[\s+\-()]/g, '');
    const beforeCount = this.state.whitelist.length;

    this.state.whitelist = this.state.whitelist.filter((j) => {
      const phone = j.split('@')[0];
      return j !== clean && phone !== clean && !j.startsWith(clean);
    });

    const removed = this.state.whitelist.length < beforeCount;
    if (removed) {
      this.saveState();
    }
    return removed;
  }

  // Registrar consumo de sticker e historial
  recordStickerUsage(jid, url, pagesUsed = 1, cid = null) {
    this.state.history.totalStickersCreated = (this.state.history.totalStickersCreated || 0) + 1;

    const phone = jid.split('@')[0];
    if (!this.state.history.users[jid]) {
      this.state.history.users[jid] = {
        count: 0,
        phone,
        firstActive: new Date().toISOString(),
        lastActive: null,
        heavyRequests: []
      };
    }

    const u = this.state.history.users[jid];
    u.count = (u.count || 0) + 1;
    u.lastActive = new Date().toISOString();

    // Si requirió más de 1 petición a la API, registrarlo como sticker pesado
    if (pagesUsed > 1) {
      const heavyEntry = {
        url,
        cid,
        requester: phone,
        pagesUsed,
        timestamp: new Date().toISOString()
      };
      u.heavyRequests.push(heavyEntry);
      this.state.history.heavyStickers.push(heavyEntry);
    }

    this.saveState();
  }

  // Resumen formateado para el comando "stoky historia"
  getHistorySummary() {
    const total = this.state.history.totalStickersCreated || 0;
    const users = Object.entries(this.state.history.users || {});
    const heavy = this.state.history.heavyStickers || [];

    return {
      totalStickers: total,
      totalUsers: users.length,
      users: users.map(([jid, data]) => ({
        jid,
        phone: data.phone || jid.split('@')[0],
        count: data.count || 0,
        heavyCount: (data.heavyRequests || []).length,
        lastActive: data.lastActive
      })).sort((a, b) => b.count - a.count),
      heavyStickers: heavy
    };
  }
}

export const stateService = new StateService();
