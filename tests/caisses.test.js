import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker from '../worker.js';
import { empty, apply, validate, balance, today, find } from '../src/domain.js';
import { cashbox, spending, overspending } from '../src/cashbox.js';
import { viewFor } from '../src/permissions.js';
import { entryToAction, pullApproved, pullRequests, reservedOn } from '../src/entries.js';

test('une dépense pour l’entreprise ou personnelle en attente ne réserve pas le budget du chantier', () => {
  const e = (scope) => ({ id: scope, kind: 'expense', projectId: 'p1', status: 'pending', data: { amount: 1000, scope } });
  assert.equal(reservedOn([e('Chantier'), e('Entreprise'), e('Personnel'), e(undefined)], 'p1', {}), 2000);
});

const KEY = 'cle-de-test-avec-plus-de-trente-deux-caracteres';
const save = (s, t, d) => apply(s, { type: 'save', table: t, data: d });
const D = '2026-11-05';
function sample() {
  let s = empty();
  s = save(s, 'clients', { id: 'c', name: 'Client' });
  s = save(s, 'projects', { id: 'p1', name: 'Villa', clientId: 'c', contractAmount: 900000, budget: 100000 });
  s = save(s, 'projects', { id: 'p2', name: 'Immeuble', clientId: 'c', contractAmount: 1, budget: 0 });
  s = save(s, 'employees', { id: 'e', name: 'Ouvrier Moussa' });
  s = save(s, 'employees', { id: 'chef1', name: 'Chef Adama' });
  s = save(s, 'employees', { id: 'chef2', name: 'Chef Bakary' });
  s = save(s, 'suppliers', { id: 'f', name: 'Quincaillerie Kati' });
  s = save(s, 'tasks', { id: 't', employeeId: 'e', projectId: 'p1', description: 'Pose', agreedAmount: 200000 });
  s = apply(s, { type: 'cash', data: { accountId: 'main', amount: 1000000, label: 'Apport', date: D } });
  s = save(s, 'accounts', { id: 'k1', name: 'Caisse Adama', opening: 0, projectId: 'p1', holderId: 'chef1' });
  s = apply(s, { type: 'transfer', data: { id: 'tr1', fromId: 'main', toId: 'k1', amount: 150000, date: D, label: 'Budget Villa' } });
  return validate(s);
}
const spend = (s, id, amount, scope, extra = {}) => save(s, 'expenses', { id, description: id, amount, scope, accountId: 'k1', category: 'Matériaux', date: D, ...extra });

test('caisse de chantier : reçu, chantier, autre chantier, entreprise, personnel et solde négatif', () => {
  let s = sample();
  s = spend(s, 'ciment', 80000, 'Chantier', { projectId: 'p1' });
  s = spend(s, 'fer', 20000, 'Chantier', { projectId: 'p2' });
  s = spend(s, 'loyer', 40000, 'Entreprise', { category: 'Loyer' });
  s = spend(s, 'perso', 30000, 'Personnel', { category: 'Autres' });
  s = apply(s, { type: 'teamPayment', data: { id: 'paie', taskId: 't', accountId: 'k1', amount: 10000, date: D } });
  const c = cashbox(s, 'k1');
  assert.equal(c.received, 150000);
  assert.equal(c.site, 90000, 'ciment + paie de l’équipe du chantier');
  assert.deepEqual(c.otherSites.map((g) => [g.name, g.amount]), [['Immeuble', 20000]]);
  assert.deepEqual(c.company.map((g) => [g.name, g.amount]), [['Loyer', 40000]]);
  assert.equal(c.personal, 30000);
  assert.equal(c.spent, 180000);
  assert.equal(c.balance, -30000, 'la caisse peut être négative : le chef a avancé l’argent');
  assert.equal(c.balance, balance(s, 'k1'));
  const over = overspending(s);
  assert.deepEqual(over.boxes.map((x) => x.account.id), ['k1']);
});

