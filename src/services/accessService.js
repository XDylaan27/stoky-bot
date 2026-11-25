import { jidNormalizedUser } from '@whiskeysockets/baileys';

// Use WhatsApp's authenticated addressing metadata, never the message text.
export async function isAuthorizedSender(sock, key, allowedJids) {
  if (key.fromMe) return true;
  const normalize = jid => typeof jid === 'string' ? jidNormalizedUser(jid) : '';
  const allowed = new Set(allowedJids.map(normalize).filter(Boolean));
  const sender = normalize(key.remoteJid);
  if (allowed.has(sender)) return true;
  if (allowed.has(normalize(key.remoteJidAlt))) return true;

  const mappings = sock.signalRepository?.lidMapping;
  if (!mappings) return false;
  try {
    if (sender.endsWith('@lid')) {
      const phone = normalize(await mappings.getPNForLID(sender));
      if (allowed.has(phone)) return true;
      // A newly linked session may only be able to look up PN -> LID.
      for (const jid of allowed) {
        if (!jid.endsWith('@s.whatsapp.net')) continue;
        if (normalize(await mappings.getLIDForPN(jid)) === sender) return true;
      }
    } else if (sender.endsWith('@s.whatsapp.net')) {
      const lid = normalize(await mappings.getLIDForPN(sender));
      if (allowed.has(lid)) return true;
    }
  } catch {
    // Missing mappings or connection failures must never grant access.
    return false;
  }
  return false;
}
