import fs from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
const context = new AsyncLocalStorage();
export function sanitizeTrace(value, depth = 0) {
 if (depth > 10) return '[depth limit]';
 if (typeof value === 'string') {
  if (/^https?:/i.test(value)) { try { const u=new URL(value); for(const k of [...u.searchParams.keys()]) if(!['cid','comment_id','share_comment_id','aweme_id','video_id','item_id'].includes(k)) u.searchParams.set(k,'REDACTED');u.username='';u.password='';return u.href; } catch {} }
  let text=value.slice(0,2000);for(const key of (process.env.RAPIDAPI_KEYS||process.env.RAPIDAPI_KEY||'').split(',').filter(Boolean))text=text.split(key).join('[REDACTED]');return text;
 }
 if (Array.isArray(value)) return value.slice(0,100).map(v=>sanitizeTrace(v,depth+1));
 if (value && typeof value==='object') return Object.fromEntries(Object.entries(value).filter(([k])=>!/(key|token|secret|authorization|cookie|user|author|avatar|headers|request|config)/i.test(k)).map(([k,v])=>[k,sanitizeTrace(v,depth+1)]));
 return value;
}
export function trace(stage, data = {}) {
 if (process.env.TIKTOK_DEBUG !== 'true') return;
 const entry={time:new Date().toISOString(),traceId:context.getStore()||'standalone',stage,...sanitizeTrace(data)};
 console.log('[TikTokTrace]',JSON.stringify(entry));
 try {fs.mkdirSync('scratch',{recursive:true});const file='scratch/tiktok-debug.jsonl';if(fs.existsSync(file)&&fs.statSync(file).size>2*1024*1024)fs.renameSync(file,file+'.previous');fs.appendFileSync(file,JSON.stringify(entry)+'\n');}catch(e){console.warn('[TikTokTrace] No se pudo guardar el log:',e.message);}
}
export async function withTikTokTrace(url, task) {return context.run(randomUUID(),async()=>{const start=Date.now();trace('link.start',{url});try{const result=await task();trace('link.complete',{elapsedMs:Date.now()-start,cid:result.cid,hasMedia:result.hasMedia,type:result.type,pagesUsed:result.pagesUsed});return result;}catch(e){trace('link.error',{elapsedMs:Date.now()-start,message:e.message});throw e;}});}