test('dépenses du jour par chantier, catégorie et caisse ; dépassement de budget', () => {
  let s = sample();
  s = spend(s, 'ciment', 80000, 'Chantier', { projectId: 'p1' });
  s = spend(s, 'loyer', 40000, 'Entreprise', { category: 'Loyer' });
  s = spend(s, 'hier', 5000, 'Chantier', { projectId: 'p1', date: '2026-11-04' });
  s = save(s, 'expenses', { id: 'caisse-ent', description: 'Gasoil', amount: 30000, scope: 'Chantier', projectId: 'p1', accountId: 'main', category: 'Carburant', date: D });
  const v = spending(s, D);
  assert.equal(v.total, 150000);
  assert.deepEqual(v.bySite.map((g) => [g.name, g.amount]), [['Villa', 110000], ['Entreprise (hors chantier)', 40000]]);
  assert.deepEqual(v.byCategory.map((g) => g.name).sort(), ['Carburant', 'Loyer', 'Matériaux']);
  assert.deepEqual(v.byAccount.map((g) => [g.name, g.amount]), [['Caisse Adama', 120000], ['Caisse entreprise', 30000]]);
  assert.deepEqual(overspending(s).sites.map((x) => [x.project.id, x.over]), [['p1', 15000 + 200000]], 'budget 100 000 : dépenses 115 000 + tâche convenue 200 000');
});

test('une caisse se rattache à un chantier et à une fiche existants', () => {
  const s = sample();
  assert.throws(() => save(s, 'accounts', { id: 'k9', name: 'X', opening: 0, projectId: 'inconnu' }), /Chantier introuvable/);
  assert.throws(() => save(s, 'accounts', { id: 'k9', name: 'X', opening: 0, holderId: 'inconnu' }), /Responsable introuvable/);
});

test('droits : le chef voit sa caisse, jamais celle des autres ni le budget du chantier', () => {
  let s = spend(sample(), 'ciment', 80000, 'Chantier', { projectId: 'p1' });
  const chef = viewFor(s, { role: 'chef', employeeId: 'chef1', projectIds: ['p1'] });
  assert.equal(chef.cashboxes.length, 1);
  assert.equal(chef.cashboxes[0].balance, 70000);
  assert.equal(chef.cashboxes[0].recent[0].label, 'ciment');
  assert.equal(chef.expenses.length, 0);
  assert.equal(JSON.stringify(chef.projects).includes('budget'), false);
  assert.equal(JSON.stringify(chef).includes('900000'), false, 'jamais le montant du contrat');
  const other = viewFor(s, { role: 'chef', employeeId: 'chef2', projectIds: ['p1'] });
  assert.equal(other.cashboxes.length, 0);
  assert.equal(viewFor(s, { role: 'ouvrier', employeeId: 'e', projectIds: ['p1'] }).cashboxes, undefined);
});

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
  return worker.fetch(new Request('https://gba.example' + path, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }), env);
}
async function world(state = sample()) {
  const env = makeEnv();
  const owner = await raw(env, 'POST', '/api/setup', {}, null, { Authorization: 'Bearer ' + KEY });
  const boss = owner.headers.getSetCookie()[0].split(';')[0];
  await raw(env, 'PUT', '/api/workspace', { revision: 0, data: state }, boss);
  const member = async (role, extra = {}) => {
    const made = await (await raw(env, 'POST', '/api/users', { name: role + ' ' + (extra.employeeId || ''), role, ...extra }, boss)).json();
    const inv = await (await raw(env, 'POST', `/api/users/${made.user.id}/invite`, undefined, boss)).json();
    const joined = await raw(env, 'POST', '/api/auth/invite/redeem', { token: inv.token, pin: '1234' });
    return joined.headers.getSetCookie()[0].split(';')[0];
  };
  const fetcher = (path, o = {}) => raw(env, o.method || 'GET', path, o.body ? JSON.parse(o.body) : undefined, boss);
  return { env, boss, member, fetcher };
}
const json = (res) => res.json();

