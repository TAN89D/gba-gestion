import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker from '../worker.js';
import { empty, apply } from '../src/domain.js';
import { viewFor } from '../src/permissions.js';

const KEY = 'cle-de-test-avec-plus-de-trente-deux-caracteres';
const BASE = 'https://gba.example';

// Vraie base SQLite, avec la même interface que Cloudflare D1.
function makeDb() {
  const db = new DatabaseSync(':memory:');
  for (const f of ['0001_workspace.sql', '0002_team.sql']) db.exec(readFileSync(new URL('../migrations/' + f, import.meta.url), 'utf8'));
  const wrap = (sql, args = []) => ({
    bind: (...a) => wrap(sql, a),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...args).changes) } }),
  });
  return { prepare: (sql) => wrap(sql) };
}
function makeEnv(extra = {}) {
  return { DB: makeDb(), BACKUP_TOKEN: KEY, ASSETS: { fetch: async () => new Response('page') }, ...extra };
}
async function call(env, method, path, { body, session, headers = {} } = {}) {
  const h = new Headers(headers);
  if (body) h.set('Content-Type', 'application/json');
  if (session) h.append('Cookie', session);
  const res = await worker.fetch(new Request(BASE + path, { method, headers: h, redirect: 'manual', ...(body ? { body: JSON.stringify(body) } : {}) }), env);
  const type = res.headers.get('Content-Type') || '';
  const json = type.includes('json') ? await res.json() : null;
  const set = res.headers.getSetCookie?.() || [];
  const cookie = set.map((c) => c.split(';')[0]).filter((c) => /=./.test(c)).join('; ');
  return { status: res.status, json, cookie, location: res.headers.get('Location'), setCookies: set };
}
const owner = (env) => call(env, 'POST', '/api/setup', { body: { name: 'Patron' }, headers: { Authorization: 'Bearer ' + KEY } });

function sample() {
  const save = (s, t, d) => apply(s, { type: 'save', table: t, data: d });
  let s = empty();
  s = save(s, 'clients', { id: 'c', name: 'CLIENT-SECRET' });
  s = save(s, 'projects', { id: 'p1', name: 'Villa', clientId: 'c', contractAmount: 987654, budget: 500000 });
  s = save(s, 'projects', { id: 'p2', name: 'Autre chantier', clientId: 'c', contractAmount: 111222, budget: 1 });
  s = save(s, 'employees', { id: 'e1', name: 'Moussa' });
  s = save(s, 'employees', { id: 'e2', name: 'Awa' });
  s = save(s, 'tasks', { id: 't1', employeeId: 'e1', projectId: 'p1', description: 'Pose', agreedAmount: 333444 });
  s = save(s, 'tasks', { id: 't2', employeeId: 'e2', projectId: 'p1', description: 'Autre tâche', agreedAmount: 555666 });
  s = save(s, 'expenses', { id: 'x1', scope: 'Chantier', projectId: 'p1', accountId: 'main', description: 'Ciment', amount: 222333 });
  s = save(s, 'expenses', { id: 'x2', scope: 'Chantier', projectId: 'p2', accountId: 'main', description: 'HORS-CHANTIER', amount: 7 });
  s = save(s, 'expenses', { id: 'x3', scope: 'Entreprise', accountId: 'main', description: 'LOYER-SECRET', amount: 9 });
  s = save(s, 'suppliers', { id: 'f', name: 'Fournisseur' });
  s = save(s, 'journal', { id: 'j1', projectId: 'p1', note: 'Dalle coulée' });
  s = save(s, 'journal', { id: 'j2', projectId: 'p2', note: 'NOTE-AUTRE' });
  s = apply(s, { type: 'invoice', data: { id: 'i', clientId: 'c', projectId: 'p1', date: '2026-01-01', lines: [{ description: 'FACTURE-SECRETE', quantity: 1, unitPrice: 777888 }] } });
  s = apply(s, { type: 'payment', data: { id: 'pay', invoiceId: 'i', accountId: 'main', amount: 100 } });
  return s;
}
async function withData(env) {
  await env.DB.prepare('INSERT INTO workspace(id,revision,payload,updated_at) VALUES(1,1,?,?)').bind(JSON.stringify(sample()), 'x').run();
}
async function addMember(env, session, data) {
  const made = await call(env, 'POST', '/api/users', { session, body: data });
  assert.equal(made.status, 201);
  const inv = await call(env, 'POST', `/api/users/${made.json.user.id}/invite`, { session });
  assert.equal(inv.status, 201);
  return { id: made.json.user.id, token: inv.json.token };
}
async function join(env, token, pin = '1234') {
  return call(env, 'POST', '/api/auth/invite/redeem', { body: { token, pin } });
}

