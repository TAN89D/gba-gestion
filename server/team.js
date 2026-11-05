import { apply, validate } from '../src/domain.js';
import { ROLES, viewFor, canWrite, canManageTeam } from '../src/permissions.js';

const SESSION_COOKIE = 'gba_session';
const STATE_COOKIE = 'gba_google_state';
const SESSION_SECONDS = 30 * 86400;
const INVITE_SECONDS = 7 * 86400;
const PIN_ITERATIONS = 100000; // maximum accepté par Cloudflare Workers
const MAX_PIN_FAILURES = 5;
const REVOKE_AFTER_FAILURES = 20;
const LOCK_SECONDS = 15 * 60;
const MAX_BODY = 1800000;

const encoder = new TextEncoder();
const hex = (buffer) => Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, '0')).join('');
const sha256 = async (text) => hex(await crypto.subtle.digest('SHA-256', encoder.encode(text)));
const nowSeconds = () => Math.floor(Date.now() / 1000);
function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function pinHash(pin, salt) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(pin), 'PBKDF2', false, ['deriveBits']);
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: encoder.encode(salt), iterations: PIN_ITERATIONS }, key, 256));
}
async function sameSecret(a, b) {
  const [x, y] = await Promise.all([sha256(String(a)), sha256(String(b))]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new HttpError(status, message); };
function reply(data, status = 200, cookies = []) {
  const headers = new Headers({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  cookies.forEach((c) => headers.append('Set-Cookie', c));
  return new Response(JSON.stringify(data), { status, headers });
}
function redirect(location, cookies = []) {
  const headers = new Headers({ Location: location, 'Cache-Control': 'no-store' });
  cookies.forEach((c) => headers.append('Set-Cookie', c));
  return new Response(null, { status: 302, headers });
}
function cookie(name, value, url, maxAge, sameSite = 'Strict') {
  const secure = url.protocol === 'https:' ? '; Secure' : '';
  return `${name}=${value}; Path=/; HttpOnly; SameSite=${sameSite}; Max-Age=${maxAge}${secure}`;
}
function readCookie(request, name) {
  for (const part of (request.headers.get('Cookie') || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return '';
}
async function readJson(request) {
  if (Number(request.headers.get('Content-Length') || 0) > MAX_BODY) fail(413, 'Données trop volumineuses.');
  const raw = await request.text();
  if (raw.length > MAX_BODY) fail(413, 'Données trop volumineuses.');
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error();
    return value;
  } catch { fail(400, 'Requête invalide.'); }
}
const publicUser = (row) => ({
  id: row.id, name: row.name, role: row.role, email: row.email || '', employeeId: row.employee_id || '',
  projectIds: JSON.parse(row.project_ids || '[]'), active: !!row.active,
});

async function startSession(env, url, userId) {
  const token = randomToken();
  await env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(nowSeconds()).run();
  await env.DB.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)')
    .bind(await sha256(token), userId, nowSeconds() + SESSION_SECONDS).run();
  return cookie(SESSION_COOKIE, token, url, SESSION_SECONDS);
}
async function currentUser(request, env) {
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) return null;
  const row = await env.DB.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? AND u.active=1')
    .bind(await sha256(token), nowSeconds()).first();
  return row ? publicUser(row) : null;
}
async function requireUser(request, env) {
  const user = await currentUser(request, env);
  if (!user) fail(401, 'Connexion requise.');
  return user;
}
async function requireManager(request, env) {
  const user = await requireUser(request, env);
  if (!canManageTeam(user)) fail(403, 'Accès réservé à la direction.');
  return user;
}

function cleanMember(body, base = {}) {
  const name = String(body.name ?? base.name ?? '').trim();
  if (!name || name.length > 80) fail(400, 'Nom obligatoire (80 caractères maximum).');
  const role = body.role ?? base.role;
  if (!Object.hasOwn(ROLES, role)) fail(400, 'Rôle invalide.');
  const email = String(body.email ?? base.email ?? '').trim().toLowerCase();
  if (email && (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200)) fail(400, 'Adresse e-mail invalide.');
  const projectIds = body.projectIds ?? base.projectIds ?? [];
  if (!Array.isArray(projectIds) || projectIds.length > 500 || projectIds.some((x) => typeof x !== 'string' || x.length > 100)) fail(400, 'Liste de chantiers invalide.');
  const employeeId = String(body.employeeId ?? base.employeeId ?? '');
  if (employeeId.length > 100) fail(400, 'Identifiant employé invalide.');
  return { name, role, email: email || null, projectIds: [...new Set(projectIds)], employeeId: employeeId || null };
}
async function endAccess(env, userId) {
  await env.DB.prepare('DELETE FROM sessions WHERE user_id=?').bind(userId).run();
  await env.DB.prepare('UPDATE devices SET revoked=1 WHERE user_id=?').bind(userId).run();
  await env.DB.prepare('DELETE FROM invites WHERE user_id=? AND used_at IS NULL').bind(userId).run();
}
async function directionCount(env) {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE role='direction' AND active=1").first();
  return Number(row?.n || 0);
}

async function setup(request, env, url) {
  if (!env.BACKUP_TOKEN || env.BACKUP_TOKEN.length < 32) fail(503, 'Clé privée non configurée.');
  if (!await sameSecret(request.headers.get('Authorization') || '', 'Bearer ' + env.BACKUP_TOKEN)) fail(401, 'Clé privée incorrecte.');
  const body = await readJson(request);
  let row = await env.DB.prepare("SELECT * FROM users WHERE role='direction' AND active=1 ORDER BY created_at LIMIT 1").first();
  if (!row) {
    const member = cleanMember({ name: body.name || 'Direction', role: 'direction', email: body.email });
    const id = crypto.randomUUID();
    await env.DB.prepare('INSERT INTO users(id,name,role,email,employee_id,project_ids,active,created_at) VALUES(?,?,?,?,NULL,?,1,?)')
      .bind(id, member.name, 'direction', member.email, '[]', new Date().toISOString()).run();
    row = await env.DB.prepare('SELECT * FROM users WHERE id=?').bind(id).first();
  }
  return reply({ user: publicUser(row) }, 200, [await startSession(env, url, row.id)]);
}
async function findInvite(env, token) {
  if (typeof token !== 'string' || !token) fail(400, 'Invitation invalide.');
  const row = await env.DB.prepare('SELECT i.expires_at,i.used_at,u.* FROM invites i JOIN users u ON u.id=i.user_id WHERE i.token_hash=? AND u.active=1')
    .bind(await sha256(token)).first();
  if (!row || row.used_at || row.expires_at < nowSeconds()) fail(410, 'Invitation expirée ou déjà utilisée. Demandez-en une nouvelle.');
  return row;
}
async function inviteInfo(request, env) {
  const row = await findInvite(env, (await readJson(request)).token);
  return reply({ name: row.name, role: row.role, hasEmail: !!row.email });
}
async function redeemInvite(request, env, url) {
  const body = await readJson(request);
  const row = await findInvite(env, body.token);
  if (!/^\d{4}$/.test(String(body.pin))) fail(400, 'Choisissez un code à 4 chiffres.');
  const used = await env.DB.prepare('UPDATE invites SET used_at=? WHERE token_hash=? AND used_at IS NULL')
    .bind(nowSeconds(), await sha256(body.token)).run();
  if (used.meta.changes !== 1) fail(410, 'Invitation expirée ou déjà utilisée. Demandez-en une nouvelle.');
  const secret = randomToken();
  const salt = randomToken();
  await env.DB.prepare('INSERT INTO devices(id,secret_hash,user_id,pin_salt,pin_hash,created_at) VALUES(?,?,?,?,?,?)')
    .bind(crypto.randomUUID(), await sha256(secret), row.id, salt, await pinHash(String(body.pin), salt), new Date().toISOString()).run();
  return reply({ deviceSecret: secret, user: publicUser(row) }, 200, [await startSession(env, url, row.id)]);
}
async function pinLogin(request, env, url) {
  const body = await readJson(request);
  const wrong = () => fail(401, 'Code incorrect.');
  if (typeof body.secret !== 'string' || !/^\d{4}$/.test(String(body.pin))) wrong();
  const device = await env.DB.prepare('SELECT d.*,u.active FROM devices d JOIN users u ON u.id=d.user_id WHERE d.secret_hash=?')
    .bind(await sha256(body.secret)).first();
  if (!device || device.revoked || !device.active) wrong();
  // L'essai est compté en une seule opération, avant la vérification :
  // des requêtes simultanées ne peuvent donc pas dépasser la limite.
  const now = nowSeconds();
  const attempt = await env.DB.prepare(
    `UPDATE devices SET failed=failed+1,
       locked_until=CASE WHEN (failed+1)%${MAX_PIN_FAILURES}=0 THEN ? ELSE locked_until END,
       revoked=CASE WHEN failed+1>=${REVOKE_AFTER_FAILURES} THEN 1 ELSE revoked END
     WHERE id=? AND revoked=0 AND locked_until<=? RETURNING failed`,
  ).bind(now + LOCK_SECONDS, device.id, now).first();
  if (!attempt) fail(429, 'Trop d’essais. Réessayez dans 15 minutes.');
  if (await pinHash(String(body.pin), device.pin_salt) !== device.pin_hash) {
    if (attempt.failed % MAX_PIN_FAILURES === 0) fail(429, 'Trop d’essais. Réessayez dans 15 minutes.');
    wrong();
  }
  await env.DB.prepare('UPDATE devices SET failed=0,locked_until=0 WHERE id=? AND revoked=0').bind(device.id).run();
  const row = await env.DB.prepare('SELECT * FROM users WHERE id=?').bind(device.user_id).first();
  return reply({ user: publicUser(row) }, 200, [await startSession(env, url, device.user_id)]);
}
function googleStart(env, url) {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) fail(503, 'Connexion Google non configurée.');
  const state = randomToken();
  const target = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  target.search = new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, redirect_uri: url.origin + '/api/auth/google/callback', response_type: 'code', scope: 'openid email', state, prompt: 'select_account' }).toString();
  return redirect(target.toString(), [cookie(STATE_COOKIE, state, url, 600, 'Lax')]);
}
function decodeIdToken(token) {
  const part = String(token || '').split('.')[1];
  if (!part) fail(401, 'Réponse Google invalide.');
  try { return JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/'))); } catch { fail(401, 'Réponse Google invalide.'); }
}
async function googleCallback(request, env, url) {
  const clear = cookie(STATE_COOKIE, '', url, 0, 'Lax');
  const back = (reason) => redirect('/#connexion-refusee=' + reason, [clear]);
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return back('configuration');
  const state = url.searchParams.get('state') || '';
  const expected = readCookie(request, STATE_COOKIE);
  if (!state || !expected || !await sameSecret(state, expected)) return back('session');
  const code = url.searchParams.get('code');
  if (!code) return back('annulee');
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, redirect_uri: url.origin + '/api/auth/google/callback', grant_type: 'authorization_code' }),
  });
  if (!res.ok) return back('google');
  const claims = decodeIdToken((await res.json()).id_token);
  const issuerOk = ['https://accounts.google.com', 'accounts.google.com'].includes(claims.iss);
  if (!issuerOk || claims.aud !== env.GOOGLE_CLIENT_ID || !(claims.exp > nowSeconds()) || claims.email_verified !== true || !claims.email) return back('google');
  const row = await env.DB.prepare('SELECT * FROM users WHERE email=? AND active=1').bind(String(claims.email).toLowerCase()).first();
  if (!row) return back('compte');
  return redirect('/#connecte', [clear, await startSession(env, url, row.id)]);
}
async function logout(request, env, url) {
  const token = readCookie(request, SESSION_COOKIE);
  if (token) await env.DB.prepare('DELETE FROM sessions WHERE token_hash=?').bind(await sha256(token)).run();
  return reply({ ok: true }, 200, [cookie(SESSION_COOKIE, '', url, 0)]);
}
async function readWorkspace(env) {
  const row = await env.DB.prepare('SELECT revision,payload,updated_at FROM workspace WHERE id=1').first();
  return row ? { revision: row.revision, data: JSON.parse(row.payload), updatedAt: row.updated_at } : null;
}
async function workspace(request, env) {
  const user = await requireUser(request, env);
  const current = await readWorkspace(env);
  if (!current) return reply({ revision: 0, data: null });
  return reply({ revision: current.revision, data: viewFor(current.data, user), updatedAt: current.updatedAt });
}
// Quand le téléphone n'envoie pas ses pièces jointes (trop lourdes), celles déjà en ligne
// sont conservées, dans la limite de ce que la base peut stocker.
const STORE_LIMIT = 1900000;
export function keepAttachments(data, existingPayload) {
  if (!existingPayload) return data;
  let existing = [];
  try { existing = JSON.parse(existingPayload).attachments || []; } catch { return data; }
  let size = encoder.encode(JSON.stringify(data)).length;
  const kept = [];
  for (const item of existing) {
    const weight = encoder.encode(JSON.stringify(item)).length + 1;
    if (size + weight > STORE_LIMIT) continue;
    kept.push(item);
    size += weight;
  }
  return { ...data, attachments: kept };
}
async function importWorkspace(request, env) {
  await requireManager(request, env);
  const { revision, data, attachmentsOmitted } = await readJson(request);
  if (!Number.isInteger(revision) || revision < 0) fail(400, 'Révision invalide.');
  try { validate(data); } catch (e) { fail(400, e.message || 'Données invalides.'); }
  const previous = attachmentsOmitted === true ? await env.DB.prepare('SELECT payload FROM workspace WHERE id=1 AND revision=?').bind(revision).first() : null;
  const payload = JSON.stringify(previous ? keepAttachments(data, previous.payload) : data);
  const now = new Date().toISOString();
  const saved = revision === 0
    ? await env.DB.prepare('INSERT OR IGNORE INTO workspace(id,revision,payload,updated_at) VALUES(1,1,?,?)').bind(payload, now).run()
    : await env.DB.prepare('UPDATE workspace SET revision=revision+1,payload=?,updated_at=? WHERE id=1 AND revision=?').bind(payload, now, revision).run();
  if (saved.meta.changes !== 1) fail(409, 'Une autre version existe sur le serveur.');
  return reply({ revision: revision + 1, updatedAt: now });
}
async function action(request, env) {
  const user = await requireUser(request, env);
  if (!canWrite(user)) fail(403, 'Votre compte ne peut pas encore modifier ces données.');
  const body = await readJson(request);
  if (!body.action || typeof body.action !== 'object') fail(400, 'Action invalide.');
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = await readWorkspace(env);
    if (!current) fail(409, 'Transférez d’abord les données vers le serveur.');
    let next;
    try {
      next = apply(current.data, body.action);
      next.audit[next.audit.length - 1].by = user.id;
      validate(next);
    } catch (e) { fail(400, e.message || 'Action refusée.'); }
    const now = new Date().toISOString();
    const saved = await env.DB.prepare('UPDATE workspace SET revision=revision+1,payload=?,updated_at=? WHERE id=1 AND revision=?')
      .bind(JSON.stringify(next), now, current.revision).run();
    if (saved.meta.changes === 1) return reply({ revision: current.revision + 1, updatedAt: now });
  }
  fail(409, 'Trop de modifications simultanées. Réessayez.');
}
async function listUsers(request, env) {
  await requireManager(request, env);
  const { results } = await env.DB.prepare('SELECT * FROM users ORDER BY created_at').all();
  return reply({ users: results.map(publicUser) });
}
async function createUser(request, env) {
  await requireManager(request, env);
  const member = cleanMember(await readJson(request));
  const id = crypto.randomUUID();
  try {
    await env.DB.prepare('INSERT INTO users(id,name,role,email,employee_id,project_ids,active,created_at) VALUES(?,?,?,?,?,?,1,?)')
      .bind(id, member.name, member.role, member.email, member.employeeId, JSON.stringify(member.projectIds), new Date().toISOString()).run();
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) fail(409, 'Cette adresse e-mail est déjà utilisée.');
    throw e;
  }
  const row = await env.DB.prepare('SELECT * FROM users WHERE id=?').bind(id).first();
  return reply({ user: publicUser(row) }, 201);
}
async function updateUser(request, env, id) {
  await requireManager(request, env);
  const row = await env.DB.prepare('SELECT * FROM users WHERE id=?').bind(id).first();
  if (!row) fail(404, 'Compte introuvable.');
  const body = await readJson(request);
  const member = cleanMember(body, publicUser(row));
  const active = body.active === undefined ? !!row.active : body.active === true;
  const losesDirection = row.role === 'direction' && row.active && (member.role !== 'direction' || !active);
  if (losesDirection && await directionCount(env) <= 1) fail(409, 'Gardez au moins un compte de direction actif.');
  try {
    await env.DB.prepare('UPDATE users SET name=?,role=?,email=?,employee_id=?,project_ids=?,active=? WHERE id=?')
      .bind(member.name, member.role, member.email, member.employeeId, JSON.stringify(member.projectIds), active ? 1 : 0, id).run();
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) fail(409, 'Cette adresse e-mail est déjà utilisée.');
    throw e;
  }
  if (!active) await endAccess(env, id);
  const updated = await env.DB.prepare('SELECT * FROM users WHERE id=?').bind(id).first();
  return reply({ user: publicUser(updated) });
}
async function createInvite(request, env, id) {
  await requireManager(request, env);
  const row = await env.DB.prepare('SELECT * FROM users WHERE id=? AND active=1').bind(id).first();
  if (!row) fail(404, 'Compte introuvable ou désactivé.');
  await env.DB.prepare('DELETE FROM invites WHERE user_id=? AND used_at IS NULL').bind(id).run();
  const token = randomToken();
  const expires = nowSeconds() + INVITE_SECONDS;
  await env.DB.prepare('INSERT INTO invites(token_hash,user_id,expires_at) VALUES(?,?,?)').bind(await sha256(token), id, expires).run();
  return reply({ token, expiresAt: expires }, 201);
}