test('saisie du chef : la dépense sort de sa caisse, avec son type (chantier, entreprise, personnel)', async () => {
  const { env, member, boss, fetcher } = await world();
  const chef = await member('chef', { employeeId: 'chef1', projectIds: ['p1'] });
  const sans = await member('chef', { employeeId: 'chef2', projectIds: ['p1'] });
  const g = await member('gestionnaire');
  const post = (cookie, body) => raw(env, 'POST', '/api/entries', { kind: 'expense', projectId: 'p1', description: 'Repas', amount: 5000, date: D, ...body }, cookie);
  assert.equal((await post(sans, {})).status, 403, 'pas de caisse : pas de dépense');
  assert.equal((await post(chef, { accountId: 'main' })).status, 403, 'pas la caisse de l’entreprise');
  const made = await json(await post(chef, { scope: 'Entreprise', category: 'Nourriture / divers' }));
  assert.equal(made.entry.accountId, 'k1');
  assert.equal(made.entry.data.scope, 'Entreprise');
  await post(g, { description: 'Saisie du gestionnaire' });
  const mine = (await json(await raw(env, 'GET', '/api/entries', undefined, chef))).entries;
  assert.deepEqual(mine.map((e) => e.data.description), ['Repas'], 'le chef ne voit que ses propres saisies d’argent');
  assert.equal((await json(await raw(env, 'GET', '/api/entries', undefined, sans))).entries.length, 0);
  const action = entryToAction({ ...made.entry, accountId: 'k1' });
  assert.equal(action.data.scope, 'Entreprise');
  assert.equal(action.data.projectId, '');
  await raw(env, 'POST', `/api/entries/${made.entry.id}/decision`, { decision: 'approve', accountId: made.entry.accountId }, boss);
  let state = sample();
  await pullApproved({ getState: () => state, commit: (n) => { state = n; }, fetcher });
  assert.equal(cashbox(state, 'k1').companyTotal, 5000);
  assert.equal(balance(state, 'k1'), 145000);
});

test('matériel : besoin de l’ouvrier, demande du chef, bon de commande, livraison puis réception', async () => {
  const { env, member, boss, fetcher } = await world();
  const ouvrier = await member('ouvrier', { employeeId: 'e', projectIds: ['p1'] });
  const chef = await member('chef', { employeeId: 'chef1', projectIds: ['p1'] });
  const loin = await member('chef', { employeeId: 'chef2', projectIds: ['p2'] });
  const step = (cookie, id, body) => raw(env, 'POST', `/api/requests/${id}/step`, body, cookie);
  const body = { id: 'demande-001', projectId: 'p1', items: [{ description: 'Ciment', quantity: 20, unit: 'sac' }], note: 'Pour la dalle' };
  assert.equal((await raw(env, 'POST', '/api/requests', { ...body, projectId: 'p2' }, ouvrier)).status, 403);
  assert.equal((await raw(env, 'POST', '/api/requests', { ...body, items: [] }, ouvrier)).status, 400);
  const made = await json(await raw(env, 'POST', '/api/requests', body, ouvrier));
  assert.equal(made.request.status, 'besoin');
  assert.equal((await raw(env, 'POST', '/api/requests', body, ouvrier)).status, 200, 'un renvoi ne crée pas de doublon');
  assert.equal((await json(await raw(env, 'GET', '/api/requests', undefined, loin))).requests.length, 0, 'un chef d’un autre chantier ne la voit pas');
  assert.equal((await step(ouvrier, 'demande-001', { step: 'forward' })).status, 403);
  assert.equal((await step(chef, 'demande-001', { step: 'forward' })).status, 200);
  assert.equal((await step(chef, 'demande-001', { step: 'order', supplierId: 'f', amount: 90000 })).status, 403, 'seule la direction commande');
  assert.equal((await step(boss, 'demande-001', { step: 'order', supplierId: 'inconnu', amount: 90000 })).status, 400);
  assert.equal((await step(boss, 'demande-001', { step: 'order', supplierId: 'f', amount: 90000, expectedDate: '2026-11-10' })).status, 200);
  assert.equal((await step(chef, 'demande-001', { step: 'deliver' })).status, 409, 'pas avant que le bon soit enregistré');
  const chefView = (await json(await raw(env, 'GET', '/api/requests', undefined, chef))).requests[0];
  assert.equal(chefView.order.supplierName, 'Quincaillerie Kati');
  assert.equal(chefView.order.amount, undefined, 'le chef ne voit pas le montant');
  let state = sample();
  const run = () => pullRequests({ getState: () => state, commit: (n) => { state = n; }, fetcher });
  assert.deepEqual(await run(), { applied: 1, failed: 0, retry: false });
  const order = state.orders.find((o) => o.id === 'demande-001');
  assert.equal(order.number, 'GBA-BC-' + today().slice(0, 4) + '-001');
  assert.equal(order.status, 'Commandé');
  assert.equal(order.amount, 90000);
  assert.deepEqual(await run(), { applied: 0, failed: 0, retry: false }, 'rien en double');
  const ready = (await json(await raw(env, 'GET', '/api/requests', undefined, ouvrier))).requests[0];
  assert.equal(ready.orderNumber, order.number);
  assert.equal((await step(ouvrier, 'demande-001', { step: 'deliver' })).status, 403);
  assert.equal((await step(chef, 'demande-001', { step: 'deliver' })).status, 200);
  assert.equal((await step(ouvrier, 'demande-001', { step: 'receive' })).status, 200);
  assert.equal((await step(ouvrier, 'demande-001', { step: 'receive' })).status, 409);
  assert.deepEqual(await run(), { applied: 1, failed: 0, retry: false });
  assert.equal(state.orders.find((o) => o.id === 'demande-001').status, 'Reçu');
  assert.equal(state.deliveries.length, 1);
  const done = (await json(await raw(env, 'GET', '/api/requests', undefined, boss))).requests[0];
  assert.deepEqual(done.history.map((h) => h.step), ['besoin', 'demande', 'commande', 'livre', 'recu']);
});

