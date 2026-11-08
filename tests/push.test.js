import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker from '../worker.js';
import { validEndpoint } from '../server/push.js';

const MIGRATIONS = ['0001_workspace.sql', '0002_team.sql', '0003_entries.sql', '0004_requests.sql', '0005_presence.sql', '0006_companies.sql', '0007_limits.sql', '0008_push.sql'];
function makeEnv(extra = {}) {
  const db = new DatabaseSync(':memory:');
  for (const f of MIGRATIONS) db.exec(readFileSync(new URL('../migrations/' + f, import.meta.url), 'utf8'));
  const wrap = (sql, args = []) => ({
    bind: (...a) => wrap(sql, a),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...args).changes) } }),
  });
  return { DB: { prepare: (sql) => wrap(sql) }, ASSETS: { fetch: async () => new Response('page') }, ...extra };
}
async function raw(env, method, path, body, cookie) {
  const headers = new Headers();
  if (cookie) headers.set('Cookie', cookie);
  if (body !== undefined) headers.set('Content-Type', 'application/json');
  return worker.fetch(new Request('https://sobara.example' + path, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }), env);
}
const cookieOf = (res) => res.headers.getSetCookie()[0].split(';')[0];
const FCM = (n) => 'https://fcm.googleapis.com/fcm/send/telephone-' + n;
// Faux service de notification : on garde chaque envoi.
function fakePush(status = 201) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init }); return new Response(null, { status: typeof status === 'function' ? status(String(url)) : status }); };
  return { calls, restore: () => { globalThis.fetch = original; } };
}
const fromB64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0));

test('adresse d’envoi : seulement les vrais services de notification', () => {
  assert.equal(validEndpoint(FCM(1)), true);
  assert.equal(validEndpoint('https://web.push.apple.com/abc'), true);
  assert.equal(validEndpoint('https://updates.push.services.mozilla.com/wpush/v2/abc'), true);
  for (const bad of ['http://fcm.googleapis.com/x', 'https://evil.example/x', 'https://fcm.googleapis.com.evil.example/x', 'https://fcm.googleapis.com:8443/x', 'javascript:alert(1)', 42]) assert.equal(validEndpoint(bad), false, String(bad));
});

test('push : le chef est réveillé quand l’ouvrier signale un problème, avec une signature valide', async () => {
  const env = makeEnv({ DEMO: '1' });
  const enter = async (role) => cookieOf(await raw(env, 'POST', '/api/demo/enter', { role }));
  const chef = await enter('chef');
  const ouvrier = await enter('ouvrier');
  const boss = await enter('direction');
  assert.equal((await raw(env, 'GET', '/api/push/key')).status, 401);
  const { key } = await (await raw(env, 'GET', '/api/push/key', undefined, chef)).json();
  assert.equal(fromB64u(key).length, 65, 'clé publique P-256');
  assert.equal((await raw(env, 'POST', '/api/push/subscribe', { endpoint: 'https://evil.example/x' }, chef)).status, 400);
  assert.equal((await raw(env, 'POST', '/api/push/subscribe', { endpoint: FCM('chef') }, chef)).status, 201);
  assert.equal((await raw(env, 'POST', '/api/push/subscribe', { endpoint: FCM('ouvrier') }, ouvrier)).status, 201);
  assert.equal((await raw(env, 'POST', '/api/push/subscribe', { endpoint: FCM('patron') }, boss)).status, 201);

  const push = fakePush();
  try {
    const inc = await (await raw(env, 'POST', '/api/entries', { kind: 'incident', projectId: 'p-villa', note: 'La bétonnière est en panne' }, ouvrier)).json();
    const woken = push.calls.map((c) => c.url).sort();
    assert.deepEqual(woken, [FCM('chef'), FCM('patron')].sort(), 'chef et patron, pas l’ouvrier lui-même');
    const auth = push.calls[0].init.headers.Authorization;
    const [, jwt, pub] = auth.match(/^vapid t=([^,]+), k=(.+)$/);
    assert.equal(pub, key);
    const [h, c, sig] = jwt.split('.');
    const claims = JSON.parse(new TextDecoder().decode(fromB64u(c)));
    assert.equal(claims.aud, 'https://fcm.googleapis.com');
    assert.ok(claims.exp > Date.now() / 1000);
    const verifyKey = await crypto.subtle.importKey('raw', fromB64u(key), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    assert.equal(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, verifyKey, fromB64u(sig), new TextEncoder().encode(h + '.' + c)), true);
    assert.equal(push.calls[0].init.headers.Urgency, 'high');
    // Le chef répond : seul l'ouvrier concerné (et le patron) sont réveillés.
    push.calls.length = 0;
    assert.equal((await raw(env, 'POST', `/api/threads/${inc.entry.id}`, { id: 'message-unique-1', text: 'J’arrive.' }, chef)).status, 201);
    assert.deepEqual(push.calls.map((x) => x.url).sort(), [FCM('ouvrier'), FCM('patron')].sort());
    push.calls.length = 0;
    assert.equal((await raw(env, 'POST', `/api/threads/${inc.entry.id}`, { id: 'message-unique-1', text: 'J’arrive.' }, chef)).status, 201);
    assert.equal(push.calls.length, 0, 'un renvoi ne réveille personne');
    // Problème réglé par le patron : l'auteur est prévenu.
    push.calls.length = 0;
    assert.equal((await raw(env, 'POST', `/api/entries/${inc.entry.id}/decision`, { decision: 'resolve', reason: 'Réparée' }, boss)).status, 200);
    assert.deepEqual(push.calls.map((x) => x.url), [FCM('ouvrier')]);
    // L'ouvrier pointe : chef et patron sont prévenus.
    push.calls.length = 0;
    assert.equal((await raw(env, 'POST', '/api/presence', { projectId: 'p-villa' }, ouvrier)).status, 201);
    assert.deepEqual(push.calls.map((x) => x.url).sort(), [FCM('chef'), FCM('patron')].sort());
  } finally { push.restore(); }
});

