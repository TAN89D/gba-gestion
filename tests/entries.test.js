import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker from '../worker.js';
import { empty, apply, validate, balance } from '../src/domain.js';
import { pullApproved, entryToAction, reservedOn } from '../src/entries.js';
import { reportHtml } from '../src/report.js';
import { viewFor } from '../src/permissions.js';

const KEY = 'cle-de-test-avec-plus-de-trente-deux-caracteres';
const PHOTO = 'data:image/jpeg;base64,AAAA';
const save = (s, t, d) => apply(s, { type: 'save', table: t, data: d });
function sample() {
  let s = empty();
  s = save(s, 'clients', { id: 'c', name: 'Client' });
  s = save(s, 'projects', { id: 'p1', name: 'Villa', clientId: 'c', contractAmount: 900000, budget: 500000, managerBudget: 100000, status: 'En cours' });
  s = save(s, 'projects', { id: 'p2', name: 'Autre', clientId: 'c', contractAmount: 1, budget: 1 });
  s = save(s, 'employees', { id: 'e', name: 'Moussa' });
  s = save(s, 'tasks', { id: 't', employeeId: 'e', projectId: 'p1', description: 'Pose', agreedAmount: 200000 });
  s = apply(s, { type: 'teamPayment', data: { id: 'old', taskId: 't', accountId: 'main', amount: 50000 } });
  s = apply(s, { type: 'cash', data: { accountId: 'main', amount: 1000000, label: 'Apport' } });
  return validate(s);
}
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
async function world(state = sample()) {
  const env = makeEnv();
  const owner = await raw(env, 'POST', '/api/setup', {}, null, { Authorization: 'Bearer ' + KEY });
  const boss = owner.headers.getSetCookie()[0].split(';')[0];
  await raw(env, 'PUT', '/api/workspace', { revision: 0, data: state }, boss);
  const member = async (role, extra = {}) => {
    const made = await (await raw(env, 'POST', '/api/users', { name: role + ' test', role, ...extra }, boss)).json();
    const inv = await (await raw(env, 'POST', `/api/users/${made.user.id}/invite`, undefined, boss)).json();
    const joined = await raw(env, 'POST', '/api/auth/invite/redeem', { token: inv.token, pin: '1234' });
    return joined.headers.getSetCookie()[0].split(';')[0];
  };
  return { env, boss, member };
}
const post = async (env, cookie, body) => raw(env, 'POST', '/api/entries', body, cookie);
const json = async (res) => res.json();

