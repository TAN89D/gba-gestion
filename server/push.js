// Notifications « push » : le serveur réveille le téléphone, qui affiche lui-même la nouveauté.
// Aucun contenu n'est envoyé dans le message push : le téléphone lit ensuite /api/notifications,
// avec sa propre connexion. Les clés d'envoi (VAPID) sont créées une fois et gardées dans la base.
const enc = new TextEncoder();
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64uText = (text) => b64u(enc.encode(text));

// Seuls les services de notification connus des navigateurs peuvent recevoir nos envois.
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^android\.googleapis\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /^web\.push\.apple\.com$/, /(^|\.)notify\.windows\.com$/, /(^|\.)push\.apple\.com$/];
export function validEndpoint(value) {
  if (typeof value !== 'string' || value.length > 1000) return false;
  let url;
  try { url = new URL(value); } catch { return false; }
  return url.protocol === 'https:' && !url.port && PUSH_HOSTS.some((re) => re.test(url.hostname));
}

export async function vapidKeys(env) {
  const row = await env.DB.prepare("SELECT value FROM meta WHERE key='vapid'").first();
  if (row) return JSON.parse(row.value);
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const value = { priv: await crypto.subtle.exportKey('jwk', pair.privateKey), pub: b64u(await crypto.subtle.exportKey('raw', pair.publicKey)) };
  // Si deux requêtes créent une clé en même temps, la première enregistrée est gardée par tous.
  await env.DB.prepare("INSERT OR IGNORE INTO meta(key,value) VALUES('vapid',?)").bind(JSON.stringify(value)).run();
  return JSON.parse((await env.DB.prepare("SELECT value FROM meta WHERE key='vapid'").first()).value);
}

export async function vapidAuthorization(keys, endpoint, subject) {
  const header = b64uText(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64uText(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject }));
  const key = await crypto.subtle.importKey('jwk', keys.priv, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(header + '.' + claims));
  return `vapid t=${header}.${claims}.${b64u(signature)}, k=${keys.pub}`;
}

// Réveille tous les téléphones abonnés de ces personnes. Un abonnement expiré est retiré.
export async function pushTo(env, userIds, subject) {
  const ids = [...new Set(userIds)].filter(Boolean);
  if (!ids.length) return 0;
  const { results } = await env.DB.prepare(`SELECT endpoint FROM push_subscriptions WHERE user_id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all();
  if (!results.length) return 0;
  const keys = await vapidKeys(env);
  let sent = 0;
  await Promise.all(results.map(async ({ endpoint }) => {
    if (!validEndpoint(endpoint)) return;
    try {
      const res = await fetch(endpoint, { method: 'POST', headers: { Authorization: await vapidAuthorization(keys, endpoint, subject), TTL: '86400', Urgency: 'high', 'Content-Length': '0' } });
      if (res.status === 404 || res.status === 410) await env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint=?').bind(endpoint).run();
      else if (res.ok) sent++;
    } catch { /* service indisponible : la cloche reste à jour */ }
  }));
  return sent;
}
