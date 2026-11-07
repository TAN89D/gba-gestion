import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker from '../worker.js';
import { empty, apply, validate, due, retained, blankCompany } from '../src/domain.js';

const KEY = 'cle-de-test-avec-plus-de-trente-deux-caracteres';
const MIGRATIONS = ['0001_workspace.sql', '0002_team.sql', '0003_entries.sql', '0004_requests.sql', '0005_presence.sql', '0006_companies.sql', '0007_limits.sql'];
function makeEnv(extra = {}) {
  const db = new DatabaseSync(':memory:');
  for (const f of MIGRATIONS) db.exec(readFileSync(new URL('../migrations/' + f, import.meta.url), 'utf8'));
  const wrap = (sql, args = []) => ({
    bind: (...a) => wrap(sql, a),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...args).changes) } }),
  });
  return { DB: { prepare: (sql) => wrap(sql) }, BACKUP_TOKEN: KEY, ASSETS: { fetch: async () => new Response('page') }, SIGNUP: '1', ...extra };
}
async function raw(env, method, path, body, cookie, extra = {}) {
  const headers = new Headers(extra);
  if (cookie) headers.set('Cookie', cookie);
  if (body !== undefined) headers.set('Content-Type', 'application/json');
  return worker.fetch(new Request('https://sobara.example' + path, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }), env);
}
const cookieOf = (res) => res.headers.getSetCookie()[0].split(';')[0];
const json = (res) => res.json();
const AUDIO = 'data:audio/webm;codecs=opus;base64,GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQRChYEC';
const LOGO = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

async function signup(env, company, name = 'Patron ' + company) {
  const res = await raw(env, 'POST', '/api/companies', { company, name, phone: '+223 70 00 00 00', pin: '2468' });
  assert.equal(res.status, 201);
  const body = await res.json();
  return { cookie: cookieOf(res), ...body };
}
// Ajoute un client et un chantier, puis invite un ouvrier sur ce chantier.
async function prepare(env, who, tag) {
  let data = apply(who.workspace.data, { type: 'save', table: 'clients', data: { id: 'c-' + tag, name: 'Client ' + tag } });
  data = apply(data, { type: 'save', table: 'projects', data: { id: 'p-' + tag, name: 'Chantier ' + tag, clientId: 'c-' + tag, contractAmount: 1000000, budget: 0, shareToken: 'lien-de-suivi-' + tag + '-0123456789' } });
  data = apply(data, { type: 'settings', data: { logo: LOGO } });
  assert.equal((await raw(env, 'PUT', '/api/workspace', { revision: 1, data, companyId: who.user.companyId }, who.cookie)).status, 200);
  const made = await json(await raw(env, 'POST', '/api/users', { name: 'Ouvrier ' + tag, role: 'ouvrier', projectIds: ['p-' + tag] }, who.cookie));
  const inv = await json(await raw(env, 'POST', `/api/users/${made.user.id}/invite`, undefined, who.cookie));
  const worker_ = cookieOf(await raw(env, 'POST', '/api/auth/invite/redeem', { token: inv.token, pin: '1357' }));
  return { userId: made.user.id, worker: worker_ };
}

test('inscription : fermée par défaut, et une nouvelle entreprise part de zéro (rien de GBA)', async () => {
  const closed = makeEnv({ SIGNUP: undefined });
  assert.equal((await raw(closed, 'POST', '/api/companies', { company: 'X', name: 'Y', pin: '1234' })).status, 404);
  const env = makeEnv();
  assert.equal((await raw(env, 'POST', '/api/companies', { company: '', name: 'Y', pin: '1234' })).status, 400);
  assert.equal((await raw(env, 'POST', '/api/companies', { company: 'X', name: 'Y', pin: '12' })).status, 400);
  const a = await signup(env, 'Bâtisseurs du Sahel');
  assert.equal(a.user.role, 'direction');
  assert.equal(a.workspace.data.settings.company, 'Bâtisseurs du Sahel');
  const text = JSON.stringify(a.workspace.data);
  for (const gba of ['GÉNÉRALE BTP', 'gbafrique', '77 67 03 03', 'GBA-']) assert.ok(!text.includes(gba), gba + ' ne doit pas apparaître');
  const ws = await json(await raw(env, 'GET', '/api/workspace', undefined, a.cookie));
  assert.equal(ws.data.settings.company, 'Bâtisseurs du Sahel');
  // Le code de l'appareil rouvre la session.
  assert.equal((await raw(env, 'POST', '/api/auth/pin', { secret: a.deviceSecret, pin: '2468' })).status, 200);
  assert.equal((await raw(env, 'POST', '/api/auth/pin', { secret: a.deviceSecret, pin: '0000' })).status, 401);
});

