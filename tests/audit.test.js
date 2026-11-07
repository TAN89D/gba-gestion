import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker from '../worker.js';
import { empty, apply, validate, demo, overdue } from '../src/domain.js';
import { transferAll, createSyncEngine, writeSync, isDemo } from '../src/sync.js';
import { pullApproved } from '../src/entries.js';

// Corrections issues de l'audit complet.
const KEY = 'cle-de-test-avec-plus-de-trente-deux-caracteres';
const save = (s, t, d) => apply(s, { type: 'save', table: t, data: d });
function makeEnv() {
  const db = new DatabaseSync(':memory:');
  for (const f of ['0001_workspace.sql', '0002_team.sql', '0003_entries.sql', '0004_requests.sql', '0005_presence.sql', '0006_companies.sql', '0007_limits.sql']) db.exec(readFileSync(new URL('../migrations/' + f, import.meta.url), 'utf8'));
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
  return worker.fetch(new Request('https://gba.example' + path, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }), env);
}
function sample() {
  let s = empty();
  s = save(s, 'clients', { id: 'c', name: 'Client' });
  s = save(s, 'projects', { id: 'p1', name: 'A', clientId: 'c', contractAmount: 0, budget: 0 });
  s = save(s, 'projects', { id: 'p2', name: 'B', clientId: 'c', contractAmount: 0, budget: 0 });
  s = save(s, 'employees', { id: 'e1', name: 'Moussa' });
  s = save(s, 'employees', { id: 'e2', name: 'Awa' });
  s = save(s, 'tasks', { id: 't', employeeId: 'e1', projectId: 'p1', description: 'Pose', agreedAmount: 100000 });
  return validate(s);
}
async function world(state = sample()) {
  const env = makeEnv();
  const owner = await raw(env, 'POST', '/api/setup', {}, null, { Authorization: 'Bearer ' + KEY });
  const boss = owner.headers.getSetCookie()[0].split(';')[0];
  await raw(env, 'PUT', '/api/workspace', { revision: 0, data: state }, boss);
  const made = await (await raw(env, 'POST', '/api/users', { name: 'Fatou', role: 'gestionnaire' }, boss)).json();
  const inv = await (await raw(env, 'POST', `/api/users/${made.user.id}/invite`, undefined, boss)).json();
  const g = (await raw(env, 'POST', '/api/auth/invite/redeem', { token: inv.token, pin: '1234' })).headers.getSetCookie()[0].split(';')[0];
  return { env, boss, g };
}

