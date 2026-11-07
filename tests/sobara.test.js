import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker from '../worker.js';
import { empty, apply, validate, situation, budgetUse, newShareToken } from '../src/domain.js';
import { overspending, dayReport } from '../src/cashbox.js';
import { viewFor } from '../src/permissions.js';
import { entryToAction } from '../src/entries.js';
import { clientView } from '../server/team.js';
import { demoCompany, DEMO_SHARE_TOKEN } from '../src/demoData.js';

const KEY = 'cle-de-test-avec-plus-de-trente-deux-caracteres';
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
  return { DB: { prepare: (sql) => wrap(sql) }, BACKUP_TOKEN: KEY, ASSETS: { fetch: async () => new Response('page') }, ...extra };
}
async function raw(env, method, path, body, cookie, extra = {}) {
  const headers = new Headers(extra);
  if (cookie) headers.set('Cookie', cookie);
  if (body !== undefined) headers.set('Content-Type', 'application/json');
  return worker.fetch(new Request('https://demo.example' + path, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }), env);
}
const cookieOf = (res) => res.headers.getSetCookie()[0].split(';')[0];
async function world(state = demoCompany()) {
  const env = makeEnv();
  const boss = cookieOf(await raw(env, 'POST', '/api/setup', {}, null, { Authorization: 'Bearer ' + KEY }));
  assert.equal((await raw(env, 'PUT', '/api/workspace', { revision: 0, data: state }, boss)).status, 200);
  const member = async (role, extra = {}) => {
    const made = await (await raw(env, 'POST', '/api/users', { name: role + ' ' + (extra.employeeId || ''), role, ...extra }, boss)).json();
    const inv = await (await raw(env, 'POST', `/api/users/${made.user.id}/invite`, undefined, boss)).json();
    return cookieOf(await raw(env, 'POST', '/api/auth/invite/redeem', { token: inv.token, pin: '1234' }));
  };
  return { env, boss, member };
}

test('entreprise de démonstration : données valides, dépassement visible et rien de réel', () => {
  const s = demoCompany(new Date('2026-11-06T09:00:00Z'));
  assert.equal(validate(s), s);
  assert.notEqual(s.demo, true, 'la démo du site SoBara doit pouvoir être envoyée vers sa propre base');
  assert.match(s.settings.company, /DÉMO/);
  assert.deepEqual(overspending(s).sites.map((x) => [x.project.id, x.over]), [['p-boutique', 200000]]);
  assert.equal(s.projects.find((p) => p.id === 'p-villa').shareToken, DEMO_SHARE_TOKEN);
});

test('situation de travaux : facture la part de l’avancement moins ce qui est déjà facturé', () => {
  const s = demoCompany();
  assert.deepEqual(situation(s, 'p-villa', 60), { billed: 20250000, target: 27000000, amount: 6750000, number: 3, percent: 60 });
  assert.equal(situation(s, 'p-villa', 40).amount, 0, 'jamais de montant négatif');
  assert.throws(() => situation(s, 'p-villa', 0), /entre 1 et 100/);
  assert.throws(() => situation(s, 'p-villa', 120), /entre 1 et 100/);
  assert.throws(() => situation(s, 'inconnu', 50), /introuvable/);
  assert.equal(budgetUse(s, 'p-boutique'), 105);
});

test('avancement du chantier et lien client : valeurs contrôlées', () => {
  let s = empty();
  s = apply(s, { type: 'save', table: 'clients', data: { id: 'c', name: 'C' } });
  s = apply(s, { type: 'save', table: 'projects', data: { id: 'p', name: 'P', clientId: 'c', contractAmount: 0, budget: 0, progress: '45,6'.replace(',', '.') } });
  assert.equal(s.projects[0].progress, 46);
  assert.throws(() => apply(s, { type: 'save', table: 'projects', data: { ...s.projects[0], progress: 150 } }), /entre 0 et 100/);
  assert.throws(() => apply(s, { type: 'save', table: 'projects', data: { ...s.projects[0], shareToken: 'court' } }), /Lien de suivi invalide/);
  const token = newShareToken();
  assert.notEqual(token, newShareToken());
  s = apply(s, { type: 'save', table: 'projects', data: { ...s.projects[0], shareToken: token } });
  assert.equal(s.projects[0].shareToken, token);
  // L'équipe voit l'avancement mais jamais le lien du client.
  const view = viewFor(s, { role: 'ouvrier', projectIds: ['p'], employeeId: '' });
  assert.equal(view.projects[0].progress, 46);
  assert.equal(view.projects[0].shareToken, undefined);
});

