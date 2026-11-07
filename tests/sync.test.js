import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker from '../worker.js';
import { empty, apply, validate } from '../src/domain.js';
import { viewFor } from '../src/permissions.js';
import { buildPayload, counts, looksEmpty, localIsCurrent, transferAll, createSyncEngine, readSync, writeSync, SYNC_LIMIT } from '../src/sync.js';
import { keepAttachments } from '../server/team.js';

const KEY = 'cle-de-test-avec-plus-de-trente-deux-caracteres';
const BASE = 'https://gba.example';
function makeEnv() {
  const db = new DatabaseSync(':memory:');
  for (const f of ['0001_workspace.sql', '0002_team.sql', '0003_entries.sql', '0004_requests.sql', '0005_presence.sql', '0006_companies.sql', '0007_limits.sql', '0008_push.sql']) db.exec(readFileSync(new URL('../migrations/' + f, import.meta.url), 'utf8'));
  const wrap = (sql, args = []) => ({
    bind: (...a) => wrap(sql, a),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...args).changes) } }),
  });
  return { DB: { prepare: (sql) => wrap(sql) }, BACKUP_TOKEN: KEY, ASSETS: { fetch: async () => new Response('page') } };
}
async function raw(env, method, path, body, cookie, extra = {}) {
  const headers = new Headers(extra);
  if (cookie) headers.set('Cookie', cookie);
  if (body !== undefined) headers.set('Content-Type', 'application/json');
  return worker.fetch(new Request(BASE + path, { method, headers, ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}) }), env);
}
async function ownerCookie(env) {
  const res = await raw(env, 'POST', '/api/setup', {}, null, { Authorization: 'Bearer ' + KEY });
  return res.headers.getSetCookie()[0].split(';')[0];
}
function installBrowser(env, cookie) {
  const store = new Map();
  globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
  globalThis.fetch = async (path, options = {}) => raw(env, options.method || 'GET', path, options.body, cookie);
  return store;
}
const save = (s, t, d) => apply(s, { type: 'save', table: t, data: d });
function realistic() {
  let s = empty();
  s = save(s, 'clients', { id: 'c1', name: 'Brehima Soumaré — « été »', phone: '+223 70', scope: 'Chantier', lines: [{ description: '', unit: 'forfait' }], nextQuote: true });
  s = save(s, 'clients', { id: 'c2', name: 'Société Œuvre & Fils 🏗️' });
  s = save(s, 'projects', { id: 'p1', name: 'Villa Soumaré', clientId: 'c1', contractAmount: 5000000, budget: 3500000, sourceTable: 'quotes', sourceId: 'x' });
  s = save(s, 'employees', { id: 'e1', name: 'Moussa' });
  s = save(s, 'tasks', { id: 't1', employeeId: 'e1', projectId: 'p1', description: 'Pose', agreedAmount: 300000 });
  s = apply(s, { type: 'teamPayment', data: { id: 'tp', taskId: 't1', accountId: 'main', amount: 100000 } });
  s = save(s, 'quotes', { id: 'q1', clientId: 'c1', projectId: 'p1', lines: [{ description: 'Maçonnerie', quantity: 0.5, unit: 'lot', unitPrice: 101 }], tax: 18, discount: 1 });
  s = apply(s, { type: 'convert', id: 'q1' });
  const inv = s.invoices[0].id;
  s = apply(s, { type: 'payment', data: { id: 'pay', invoiceId: inv, accountId: 'main', amount: 10 } });
  s = apply(s, { type: 'void', table: 'payments', id: 'pay', reason: 'Erreur' });
  s = save(s, 'expenses', { id: 'x1', scope: 'Entreprise', accountId: 'main', description: 'Loyer', amount: 50000, clientId: 'c1' });
  s.legacyArchive = { schemaVersion: 3, reminders: [{ id: 1 }] };
  s.importReport = { source: 'Android V2', warnings: ['Vérifier'] };
  return validate(s);
}
function withAttachments(s, n) {
  let out = s;
  for (let i = 0; i < n; i++) out = save(out, 'attachments', { id: 'a' + i, name: 'p' + i + '.jpg', url: 'data:image/jpeg;base64,' + 'A'.repeat(900000), entityId: 'c1', entityType: 'clients' });
  return out;
}