test('messages : la direction répond à un incident, seules les personnes concernées lisent', async () => {
  const { env, member, boss } = await world();
  const ouvrier = await member('ouvrier', { employeeId: 'e', projectIds: ['p1'] });
  const loin = await member('ouvrier', { projectIds: ['p2'] });
  const inc = (await json(await raw(env, 'POST', '/api/entries', { kind: 'incident', projectId: 'p1', note: 'Fuite d’eau' }, ouvrier))).entry;
  assert.equal((await raw(env, 'POST', `/api/threads/${inc.id}`, { id: 'message-001', text: 'J’envoie le plombier demain.' }, boss)).status, 201);
  await raw(env, 'POST', `/api/threads/${inc.id}`, { id: 'message-001', text: 'J’envoie le plombier demain.' }, boss);
  assert.equal((await raw(env, 'POST', `/api/threads/${inc.id}`, { id: 'message-001', text: 'Usurpation' }, ouvrier)).status, 409);
  assert.equal((await raw(env, 'POST', `/api/threads/${inc.id}`, { text: '' }, ouvrier)).status, 400);
  await raw(env, 'POST', `/api/threads/${inc.id}`, { text: 'Merci' }, ouvrier);
  const read = (await json(await raw(env, 'GET', `/api/threads/${inc.id}`, undefined, ouvrier))).messages;
  assert.deepEqual(read.map((m) => [m.text, m.mine]), [['J’envoie le plombier demain.', false], ['Merci', true]]);
  assert.equal((await raw(env, 'GET', `/api/threads/${inc.id}`, undefined, loin)).status, 404);
  assert.equal((await raw(env, 'GET', '/api/threads/inconnu-123', undefined, boss)).status, 404);
  const listed = (await json(await raw(env, 'GET', '/api/entries', undefined, ouvrier))).entries.find((e) => e.id === inc.id);
  assert.equal(listed.messages, 2);
  for (let i = 0; i < 305; i++) await raw(env, 'POST', `/api/threads/${inc.id}`, { text: 'n' + i }, boss);
  const last = (await json(await raw(env, 'GET', `/api/threads/${inc.id}`, undefined, boss))).messages;
  assert.equal(last.length, 300);
  assert.equal(last.at(-1).text, 'n304', 'les derniers messages restent visibles');
  assert.equal((await raw(env, 'POST', `/api/entries/${inc.id}/decision`, { decision: 'resolve', reason: 'Réparé' }, boss)).status, 200);
  assert.equal((await raw(env, 'POST', `/api/entries/${inc.id}/decision`, { decision: 'reopen' }, boss)).status, 200);
});