test('deux entreprises : aucune ne voit les données, comptes, saisies, demandes ou pointages de l’autre', async () => {
  const env = makeEnv();
  const owner = cookieOf(await raw(env, 'POST', '/api/setup', {}, null, { Authorization: 'Bearer ' + KEY }));
  const main = apply(empty(), { type: 'save', table: 'clients', data: { id: 'c-gba', name: 'Client GBA' } });
  assert.equal((await raw(env, 'PUT', '/api/workspace', { revision: 0, data: main }, owner)).status, 200);
  const a = await signup(env, 'Entreprise A');
  const b = await signup(env, 'Entreprise B');
  const A = await prepare(env, a, 'a');
  const B = await prepare(env, b, 'b');

  const wsA = await json(await raw(env, 'GET', '/api/workspace', undefined, a.cookie));
  assert.deepEqual(wsA.data.clients.map((c) => c.id), ['c-a']);
  assert.deepEqual((await json(await raw(env, 'GET', '/api/workspace', undefined, owner))).data.clients.map((c) => c.id), ['c-gba']);

  const users = async (c) => (await json(await raw(env, 'GET', '/api/users', undefined, c))).users.map((u) => u.name).sort();
  assert.deepEqual(await users(a.cookie), ['Ouvrier a', 'Patron Entreprise A']);
  assert.deepEqual(await users(b.cookie), ['Ouvrier b', 'Patron Entreprise B']);
  assert.equal((await raw(env, 'PATCH', `/api/users/${A.userId}`, { active: false }, b.cookie)).status, 404);
  assert.equal((await raw(env, 'POST', `/api/users/${A.userId}/invite`, undefined, b.cookie)).status, 404);
  assert.equal((await raw(env, 'PATCH', `/api/users/${A.userId}`, { active: false }, owner)).status, 404);

  // L'ouvrier de A signale un problème avec un message vocal, demande du matériel et pointe.
  const inc = await json(await raw(env, 'POST', '/api/entries', { kind: 'incident', projectId: 'p-a', note: '', audio: AUDIO }, A.worker));
  assert.equal(inc.entry.data.note, 'Message vocal');
  assert.equal(inc.entry.hasAudio, true);
  assert.equal((await raw(env, 'POST', '/api/requests', { projectId: 'p-a', items: [{ description: 'Ciment', quantity: 5, unit: 'sac' }] }, A.worker)).status, 201);
  assert.equal((await raw(env, 'POST', '/api/presence', { projectId: 'p-a' }, A.worker)).status, 201);
  // Un ouvrier de B ne peut pas viser le chantier de A.
  assert.equal((await raw(env, 'POST', '/api/entries', { kind: 'incident', projectId: 'p-a', note: 'x' }, B.worker)).status, 403);

  const list = async (c, path, key) => (await json(await raw(env, 'GET', path, undefined, c)))[key].length;
  assert.equal(await list(a.cookie, '/api/entries', 'entries'), 1);
  assert.equal(await list(b.cookie, '/api/entries', 'entries'), 0);
  assert.equal(await list(owner, '/api/entries', 'entries'), 0);
  assert.equal(await list(b.cookie, '/api/requests', 'requests'), 0);
  assert.equal(await list(b.cookie, '/api/presence', 'presences'), 0);
  assert.equal(await list(a.cookie, '/api/presence', 'presences'), 1);
  const id = inc.entry.id;
  assert.equal((await raw(env, 'GET', `/api/entries/${id}/audio`, undefined, a.cookie)).status, 200);
  assert.equal((await json(await raw(env, 'GET', `/api/entries/${id}/audio`, undefined, a.cookie))).audio, AUDIO);
  assert.equal((await raw(env, 'GET', `/api/entries/${id}/audio`, undefined, b.cookie)).status, 404);
  assert.equal((await raw(env, 'POST', `/api/entries/${id}/decision`, { decision: 'resolve', reason: 'x' }, b.cookie)).status, 404);
  assert.equal((await raw(env, 'GET', `/api/threads/${id}`, undefined, b.cookie)).status, 404);
  assert.equal((await raw(env, 'POST', `/api/threads/${id}`, { text: 'intrus' }, b.cookie)).status, 404);
  assert.equal((await raw(env, 'POST', `/api/entries/${id}/decision`, { decision: 'resolve', reason: 'Réglé' }, a.cookie)).status, 200);

  // Chaque lien client ouvre le bon chantier, avec le logo de la bonne entreprise.
  const suiviA = await json(await raw(env, 'GET', '/api/suivi/lien-de-suivi-a-0123456789'));
  assert.equal(suiviA.project.name, 'Chantier a');
  assert.equal(suiviA.company.name, 'Entreprise A');
  assert.equal(suiviA.company.logo, LOGO);
  assert.equal((await json(await raw(env, 'GET', '/api/suivi/lien-de-suivi-b-0123456789'))).company.name, 'Entreprise B');
  // Un « _ » ou un « % » dans le lien ne sert pas de joker.
  assert.equal((await raw(env, 'GET', '/api/suivi/lien-de-suivi-_-0123456789')).status, 404);
  assert.equal((await raw(env, 'GET', '/api/suivi/lien%25de-suivi-a-0123456789')).status, 404);
});

