// Démonstration SoBara : actif uniquement sur le site de démo (variable DEMO = "1").
// On y entre sans code, avec un rôle au choix ; tout est fictif et remis à zéro chaque nuit.
import { startSession } from './team.js';
import { demoCompany, DEMO_USERS } from '../src/demoData.js';

const reply = (data, status = 200, cookies = []) => {
  const headers = new Headers({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  cookies.forEach((c) => headers.append('Set-Cookie', c));
  return new Response(JSON.stringify(data), { status, headers });
};
const ROLES = ['direction', 'gestionnaire', 'chef', 'ouvrier'];
const TABLES = ['messages', 'material_requests', 'entries', 'presences', 'sessions', 'devices', 'invites', 'users', 'workspace', 'workspaces', 'companies'];

export async function resetDemo(env, now = new Date()) {
  for (const t of TABLES) await env.DB.prepare(`DELETE FROM ${t}`).run();
  const stamp = now.toISOString();
  const data = demoCompany(now);
  await env.DB.prepare('INSERT INTO workspace(id,revision,payload,updated_at) VALUES(1,1,?,?)').bind(JSON.stringify(data), stamp).run();
  for (const u of DEMO_USERS) {
    await env.DB.prepare('INSERT INTO users(id,name,role,email,employee_id,project_ids,active,created_at) VALUES(?,?,?,NULL,?,?,1,?)')
      .bind(u.id, u.name, u.role, u.employeeId, JSON.stringify(u.projectIds), stamp).run();
  }
  const today = stamp.slice(0, 10);
  const ago = (min) => new Date(now.getTime() - min * 60000).toISOString();
  const entry = (id, kind, project, userId, name, d, status, account, created) => env.DB.prepare('INSERT INTO entries(id,kind,project_id,user_id,user_name,data,status,account_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
    .bind(id, kind, project, userId, name, JSON.stringify(d), status, account, created).run();
  // Une dépense du chef à valider, un incident signalé par l'ouvrier, et la réponse du chef.
  await entry('demo-entry-coffrage', 'expense', 'p-villa', 'demo-chef', 'Adama Traoré', { description: 'Planches de coffrage', amount: 180000, scope: 'Chantier', category: 'Matériaux', method: 'Espèces', date: today }, 'pending', 'k-adama', ago(50));
  await entry('demo-entry-brouettes', 'incident', 'p-villa', 'demo-ouvrier', 'Moussa Diarra', { note: 'Deux brouettes sont cassées, on travaille plus lentement.', type: 'Problème', date: today }, 'open', null, ago(120));
  await env.DB.prepare('INSERT INTO messages(id,thread_id,user_id,user_name,role,text,created_at) VALUES(?,?,?,?,?,?,?)')
    .bind('demo-msg-1', 'demo-entry-brouettes', 'demo-chef', 'Adama Traoré', 'chef', 'Bien reçu. Je passe à la quincaillerie cet après-midi.', ago(90)).run();
  // Un besoin de matériel envoyé par l'ouvrier, en attente du chef.
  const items = [{ description: 'Ciment', quantity: 30, unit: 'sac' }, { description: 'Fer de 10', quantity: 20, unit: 'barre' }];
  await env.DB.prepare("INSERT INTO material_requests(id,project_id,user_id,user_name,items,note,status,history,created_at,updated_at) VALUES(?,?,?,?,?,?,'besoin',?,?,?)")
    .bind('demo-besoin-1', 'p-villa', 'demo-ouvrier', 'Moussa Diarra', JSON.stringify(items), 'Pour la dalle du 1er étage', JSON.stringify([{ status: 'besoin', by: 'Moussa Diarra', at: ago(180) }]), ago(180), ago(180)).run();
  // Pointage du matin du chef ; l'ouvrier peut essayer « Je suis arrivé » lui-même.
  const presence = (id, project, userId, name, role, time) => env.DB.prepare('INSERT INTO presences(id,project_id,user_id,user_name,role,date,time,lat,lng,note,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    .bind(id, project, userId, name, role, today, time, 12.7441, -8.0726, '', stamp).run();
  await presence('demo-pres-chef', 'p-villa', 'demo-chef', 'Adama Traoré', 'chef', '07:12');
  return data;
}

async function enter(request, env, url) {
  let body = {};
  try { body = await request.json(); } catch { /* corps vide */ }
  if (!ROLES.includes(body.role)) return reply({ error: 'Rôle inconnu.' }, 400);
  let row = await env.DB.prepare('SELECT revision,payload,updated_at FROM workspace WHERE id=1').first();
  const user = await env.DB.prepare('SELECT id FROM users WHERE id=?').bind('demo-' + body.role).first();
  if (!row || !user) { await resetDemo(env); row = await env.DB.prepare('SELECT revision,payload,updated_at FROM workspace WHERE id=1').first(); }
  const cookie = await startSession(env, url, 'demo-' + body.role);
  const out = { role: body.role };
  if (body.role === 'direction') out.workspace = { revision: row.revision, data: JSON.parse(row.payload) };
  return reply(out, 200, [cookie]);
}

export async function handleDemo(request, env) {
  const url = new URL(request.url);
  const origin = request.headers.get('Origin');
  if (request.method !== 'GET' && origin && origin !== url.origin) return reply({ error: 'Origine refusée.' }, 403);
  try {
    if (request.method === 'POST' && url.pathname === '/api/demo/enter') return await enter(request, env, url);
    if (request.method === 'POST' && url.pathname === '/api/demo/reset') { await resetDemo(env); return reply({ ok: true }); }
    return reply({ error: 'Adresse inconnue.' }, 404);
  } catch (e) {
    console.error('demo', e?.message);
    return reply({ error: 'Erreur du serveur. Réessayez.' }, 500);
  }
}