test('espace client : seul le chantier du lien, sans les autres clients ni les incidents', () => {
  const s = demoCompany();
  s.journal.push({ id: 'j-inc', projectId: 'p-villa', date: '2026-11-01', kind: 'Incident', note: 'Vol de matériel' });
  s.journal.push({ id: 'j-note', projectId: 'p-villa', date: '2026-11-02', kind: 'Note', note: 'Négocier le prix du fer' });
  assert.equal(clientView(s, 'mauvais-jeton-de-plus-de-20'), null);
  assert.equal(clientView(s, 'court'), null);
  const v = clientView(s, DEMO_SHARE_TOKEN);
  assert.equal(v.project.name, 'Villa R+1 à Kati');
  assert.equal(v.project.progress, 45);
  assert.deepEqual(v.money, { contract: 45000000, billed: 20250000, billedHT: 20250000, paid: 17500000, retained: 0, due: 2750000, toBill: 24750000 });
  assert.equal(v.payments.length, 2);
  assert.ok(v.journal.length > 0 && v.journal.every((j) => ['Avancement', 'Réception'].includes(j.kind)));
  const text = JSON.stringify(v);
  for (const secret of ['Immeuble', 'Coulibaly', 'Caisse', 'Avance personnelle', 'k-adama', 'Vol de matériel', 'Négocier']) assert.ok(!text.includes(secret), secret + ' ne doit pas apparaître');
});

test('espace client par le serveur : sans compte, et arrêté quand le lien est retiré', async () => {
  const { env, boss } = await world();
  const ok = await raw(env, 'GET', '/api/suivi/' + DEMO_SHARE_TOKEN);
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).client, 'M. Diallo (vit à Paris)');
  assert.equal((await raw(env, 'GET', '/api/suivi/inconnu-inconnu-inconnu-1')).status, 404);
  const ws = await (await raw(env, 'GET', '/api/workspace', undefined, boss)).json();
  const data = { ...ws.data, projects: ws.data.projects.map((p) => (p.id === 'p-villa' ? { ...p, shareToken: '' } : p)) };
  assert.equal((await raw(env, 'PUT', '/api/workspace', { revision: ws.revision, data }, boss)).status, 200);
  assert.equal((await raw(env, 'GET', '/api/suivi/' + DEMO_SHARE_TOKEN)).status, 404);
});

test('pointage : une fois par jour et par chantier, seulement sur ses chantiers, visibilité selon le rôle', async () => {
  const { env, boss, member } = await world();
  const moussa = await member('ouvrier', { employeeId: 'e-moussa', projectIds: ['p-villa'] });
  const ibrahim = await member('ouvrier', { employeeId: 'e-ibrahim', projectIds: ['p-immeuble'] });
  const chef = await member('chef', { employeeId: 'e-adama', projectIds: ['p-villa'] });
  const gest = await member('gestionnaire', { employeeId: 'e-fatou' });
  const first = await raw(env, 'POST', '/api/presence', { projectId: 'p-villa', lat: 12.74412345, lng: -8.0726 }, moussa);
  assert.equal(first.status, 201);
  const p = (await first.json()).presence;
  assert.equal(p.lat, 12.74412);
  assert.match(p.time, /^\d{2}:\d{2}$/);
  const again = await raw(env, 'POST', '/api/presence', { projectId: 'p-villa' }, moussa);
  assert.equal(again.status, 200);
  assert.equal((await again.json()).presence.id, p.id);
  assert.equal((await raw(env, 'POST', '/api/presence', { projectId: 'p-immeuble' }, moussa)).status, 403);
  assert.equal((await raw(env, 'POST', '/api/presence', { projectId: 'p-villa' }, boss)).status, 403);
  const bad = await raw(env, 'POST', '/api/presence', { projectId: 'p-immeuble', lat: 999, lng: 5 }, ibrahim);
  assert.equal((await bad.json()).presence.lat, null, 'position impossible ignorée');
  const names = async (who) => (await (await raw(env, 'GET', '/api/presence', undefined, who)).json()).presences.map((x) => x.projectId).sort();
  assert.deepEqual(await names(moussa), ['p-villa']);
  assert.deepEqual(await names(ibrahim), ['p-immeuble']);
  assert.deepEqual(await names(chef), ['p-villa']);
  assert.deepEqual(await names(gest), ['p-immeuble', 'p-villa']);
  assert.deepEqual(await names(boss), ['p-immeuble', 'p-villa']);
  assert.equal((await raw(env, 'GET', '/api/presence')).status, 401);
});

