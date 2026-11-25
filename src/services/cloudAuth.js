import { BufferJSON, proto } from '@whiskeysockets/baileys';

export async function useCloudAuth(store) {
  const files = await store.get('auth');
  if (!files?.['creds.json']) throw new Error('No hay sesion migrada: se requiere vinculacion inicial');
  const parse = text => text ? JSON.parse(text, BufferJSON.reviver) : null;
  const filename = (type, id) => `${type}-${id}.json`.replace(/\//g, '__').replace(/:/g, '-');
  const creds = parse(files['creds.json']);
  let chain = Promise.resolve();
  const persist = () => {
    const snapshot = { ...files };
    const task = chain.then(() => store.put('auth', snapshot));
    chain = task.catch(() => {});
    return task;
  };
  return {
    state: { creds, keys: {
      get: async (type, ids) => Object.fromEntries(ids.map(id => {
        let value = parse(files[filename(type, id)]);
        if (type === 'app-state-sync-key' && value) value = proto.Message.AppStateSyncKeyData.fromObject(value);
        return [id, value];
      })),
      set: async data => {
        for (const [type, entries] of Object.entries(data)) for (const [id, value] of Object.entries(entries)) {
          const file = filename(type, id);
          if (value == null) delete files[file];
          else files[file] = JSON.stringify(value, BufferJSON.replacer);
        }
        await persist();
      }
    } },
    saveCreds: async () => { files['creds.json'] = JSON.stringify(creds, BufferJSON.replacer); await persist(); },
    flush: () => chain
  };
}