test('réception serveur : réservée à la direction', async () => {
  const env = makeEnv();
  const cookie = await ownerCookie(env);
  assert.equal((await raw(env, 'PUT', '/api/workspace', { revision: 0, data: empty() })).status, 401);
  const made = await (await raw(env, 'POST', '/api/users', { name: 'M', role: 'gestionnaire' }, cookie)).json();
  const inv = await (await raw(env, 'POST', `/api/users/${made.user.id}/invite`, undefined, cookie)).json();
  const joined = await raw(env, 'POST', '/api/auth/invite/redeem', { token: inv.token, pin: '1234' });
  const memberCookie = joined.headers.getSetCookie()[0].split(';')[0];
  assert.equal((await raw(env, 'PUT', '/api/workspace', { revision: 0, data: empty() }, memberCookie)).status, 403);
  assert.equal((await (await raw(env, 'GET', '/api/workspace', undefined, cookie)).json()).revision, 0);
});
test('réception serveur : données invalides et conflits refusés sans rien changer', async () => {
  const env = makeEnv();
  const cookie = await ownerCookie(env);
  assert.equal((await raw(env, 'PUT', '/api/workspace', { revision: 0, data: { schema: 3 } }, cookie)).status, 400);
  assert.equal((await raw(env, 'PUT', '/api/workspace', { revision: -1, data: empty() }, cookie)).status, 400);
  assert.equal((await raw(env, 'PUT', '/api/workspace', { revision: 5, data: empty() }, cookie)).status, 409);
  const first = realistic();
  assert.equal((await raw(env, 'PUT', '/api/workspace', { revision: 0, data: first }, cookie)).status, 200);
  assert.equal((await raw(env, 'PUT', '/api/workspace', { revision: 0, data: empty() }, cookie)).status, 409);
  const after = await (await raw(env, 'GET', '/api/workspace', undefined, cookie)).json();
  assert.equal(JSON.stringify(after.data), JSON.stringify(first));
  assert.equal(after.revision, 1);
});
test('transfert : copie identique au champ près, y compris anciens champs et caractères spéciaux', async () => {
  const env = makeEnv();
  const store = installBrowser(env, await ownerCookie(env));
  const s = realistic();
  const before = JSON.stringify(s);
  const r = await transferAll(() => s);
  assert.equal(r.done, true);
  assert.equal(JSON.stringify(s), before);
  const remote = await (await fetch('/api/workspace')).json();
  assert.equal(JSON.stringify(remote.data), before);
  assert.equal(remote.data.clients[0].name, 'Brehima Soumaré — « été »');
  assert.equal(remote.data.legacyArchive.reminders.length, 1);
  assert.equal(remote.data.payments[0].void, true);
  assert.deepEqual(r.sent, counts(s));
  assert.equal(readSync().enabled, true);
  assert.equal(readSync().revision, 1);
  assert.equal(store.has('gba-web-v3'), false);
});
test('transfert : les données locales ne sont jamais écrites', async () => {
  const env = makeEnv();
  const store = installBrowser(env, await ownerCookie(env));
  localStorage.setItem('gba-web-v3', 'DONNEES-LOCALES');
  await transferAll(() => realistic());
  assert.equal(store.get('gba-web-v3'), 'DONNEES-LOCALES');
});
test('transfert : une version en ligne inconnue demande confirmation', async () => {
  const env = makeEnv();
  const cookie = await ownerCookie(env);
  installBrowser(env, cookie);
  const other = save(realistic(), 'clients', { id: 'autre', name: 'Autre téléphone' });
  await raw(env, 'PUT', '/api/workspace', { revision: 0, data: other }, cookie);
  const s = realistic();
  const r = await transferAll(() => s);
  assert.equal(r.needsConfirm, true);
  assert.equal(r.remoteCounts.clients, 3);
  assert.equal((await (await fetch('/api/workspace')).json()).data.clients.length, 3);
  assert.equal(readSync().enabled, false);
  const forced = await transferAll(() => s, { overwriteRevision: r.remoteRevision });
  assert.equal(forced.done, true);
  assert.equal((await (await fetch('/api/workspace')).json()).data.clients.length, 2);
});
test('transfert : la confirmation ne vaut que pour la version présentée', async () => {
  const env = makeEnv();
  const cookie = await ownerCookie(env);
  installBrowser(env, cookie);
  await raw(env, 'PUT', '/api/workspace', { revision: 0, data: realistic() }, cookie);
  const s = realistic();
  const seen = await transferAll(() => s);
  assert.equal(seen.needsConfirm, true);
  const newer = save(realistic(), 'clients', { id: 'n', name: 'Publié entre-temps' });
  await raw(env, 'PUT', '/api/workspace', { revision: seen.remoteRevision, data: newer }, cookie);
  const again = await transferAll(() => s, { overwriteRevision: seen.remoteRevision });
  assert.equal(again.needsConfirm, true);
  assert.equal(again.remoteRevision, seen.remoteRevision + 1);
  assert.equal((await (await fetch('/api/workspace')).json()).data.clients.some((c) => c.id === 'n'), true);
});
test('onglet périmé : détecté, et l’envoi automatique reste bloqué', async () => {
  const env = makeEnv();
  installBrowser(env, await ownerCookie(env));
  const s = realistic();
  const stale = { ...s, updatedAt: '2020-01-01T00:00:00.000Z' };
  assert.equal(localIsCurrent(JSON.stringify(s), s), true);
  assert.equal(localIsCurrent(null, s), true);
  assert.equal(localIsCurrent(JSON.stringify(s), stale), false);
  assert.equal(localIsCurrent('illisible', s), false);
  await transferAll(() => s);
  const statuses = [];
  const state = { current: stale };
  const { engine } = engineFor(state, statuses, () => localIsCurrent(JSON.stringify(s), state.current));
  assert.equal(await engine.runNow(), 'off');
  assert.equal((await (await fetch('/api/workspace')).json()).revision, 1);
});
test('pièces jointes déjà en ligne conservées quand elles ne sont plus envoyées', async () => {
  const env = makeEnv();
  installBrowser(env, await ownerCookie(env));
  const state = { current: withAttachments(realistic(), 1) };
  const first = await transferAll(() => state.current);
  assert.equal(first.withoutAttachments, false);
  assert.equal((await (await fetch('/api/workspace')).json()).data.attachments.length, 1);
  state.current = withAttachments(state.current, 3);
  const { engine } = engineFor(state, []);
  assert.equal(await engine.runNow(), 'ok');
  assert.equal(readSync().withoutAttachments, true);
  const remote = await (await fetch('/api/workspace')).json();
  assert.ok(remote.data.attachments.length >= 1, 'la pièce déjà en ligne doit rester');
  assert.equal(remote.data.attachments[0].id, 'a0');
  assert.equal(state.current.attachments.length, 3);
});
test('sauvegarde par clé : mêmes pièces jointes conservées', async () => {
  const env = makeEnv();
  const cookie = await ownerCookie(env);
  installBrowser(env, cookie);
  const withOne = withAttachments(realistic(), 1);
  const auth = { Authorization: 'Bearer ' + KEY };
  assert.equal((await raw(env, 'PUT', '/api/backup', { revision: 0, data: withOne }, null, auth)).status, 200);
  assert.equal((await raw(env, 'PUT', '/api/backup', { revision: 1, data: { ...withOne, attachments: [] }, attachmentsOmitted: true }, null, auth)).status, 200);
  assert.equal((await (await fetch('/api/workspace')).json()).data.attachments.length, 1);
  assert.equal((await raw(env, 'PUT', '/api/backup', { revision: 2, data: { ...withOne, attachments: [] } }, null, auth)).status, 200);
  assert.equal((await (await fetch('/api/workspace')).json()).data.attachments.length, 0);
});
test('la limite de stockage n’est jamais dépassée en gardant les pièces jointes', () => {
  const big = { ...realistic(), attachments: [] };
  big.journal = [{ id: 'j', projectId: 'p1', note: 'x'.repeat(1700000) }];
  const old = JSON.stringify(withAttachments(realistic(), 2));
  // Plutôt que de supprimer des pièces jointes en silence, l'envoi est refusé.
  assert.throws(() => keepAttachments(big, old), /Plus assez de place/);
  // Celles supprimées sur le téléphone ne reviennent pas ; les autres sont gardées.
  const small = { ...realistic(), attachments: [] };
  const two = JSON.parse(old).attachments.map((a) => a.id);
  assert.deepEqual(keepAttachments(small, old, [two[1]]).attachments.map((a) => a.id), [two[1]]);
  assert.equal(keepAttachments(small, old).attachments.length, 2);
  assert.equal(keepAttachments(big, 'illisible'), big);
  assert.equal(keepAttachments(big, null), big);
});
test('transfert : un appareil vide ne remplace jamais une base en ligne', async () => {
  const env = makeEnv();
  const cookie = await ownerCookie(env);
  installBrowser(env, cookie);
  await raw(env, 'PUT', '/api/workspace', { revision: 0, data: realistic() }, cookie);
  await assert.rejects(() => transferAll(() => empty(), { overwriteRevision: 1 }), /vide/);
  assert.equal((await (await fetch('/api/workspace')).json()).data.clients.length, 2);
  assert.equal(looksEmpty(empty()), true);
  assert.equal(looksEmpty(realistic()), false);
});
test('transfert : pièces jointes trop lourdes laissées sur le téléphone, le reste part', async () => {
  const env = makeEnv();
  installBrowser(env, await ownerCookie(env));
  const s = withAttachments(realistic(), 3);
  assert.equal(buildPayload(s, 0).withoutAttachments, true);
  const r = await transferAll(() => s);
  assert.equal(r.withoutAttachments, true);
  assert.equal(r.attachmentsKept, 3);
  assert.equal(s.attachments.length, 3);
  const remote = await (await fetch('/api/workspace')).json();
  assert.equal(remote.data.attachments.length, 0);
  assert.equal(remote.data.clients.length, 2);
  assert.ok(buildPayload(realistic(), 0).body.length < SYNC_LIMIT);
});
test('après transfert, chaque rôle ne reçoit que sa part des vraies données', async () => {
  const env = makeEnv();
  installBrowser(env, await ownerCookie(env));
  await transferAll(() => realistic());
  const remote = await (await fetch('/api/workspace')).json();
  const worker_ = JSON.stringify(viewFor(remote.data, { role: 'ouvrier', projectIds: ['p1'], employeeId: 'e1' }));
  assert.equal(worker_.includes('Soumaré —'), false);
  assert.equal(worker_.includes('5000000'), false);
  assert.equal(worker_.includes('nextQuote'), false);
  assert.equal(worker_.includes('300000'), true);
});
function engineFor(state, statuses, canRun) {
  const timers = { calls: [], setTimeout(fn, ms) { this.calls.push({ fn, ms }); return this.calls.length; }, clearTimeout() {} };
  return { timers, engine: createSyncEngine({ getState: () => state.current, canRun, onStatus: (s) => statuses.push(s), timers }) };
}
test('envoi automatique : désactivé tant que le transfert n’a pas réussi', async () => {
  const env = makeEnv();
  installBrowser(env, await ownerCookie(env));
  const statuses = [];
  const { engine } = engineFor({ current: realistic() }, statuses);
  assert.equal(await engine.runNow(), 'off');
  assert.deepEqual(statuses, []);
  assert.equal((await (await fetch('/api/workspace')).json()).revision, 0);
});
test('envoi automatique : une nouvelle saisie part et la révision suit', async () => {
  const env = makeEnv();
  installBrowser(env, await ownerCookie(env));
  const state = { current: realistic() };
  await transferAll(() => state.current);
  const statuses = [];
  const { engine } = engineFor(state, statuses);
  state.current = save(state.current, 'clients', { id: 'c3', name: 'Nouveau client' });
  assert.equal(await engine.runNow(), 'ok');
  assert.equal(readSync().revision, 2);
  const remote = await (await fetch('/api/workspace')).json();
  assert.equal(JSON.stringify(remote.data), JSON.stringify(state.current));
  assert.equal(await engine.runNow(), 'ok');
  assert.equal(readSync().revision, 2);
});
test('envoi automatique : un conflit arrête tout sans écraser', async () => {
  const env = makeEnv();
  const cookie = await ownerCookie(env);
  installBrowser(env, cookie);
  const state = { current: realistic() };
  await transferAll(() => state.current);
  const elsewhere = save(state.current, 'clients', { id: 'z', name: 'Saisi ailleurs' });
  await raw(env, 'PUT', '/api/workspace', { revision: 1, data: elsewhere }, cookie);
  state.current = save(state.current, 'clients', { id: 'c3', name: 'Local' });
  const statuses = [];
  const { engine } = engineFor(state, statuses);
  assert.equal(await engine.runNow(), 'conflict');
  const remote = await (await fetch('/api/workspace')).json();
  assert.equal(remote.data.clients.some((c) => c.id === 'z'), true);
  assert.equal(remote.data.clients.some((c) => c.id === 'c3'), false);
});
test('envoi automatique : sans réseau, réessaie plus tard et garde la révision', async () => {
  const env = makeEnv();
  installBrowser(env, await ownerCookie(env));
  const state = { current: realistic() };
  await transferAll(() => state.current);
  const working = globalThis.fetch;
  globalThis.fetch = async () => { throw new TypeError('hors ligne'); };
  state.current = save(state.current, 'clients', { id: 'c3', name: 'Hors ligne' });
  const statuses = [];
  const { engine, timers } = engineFor(state, statuses);
  assert.equal(await engine.runNow(), 'retry');
  assert.equal(readSync().revision, 1);
  assert.equal(timers.calls.at(-1).ms, 60000);
  globalThis.fetch = working;
  assert.equal(await engine.runNow(), 'ok');
  assert.equal((await (await fetch('/api/workspace')).json()).data.clients.some((c) => c.id === 'c3'), true);
});
test('envoi automatique : données vides ou illisibles jamais envoyées', async () => {
  const env = makeEnv();
  installBrowser(env, await ownerCookie(env));
  const state = { current: realistic() };
  await transferAll(() => state.current);
  state.current = empty();
  const statuses = [];
  assert.equal(await engineFor(state, statuses).engine.runNow(), 'empty');
  state.current = save(realistic(), 'clients', { id: 'c3', name: 'X' });
  assert.equal(await engineFor(state, [], () => false).engine.runNow(), 'off');
  assert.equal((await (await fetch('/api/workspace')).json()).revision, 1);
});
test('envoi automatique : session expirée signalée, rien de perdu', async () => {
  const env = makeEnv();
  const cookie = await ownerCookie(env);
  installBrowser(env, cookie);
  const state = { current: realistic() };
  await transferAll(() => state.current);
  await raw(env, 'POST', '/api/auth/logout', undefined, cookie);
  state.current = save(state.current, 'clients', { id: 'c3', name: 'X' });
  const statuses = [];
  assert.equal(await engineFor(state, statuses).engine.runNow(), 'auth');
  assert.equal(statuses.at(-1), 'auth');
  writeSync({ enabled: false });
});