test('démonstration : entrée par rôle sans code, remise à zéro, et fermée hors du site de démo', async () => {
  const off = makeEnv();
  assert.equal((await raw(off, 'POST', '/api/demo/enter', { role: 'chef' })).status, 404);
  const env = makeEnv({ DEMO: '1' });
  assert.equal((await raw(env, 'POST', '/api/demo/enter', { role: 'pirate' })).status, 400);
  const boss = await raw(env, 'POST', '/api/demo/enter', { role: 'direction' });
  assert.equal(boss.status, 200);
  const b = await boss.json();
  assert.equal(b.workspace.revision, 1);
  assert.equal(b.workspace.data.settings.company, 'BTP DÉMO SARL');
  const chef = cookieOf(await raw(env, 'POST', '/api/demo/enter', { role: 'chef' }));
  assert.equal((await (await raw(env, 'GET', '/api/me', undefined, chef)).json()).user.name, 'Adama Traoré');
  const chefView = await (await raw(env, 'GET', '/api/workspace', undefined, chef)).json();
  assert.deepEqual(chefView.data.projects.map((p) => p.id).sort(), ['p-boutique', 'p-villa']);
  assert.equal((await (await raw(env, 'GET', '/api/presence', undefined, chef)).json()).presences.length, 1);
  assert.equal((await (await raw(env, 'GET', '/api/requests', undefined, chef)).json()).requests.length, 1);
  // La clé privée et la sauvegarde ne s'ouvrent jamais sur la démo.
  assert.equal((await raw(env, 'POST', '/api/setup', {}, null, { Authorization: 'Bearer ' + KEY })).status, 403);
  assert.equal((await raw(env, 'GET', '/api/backup', undefined, null, { Authorization: 'Bearer ' + KEY })).status, 403);
  // Le patron de la démo modifie les données, puis la nuit remet tout à zéro.
  const bossCookie = cookieOf(boss);
  const changed = { ...b.workspace.data, clients: [...b.workspace.data.clients, { id: 'c-new', name: 'Visiteur' }] };
  assert.equal((await raw(env, 'PUT', '/api/workspace', { revision: 1, data: changed }, bossCookie)).status, 200);
  let waited;
  await worker.scheduled({}, env, { waitUntil: (p) => { waited = p; } });
  await waited;
  const after = await (await raw(env, 'POST', '/api/demo/enter', { role: 'direction' })).json();
  assert.equal(after.workspace.revision, 1);
  assert.ok(!after.workspace.data.clients.some((c) => c.id === 'c-new'));
  assert.equal((await raw(env, 'GET', '/api/me', undefined, chef)).status, 401, 'les anciennes sessions sont fermées');
});

test('le cron ne touche jamais à une base qui n’est pas celle de la démo', async () => {
  const { env, boss } = await world();
  let called = false;
  await worker.scheduled({}, env, { waitUntil: () => { called = true; } });
  assert.equal(called, false);
  assert.equal((await (await raw(env, 'GET', '/api/workspace', undefined, boss)).json()).revision, 1);
});

test('résumé du jour pour WhatsApp, et référence Orange Money conservée à la validation', () => {
  const s = demoCompany(new Date('2026-11-06T09:00:00Z'));
  const text = dayReport(s, '2026-11-06');
  assert.match(text, /Résumé du 06\/11\/2026 – BTP DÉMO SARL/);
  assert.match(text, /Dépenses : 1\s155\s000 F \(6\)/u);
  assert.match(text, /budget dépassé de 200\s000 F/u);
  const a = entryToAction({ id: 'x', kind: 'expense', projectId: 'p', accountId: 'k', userName: 'A', data: { description: 'd', amount: 5, scope: 'Chantier', method: 'Orange Money', reference: 'OM-1', date: '2026-11-06' } });
  assert.equal(a.data.reference, 'OM-1');
  const b = entryToAction({ id: 'y', kind: 'teamPayment', accountId: 'k', userName: 'A', data: { taskId: 't', amount: 5, method: 'Espèces', reference: '', date: '2026-11-06' } });
  assert.equal(b.data.reference, undefined);
});