test('push : un téléphone qui n’existe plus est oublié, et la déconnexion coupe les alertes', async () => {
  const env = makeEnv({ DEMO: '1' });
  const enter = async (role) => cookieOf(await raw(env, 'POST', '/api/demo/enter', { role }));
  const chef = await enter('chef');
  const ouvrier = await enter('ouvrier');
  await raw(env, 'POST', '/api/push/subscribe', { endpoint: FCM('vieux') }, chef);
  await raw(env, 'POST', '/api/push/subscribe', { endpoint: FCM('neuf') }, chef);
  const push = fakePush((url) => (url.endsWith('vieux') ? 410 : 201));
  try {
    await raw(env, 'POST', '/api/entries', { kind: 'incident', projectId: 'p-villa', note: 'x' }, ouvrier);
    push.calls.length = 0;
    await raw(env, 'POST', '/api/entries', { kind: 'incident', projectId: 'p-villa', note: 'y' }, ouvrier);
    assert.deepEqual(push.calls.map((x) => x.url), [FCM('neuf')]);
    assert.equal((await raw(env, 'POST', '/api/push/unsubscribe', { endpoint: FCM('neuf') }, chef)).status, 200);
    push.calls.length = 0;
    await raw(env, 'POST', '/api/entries', { kind: 'incident', projectId: 'p-villa', note: 'z' }, ouvrier);
    assert.equal(push.calls.length, 0);
  } finally { push.restore(); }
});

test('push : jamais d’alerte vers une autre entreprise', async () => {
  const env = makeEnv({ SIGNUP: '1' });
  const signup = async (company) => { const r = await raw(env, 'POST', '/api/companies', { company, name: 'Patron ' + company, pin: '2468' }); return { cookie: cookieOf(r), ...(await r.json()) }; };
  const a = await signup('A');
  const b = await signup('B');
  await raw(env, 'POST', '/api/push/subscribe', { endpoint: FCM('b') }, b.cookie);
  const push = fakePush();
  try {
    const { apply } = await import('../src/domain.js');
    let data = apply(a.workspace.data, { type: 'save', table: 'clients', data: { id: 'c', name: 'C' } });
    data = apply(data, { type: 'save', table: 'projects', data: { id: 'p', name: 'P', clientId: 'c', contractAmount: 1, budget: 0 } });
    await raw(env, 'PUT', '/api/workspace', { revision: 1, data, companyId: a.user.companyId }, a.cookie);
    const made = await (await raw(env, 'POST', '/api/users', { name: 'Ouvrier A', role: 'ouvrier', projectIds: ['p'] }, a.cookie)).json();
    const inv = await (await raw(env, 'POST', `/api/users/${made.user.id}/invite`, undefined, a.cookie)).json();
    const worker_ = cookieOf(await raw(env, 'POST', '/api/auth/invite/redeem', { token: inv.token, pin: '1357' }));
    await raw(env, 'POST', '/api/entries', { kind: 'incident', projectId: 'p', note: 'x' }, worker_);
    assert.equal(push.calls.length, 0);
  } finally { push.restore(); }
});

test('démo : la remise à zéro marche même avec des téléphones abonnés aux alertes', async () => {
  const env = makeEnv({ DEMO: '1' });
  const chef = cookieOf(await raw(env, 'POST', '/api/demo/enter', { role: 'chef' }));
  assert.equal((await raw(env, 'POST', '/api/push/subscribe', { endpoint: FCM('demo') }, chef)).status, 201);
  let job;
  await worker.scheduled({}, env, { waitUntil: (p) => { job = p; } });
  await job;
  assert.equal((await raw(env, 'GET', '/api/me', undefined, chef)).status, 401, 'tout est reparti de zéro');
  assert.equal((await raw(env, 'POST', '/api/demo/enter', { role: 'chef' })).status, 200);
});
