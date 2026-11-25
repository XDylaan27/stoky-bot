import 'dotenv/config';
import http from 'node:http';
import fs from 'node:fs';
import { CloudStore, setCloudStore } from './services/cloudStore.js';

const status = { whatsapp: 'starting', storage: 'starting' };
globalThis.stokyStatus = status;
const server = http.createServer((req, res) => {
  if (req.url !== '/health') { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({ service: 'stoky', ...status }));
});
server.listen(Number(process.env.PORT || 10000), '0.0.0.0');
const store = new CloudStore();
setCloudStore(store);
let leased = false, stopping = false, heartbeat;
async function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  clearInterval(heartbeat);
  globalThis.stokyStopping = true;
  globalThis.stokySocket?.end(new Error('Shutdown'));
  try {
    if (leased) {
      await globalThis.stokyAuth?.flush();
      if (fs.existsSync('data/bot_state.json')) await store.put('state', JSON.parse(fs.readFileSync('data/bot_state.json', 'utf8')));
      await store.call('release');
    }
  } catch { console.error('[Cloud] No se pudo completar el guardado final'); }
  server.close();
  process.exit(code);
}
process.on('SIGTERM', () => shutdown());
process.on('SIGINT', () => shutdown());
process.on('unhandledRejection', () => { console.error('[Cloud] Error asincrono; reinicio seguro'); shutdown(1); });
try {
  while (!(await store.call('acquire'))) {
    status.whatsapp = 'waiting_for_previous_instance';
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
  leased = true;
  status.storage = 'connected';
  let busy = false, lastState = '';
  heartbeat = setInterval(async () => {
    if (busy || stopping) return;
    busy = true;
    try {
      if (!(await store.call('acquire'))) throw new Error('Lease lost');
      if (fs.existsSync('data/bot_state.json')) {
        const raw = fs.readFileSync('data/bot_state.json', 'utf8');
        if (raw !== lastState) { await store.put('state', JSON.parse(raw)); lastState = raw; }
      }
    } catch { status.storage = 'unavailable'; await shutdown(1); }
    finally { busy = false; }
  }, 20000);
  fs.mkdirSync('data', { recursive: true });
  const state = await store.get('state');
  if (state) { lastState = JSON.stringify(state); fs.writeFileSync('data/bot_state.json', lastState); }
  const keys = await store.get('keys');
  if (keys?.length) process.env.RAPIDAPI_KEYS = [...new Set([...keys, ...(process.env.RAPIDAPI_KEYS || '').split(',').filter(Boolean)])].join(',');
  await import('./index.js');
} catch { console.error('[Cloud] No se pudo recuperar la sesion privada'); await shutdown(1); }