test('notifications : le chef voit le problème vocal de l’ouvrier et sa réponse revient à l’ouvrier', async () => {
  const env = makeEnv({ DEMO: '1' });
  const enter = async (role) => cookieOf(await raw(env, 'POST', '/api/demo/enter', { role }));
  const ouvrier = await enter('ouvrier');
  const chef = await enter('chef');
  const boss = await enter('direction');
  const audio = 'data:audio/webm;base64,GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQRChYEC';
  const inc = await (await raw(env, 'POST', '/api/entries', { kind: 'incident', projectId: 'p-villa', audio }, ouvrier)).json();
  assert.equal((await raw(env, 'POST', '/api/presence', { projectId: 'p-villa' }, ouvrier)).status, 201);
  const list = async (who) => (await (await raw(env, 'GET', '/api/notifications', undefined, who)).json()).items;
  const forChef = await list(chef);
  const vocal = forChef.find((x) => x.entryId === inc.entry.id);
  assert.equal(vocal.title, 'Problème signalé');
  assert.equal(vocal.hasAudio, true);
  assert.ok(forChef.some((x) => x.kind === 'presence' && /Moussa Diarra est arrivé/.test(x.title)));
  assert.ok(!forChef.some((x) => x.kind === 'expense' && x.text.startsWith('Adama')), 'pas ses propres saisies');
  // L'ouvrier ne reçoit pas les saisies des autres, seulement ce qui le concerne.
  assert.ok(!(await list(ouvrier)).some((x) => x.kind === 'presence' || x.entryId === inc.entry.id && x.kind === 'incident'));
  assert.equal((await raw(env, 'POST', `/api/threads/${inc.entry.id}`, { text: 'J’arrive avec les outils.' }, chef)).status, 201);
  assert.equal((await raw(env, 'POST', `/api/entries/${inc.entry.id}/decision`, { decision: 'resolve', reason: 'Réparé' }, boss)).status, 200);
  const forWorker = await list(ouvrier);
  assert.ok(forWorker.some((x) => x.kind === 'message' && x.title === 'Message de Adama Traoré'));
  assert.ok(forWorker.some((x) => x.kind === 'decision' && /Problème réglé/.test(x.title)));
  // « Depuis » : rien de nouveau après maintenant.
  const now = new Date(Date.now() + 1000).toISOString();
  assert.equal((await (await raw(env, 'GET', '/api/notifications?since=' + now, undefined, chef)).json()).items.length, 0);
  assert.equal((await raw(env, 'GET', '/api/notifications')).status, 401);
});

test('audit : la démo ne peut être remise à zéro qu’une fois toutes les 10 minutes', async () => {
  const env = makeEnv({ DEMO: '1' });
  assert.equal((await raw(env, 'POST', '/api/demo/reset')).status, 200);
  assert.equal((await raw(env, 'POST', '/api/demo/reset')).status, 429);
});

test('audit : la relance ne réclame jamais la retenue de garantie non libérée', async () => {
  const { overdue, due } = await import('../src/domain.js');
  let s = empty();
  s = apply(s, { type: 'save', table: 'clients', data: { id: 'c', name: 'C' } });
  s = apply(s, { type: 'invoice', data: { id: 'i', clientId: 'c', retention: 10, date: '2026-01-01', tax: 0, discount: 0, lines: [{ description: 'x', quantity: 1, unit: 'u', unitPrice: 1000 }] } });
  s = apply(s, { type: 'save', table: 'schedules', data: { id: 'sc', invoiceId: 'i', dueDate: '2026-02-01', amount: 1000 } });
  s = apply(s, { type: 'payment', data: { invoiceId: 'i', accountId: 'main', amount: 800, date: '2026-02-02' } });
  assert.equal(due(s, s.invoices[0]), 100);
  assert.equal(overdue(s, '2026-03-01')[0].amount, 100);
});