test('message vocal : seulement sur un signalement, au bon format', async () => {
  const env = makeEnv();
  const a = await signup(env, 'Entreprise V');
  const A = await prepare(env, a, 'v');
  assert.equal((await raw(env, 'POST', '/api/entries', { kind: 'incident', projectId: 'p-v', audio: 'data:text/html;base64,PGI+' }, A.worker)).status, 400);
  assert.equal((await raw(env, 'POST', '/api/entries', { kind: 'photo', projectId: 'p-v', audio: AUDIO, photo: LOGO }, A.worker)).status, 400);
  assert.equal((await raw(env, 'POST', '/api/entries', { kind: 'incident', projectId: 'p-v', audio: 'data:audio/webm;base64,' + 'A'.repeat(900001) }, A.worker)).status, 413);
});

test('retenue de garantie : le client la garde jusqu’à la libération', () => {
  let s = empty();
  s = apply(s, { type: 'save', table: 'clients', data: { id: 'c', name: 'C' } });
  assert.throws(() => apply(s, { type: 'invoice', data: { id: 'bad', clientId: 'c', retention: 25, lines: [{ description: 'x', quantity: 1, unit: 'u', unitPrice: 1000 }] } }), /entre 0 et 20/);
  s = apply(s, { type: 'invoice', data: { id: 'i', clientId: 'c', retention: 5, tax: 0, discount: 0, lines: [{ description: 'Situation', quantity: 1, unit: 'forfait', unitPrice: 1000000 }] } });
  const i = s.invoices[0];
  assert.equal(retained(i), 50000);
  assert.equal(due(s, i), 950000);
  assert.throws(() => apply(s, { type: 'payment', data: { invoiceId: 'i', accountId: 'main', amount: 960000, date: '2026-11-06' } }), /dépasse/);
  s = apply(s, { type: 'payment', data: { invoiceId: 'i', accountId: 'main', amount: 950000, date: '2026-11-06' } });
  assert.equal(due(s, s.invoices[0]), 0);
  s = apply(s, { type: 'releaseRetention', id: 'i' });
  assert.equal(due(s, s.invoices[0]), 50000);
  assert.throws(() => apply(s, { type: 'releaseRetention', id: 'i' }), /Aucune retenue/);
  assert.equal(validate(s), s);
});

test('logo de l’entreprise : image contrôlée, et entreprise vierge valide', () => {
  const s = blankCompany({ company: 'Test' });
  assert.equal(validate(s), s);
  assert.equal(apply(s, { type: 'settings', data: { logo: LOGO } }).settings.logo, LOGO);
  assert.throws(() => apply(s, { type: 'settings', data: { logo: 'data:image/svg+xml;base64,PHN2Zz4=' } }), /Logo invalide/);
  assert.throws(() => apply(s, { type: 'settings', data: { logo: 'data:image/png;base64,' + 'A'.repeat(300000) } }), /Logo invalide/);
});