test('sans clé valide, impossible de créer ou d’ouvrir la direction', async () => {
  const env = makeEnv();
  assert.equal((await call(env, 'POST', '/api/setup', { body: {} })).status, 401);
  assert.equal((await call(env, 'POST', '/api/setup', { body: {}, headers: { Authorization: 'Bearer faux' } })).status, 401);
  assert.equal((await call({ ...env, BACKUP_TOKEN: 'court' }, 'POST', '/api/setup', { body: {} })).status, 503);
});
test('la clé rouvre le même compte de direction, sans en créer un second', async () => {
  const env = makeEnv();
  const a = await owner(env);
  const b = await owner(env);
  assert.equal(a.json.user.id, b.json.user.id);
  assert.match(a.setCookies[0], /HttpOnly/);
  assert.match(a.setCookies[0], /Secure/);
  assert.match(a.setCookies[0], /SameSite=Strict/);
  assert.equal((await call(env, 'GET', '/api/users', { session: a.cookie })).json.users.length, 1);
});
test('toutes les routes privées refusent un visiteur sans session', async () => {
  const env = makeEnv();
  for (const [m, p] of [['GET', '/api/me'], ['GET', '/api/workspace'], ['GET', '/api/users'], ['POST', '/api/users'], ['POST', '/api/actions'], ['PATCH', '/api/users/x'], ['POST', '/api/users/x/invite']]) {
    assert.equal((await call(env, m, p, m === 'GET' ? {} : { body: {} })).status, 401, p);
  }
  assert.equal((await call(env, 'GET', '/api/me', { session: 'gba_session=faux' })).status, 401);
  assert.equal((await call(env, 'GET', '/api/inconnue')).status, 404);
});
test('une requête venue d’un autre site est refusée', async () => {
  const env = makeEnv();
  const o = await owner(env);
  const r = await call(env, 'POST', '/api/users', { session: o.cookie, body: { name: 'X', role: 'ouvrier' }, headers: { Origin: 'https://pirate.example' } });
  assert.equal(r.status, 403);
});
test('invitation : un seul usage, code à 4 chiffres, puis connexion par code', async () => {
  const env = makeEnv();
  const o = await owner(env);
  const m = await addMember(env, o.cookie, { name: 'Moussa', role: 'ouvrier' });
  const info = await call(env, 'POST', '/api/auth/invite/info', { body: { token: m.token } });
  assert.deepEqual(info.json, { name: 'Moussa', role: 'ouvrier', hasEmail: false });
  assert.equal((await join(env, m.token, '12')).status, 400);
  assert.equal((await join(env, m.token, 'abcd')).status, 400);
  const j = await join(env, m.token);
  assert.equal(j.status, 200);
  assert.ok(j.json.deviceSecret);
  assert.equal((await call(env, 'GET', '/api/me', { session: j.cookie })).json.user.name, 'Moussa');
  assert.equal((await join(env, m.token)).status, 410);
  const pin = await call(env, 'POST', '/api/auth/pin', { body: { secret: j.json.deviceSecret, pin: '1234' } });
  assert.equal(pin.status, 200);
  assert.equal((await call(env, 'POST', '/api/auth/pin', { body: { secret: 'autre-appareil', pin: '1234' } })).status, 401);
});
test('une nouvelle invitation annule la précédente, et une invitation expirée est refusée', async () => {
  const env = makeEnv();
  const o = await owner(env);
  const m = await addMember(env, o.cookie, { name: 'Awa', role: 'ouvrier' });
  const next = await call(env, 'POST', `/api/users/${m.id}/invite`, { session: o.cookie });
  assert.equal((await join(env, m.token)).status, 410);
  await env.DB.prepare('UPDATE invites SET expires_at=1').run();
  assert.equal((await join(env, next.json.token)).status, 410);
});
test('code faux : blocage après 5 essais, même avec le bon code', async () => {
  const env = makeEnv();
  const o = await owner(env);
  const m = await addMember(env, o.cookie, { name: 'Moussa', role: 'ouvrier' });
  const { json } = await join(env, m.token);
  for (let i = 0; i < 4; i++) assert.equal((await call(env, 'POST', '/api/auth/pin', { body: { secret: json.deviceSecret, pin: '0000' } })).status, 401);
  assert.equal((await call(env, 'POST', '/api/auth/pin', { body: { secret: json.deviceSecret, pin: '0000' } })).status, 429);
  assert.equal((await call(env, 'POST', '/api/auth/pin', { body: { secret: json.deviceSecret, pin: '1234' } })).status, 429);
  await env.DB.prepare('UPDATE devices SET locked_until=0').run();
  assert.equal((await call(env, 'POST', '/api/auth/pin', { body: { secret: json.deviceSecret, pin: '1234' } })).status, 200);
  const row = await env.DB.prepare('SELECT failed FROM devices').first();
  assert.equal(row.failed, 0);
});
test('des essais simultanés ne contournent pas le blocage du code', async () => {
  const env = makeEnv();
  const o = await owner(env);
  const m = await addMember(env, o.cookie, { name: 'Moussa', role: 'ouvrier' });
  const { json } = await join(env, m.token);
  const tries = await Promise.all(Array.from({ length: 25 }, () => call(env, 'POST', '/api/auth/pin', { body: { secret: json.deviceSecret, pin: '0000' } })));
  const row = await env.DB.prepare('SELECT failed,locked_until,revoked FROM devices').first();
  assert.equal(row.failed, 5);
  assert.ok(row.locked_until > Date.now() / 1000);
  assert.equal(tries.filter((r) => r.status === 401).length, 4);
  assert.equal(tries.filter((r) => r.status === 429).length, 21);
  assert.equal((await call(env, 'POST', '/api/auth/pin', { body: { secret: json.deviceSecret, pin: '1234' } })).status, 429);
});
test('20 essais faux révoquent l’appareil, même avec le bon code ensuite', async () => {
  const env = makeEnv();
  const o = await owner(env);
  const m = await addMember(env, o.cookie, { name: 'Moussa', role: 'ouvrier' });
  const { json } = await join(env, m.token);
  for (let i = 0; i < 20; i++) {
    await env.DB.prepare('UPDATE devices SET locked_until=0').run();
    await call(env, 'POST', '/api/auth/pin', { body: { secret: json.deviceSecret, pin: '0000' } });
  }
  await env.DB.prepare('UPDATE devices SET locked_until=0').run();
  assert.equal((await call(env, 'POST', '/api/auth/pin', { body: { secret: json.deviceSecret, pin: '1234' } })).status, 401);
});
test('la déconnexion invalide bien la session sur le serveur', async () => {
  const env = makeEnv();
  const o = await owner(env);
  const m = await addMember(env, o.cookie, { name: 'Moussa', role: 'ouvrier' });
  const j = await join(env, m.token);
  assert.equal((await call(env, 'POST', '/api/auth/logout', { session: j.cookie })).status, 200);
  assert.equal((await call(env, 'GET', '/api/me', { session: j.cookie })).status, 401);
});
test('désactiver un compte coupe immédiatement sessions, appareil et invitations', async () => {
  const env = makeEnv();
  const o = await owner(env);
  const m = await addMember(env, o.cookie, { name: 'Moussa', role: 'ouvrier' });
  const j = await join(env, m.token);
  const spare = await call(env, 'POST', `/api/users/${m.id}/invite`, { session: o.cookie });
  assert.equal((await call(env, 'PATCH', `/api/users/${m.id}`, { session: o.cookie, body: { active: false } })).status, 200);
  assert.equal((await call(env, 'GET', '/api/me', { session: j.cookie })).status, 401);
  assert.equal((await call(env, 'POST', '/api/auth/pin', { body: { secret: j.json.deviceSecret, pin: '1234' } })).status, 401);
  assert.equal((await join(env, spare.json.token)).status, 410);
  assert.equal((await call(env, 'POST', `/api/users/${m.id}/invite`, { session: o.cookie })).status, 404);
});
test('le dernier compte de direction reste protégé', async () => {
  const env = makeEnv();
  const o = await owner(env);
  const id = o.json.user.id;
  assert.equal((await call(env, 'PATCH', `/api/users/${id}`, { session: o.cookie, body: { active: false } })).status, 409);
  assert.equal((await call(env, 'PATCH', `/api/users/${id}`, { session: o.cookie, body: { role: 'ouvrier' } })).status, 409);
});
test('un membre ne peut ni gérer l’équipe, ni modifier, ni s’élever', async () => {
  const env = makeEnv();
  const o = await owner(env);
  await withData(env);
  for (const role of ['gestionnaire', 'chef', 'ouvrier']) {
    const m = await addMember(env, o.cookie, { name: role, role, projectIds: ['p1'] });
    const j = await join(env, m.token);
    assert.equal((await call(env, 'GET', '/api/users', { session: j.cookie })).status, 403, role);
    assert.equal((await call(env, 'POST', '/api/users', { session: j.cookie, body: { name: 'Pirate', role: 'direction' } })).status, 403, role);
    assert.equal((await call(env, 'PATCH', `/api/users/${m.id}`, { session: j.cookie, body: { role: 'direction' } })).status, 403, role);
    assert.equal((await call(env, 'POST', `/api/users/${m.id}/invite`, { session: j.cookie })).status, 403, role);
    assert.equal((await call(env, 'POST', '/api/actions', { session: j.cookie, body: { action: { type: 'cash', data: { accountId: 'main', amount: 5, label: 'Vol' } } } })).status, 403, role);
    assert.equal((await call(env, 'GET', '/api/backup', { session: j.cookie })).status, 401, role);
  }
});
test('entrées invalides refusées lors de la création d’un compte', async () => {
  const env = makeEnv();
  const o = await owner(env);
  const bad = [{ role: 'ouvrier' }, { name: 'X', role: 'patron' }, { name: 'X', role: '__proto__' }, { name: 'X', role: 'ouvrier', email: 'pas-un-mail' }, { name: 'X', role: 'ouvrier', projectIds: 'p1' }];
  for (const body of bad) assert.equal((await call(env, 'POST', '/api/users', { session: o.cookie, body })).status, 400, JSON.stringify(body));
  assert.equal((await call(env, 'POST', '/api/users', { session: o.cookie, body: { name: 'X', role: 'acheteur' } })).status, 400);
  await call(env, 'POST', '/api/users', { session: o.cookie, body: { name: 'A', role: 'chef', email: 'a@gmail.com' } });
  assert.equal((await call(env, 'POST', '/api/users', { session: o.cookie, body: { name: 'B', role: 'chef', email: 'A@gmail.com' } })).status, 409);
});
const SECRETS = ['987654', '111222', 'CLIENT-SECRET', 'FACTURE-SECRETE', '777888', 'HORS-CHANTIER', 'LOYER-SECRET', 'NOTE-AUTRE'];
test('gestionnaire : seulement ses chantiers, jamais la caisse ni les marges', () => {
  const s = sample();
  const v = viewFor(s, { role: 'gestionnaire', projectIds: ['p1'] });
  const text = JSON.stringify(v);
  for (const secret of SECRETS) assert.equal(text.includes(secret), false, secret);
  assert.equal(v.projects.length, 1);
  assert.equal(v.expenses[0].amount, 222333);
  assert.equal(v.invoices.length + v.payments.length + v.clients.length + v.quotes.length + v.audit.length, 0);
  assert.deepEqual(v.accounts, [{ id: 'main', name: 'Caisse entreprise' }]);
  assert.equal(v.settings.phone, undefined);
});
test('chef de chantier : suivi de ses chantiers, sans aucun montant', () => {
  let s = sample();
  s = apply(s, { type: 'save', table: 'employees', data: { id: 'e3', name: 'Hors-Chantier-Employe' } });
  s = apply(s, { type: 'save', table: 'tasks', data: { id: 't9', employeeId: 'e3', projectId: 'p2', description: 'Tâche ailleurs', agreedAmount: 99887 } });
  s = apply(s, { type: 'teamPayment', data: { taskId: 't1', accountId: 'main', amount: 44556 } });
  const v = viewFor(s, { role: 'chef', projectIds: ['p1'] });
  const text = JSON.stringify(v);
  for (const secret of [...SECRETS, '222333', '333444', '555666', '500000', '99887', '44556', 'Hors-Chantier-Employe', 'Tâche ailleurs', 'agreedAmount', 'budget', 'lastPrice']) assert.equal(text.includes(secret), false, secret);
  assert.deepEqual(v.tasks.map((t) => t.id), ['t1', 't2']);
  assert.deepEqual(v.employees.map((e) => e.name), ['Moussa', 'Awa']);
  assert.deepEqual(v.journal.map((j) => j.id), ['j1']);
  assert.equal(v.expenses.length + v.orders.length + v.teamPayments.length + v.accounts.length, 0);
  assert.equal(viewFor(s, { role: 'chef', projectIds: [] }).projects.length, 0);
});
test('ouvrier : ses tâches et ses paiements sur tous ses chantiers, rien d’autre', () => {
  let s = sample();
  s = apply(s, { type: 'teamPayment', data: { id: 'own', taskId: 't1', accountId: 'main', amount: 44555 } });
  s = apply(s, { type: 'teamPayment', data: { id: 'other', taskId: 't2', accountId: 'main', amount: 66777 } });
  s = apply(s, { type: 'save', table: 'tasks', data: { id: 't3', employeeId: 'e1', projectId: 'p2', description: 'Tâche ailleurs', agreedAmount: 88999 } });
  s = apply(s, { type: 'teamPayment', data: { id: 'gone', taskId: 't3', accountId: 'main', amount: 12121 } });
  s = apply(s, { type: 'void', table: 'teamPayments', id: 'gone', reason: 'Erreur' });
  const v = viewFor(s, { role: 'ouvrier', projectIds: ['p1'], employeeId: 'e1' });
  const text = JSON.stringify(v);
  for (const secret of ['987654', '111222', 'CLIENT-SECRET', 'FACTURE-SECRETE', '777888', 'LOYER-SECRET', 'NOTE-AUTRE', '222333', '555666', '66777', '12121', '500000', 'Autre tâche', 'Awa']) assert.equal(text.includes(secret), false, secret);
  assert.deepEqual(v.tasks.map((t) => [t.id, t.agreedAmount]), [['t1', 333444], ['t3', 88999]]);
  assert.deepEqual(v.teamPayments.map((p) => [p.id, p.amount]), [['own', 44555]]);
  assert.deepEqual(v.projects.map((p) => p.name), ['Villa', 'Autre chantier']);
  assert.equal(v.projects[0].budget, undefined);
  assert.equal(viewFor(sample(), { role: 'ouvrier', projectIds: ['p1'] }).tasks.length, 0);
  assert.equal(viewFor(sample(), { role: 'ouvrier', projectIds: [] }).projects.length, 0);
});
test('le filtre s’applique bien à la réponse du serveur', async () => {
  const env = makeEnv();
  const o = await owner(env);
  await withData(env);
  const m = await addMember(env, o.cookie, { name: 'Moussa', role: 'ouvrier', projectIds: ['p1'], employeeId: 'e1' });
  const j = await join(env, m.token);
  const seen = await call(env, 'GET', '/api/workspace', { session: j.cookie });
  assert.equal(JSON.stringify(seen.json).includes('987654'), false);
  assert.equal(seen.json.data.tasks.length, 1);
  const all = await call(env, 'GET', '/api/workspace', { session: o.cookie });
  assert.equal(all.json.data.clients.length, 1);
});
test('la direction modifie via le serveur, avec contrôle et trace de l’auteur', async () => {
  const env = makeEnv();
  const o = await owner(env);
  assert.equal((await call(env, 'POST', '/api/actions', { session: o.cookie, body: { action: { type: 'cash', data: { accountId: 'main', amount: 5, label: 'A' } } } })).status, 409);
  await withData(env);
  const ok = await call(env, 'POST', '/api/actions', { session: o.cookie, body: { action: { type: 'cash', data: { accountId: 'main', amount: 5000, label: 'Apport' } } } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.revision, 2);
  const after = await call(env, 'GET', '/api/workspace', { session: o.cookie });
  assert.equal(after.json.data.audit.at(-1).by, o.json.user.id);
  assert.equal((await call(env, 'POST', '/api/actions', { session: o.cookie, body: { action: { type: 'payment', data: { invoiceId: 'i', accountId: 'main', amount: 999999999 } } } })).status, 400);
  assert.equal((await call(env, 'GET', '/api/workspace', { session: o.cookie })).json.revision, 2);
});
function googleEnv(claims, ok = true) {
  const env = makeEnv({ GOOGLE_CLIENT_ID: 'client-id', GOOGLE_CLIENT_SECRET: 'client-secret' });
  const part = Buffer.from(JSON.stringify({ iss: 'https://accounts.google.com', aud: 'client-id', exp: Math.floor(Date.now() / 1000) + 300, email_verified: true, ...claims })).toString('base64url');
  globalThis.fetch = async () => new Response(JSON.stringify({ id_token: 'x.' + part + '.y' }), { status: ok ? 200 : 400 });
  return env;
}
async function googleFlow(env) {
  const start = await call(env, 'GET', '/api/auth/google/start');
  const state = new URL(start.location).searchParams.get('state');
  return call(env, 'GET', `/api/auth/google/callback?state=${state}&code=abc`, { session: start.cookie });
}
test('Google : seule une adresse vérifiée et invitée peut entrer', async () => {
  const real = globalThis.fetch;
  try {
    let env = googleEnv({ email: 'Gestion@Gmail.com' });
    let o = await owner(env);
    await call(env, 'POST', '/api/users', { session: o.cookie, body: { name: 'Gestion', role: 'gestionnaire', email: 'gestion@gmail.com' } });
    const good = await googleFlow(env);
    assert.equal(good.location, '/#connecte');
    assert.equal((await call(env, 'GET', '/api/me', { session: good.cookie })).json.user.name, 'Gestion');
    const reject = async (claims, reason) => {
      const e = googleEnv(claims);
      const a = await owner(e);
      await call(e, 'POST', '/api/users', { session: a.cookie, body: { name: 'G', role: 'gestionnaire', email: 'gestion@gmail.com' } });
      const r = await googleFlow(e);
      assert.equal(r.location, '/#connexion-refusee=' + reason, JSON.stringify(claims));
      assert.equal(r.setCookies.some((c) => c.startsWith('gba_session')), false);
    };
    await reject({ email: 'inconnu@gmail.com' }, 'compte');
    await reject({ email: 'gestion@gmail.com', email_verified: false }, 'google');
    await reject({ email: 'gestion@gmail.com', aud: 'autre-application' }, 'google');
    await reject({ email: 'gestion@gmail.com', iss: 'https://pirate.example' }, 'google');
    await reject({ email: 'gestion@gmail.com', exp: 1 }, 'google');
  } finally { globalThis.fetch = real; }
});
test('Google : un retour sans le bon jeton de sécurité est refusé', async () => {
  const real = globalThis.fetch;
  try {
    const env = googleEnv({ email: 'a@gmail.com' });
    const start = await call(env, 'GET', '/api/auth/google/start');
    assert.match(start.location, /^https:\/\/accounts\.google\.com\//);
    const forged = await call(env, 'GET', '/api/auth/google/callback?state=faux&code=abc', { session: start.cookie });
    assert.equal(forged.location, '/#connexion-refusee=session');
    assert.equal((await call(env, 'GET', '/api/auth/google/callback?state=x&code=abc')).location, '/#connexion-refusee=session');
    assert.equal((await call(makeEnv(), 'GET', '/api/auth/google/start')).status, 503);
  } finally { globalThis.fetch = real; }
});