test('gestionnaire : dépense, scan, paiement, incident et photo sur tous les chantiers', async () => {
  const { env, member } = await world();
  const g = await member('gestionnaire');
  const expense = await json(await post(env, g, { kind: 'expense', projectId: 'p2', description: 'Ciment', amount: 15000, photo: PHOTO }));
  assert.equal(expense.entry.status, 'pending');
  assert.equal(expense.entry.hasPhoto, true);
  assert.equal(JSON.stringify(expense).includes('AAAA'), false);
  assert.equal((await json(await post(env, g, { kind: 'teamPayment', projectId: 'p1', taskId: 't', amount: 100000 }))).entry.status, 'pending');
  assert.equal((await json(await post(env, g, { kind: 'incident', projectId: 'p1', note: 'Fuite' }))).entry.status, 'open');
  assert.equal((await json(await post(env, g, { kind: 'photo', projectId: 'p1', photo: PHOTO, note: 'Dalle' }))).entry.status, 'info');
});
test('contrôles : montants, photo, tâche, chantier et reste à payer', async () => {
  const { env, member } = await world();
  const g = await member('gestionnaire');
  const cases = [
    [{ kind: 'expense', projectId: 'p1', description: 'X', amount: 0 }, 400],
    [{ kind: 'expense', projectId: 'p1', description: 'X', amount: 10.5 }, 400],
    [{ kind: 'expense', projectId: 'p1', description: '', amount: 10 }, 400],
    [{ kind: 'expense', projectId: 'inconnu', description: 'X', amount: 10 }, 403],
    [{ kind: 'photo', projectId: 'p1' }, 400],
    [{ kind: 'photo', projectId: 'p1', photo: 'data:text/html;base64,AAAA' }, 400],
    [{ kind: 'photo', projectId: 'p1', photo: 'javascript:alert(1)' }, 400],
    [{ kind: 'incident', projectId: 'p1', note: '' }, 400],
    [{ kind: 'teamPayment', projectId: 'p2', taskId: 't', amount: 10 }, 400],
    [{ kind: 'teamPayment', projectId: 'p1', taskId: 't', amount: 150001 }, 400],
    [{ kind: 'facture', projectId: 'p1' }, 403],
  ];
  for (const [body, status] of cases) assert.equal((await post(env, g, body)).status, status, JSON.stringify(body));
  assert.equal((await post(env, g, { kind: 'teamPayment', projectId: 'p1', taskId: 't', amount: 100000 })).status, 201);
  assert.equal((await post(env, g, { kind: 'teamPayment', projectId: 'p1', taskId: 't', amount: 50001 })).status, 400, 'les paiements en attente comptent');
});
test('un envoi répété ne crée pas de doublon', async () => {
  const { env, member, boss } = await world();
  const g = await member('gestionnaire');
  const body = { kind: 'expense', id: 'identifiant-unique-1', projectId: 'p1', description: 'X', amount: 10 };
  await post(env, g, body); await post(env, g, body);
  assert.equal((await json(await raw(env, 'GET', '/api/entries', undefined, boss))).entries.length, 1);
  const c = await member('chef', { projectIds: ['p1'] });
  assert.equal((await post(env, g, { ...body, id: 'identifiant-unique-2' })).status, 201);
  const stolen = await post(env, await member('gestionnaire', { name: 'Autre' }), body);
  assert.equal(stolen.status, 409);
  assert.ok(c);
});
test('chef et ouvrier : photos et incidents seulement, sur leurs chantiers', async () => {
  const { env, member, boss } = await world();
  const c = await member('chef', { projectIds: ['p1'] });
  const w = await member('ouvrier', { employeeId: 'e' });
  const g = await member('gestionnaire');
  const money = await json(await post(env, g, { kind: 'expense', projectId: 'p1', description: 'MONTANT-CACHE', amount: 777111, photo: PHOTO }));
  for (const cookie of [c, w]) {
    assert.equal((await post(env, cookie, { kind: 'expense', projectId: 'p1', description: 'X', amount: 10 })).status, 403);
    assert.equal((await post(env, cookie, { kind: 'teamPayment', projectId: 'p1', taskId: 't', amount: 10 })).status, 403);
    assert.equal((await post(env, cookie, { kind: 'photo', projectId: 'p2', photo: PHOTO })).status, 403);
    assert.equal((await post(env, cookie, { kind: 'photo', projectId: 'p1', photo: PHOTO })).status, 201);
    const seen = JSON.stringify(await json(await raw(env, 'GET', '/api/entries', undefined, cookie)));
    assert.equal(seen.includes('MONTANT-CACHE'), false);
    assert.equal(seen.includes('777111'), false);
    assert.equal((await raw(env, 'GET', `/api/entries/${money.entry.id}/photo`, undefined, cookie)).status, 404);
    assert.equal((await raw(env, 'GET', '/api/entries/to-apply', undefined, cookie)).status, 403);
    assert.equal((await raw(env, 'POST', `/api/entries/${money.entry.id}/decision`, { decision: 'approve', accountId: 'main' }, cookie)).status, 403);
  }
  assert.equal((await raw(env, 'POST', `/api/entries/${money.entry.id}/decision`, { decision: 'approve', accountId: 'main' }, g)).status, 403, 'le gestionnaire ne valide pas lui-même');
  assert.equal((await raw(env, 'GET', `/api/entries/${money.entry.id}/photo`, undefined, boss)).status, 200);
  assert.equal((await raw(env, 'GET', '/api/entries')).status, 401);
  assert.equal((await post(env, null, { kind: 'photo', projectId: 'p1', photo: PHOTO })).status, 401);
});
test('validation : caisse obligatoire, une seule décision, motif de refus', async () => {
  const { env, member, boss } = await world();
  const g = await member('gestionnaire');
  const a = (await json(await post(env, g, { kind: 'expense', projectId: 'p1', description: 'A', amount: 10 }))).entry.id;
  const b = (await json(await post(env, g, { kind: 'expense', projectId: 'p1', description: 'B', amount: 20 }))).entry.id;
  const i = (await json(await post(env, g, { kind: 'incident', projectId: 'p1', note: 'Fuite' }))).entry.id;
  const decide = (id, body) => raw(env, 'POST', `/api/entries/${id}/decision`, body, boss);
  assert.equal((await decide(a, { decision: 'approve' })).status, 400);
  assert.equal((await decide(a, { decision: 'approve', accountId: 'inconnue' })).status, 400);
  assert.equal((await decide(a, { decision: 'approve', accountId: 'main' })).status, 200);
  assert.equal((await decide(a, { decision: 'reject', reason: 'Non' })).status, 409);
  assert.equal((await decide(b, { decision: 'reject' })).status, 400);
  assert.equal((await json(await decide(b, { decision: 'reject', reason: 'Trop cher' }))).entry.reason, 'Trop cher');
  assert.equal((await decide(i, { decision: 'approve', accountId: 'main' })).status, 400);
  assert.equal((await json(await decide(i, { decision: 'resolve' }))).entry.status, 'resolved');
});
test('après validation, le téléphone enregistre les saisies une seule fois', async () => {
  const start = sample();
  const { env, member, boss } = await world(start);
  const g = await member('gestionnaire');
  const e1 = (await json(await post(env, g, { kind: 'expense', projectId: 'p1', description: 'Ciment', amount: 15000 }))).entry.id;
  const e2 = (await json(await post(env, g, { kind: 'teamPayment', projectId: 'p1', taskId: 't', amount: 100000 }))).entry.id;
  const refused = (await json(await post(env, g, { kind: 'expense', projectId: 'p1', description: 'Refusée', amount: 99 }))).entry.id;
  await raw(env, 'POST', `/api/entries/${e1}/decision`, { decision: 'approve', accountId: 'main' }, boss);
  await raw(env, 'POST', `/api/entries/${e2}/decision`, { decision: 'approve', accountId: 'main' }, boss);
  await raw(env, 'POST', `/api/entries/${refused}/decision`, { decision: 'reject', reason: 'Non' }, boss);
  let state = start;
  const fetcher = (path, o = {}) => raw(env, o.method || 'GET', path, o.body ? JSON.parse(o.body) : undefined, boss);
  const run = () => pullApproved({ getState: () => state, commit: (n) => { state = n; }, fetcher });
  const before = balance(state, 'main');
  assert.deepEqual(await run(), { applied: 2, failed: 0, retry: false });
  assert.equal(state.expenses.find((x) => x.id === e1).projectId, 'p1');
  assert.equal(state.teamPayments.find((x) => x.id === e2).amount, 100000);
  assert.equal(state.expenses.some((x) => x.id === refused), false);
  assert.equal(balance(state, 'main'), before - 115000);
  assert.equal(validate(state), state);
  assert.deepEqual(await run(), { applied: 0, failed: 0, retry: false });
  assert.equal(state.expenses.length, 1);
});
test('une saisie validée impossible à enregistrer est signalée, sans rien casser', async () => {
  const start = sample();
  const { env, member, boss } = await world(start);
  const g = await member('gestionnaire');
  const id = (await json(await post(env, g, { kind: 'teamPayment', projectId: 'p1', taskId: 't', amount: 100000 }))).entry.id;
  await raw(env, 'POST', `/api/entries/${id}/decision`, { decision: 'approve', accountId: 'main' }, boss);
  let state = apply(start, { type: 'teamPayment', data: { id: 'entre-temps', taskId: 't', accountId: 'main', amount: 150000 } });
  const fetcher = (path, o = {}) => raw(env, o.method || 'GET', path, o.body ? JSON.parse(o.body) : undefined, boss);
  const r = await pullApproved({ getState: () => state, commit: (n) => { state = n; }, fetcher });
  assert.deepEqual(r, { applied: 0, failed: 1, retry: false });
  assert.equal(state.teamPayments.some((x) => x.id === id), false);
  const list = (await json(await raw(env, 'GET', '/api/entries', undefined, boss))).entries;
  assert.match(list[0].applyError, /dépasse/);
  assert.deepEqual(await pullApproved({ getState: () => state, commit: () => assert.fail(), fetcher }), { applied: 0, failed: 0, retry: false });
});
test('une panne locale ne bloque rien : la saisie reste à enregistrer et réserve le budget', async () => {
  const start = sample();
  const { env, member, boss } = await world(start);
  const g = await member('gestionnaire');
  const id = (await json(await post(env, g, { kind: 'expense', projectId: 'p1', description: 'Ciment', amount: 30000 }))).entry.id;
  await raw(env, 'POST', `/api/entries/${id}/decision`, { decision: 'approve', accountId: 'main' }, boss);
  let state = start;
  const fetcher = (path, o = {}) => raw(env, o.method || 'GET', path, o.body ? JSON.parse(o.body) : undefined, boss);
  const full = await pullApproved({ getState: () => state, commit: () => { throw Error('Stockage plein'); }, fetcher });
  assert.deepEqual(full, { applied: 0, failed: 0, retry: true });
  const pending = (await json(await raw(env, 'GET', '/api/entries/to-apply', undefined, boss))).entries;
  assert.equal(pending.length, 1);
  assert.equal(pending[0].applyError, '');
  const offline = await pullApproved({ getState: () => state, commit: (n) => { state = n; }, flush: async () => false, fetcher });
  assert.deepEqual(offline, { applied: 0, failed: 0, retry: true });
  assert.equal(state.expenses.length, 1, 'enregistrée sur le téléphone');
  assert.equal((await json(await raw(env, 'GET', '/api/entries/to-apply', undefined, boss))).entries.length, 1, 'pas encore marquée');
  const list = (await json(await raw(env, 'GET', '/api/entries', undefined, boss))).entries;
  assert.equal(reservedOn(list, 'p1', { expenses: [], teamPayments: [] }), 30000);
  assert.equal(reservedOn(list, 'p1', state), 0, 'jamais compté deux fois');
  const before = state;
  const done = await pullApproved({ getState: () => state, commit: () => assert.fail('pas de second enregistrement'), fetcher });
  assert.deepEqual(done, { applied: 1, failed: 0, retry: false });
  assert.equal(state, before);
  assert.equal((await json(await raw(env, 'GET', '/api/entries/to-apply', undefined, boss))).entries.length, 0);
});
test('un refus des règles peut être réessayé ou abandonné, et les saisies à traiter restent listées', async () => {
  const start = sample();
  const { env, member, boss } = await world(start);
  const g = await member('gestionnaire');
  const id = (await json(await post(env, g, { kind: 'teamPayment', projectId: 'p1', taskId: 't', amount: 100000 }))).entry.id;
  const decide = (body) => raw(env, 'POST', `/api/entries/${id}/decision`, body, boss);
  assert.equal((await decide({ decision: 'retry' })).status, 409);
  await decide({ decision: 'approve', accountId: 'main' });
  await raw(env, 'POST', `/api/entries/${id}/applied`, { error: 'Dépasse le solde' }, boss);
  assert.equal((await json(await raw(env, 'GET', '/api/entries/to-apply', undefined, boss))).entries.length, 0);
  assert.equal((await decide({ decision: 'retry' })).status, 200);
  assert.equal((await json(await raw(env, 'GET', '/api/entries/to-apply', undefined, boss))).entries.length, 1);
  await raw(env, 'POST', `/api/entries/${id}/applied`, { error: 'Encore' }, boss);
  assert.equal((await decide({ decision: 'cancel' })).status, 400);
  assert.equal((await json(await decide({ decision: 'cancel', reason: 'Payé autrement' }))).entry.status, 'rejected');
  assert.equal((await raw(env, 'POST', `/api/entries/${id}/decision`, { decision: 'retry' }, g)).status, 403);
  const oldest = (await json(await post(env, g, { kind: 'expense', projectId: 'p1', description: 'Ancienne', amount: 5, id: 'la-plus-ancienne-1' }))).entry.id;
  await env.DB.prepare("UPDATE entries SET created_at='2000-01-01T00:00:00Z' WHERE id=?").bind(oldest).run();
  for (let i = 0; i < 1001; i++) await env.DB.prepare("INSERT INTO entries(id,kind,project_id,user_id,user_name,data,status,created_at) SELECT ?,'incident','p1',user_id,'x','{\"note\":\"x\",\"date\":\"2026-01-01\"}','resolved','2026-01-01' FROM entries WHERE id=?").bind('bulk-' + i, oldest).run();
  const all = (await json(await raw(env, 'GET', '/api/entries', undefined, boss))).entries;
  assert.equal(all.some((e) => e.id === oldest), true);
});
test('rapport : les écritures annulées ne comptent pas', () => {
  let s = sample();
  s = save(s, 'expenses', { id: 'x', scope: 'Chantier', projectId: 'p1', accountId: 'main', description: 'Erreur', amount: 30000 });
  s = save(s, 'expenses', { id: 'y', scope: 'Chantier', projectId: 'p1', accountId: 'main', description: 'Bonne', amount: 20000 });
  s = apply(s, { type: 'void', table: 'expenses', id: 'x', reason: 'Erreur' });
  const html = reportHtml({ company: 'GBA', project: s.projects[0], data: s, finance: { contract: 1, received: 0, toCollect: 0, margin: 0 } }).replace(/ | /g, ' ');
  assert.match(html, /Dépenses<\/td><td>20 000 F/);
  assert.equal(html.includes('Erreur'), false);
});
test('reste du budget : les saisies en attente comptent, pas les refusées ni celles déjà enregistrées', () => {
  const e = (status, appliedAt, kind = 'expense') => ({ projectId: 'p', kind, status, appliedAt, data: { amount: 100 } });
  assert.equal(reservedOn([e('pending'), e('approved', ''), e('approved', 'x'), e('rejected'), e('open', '', 'incident')], 'p'), 200);
  assert.equal(reservedOn(undefined, 'p'), 0);
  const action = entryToAction({ id: 'i', kind: 'expense', projectId: 'p1', accountId: 'main', userName: 'A', data: { description: 'X', amount: 5, date: '2026-01-01' } });
  assert.equal(validate(apply(sample(), action)).expenses.at(-1).scope, 'Chantier');
});
test('rapport : selon le rôle, sans montant caché et sans injection', () => {
  const s = sample();
  const entries = [{ projectId: 'p1', kind: 'incident', status: 'open', userName: '<script>x</script>', data: { note: '<img src=x onerror=alert(1)>', type: 'Problème', date: '2026-01-02' } }, { projectId: 'p2', kind: 'incident', status: 'open', userName: 'A', data: { note: 'AUTRE-CHANTIER', type: 'P', date: '2026-01-02' } }];
  const photos = [{ src: PHOTO, date: '2026-01-02', note: 'Dalle', by: 'A' }, { src: 'javascript:alert(1)', date: '2026-01-02' }];
  const worker_ = viewFor(s, { role: 'chef', projectIds: ['p1'] });
  const html = reportHtml({ company: 'GBA', project: worker_.projects[0], data: worker_, entries, photos, now: '2026-02-01T00:00:00Z' });
  assert.match(html, /Rapport de chantier : Villa/);
  assert.match(html, /01\/02\/2026/);
  assert.equal(html.includes('<script>'), false);
  assert.equal(html.includes('<img src=x'), false);
  assert.equal(html.includes('javascript:'), false);
  assert.equal(html.includes('AUTRE-CHANTIER'), false);
  for (const secret of ['900 000', '500 000', '200 000', '50 000', 'Contrat', 'Marge', 'Budget confié']) assert.equal(html.includes(secret), false, secret);
  const manager = viewFor(s, { role: 'gestionnaire', projectIds: [] });
  const m = reportHtml({ company: 'GBA', project: manager.projects[0], data: manager, entries: [], photos: [] });
  assert.match(m, /Budget confié/);
  assert.equal(m.includes('Contrat'), false);
  const boss = reportHtml({ company: 'GBA', project: s.projects[0], data: s, entries: [], photos: [], finance: { contract: 900000, received: 0, toCollect: 0, margin: 700000 } });
  assert.match(boss, /Contrat/);
  assert.match(boss, /Marge estimée/);
});