test('caisse créée avec un « solde initial » par erreur : on le corrige, ou on le fait venir de la caisse entreprise', () => {
  let s = empty();
  s = apply(s, { type: 'cash', data: { accountId: 'main', amount: 1000000, label: 'Apport', date: D } });
  s = save(s, 'clients', { id: 'c', name: 'C' });
  s = save(s, 'projects', { id: 'p', name: 'Renouvellement', clientId: 'c', contractAmount: 1200000, budget: 1200000 });
  s = save(s, 'accounts', { id: 'k', name: 'Caisse Renouvellement', opening: 800000, projectId: 'p' });
  assert.equal(balance(s, 'k') + balance(s, 'main'), 1800000, 'l’argent « de départ » s’ajoute sans sortir d’ailleurs');
  // Pas assez dans la caisse entreprise : rien ne change.
  const poor = apply(s, { type: 'cash', data: { accountId: 'main', amount: -500000, label: 'Retrait', date: D } });
  assert.throws(() => apply(poor, { type: 'openingToTransfer', id: 'k', data: { fromId: 'main' } }), /il manque 300/);
  const moved = apply(s, { type: 'openingToTransfer', id: 'k', data: { fromId: 'main', label: 'Budget Renouvellement' } });
  assert.equal(find(moved, 'accounts', 'k').opening, 0);
  assert.equal(balance(moved, 'k'), 800000);
  assert.equal(balance(moved, 'main'), 200000);
  assert.equal(balance(moved, 'k') + balance(moved, 'main'), 1000000, 'le total est juste');
  assert.equal(validate(moved), moved);
  // Ou simplement corriger le montant de départ, avec un motif gardé dans l'historique.
  assert.throws(() => apply(s, { type: 'fixOpening', id: 'k', data: { opening: 0 } }), /pourquoi/);
  const fixed = apply(s, { type: 'fixOpening', id: 'k', data: { opening: 0 }, reason: 'Erreur de saisie' });
  assert.equal(find(fixed, 'accounts', 'k').opening, 0);
  assert.equal(find(fixed, 'accounts', 'k').openingHistory[0].from, 800000);
  assert.equal(fixed.audit.at(-1).reason, 'Erreur de saisie');
});

test('budget donné par erreur : on corrige le montant ou on l’annule, et les soldes suivent', () => {
  let s = sample();
  assert.equal(balance(s, 'k1'), 150000);
  s = apply(s, { type: 'correctTransfer', id: 'tr1', data: { amount: 100000 }, reason: 'Correction du montant' });
  assert.equal(balance(s, 'k1'), 100000);
  assert.equal(balance(s, 'main'), 900000);
  assert.equal(s.transfers.filter((t) => !t.void).length, 1);
  assert.equal(find(s, 'transfers', 'tr1').void, true);
  assert.throws(() => apply(s, { type: 'correctTransfer', id: 'tr1', data: { amount: 5 }, reason: 'x' }), /déjà annulé/);
  const fresh = s.transfers.find((t) => !t.void);
  assert.throws(() => apply(s, { type: 'correctTransfer', id: fresh.id, data: { amount: 5000000 }, reason: 'x' }), /n’a que/);
  s = apply(s, { type: 'void', table: 'transfers', id: fresh.id, reason: 'Erreur' });
  assert.equal(balance(s, 'k1'), 0);
  assert.equal(balance(s, 'main'), 1000000);
  assert.equal(validate(s), s);
});
