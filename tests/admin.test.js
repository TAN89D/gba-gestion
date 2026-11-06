import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker from '../worker.js';
import { empty, apply, validate } from '../src/domain.js';
import { overview, projectRows, invoiceRows, expenseRows, workerRows, activityRows } from '../src/adminData.js';

const save = (s, t, d) => apply(s, { type: 'save', table: t, data: d });
function sample() {
  let s = empty();
  s = save(s, 'accounts', { id: 'om', name: 'Orange Money', opening: 0 });
  s = apply(s, { type: 'cash', data: { accountId: 'main', amount: 1000000, label: 'Apport' } });
  s = save(s, 'clients', { id: 'c', name: 'Client A' });
  s = save(s, 'projects', { id: 'p', name: 'Villa', clientId: 'c', contractAmount: 2000000, budget: 300000, status: 'En cours' });
  s = save(s, 'projects', { id: 'q', name: 'Fini', clientId: 'c', contractAmount: 100000, budget: 0, status: 'Terminé' });
  s = save(s, 'employees', { id: 'e', name: 'Moussa', role: 'Maçon' });
  s = save(s, 'employees', { id: 'f', name: 'Sans tâche' });
  s = save(s, 'tasks', { id: 't', employeeId: 'e', projectId: 'p', description: 'Pose', agreedAmount: 250000 });
  s = apply(s, { type: 'teamPayment', data: { taskId: 't', accountId: 'main', amount: 100000 } });
  s = apply(s, { type: 'invoice', data: { id: 'i', clientId: 'c', projectId: 'p', date: '2026-01-01', dueDate: '2026-02-01', tax: 18, lines: [{ description: 'Travaux', quantity: 1, unitPrice: 1000000 }] } });
  s = apply(s, { type: 'payment', data: { id: 'ok', invoiceId: 'i', accountId: 'main', amount: 400000 } });
  s = apply(s, { type: 'payment', data: { id: 'bad', invoiceId: 'i', accountId: 'main', amount: 5000 } });
  s = apply(s, { type: 'void', table: 'payments', id: 'bad', reason: 'Erreur' });
  s = save(s, 'expenses', { id: 'x', scope: 'Chantier', projectId: 'p', accountId: 'main', description: 'Ciment', amount: 200000, category: 'Matériaux' });
  s = save(s, 'expenses', { id: 'y', scope: 'Entreprise', accountId: 'main', description: 'Annulée', amount: 7000 });
  s = apply(s, { type: 'void', table: 'expenses', id: 'y', reason: 'Erreur' });
  s = save(s, 'materials', { id: 'm', description: 'Ciment', unit: 'sac', opening: 3, threshold: 5, lastPrice: 1 });
  s = save(s, 'materials', { id: 'n', description: 'Sans seuil', unit: 'u', opening: 0, threshold: 0, lastPrice: 1 });
  return validate(s);
}
test('vue d’ensemble : montants justes, annulations exclues', () => {
  const o = overview(sample(), '2026-06-01');
  assert.equal(o.received, 400000);
  assert.equal(o.invoiced, 1180000);
  assert.equal(o.toCollect, 780000);
  assert.equal(o.expenses, 200000);
  assert.equal(o.teamPaid, 100000);
  assert.equal(o.teamDue, 150000);
  assert.equal(o.cash, 1000000 + 400000 - 200000 - 100000);
  assert.deepEqual(o.accounts.map((a) => a.balance), [1100000, 0]);
  assert.equal(o.activeProjects, 1);
});
test('alertes : retard, budget et stock', () => {
  const o = overview(sample(), '2026-06-01');
  assert.deepEqual(o.late.map((x) => [x.number.slice(0, 5), x.client, x.amount]), [['GBA-F', 'Client A', 780000]]);
  assert.deepEqual(o.overBudget, [{ id: 'p', name: 'Villa', over: 150000 }]);
  assert.deepEqual(o.lowStock.map((x) => x.name), ['Ciment']);
  assert.equal(overview(sample(), '2026-01-15').late.length, 0);
});
test('chantiers : contrat, coût engagé et marge', () => {
  const [villa] = projectRows(sample());
  assert.equal(villa.client, 'Client A');
  assert.equal(villa.received, 400000);
  assert.equal(villa.forecast, 450000);
  assert.equal(villa.used, 150);
  assert.equal(villa.margin, 2000000 - 200000 - 250000);
  assert.equal(projectRows(sample())[1].used, null);
});
test('un ancien paiement sans chantier compte dans le chantier de sa facture', () => {
  const s = sample();
  delete s.payments[0].projectId;
  assert.equal(projectRows(s)[0].received, 400000);
  assert.equal(overview(s).received, 400000);
});
test('factures, dépenses, paie et activité', () => {
  const s = sample();
  const [inv] = invoiceRows(s);
  assert.deepEqual([inv.total, inv.paid, inv.left, inv.status], [1180000, 400000, 780000, 'Partiellement payée']);
  const rows = expenseRows(s);
  assert.equal(rows.find((r) => r.id === 'y').void, true);
  assert.equal(rows.find((r) => r.id === 'x').project, 'Villa');
  const w = workerRows(s);
  assert.deepEqual([w[0].agreed, w[0].paid, w[0].left], [250000, 100000, 150000]);
  assert.deepEqual([w[1].agreed, w[1].left], [0, 0]);
  const log = activityRows(s);
  assert.equal(log.length, s.audit.length);
  assert.equal(log[0].id, s.audit.at(-1).id);
  assert.equal(activityRows(s, 2).length, 2);
});
test('tableau de bord : base vide sans erreur', () => {
  const s = empty();
  const o = overview(s);
  assert.equal(o.cash, 0);
  assert.deepEqual([projectRows(s), invoiceRows(s), expenseRows(s), workerRows(s), activityRows(s)], [[], [], [], [], []]);
});