test('critique : la démonstration ne remplace jamais la base commune', async () => {
  const { env, boss } = await world();
  assert.equal(isDemo(demo()), true);
  assert.equal((await raw(env, 'PUT', '/api/workspace', { revision: 1, data: demo() }, boss)).status, 400);
  assert.equal((await raw(env, 'PUT', '/api/backup', { revision: 1, data: demo() }, null, { Authorization: 'Bearer ' + KEY })).status, 400);
  const store = new Map();
  globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
  globalThis.fetch = async (path, o = {}) => raw(env, o.method || 'GET', path, o.body ? JSON.parse(o.body) : undefined, boss);
  writeSync({ enabled: true, revision: 1 });
  const statuses = [];
  const engine = createSyncEngine({ getState: () => demo(), onStatus: (x) => statuses.push(x), timers: { setTimeout() {}, clearTimeout() {} } });
  assert.equal(await engine.runNow(), 'demo');
  await assert.rejects(() => transferAll(() => demo(), { overwriteRevision: 1 }), /démonstration/);
  const remote = await (await raw(env, 'GET', '/api/workspace', undefined, boss)).json();
  assert.equal(remote.revision, 1);
  assert.equal(remote.data.demo, undefined);
});
test('un renvoi après réponse perdue retourne la saisie déjà enregistrée', async () => {
  const { env, g } = await world();
  const body = { id: 'paiement-renvoye-1', kind: 'teamPayment', projectId: 'p1', taskId: 't', amount: 100000 };
  assert.equal((await raw(env, 'POST', '/api/entries', body, g)).status, 201);
  const again = await raw(env, 'POST', '/api/entries', body, g);
  assert.equal(again.status, 200);
  assert.equal((await again.json()).entry.data.amount, 100000);
  assert.equal((await raw(env, 'POST', '/api/entries', { ...body, id: 'autre-identifiant-1' }, g)).status, 400, 'le solde reste protégé');
});
test('un paiement validé ne suit pas une tâche déplacée', async () => {
  const start = sample();
  const { env, boss, g } = await world(start);
  const id = (await (await raw(env, 'POST', '/api/entries', { kind: 'teamPayment', projectId: 'p1', taskId: 't', amount: 30000 }, g)).json()).entry.id;
  const moved = save(start, 'tasks', { id: 't', employeeId: 'e1', projectId: 'p2', description: 'Pose', agreedAmount: 100000 });
  await raw(env, 'PUT', '/api/workspace', { revision: 1, data: moved }, boss);
  assert.equal((await raw(env, 'POST', `/api/entries/${id}/decision`, { decision: 'approve', accountId: 'main' }, boss)).status, 409);
  const reassigned = save(start, 'tasks', { id: 't', employeeId: 'e2', projectId: 'p1', description: 'Pose', agreedAmount: 100000 });
  await raw(env, 'PUT', '/api/workspace', { revision: 2, data: reassigned }, boss);
  assert.equal((await raw(env, 'POST', `/api/entries/${id}/decision`, { decision: 'approve', accountId: 'main' }, boss)).status, 409);
  await raw(env, 'PUT', '/api/workspace', { revision: 3, data: start }, boss);
  assert.equal((await raw(env, 'POST', `/api/entries/${id}/decision`, { decision: 'approve', accountId: 'main' }, boss)).status, 200);
  let state = moved;
  const fetcher = (path, o = {}) => raw(env, o.method || 'GET', path, o.body ? JSON.parse(o.body) : undefined, boss);
  const r = await pullApproved({ getState: () => state, commit: (n) => { state = n; }, fetcher });
  assert.deepEqual(r, { applied: 0, failed: 1, retry: false });
  assert.equal(state.teamPayments.length, 0);
});
test('ancienne saisie sans ouvrier : l’ouvrier est figé à la validation', async () => {
  const start = sample();
  const { env, boss, g } = await world(start);
  const id = (await (await raw(env, 'POST', '/api/entries', { kind: 'teamPayment', projectId: 'p1', taskId: 't', amount: 30000 }, g)).json()).entry.id;
  await env.DB.prepare("UPDATE entries SET data=json_remove(data,'$.employeeId') WHERE id=?").bind(id).run();
  assert.equal((await raw(env, 'POST', `/api/entries/${id}/decision`, { decision: 'approve', accountId: 'main' }, boss)).status, 200);
  const stored = (await (await raw(env, 'GET', '/api/entries', undefined, boss)).json()).entries.find((e) => e.id === id);
  assert.equal(stored.data.employeeId, 'e1');
  let state = save(start, 'tasks', { id: 't', employeeId: 'e2', projectId: 'p1', description: 'Pose', agreedAmount: 100000 });
  const fetcher = (path, o = {}) => raw(env, o.method || 'GET', path, o.body ? JSON.parse(o.body) : undefined, boss);
  assert.deepEqual(await pullApproved({ getState: () => state, commit: (n) => { state = n; }, fetcher }), { applied: 0, failed: 1, retry: false });
  assert.equal(state.teamPayments.length, 0);
});
test('un renvoi est confirmé même si le chantier n’est plus attribué', async () => {
  const { env, boss } = await world();
  const made = await (await raw(env, 'POST', '/api/users', { name: 'Seydou', role: 'chef', projectIds: ['p1'] }, boss)).json();
  const inv = await (await raw(env, 'POST', `/api/users/${made.user.id}/invite`, undefined, boss)).json();
  const chef = (await raw(env, 'POST', '/api/auth/invite/redeem', { token: inv.token, pin: '1234' })).headers.getSetCookie()[0].split(';')[0];
  const body = { id: 'incident-renvoye-1', kind: 'incident', projectId: 'p1', note: 'Fuite' };
  assert.equal((await raw(env, 'POST', '/api/entries', body, chef)).status, 201);
  await raw(env, 'PATCH', `/api/users/${made.user.id}`, { projectIds: [] }, boss);
  assert.equal((await raw(env, 'POST', '/api/entries', body, chef)).status, 200);
  assert.equal((await raw(env, 'POST', '/api/entries', { ...body, id: 'nouvel-incident-1' }, chef)).status, 403);
});
test('dates de saisie : vide = aujourd’hui, invalide = refusée', async () => {
  const { env, g } = await world();
  const ok = await (await raw(env, 'POST', '/api/entries', { kind: 'incident', projectId: 'p1', note: 'x' }, g)).json();
  assert.match(ok.entry.data.date, /^\d{4}-\d{2}-\d{2}$/);
  for (const date of ['2026-99-99', '2026-02-30', 'hier', '2026-1-5']) assert.equal((await raw(env, 'POST', '/api/entries', { kind: 'incident', projectId: 'p1', note: 'x', date }, g)).status, 400, date);
  assert.equal((await raw(env, 'POST', '/api/entries', { kind: 'incident', projectId: 'p1', note: 'x', date: '2028-02-29' }, g)).status, 201);
});
test('relances : la part hors échéancier n’est plus oubliée', () => {
  let s = sample();
  s = apply(s, { type: 'invoice', data: { id: 'i', clientId: 'c', date: '2026-01-01', dueDate: '2026-02-01', lines: [{ description: 'X', quantity: 1, unitPrice: 1000 }] } });
  s = save(s, 'schedules', { invoiceId: 'i', dueDate: '2026-01-15', amount: 100 });
  s = apply(s, { type: 'payment', data: { invoiceId: 'i', accountId: 'main', amount: 100 } });
  assert.equal(overdue(s, '2026-01-20').length, 0, 'avant l’échéance globale');
  const late = overdue(s, '2026-03-01');
  assert.equal(late[0].amount, 900);
  assert.equal(late[0].date, '2026-02-01');
  s = apply(s, { type: 'payment', data: { invoiceId: 'i', accountId: 'main', amount: 400 } });
  assert.equal(overdue(s, '2026-03-01')[0].amount, 500);
});
test('relances : échéancier partiel en retard + part hors échéancier', () => {
  let s = sample();
  s = apply(s, { type: 'invoice', data: { id: 'i', clientId: 'c', date: '2026-01-01', dueDate: '2026-03-01', lines: [{ description: 'X', quantity: 1, unitPrice: 1000 }] } });
  s = save(s, 'schedules', { invoiceId: 'i', dueDate: '2026-01-15', amount: 300 });
  assert.deepEqual(overdue(s, '2026-02-01').map((x) => [x.amount, x.date]), [[300, '2026-01-15']]);
  assert.deepEqual(overdue(s, '2026-04-01').map((x) => [x.amount, x.date]), [[1000, '2026-01-15']]);
});
test('une commande reçue ne revient pas en arrière', () => {
  let s = sample();
  s = save(s, 'suppliers', { id: 'f', name: 'F' });
  s = save(s, 'orders', { id: 'o', supplierId: 'f', description: 'Fer', amount: 100 });
  s = apply(s, { type: 'delivery', data: { orderId: 'o' } });
  assert.throws(() => save(s, 'orders', { ...s.orders[0], status: 'Commandé' }), /réceptionnée/);
  assert.throws(() => apply(s, { type: 'delivery', data: { orderId: 'o' } }), /réceptionnée/);
  assert.equal(save(s, 'orders', { ...s.orders[0], description: 'Fer 12 mm' }).orders[0].status, 'Reçu');
});
test('dépense de chantier sans chantier : message clair', () => {
  assert.throws(() => save(sample(), 'expenses', { scope: 'Chantier', projectId: '', accountId: 'main', description: 'X', amount: 10 }), /Choisissez le chantier/);
});
test('un second compte de direction peut être invité et rejoint le tableau de bord', async () => {
  const { env, boss } = await world();
  const made = await (await raw(env, 'POST', '/api/users', { name: 'Associé', role: 'direction' }, boss)).json();
  const inv = await raw(env, 'POST', `/api/users/${made.user.id}/invite`, undefined, boss);
  assert.equal(inv.status, 201);
  const joined = await raw(env, 'POST', '/api/auth/invite/redeem', { token: (await inv.json()).token, pin: '4321' });
  const cookie = joined.headers.getSetCookie()[0].split(';')[0];
  assert.equal((await raw(env, 'GET', '/api/users', undefined, cookie)).status, 200);
});
