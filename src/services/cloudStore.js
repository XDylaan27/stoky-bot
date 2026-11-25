import crypto from 'node:crypto';

export class CloudStore {
  constructor(env = process.env) {
    this.url = env.STOKY_STATE_URL;
    this.token = env.STOKY_STATE_TOKEN;
    this.key = Buffer.from(env.STOKY_STATE_KEY || '', 'hex');
    this.owner = crypto.randomUUID();
    if (!this.url || !this.token || this.key.length !== 32) throw new Error('Falta configurar el almacenamiento privado de Stoky');
  }
  seal(value) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
  }
  open(value) {
    const data = Buffer.from(value, 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, data.subarray(0, 12));
    decipher.setAuthTag(data.subarray(12, 28));
    return JSON.parse(Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString());
  }
  async call(action, extra = {}) {
    try {
      const response = await fetch(this.url, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-stoky-token': this.token },
        body: JSON.stringify({ action, owner: this.owner, ...extra }), signal: AbortSignal.timeout(15000)
      });
      if (!response.ok) throw new Error(String(response.status));
      return await response.json();
    } catch (error) { throw new Error(`Almacenamiento privado no disponible (${error.name === 'TimeoutError' ? 'timeout' : /^\d{3}$/.test(error.message) ? error.message : 'network'})`); }
  }
  async get(name) { const value = await this.call('get', { name }); return value === null ? null : this.open(value); }
  async put(name, value) { return this.call('put', { name, value: this.seal(value) }); }
}

export let cloudStore;
export function setCloudStore(store) { cloudStore = store; }