export async function handleTeam(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  const notFound = () => reply({ error: 'Adresse inconnue.' }, 404);
  if (!env.DB) return reply({ error: 'Base de données non configurée.' }, 503);
  if (method !== 'GET') {
    const origin = request.headers.get('Origin');
    if (origin && origin !== url.origin) return reply({ error: 'Origine refusée.' }, 403);
  }
  try {
    if (method === 'POST' && path === '/api/setup') return await setup(request, env, url);
    if (method === 'POST' && path === '/api/auth/invite/info') return await inviteInfo(request, env);
    if (method === 'POST' && path === '/api/auth/invite/redeem') return await redeemInvite(request, env, url);
    if (method === 'POST' && path === '/api/auth/pin') return await pinLogin(request, env, url);
    if (method === 'GET' && path === '/api/auth/google/start') return googleStart(env, url);
    if (method === 'GET' && path === '/api/auth/google/callback') return await googleCallback(request, env, url);
    if (method === 'POST' && path === '/api/auth/logout') return await logout(request, env, url);
    if (method === 'GET' && path === '/api/me') return reply({ user: await requireUser(request, env) });
    if (method === 'GET' && path === '/api/workspace') return await workspace(request, env);
    if (method === 'PUT' && path === '/api/workspace') return await importWorkspace(request, env);
    if (method === 'POST' && path === '/api/actions') return await action(request, env);
    if (method === 'GET' && path === '/api/users') return await listUsers(request, env);
    if (method === 'POST' && path === '/api/users') return await createUser(request, env);
    const member = path.match(/^\/api\/users\/([\w-]{1,100})(\/invite)?$/);
    if (member && method === 'PATCH' && !member[2]) return await updateUser(request, env, member[1]);
    if (member && method === 'POST' && member[2]) return await createInvite(request, env, member[1]);
    return notFound();
  } catch (e) {
    if (e instanceof HttpError) return reply({ error: e.message }, e.status);
    console.error('team api', e?.message);
    return reply({ error: 'Erreur du serveur. Réessayez.' }, 500);
  }
}