const KEY = 'cle-de-test-avec-plus-de-trente-deux-caracteres';
function makeEnv(extra = {}) {
  const db = new DatabaseSync(':memory:');
  for (const f of ['0001_workspace.sql', '0002_team.sql', '0003_entries.sql', '0004_requests.sql', '0005_presence.sql', '0006_companies.sql']) db.exec(readFileSync(new URL('../migrations/' + f, import.meta.url), 'utf8'));
  const wrap = (sql, args = []) => ({
    bind: (...a) => wrap(sql, a),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...args).changes) } }),
  });
  return { DB: { prepare: (sql) => wrap(sql) }, BACKUP_TOKEN: KEY, ASSETS: { fetch: async () => new Response('page') }, ...extra };
}
async function raw(env, method, path, body, cookie, extra = {}) {
  const headers = new Headers(extra);
  if (cookie) headers.set('Cookie', cookie);
  if (body) headers.set('Content-Type', 'application/json');
  return worker.fetch(new Request('https://gba.example' + path, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) }), env);
}
test('configuration publique : seulement savoir si Google est actif', async () => {
  const off = await (await raw(makeEnv(), 'GET', '/api/config')).json();
  assert.deepEqual(off, { google: false, signup: false });
  const on = await (await raw(makeEnv({ GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret-tres-prive' }), 'GET', '/api/config')).text();
  assert.equal(on, '{"google":true,"signup":false}');
});
test('la direction ne peut pas se retirer elle-même, même avec un second compte', async () => {
  const env = makeEnv();
  const owner = await raw(env, 'POST', '/api/setup', {}, null, { Authorization: 'Bearer ' + KEY });
  const cookie = owner.headers.getSetCookie()[0].split(';')[0];
  const me = (await owner.json()).user;
  assert.equal((await raw(env, 'POST', '/api/users', { name: 'Second', role: 'direction' }, cookie)).status, 201);
  assert.equal((await raw(env, 'PATCH', `/api/users/${me.id}`, { role: 'gestionnaire' }, cookie)).status, 409);
  assert.equal((await raw(env, 'PATCH', `/api/users/${me.id}`, { active: false }, cookie)).status, 409);
  const renamed = await raw(env, 'PATCH', `/api/users/${me.id}`, { name: 'Patron' }, cookie);
  assert.equal(renamed.status, 200);
  assert.equal((await renamed.json()).user.role, 'direction');
});
test('accès : appareils et connexions comptés, liste réservée à la direction', async () => {
  const env = makeEnv();
  const owner = await raw(env, 'POST', '/api/setup', {}, null, { Authorization: 'Bearer ' + KEY });
  const cookie = owner.headers.getSetCookie()[0].split(';')[0];
  const made = await (await raw(env, 'POST', '/api/users', { name: 'Moussa', role: 'ouvrier' }, cookie)).json();
  const inv = await (await raw(env, 'POST', `/api/users/${made.user.id}/invite`, null, cookie)).json();
  const joined = await raw(env, 'POST', '/api/auth/invite/redeem', { token: inv.token, pin: '1234' });
  const member = joined.headers.getSetCookie()[0].split(';')[0];
  const list = (await (await raw(env, 'GET', '/api/users', null, cookie)).json()).users;
  const moussa = list.find((u) => u.name === 'Moussa');
  assert.deepEqual([moussa.devices, moussa.sessions], [1, 1]);
  assert.equal(list.find((u) => u.role === 'direction').sessions, 1);
  assert.equal(JSON.stringify(list).includes('pin_hash'), false);
  assert.equal(JSON.stringify(list).includes('secret_hash'), false);
  assert.equal((await raw(env, 'GET', '/api/users', null, member)).status, 403);
  await raw(env, 'PATCH', `/api/users/${made.user.id}`, { active: false }, cookie);
  const after = (await (await raw(env, 'GET', '/api/users', null, cookie)).json()).users.find((u) => u.name === 'Moussa');
  assert.deepEqual([after.devices, after.sessions, after.active], [0, 0, false]);
});