test('audit : des données d’une entreprise ne peuvent jamais remplacer celles d’une autre', async () => {
  const env = makeEnv();
  const a = await signup(env, 'Entreprise A');
  const b = await signup(env, 'Entreprise B');
  const dataA = apply(a.workspace.data, { type: 'save', table: 'clients', data: { id: 'c-a', name: 'Client A' } });
  // Le téléphone de A est connecté au compte de B : l'envoi est refusé, rien n'est remplacé.
  assert.equal((await raw(env, 'PUT', '/api/workspace', { revision: 1, data: dataA, companyId: a.user.companyId }, b.cookie)).status, 409);
  assert.equal((await raw(env, 'PUT', '/api/workspace', { revision: 1, data: dataA }, b.cookie)).status, 409, 'sans entreprise indiquée, seule l’entreprise d’origine est acceptée');
  assert.deepEqual((await json(await raw(env, 'GET', '/api/workspace', undefined, b.cookie))).data.clients, []);
  assert.equal((await raw(env, 'PUT', '/api/workspace', { revision: 1, data: dataA, companyId: a.user.companyId }, a.cookie)).status, 200);
});

test('audit : le gestionnaire voit les dépenses de chantier, pas les dépenses personnelles des autres', async () => {
  const env = makeEnv();
  const a = await signup(env, 'Entreprise G');
  let data = apply(a.workspace.data, { type: 'save', table: 'clients', data: { id: 'c', name: 'C' } });
  data = apply(data, { type: 'save', table: 'projects', data: { id: 'p', name: 'P', clientId: 'c', contractAmount: 1, budget: 0 } });
  data = apply(data, { type: 'save', table: 'employees', data: { id: 'e-chef', name: 'Chef' } });
  data = apply(data, { type: 'save', table: 'accounts', data: { id: 'k', name: 'Caisse chef', opening: 0, projectId: 'p', holderId: 'e-chef' } });
  assert.equal((await raw(env, 'PUT', '/api/workspace', { revision: 1, data, companyId: a.user.companyId }, a.cookie)).status, 200);
  const invite = async (body) => { const made = await json(await raw(env, 'POST', '/api/users', body, a.cookie)); const inv = await json(await raw(env, 'POST', `/api/users/${made.user.id}/invite`, undefined, a.cookie)); return cookieOf(await raw(env, 'POST', '/api/auth/invite/redeem', { token: inv.token, pin: '1357' })); };
  const chef = await invite({ name: 'Chef', role: 'chef', employeeId: 'e-chef', projectIds: ['p'] });
  const gest = await invite({ name: 'Gest', role: 'gestionnaire' });
  const add = async (scope, description) => (await json(await raw(env, 'POST', '/api/entries', { kind: 'expense', projectId: 'p', scope, description, amount: 1000, photo: LOGO }, chef))).entry.id;
  const site = await add('Chantier', 'Ciment');
  const perso = await add('Personnel', 'Avance perso');
  const seen = (await json(await raw(env, 'GET', '/api/entries', undefined, gest))).entries.map((e) => e.id);
  assert.ok(seen.includes(site));
  assert.ok(!seen.includes(perso));
  assert.equal((await raw(env, 'GET', `/api/entries/${perso}/photo`, undefined, gest)).status, 404);
  assert.ok(!(await json(await raw(env, 'GET', '/api/notifications', undefined, gest))).items.some((x) => x.entryId === perso));
  assert.equal((await raw(env, 'GET', `/api/entries/${perso}/photo`, undefined, a.cookie)).status, 200, 'la direction voit tout');
});

test('audit : inscriptions limitées par connexion', async () => {
  const env = makeEnv();
  const from = (ip, n) => raw(env, 'POST', '/api/companies', { company: 'Spam ' + n, name: 'X', pin: '1234' }, null, { 'CF-Connecting-IP': ip });
  for (let i = 0; i < 3; i++) assert.equal((await from('1.2.3.4', i)).status, 201);
  assert.equal((await from('1.2.3.4', 9)).status, 429);
  assert.equal((await from('5.6.7.8', 1)).status, 201, 'une autre connexion peut s’inscrire');
});
