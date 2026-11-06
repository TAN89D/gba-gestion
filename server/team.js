import { apply, validate, blankCompany, docTotal, retained as retainedOf } from '../src/domain.js';
import { ROLES, viewFor, canWrite, canManageTeam } from '../src/permissions.js';
import { heldBy } from '../src/cashbox.js';

const SESSION_COOKIE = 'gba_session';
// Entreprise d'origine du site (ses données restent dans la table workspace, ligne 1).
export const MAIN = 'main';
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
  projectIds: JSON.parse(row.project_ids || '[]'), active: !!row.active, companyId: row.company_id || MAIN,
});

export async function startSession(env, url, userId) {
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
async function directionCount(env, companyId) {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE role='direction' AND active=1 AND company_id=?").bind(companyId).first();
  return Number(row?.n || 0);
}

async function setup(request, env, url) {
  if (!env.BACKUP_TOKEN || env.BACKUP_TOKEN.length < 32) fail(503, 'Clé privée non configurée.');
  if (!await sameSecret(request.headers.get('Authorization') || '', 'Bearer ' + env.BACKUP_TOKEN)) fail(401, 'Clé privée incorrecte.');
  const body = await readJson(request);
  let row = await env.DB.prepare("SELECT * FROM users WHERE role='direction' AND active=1 AND company_id='main' ORDER BY created_at LIMIT 1").first();
  if (!row) {
    const member = cleanMember({ name: body.name || 'Direction', role: 'direction', email: body.email });
    const id = crypto.randomUUID();
    await env.DB.prepare('INSERT INTO users(id,name,role,email,employee_id,project_ids,active,created_at) VALUES(?,?,?,?,NULL,?,1,?)')
      .bind(id, member.name, 'direction', member.email, '[]', new Date().toISOString()).run();
    row = await env.DB.prepare('SELECT * FROM users WHERE id=?').bind(id).first();
  }
  return reply({ user: publicUser(row) }, 200, [await startSession(env, url, row.id)]);
}
// ---- Inscription d'une nouvelle entreprise (site SoBara, variable SIGNUP = "1") ----
// Crée l'entreprise, ses données vides, le compte de direction et le code de cet appareil.
async function createCompany(request, env, url) {
  if (env.SIGNUP !== '1') fail(404, 'Adresse inconnue.');
  const body = await readJson(request);
  const company = shortText(body.company, 80, 'Nom de l’entreprise');
  const name = shortText(body.name, 80, 'Votre nom');
  const phone = shortText(body.phone, 30, 'Téléphone');
  if (!company || !name) fail(400, 'Indiquez le nom de l’entreprise et votre nom.');
  if (!/^\d{4}$/.test(String(body.pin))) fail(400, 'Choisissez un code à 4 chiffres.');
  const companyId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const now = new Date().toISOString();
  const data = blankCompany({ company, phone, now });
  validate(data);
  await env.DB.prepare('INSERT INTO companies(id,name,phone,active,created_at) VALUES(?,?,?,1,?)').bind(companyId, company, phone, now).run();
  await env.DB.prepare('INSERT INTO workspaces(company_id,revision,payload,updated_at) VALUES(?,1,?,?)').bind(companyId, JSON.stringify(data), now).run();
  await env.DB.prepare("INSERT INTO users(id,name,role,email,employee_id,project_ids,active,created_at,company_id) VALUES(?,?,'direction',NULL,NULL,'[]',1,?,?)").bind(userId, name, now, companyId).run();
  const secret = randomToken();
  const salt = randomToken();
  await env.DB.prepare('INSERT INTO devices(id,secret_hash,user_id,pin_salt,pin_hash,created_at) VALUES(?,?,?,?,?,?)')
    .bind(crypto.randomUUID(), await sha256(secret), userId, salt, await pinHash(String(body.pin), salt), now).run();
  const row = await env.DB.prepare('SELECT * FROM users WHERE id=?').bind(userId).first();
  return reply({ deviceSecret: secret, user: publicUser(row), workspace: { revision: 1, data } }, 201, [await startSession(env, url, userId)]);
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
async function readWorkspace(env, companyId = MAIN) {
  const row = companyId === MAIN
    ? await env.DB.prepare('SELECT revision,payload,updated_at FROM workspace WHERE id=1').first()
    : await env.DB.prepare('SELECT revision,payload,updated_at FROM workspaces WHERE company_id=?').bind(companyId).first();
  return row ? { revision: row.revision, data: JSON.parse(row.payload), updatedAt: row.updated_at } : null;
}
// Écrit une nouvelle version des données, seulement si la version attendue est toujours la dernière.
export async function writeWorkspace(env, companyId, revision, payload, now) {
  const main = companyId === MAIN;
  return revision === 0
    ? (main ? env.DB.prepare('INSERT OR IGNORE INTO workspace(id,revision,payload,updated_at) VALUES(1,1,?,?)').bind(payload, now)
      : env.DB.prepare('INSERT OR IGNORE INTO workspaces(company_id,revision,payload,updated_at) VALUES(?,1,?,?)').bind(companyId, payload, now)).run()
    : (main ? env.DB.prepare('UPDATE workspace SET revision=revision+1,payload=?,updated_at=? WHERE id=1 AND revision=?').bind(payload, now, revision)
      : env.DB.prepare('UPDATE workspaces SET revision=revision+1,payload=?,updated_at=? WHERE company_id=? AND revision=?').bind(payload, now, companyId, revision)).run();
}
async function workspace(request, env) {
  const user = await requireUser(request, env);
  const current = await readWorkspace(env, user.companyId);
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
  const user = await requireManager(request, env);
  const { revision, data, attachmentsOmitted } = await readJson(request);
  if (!Number.isInteger(revision) || revision < 0) fail(400, 'Révision invalide.');
  if (data?.demo === true) fail(400, 'Les données de démonstration ne peuvent pas remplacer la base commune.');
  try { validate(data); } catch (e) { fail(400, e.message || 'Données invalides.'); }
  const existing = attachmentsOmitted === true ? await readWorkspace(env, user.companyId) : null;
  const previous = existing && existing.revision === revision ? JSON.stringify(existing.data) : null;
  const payload = JSON.stringify(previous ? keepAttachments(data, previous) : data);
  const now = new Date().toISOString();
  const saved = await writeWorkspace(env, user.companyId, revision, payload, now);
  if (saved.meta.changes !== 1) fail(409, 'Une autre version existe sur le serveur.');
  return reply({ revision: revision + 1, updatedAt: now });
}
async function action(request, env) {
  const user = await requireUser(request, env);
  if (!canWrite(user)) fail(403, 'Votre compte ne peut pas encore modifier ces données.');
  const body = await readJson(request);
  if (!body.action || typeof body.action !== 'object') fail(400, 'Action invalide.');
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = await readWorkspace(env, user.companyId);
    if (!current) fail(409, 'Transférez d’abord les données vers le serveur.');
    let next;
    try {
      next = apply(current.data, body.action);
      next.audit[next.audit.length - 1].by = user.id;
      validate(next);
    } catch (e) { fail(400, e.message || 'Action refusée.'); }
    const now = new Date().toISOString();
    const saved = await writeWorkspace(env, user.companyId, current.revision, JSON.stringify(next), now);
    if (saved.meta.changes === 1) return reply({ revision: current.revision + 1, updatedAt: now });
  }
  fail(409, 'Trop de modifications simultanées. Réessayez.');
}
async function listUsers(request, env) {
  const me = await requireManager(request, env);
  const { results } = await env.DB.prepare(
    `SELECT u.*,
       (SELECT COUNT(*) FROM devices d WHERE d.user_id=u.id AND d.revoked=0) AS device_count,
       (SELECT COUNT(*) FROM sessions s WHERE s.user_id=u.id AND s.expires_at>?) AS session_count
     FROM users u WHERE u.company_id=? ORDER BY u.created_at`,
  ).bind(nowSeconds(), me.companyId).all();
  return reply({ users: results.map((row) => ({ ...publicUser(row), devices: Number(row.device_count), sessions: Number(row.session_count) })) });
}
async function createUser(request, env) {
  const me = await requireManager(request, env);
  const member = cleanMember(await readJson(request));
  const id = crypto.randomUUID();
  try {
    await env.DB.prepare('INSERT INTO users(id,name,role,email,employee_id,project_ids,active,created_at,company_id) VALUES(?,?,?,?,?,?,1,?,?)')
      .bind(id, member.name, member.role, member.email, member.employeeId, JSON.stringify(member.projectIds), new Date().toISOString(), me.companyId).run();
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) fail(409, 'Cette adresse e-mail est déjà utilisée.');
    throw e;
  }
  const row = await env.DB.prepare('SELECT * FROM users WHERE id=?').bind(id).first();
  return reply({ user: publicUser(row) }, 201);
}
async function updateUser(request, env, id) {
  const requester = await requireManager(request, env);
  const row = await env.DB.prepare('SELECT * FROM users WHERE id=? AND company_id=?').bind(id, requester.companyId).first();
  if (!row) fail(404, 'Compte introuvable.');
  const body = await readJson(request);
  const member = cleanMember(body, publicUser(row));
  const active = body.active === undefined ? !!row.active : body.active === true;
  if (requester.id === id && (member.role !== row.role || !active)) fail(409, 'Vous ne pouvez pas retirer votre propre accès de direction.');
  const losesDirection = row.role === 'direction' && row.active && (member.role !== 'direction' || !active);
  if (losesDirection && await directionCount(env, requester.companyId) <= 1) fail(409, 'Gardez au moins un compte de direction actif.');
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
  const me = await requireManager(request, env);
  const row = await env.DB.prepare('SELECT * FROM users WHERE id=? AND active=1 AND company_id=?').bind(id, me.companyId).first();
  if (!row) fail(404, 'Compte introuvable ou désactivé.');
  await env.DB.prepare('DELETE FROM invites WHERE user_id=? AND used_at IS NULL').bind(id).run();
  const token = randomToken();
  const expires = nowSeconds() + INVITE_SECONDS;
  await env.DB.prepare('INSERT INTO invites(token_hash,user_id,expires_at) VALUES(?,?,?)').bind(await sha256(token), id, expires).run();
  return reply({ token, expiresAt: expires }, 201);
}

// ---- Saisies de l'équipe : dépenses et paiements à valider, incidents, photos de chantier ----
const ENTRY_KINDS = { direction: ['expense', 'teamPayment', 'incident', 'photo'], gestionnaire: ['expense', 'teamPayment', 'incident', 'photo'], chef: ['expense', 'incident', 'photo'], ouvrier: ['incident', 'photo'] };
const PHOTO_LIMIT = 1500000;
// Message vocal : environ une minute au format compressé du téléphone.
const AUDIO_LIMIT = 900000;
const AUDIO_FORMAT = /^data:audio\/(webm|ogg|mp4|mpeg|aac|x-m4a)(;[\w=.-]+)*;base64,[A-Za-z0-9+/=]+$/;
const MONEY_KINDS = ['expense', 'teamPayment'];
const seesMoney = (user) => ['direction', 'gestionnaire'].includes(user.role);
const shortText = (value, max, label) => {
  const text = String(value ?? '').trim();
  if (text.length > max) fail(400, label + ' trop long.');
  return text;
};
const validAmount = (value) => {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) fail(400, 'Le montant doit être un entier positif en FCFA.');
  return n;
};
const validDate = (value) => {
  if (value === undefined || value === null || value === '') return new Date().toISOString().slice(0, 10);
  const text = String(value);
  const day = new Date(text + 'T00:00:00Z');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(day.getTime()) || day.toISOString().slice(0, 10) !== text) fail(400, 'Date invalide.');
  return text;
};
const publicEntry = (row) => ({
  id: row.id, kind: row.kind, projectId: row.project_id, userName: row.user_name, data: JSON.parse(row.data), status: row.status,
  accountId: row.account_id || '', reason: row.reason || '', createdAt: row.created_at, decidedAt: row.decided_at || '', appliedAt: row.applied_at || '', applyError: row.apply_error || '', hasPhoto: !!row.has_photo, hasAudio: !!row.has_audio, messages: Number(row.messages || 0),
});
const ENTRY_COLUMNS = 'id,kind,project_id,user_id,user_name,data,status,account_id,reason,created_at,decided_at,applied_at,apply_error,company_id,photo IS NOT NULL AS has_photo,audio IS NOT NULL AS has_audio,(SELECT COUNT(*) FROM messages m WHERE m.thread_id=entries.id) AS messages';
async function visibleProjects(env, user) {
  const current = await readWorkspace(env, user.companyId);
  if (!current) return { current: null, ids: new Set() };
  return { current, ids: new Set(viewFor(current.data, user).projects.map((p) => p.id)) };
}
// Le chef de chantier ne voit, parmi les saisies d'argent, que les siennes (dépenses de sa caisse).
const entryAllowed = (entry, user, ids) => (seesMoney(user) ? true : MONEY_KINDS.includes(entry.kind) ? entry.user_id === user.id : ids.has(entry.project_id));
async function reservedOnTask(env, taskId, state, companyId) {
  const { results } = await env.DB.prepare("SELECT id,data FROM entries WHERE company_id=? AND kind='teamPayment' AND (status='pending' OR (status='approved' AND applied_at IS NULL))").bind(companyId).all();
  return results.reduce((n, row) => { const d = JSON.parse(row.data); return d.taskId === taskId && !state.teamPayments.some((p) => p.id === row.id) ? n + Number(d.amount || 0) : n; }, 0);
}
async function createEntry(request, env) {
  const user = await requireUser(request, env);
  const body = await readJson(request);
  // Un renvoi (réponse perdue) retourne la saisie déjà enregistrée, avant tout autre contrôle.
  if (typeof body.id === 'string' && /^[\w-]{8,64}$/.test(body.id)) {
    const known = await env.DB.prepare(`SELECT ${ENTRY_COLUMNS} FROM entries WHERE id=?`).bind(body.id).first();
    if (known) {
      if (known.user_id !== user.id || known.company_id !== user.companyId) fail(409, 'Identifiant déjà utilisé.');
      return reply({ entry: publicEntry(known) }, 200);
    }
  }
  if (!(ENTRY_KINDS[user.role] || []).includes(body.kind)) fail(403, 'Votre compte ne peut pas faire cette saisie.');
  const { current, ids } = await visibleProjects(env, user);
  if (!current) fail(409, 'Les données de l’entreprise ne sont pas encore disponibles.');
  if (typeof body.projectId !== 'string' || !ids.has(body.projectId)) fail(403, 'Chantier non autorisé.');
  const id = typeof body.id === 'string' && /^[\w-]{8,64}$/.test(body.id) ? body.id : crypto.randomUUID();
  const date = validDate(body.date);
  let data;
  if (body.kind === 'expense') {
    const description = shortText(body.description, 300, 'Désignation');
    if (!description) fail(400, 'Désignation obligatoire.');
    const scope = ['Chantier', 'Entreprise', 'Personnel'].includes(body.scope) ? body.scope : 'Chantier';
    data = { description, amount: validAmount(body.amount), scope, category: shortText(body.category, 60, 'Catégorie') || 'Autres', method: shortText(body.method, 40, 'Mode'), reference: shortText(body.reference, 60, 'Référence'), date };
  } else if (body.kind === 'teamPayment') {
    const task = current.data.tasks.find((t) => t.id === body.taskId && t.projectId === body.projectId);
    if (!task) fail(400, 'Choisissez une tâche de ce chantier.');
    const amount = validAmount(body.amount);
    const paid = current.data.teamPayments.filter((p) => !p.void && p.taskId === task.id).reduce((n, p) => n + Number(p.amount || 0), 0);
    if (amount > Number(task.agreedAmount) - paid - await reservedOnTask(env, task.id, current.data, user.companyId)) fail(400, 'Le paiement dépasse le reste à payer de cette tâche.');
    data = { taskId: task.id, employeeId: task.employeeId, description: shortText(task.description, 300, 'Tâche'), amount, method: shortText(body.method, 40, 'Mode'), reference: shortText(body.reference, 60, 'Référence'), date };
  } else if (body.kind === 'incident') {
    const note = shortText(body.note, 2000, 'Description') || (body.audio ? 'Message vocal' : '');
    if (!note) fail(400, 'Décrivez le problème ou enregistrez un message vocal.');
    data = { note, type: shortText(body.type, 60, 'Type') || 'Problème', date };
  } else {
    data = { note: shortText(body.note, 500, 'Note'), date };
  }
  let audio = null;
  if (body.audio !== undefined && body.audio !== null && body.audio !== '') {
    if (body.kind !== 'incident') fail(400, 'Le message vocal accompagne un signalement.');
    if (typeof body.audio !== 'string' || !AUDIO_FORMAT.test(body.audio)) fail(400, 'Message vocal invalide.');
    if (body.audio.length > AUDIO_LIMIT) fail(413, 'Message vocal trop long (1 minute environ au maximum).');
    audio = body.audio;
  }
  let photo = null;
  if (body.photo !== undefined && body.photo !== null && body.photo !== '') {
    if (typeof body.photo !== 'string' || !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(body.photo)) fail(400, 'Photo invalide.');
    if (body.photo.length > PHOTO_LIMIT) fail(413, 'Photo trop volumineuse.');
    photo = body.photo;
  }
  if (body.kind === 'photo' && !photo) fail(400, 'Ajoutez une photo.');
  // L'argent sort de la caisse confiée à la personne (celle du chantier si elle en a une) ;
  // la direction peut encore la changer au moment de valider.
  let accountId = null;
  if (MONEY_KINDS.includes(body.kind)) {
    const held = heldBy(current.data, user.employeeId);
    if (user.role === 'chef' && !held.length) fail(403, 'Aucune caisse ne vous est confiée : demandez-en une à la direction.');
    if (body.accountId) {
      if (!held.some((a) => a.id === body.accountId)) fail(403, 'Cette caisse ne vous est pas confiée.');
      accountId = body.accountId;
    } else if (held.length) accountId = (held.find((a) => a.projectId === body.projectId) || held[0]).id;
  }
  const status = MONEY_KINDS.includes(body.kind) ? 'pending' : body.kind === 'incident' ? 'open' : 'info';
  const saved = await env.DB.prepare('INSERT OR IGNORE INTO entries(id,kind,project_id,user_id,user_name,data,photo,audio,status,account_id,created_at,company_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
    .bind(id, body.kind, body.projectId, user.id, user.name, JSON.stringify(data), photo, audio, status, accountId, new Date().toISOString(), user.companyId).run();
  if (saved.meta.changes !== 1) {
    const existing = await env.DB.prepare('SELECT user_id FROM entries WHERE id=?').bind(id).first();
    if (existing?.user_id !== user.id) fail(409, 'Identifiant déjà utilisé.');
  }
  const row = await env.DB.prepare(`SELECT ${ENTRY_COLUMNS} FROM entries WHERE id=?`).bind(id).first();
  return reply({ entry: publicEntry(row) }, 201);
}
async function listEntries(request, env) {
  const user = await requireUser(request, env);
  const { ids } = await visibleProjects(env, user);
  // Ce qui reste à traiter est toujours renvoyé, même au-delà des 1000 dernières saisies.
  const { results } = await env.DB.prepare(`SELECT ${ENTRY_COLUMNS} FROM entries WHERE company_id=? AND (status IN ('pending','open') OR (status='approved' AND applied_at IS NULL) OR id IN (SELECT id FROM entries WHERE company_id=? ORDER BY created_at DESC LIMIT 1000)) ORDER BY created_at DESC`).bind(user.companyId, user.companyId).all();
  return reply({ entries: results.filter((row) => entryAllowed(row, user, ids)).map(publicEntry) });
}
async function entryPhoto(request, env, id) {
  const user = await requireUser(request, env);
  const row = await env.DB.prepare('SELECT kind,project_id,user_id,photo,company_id FROM entries WHERE id=?').bind(id).first();
  const { ids } = await visibleProjects(env, user);
  if (!row || !(row.company_id === user.companyId) || !entryAllowed(row, user, ids) || !row.photo) fail(404, 'Photo introuvable.');
  return reply({ photo: row.photo });
}
async function entryAudio(request, env, id) {
  const user = await requireUser(request, env);
  const row = await env.DB.prepare('SELECT kind,project_id,user_id,audio,company_id FROM entries WHERE id=?').bind(id).first();
  const { ids } = await visibleProjects(env, user);
  if (!row || !(row.company_id === user.companyId) || !entryAllowed(row, user, ids) || !row.audio) fail(404, 'Message vocal introuvable.');
  return reply({ audio: row.audio });
}
async function decideEntry(request, env, id) {
  const user = await requireManager(request, env);
  const body = await readJson(request);
  const row = await env.DB.prepare('SELECT kind,status,project_id,data,company_id FROM entries WHERE id=?').bind(id).first();
  if (!row || !(row.company_id === user.companyId)) fail(404, 'Saisie introuvable.');
  const now = new Date().toISOString();
  let result;
  if (body.decision === 'approve') {
    if (!MONEY_KINDS.includes(row.kind)) fail(400, 'Cette saisie ne se valide pas.');
    const current = await readWorkspace(env, user.companyId);
    if (!current?.data.accounts.some((a) => a.id === body.accountId)) fail(400, 'Choisissez la caisse à utiliser.');
    if (row.kind === 'teamPayment') {
      const d = JSON.parse(row.data);
      const task = current.data.tasks.find((t) => t.id === d.taskId);
      if (!task || task.projectId !== row.project_id || (d.employeeId && task.employeeId !== d.employeeId)) fail(409, 'La tâche a changé de chantier ou d’ouvrier depuis la saisie. Refusez-la et demandez une nouvelle saisie.');
      // Une saisie ancienne ne connaissait pas l'ouvrier : on fige celui que la direction valide.
      if (!d.employeeId) {
        await env.DB.prepare("UPDATE entries SET data=? WHERE id=? AND status='pending'").bind(JSON.stringify({ ...d, employeeId: task.employeeId }), id).run();
      }
    }
    result = await env.DB.prepare("UPDATE entries SET status='approved',account_id=?,decided_at=? WHERE id=? AND status='pending'").bind(body.accountId, now, id).run();
  } else if (body.decision === 'reject') {
    const reason = shortText(body.reason, 500, 'Motif');
    if (!reason) fail(400, 'Indiquez le motif du refus.');
    result = await env.DB.prepare("UPDATE entries SET status='rejected',reason=?,decided_at=? WHERE id=? AND status='pending'").bind(reason, now, id).run();
  } else if (body.decision === 'resolve') {
    result = await env.DB.prepare("UPDATE entries SET status='resolved',reason=?,decided_at=? WHERE id=? AND status='open'").bind(shortText(body.reason, 500, 'Note'), now, id).run();
  } else if (body.decision === 'reopen') {
    result = await env.DB.prepare("UPDATE entries SET status='open',decided_at=? WHERE id=? AND status='resolved'").bind(now, id).run();
  } else if (body.decision === 'retry') {
    result = await env.DB.prepare("UPDATE entries SET apply_error=NULL WHERE id=? AND status='approved' AND applied_at IS NULL AND apply_error IS NOT NULL").bind(id).run();
  } else if (body.decision === 'cancel') {
    const reason = shortText(body.reason, 500, 'Motif');
    if (!reason) fail(400, 'Indiquez le motif.');
    result = await env.DB.prepare("UPDATE entries SET status='rejected',reason=?,apply_error=NULL,decided_at=? WHERE id=? AND status='approved' AND applied_at IS NULL AND apply_error IS NOT NULL").bind(reason, now, id).run();
  } else fail(400, 'Décision invalide.');
  if (result.meta.changes !== 1) fail(409, 'Cette saisie a déjà été traitée.');
  const updated = await env.DB.prepare(`SELECT ${ENTRY_COLUMNS} FROM entries WHERE id=?`).bind(id).first();
  return reply({ entry: publicEntry(updated) });
}
async function entriesToApply(request, env) {
  const user = await requireManager(request, env);
  const { results } = await env.DB.prepare(`SELECT ${ENTRY_COLUMNS} FROM entries WHERE company_id=? AND status='approved' AND applied_at IS NULL AND apply_error IS NULL ORDER BY created_at`).bind(user.companyId).all();
  return reply({ entries: results.map(publicEntry) });
}
async function markApplied(request, env, id) {
  const user = await requireManager(request, env);
  const body = await readJson(request);
  const error = body.error ? shortText(body.error, 300, 'Erreur') : null;
  const result = await env.DB.prepare(error
    ? "UPDATE entries SET apply_error=? WHERE id=? AND company_id=? AND status='approved' AND applied_at IS NULL"
    : "UPDATE entries SET applied_at=? WHERE id=? AND company_id=? AND status='approved' AND applied_at IS NULL").bind(error || new Date().toISOString(), id, user.companyId).run();
  if (result.meta.changes !== 1) fail(409, 'Saisie déjà traitée.');
  return reply({ ok: true });
}

// ---- Demandes de matériel ----
// besoin (ouvrier) -> demande (chef, gestionnaire) -> commande (direction : bon de commande)
// -> livre (matériel arrivé sur le chantier) -> recu (la personne qui l'a demandé l'a reçu).
const REQUEST_COLUMNS = 'id,company_id,project_id,user_id,user_name,items,note,status,order_data,order_number,order_applied_at,delivery_applied_at,apply_error,reason,history,created_at,updated_at,(SELECT COUNT(*) FROM messages m WHERE m.thread_id=material_requests.id) AS messages';
const requestAllowed = (row, user, ids) => ['direction', 'gestionnaire'].includes(user.role) || row.user_id === user.id || (user.role === 'chef' && ids.has(row.project_id));
const leads = (user, row, ids) => user.role === 'direction' || user.role === 'gestionnaire' || (user.role === 'chef' && ids.has(row.project_id));
function publicRequest(row, user) {
  const order = row.order_data ? JSON.parse(row.order_data) : null;
  return {
    id: row.id, projectId: row.project_id, userName: row.user_name, mine: row.user_id === user.id, items: JSON.parse(row.items), note: row.note || '', status: row.status, reason: row.reason || '',
    order: order ? { supplierName: order.supplierName, expectedDate: order.expectedDate || '', ...(seesMoney(user) ? { supplierId: order.supplierId, amount: order.amount } : {}) } : null,
    orderNumber: row.order_number || '', orderReady: !!row.order_applied_at, deliveryApplied: !!row.delivery_applied_at, applyError: row.apply_error || '',
    history: JSON.parse(row.history || '[]'), messages: Number(row.messages || 0), createdAt: row.created_at, updatedAt: row.updated_at,
  };
}
function validItems(value) {
  if (!Array.isArray(value) || !value.length || value.length > 30) fail(400, 'Indiquez entre 1 et 30 articles.');
  return value.map((x) => {
    const description = shortText(x?.description, 200, 'Article');
    const quantity = Number(x?.quantity);
    if (!description) fail(400, 'Chaque article doit avoir une désignation.');
    if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 1000000) fail(400, 'Quantité invalide.');
    return { description, quantity, unit: shortText(x?.unit, 20, 'Unité') };
  });
}
async function createRequest(request, env) {
  const user = await requireUser(request, env);
  const body = await readJson(request);
  const validId = typeof body.id === 'string' && /^[\w-]{8,64}$/.test(body.id);
  if (validId) {
    const known = await env.DB.prepare(`SELECT ${REQUEST_COLUMNS} FROM material_requests WHERE id=?`).bind(body.id).first();
    if (known) {
      if (known.user_id !== user.id || known.company_id !== user.companyId) fail(409, 'Identifiant déjà utilisé.');
      return reply({ request: publicRequest(known, user) });
    }
  }
  const { current, ids } = await visibleProjects(env, user);
  if (!current) fail(409, 'Les données de l’entreprise ne sont pas encore disponibles.');
  if (typeof body.projectId !== 'string' || !ids.has(body.projectId)) fail(403, 'Chantier non autorisé.');
  const items = validItems(body.items);
  const now = new Date().toISOString();
  const status = user.role === 'ouvrier' ? 'besoin' : 'demande';
  const id = validId ? body.id : crypto.randomUUID();
  const history = [{ at: now, by: user.name, step: status }];
  await env.DB.prepare('INSERT OR IGNORE INTO material_requests(id,project_id,user_id,user_name,items,note,status,history,created_at,updated_at,company_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    .bind(id, body.projectId, user.id, user.name, JSON.stringify(items), shortText(body.note, 1000, 'Note'), status, JSON.stringify(history), now, now, user.companyId).run();
  const row = await env.DB.prepare(`SELECT ${REQUEST_COLUMNS} FROM material_requests WHERE id=?`).bind(id).first();
  if (row.user_id !== user.id || row.company_id !== user.companyId) fail(409, 'Identifiant déjà utilisé.');
  return reply({ request: publicRequest(row, user) }, 201);
}
async function listRequests(request, env) {
  const user = await requireUser(request, env);
  const { ids } = await visibleProjects(env, user);
  const { results } = await env.DB.prepare(`SELECT ${REQUEST_COLUMNS} FROM material_requests WHERE company_id=? AND (status IN ('besoin','demande','commande','livre') OR id IN (SELECT id FROM material_requests WHERE company_id=? ORDER BY updated_at DESC LIMIT 300)) ORDER BY updated_at DESC`).bind(user.companyId, user.companyId).all();
  return reply({ requests: results.filter((row) => requestAllowed(row, user, ids)).map((row) => publicRequest(row, user)) });
}
async function stepRequest(request, env, id) {
  const user = await requireUser(request, env);
  const body = await readJson(request);
  const row = await env.DB.prepare('SELECT * FROM material_requests WHERE id=? AND company_id=?').bind(id, user.companyId).first();
  const { current, ids } = await visibleProjects(env, user);
  if (!row || !requestAllowed(row, user, ids)) fail(404, 'Demande introuvable.');
  const lead = leads(user, row, ids);
  const sets = {};
  let from;
  let to;
  if (body.step === 'forward') {
    if (!lead) fail(403, 'Seuls le chef de chantier, le gestionnaire ou la direction transmettent une demande.');
    from = ['besoin']; to = 'demande';
    if (body.items !== undefined) sets.items = JSON.stringify(validItems(body.items));
  } else if (body.step === 'refuse') {
    if (!lead) fail(403, 'Action non autorisée.');
    from = user.role === 'direction' ? ['besoin', 'demande'] : ['besoin']; to = 'refuse';
    sets.reason = shortText(body.reason, 500, 'Motif');
    if (!sets.reason) fail(400, 'Indiquez le motif du refus.');
  } else if (body.step === 'order') {
    if (user.role !== 'direction') fail(403, 'Seule la direction établit le bon de commande.');
    const supplier = current?.data.suppliers.find((x) => x.id === body.supplierId);
    if (!supplier) fail(400, 'Choisissez le fournisseur.');
    from = ['demande']; to = 'commande';
    sets.order_data = JSON.stringify({ supplierId: supplier.id, supplierName: supplier.name, amount: validAmount(body.amount), expectedDate: body.expectedDate ? validDate(body.expectedDate) : '' });
    if (body.items !== undefined) sets.items = JSON.stringify(validItems(body.items));
  } else if (body.step === 'deliver') {
    if (!lead) fail(403, 'Seuls le chef de chantier, le gestionnaire ou la direction confirment la livraison.');
    if (!row.order_applied_at) fail(409, 'Le bon de commande n’est pas encore enregistré par la direction.');
    from = ['commande']; to = 'livre';
  } else if (body.step === 'receive') {
    if (!lead && row.user_id !== user.id) fail(403, 'Action non autorisée.');
    from = ['livre']; to = 'recu';
  } else if (body.step === 'retry') {
    if (user.role !== 'direction') fail(403, 'Action non autorisée.');
    const done = await env.DB.prepare('UPDATE material_requests SET apply_error=NULL WHERE id=? AND company_id=? AND apply_error IS NOT NULL').bind(id, user.companyId).run();
    if (done.meta.changes !== 1) fail(409, 'Rien à réessayer.');
    return reply({ ok: true });
  } else fail(400, 'Étape inconnue.');
  if (!from.includes(row.status)) fail(409, 'Cette demande a déjà avancé : actualisez.');
  const now = new Date().toISOString();
  const history = [...JSON.parse(row.history || '[]'), { at: now, by: user.name, step: to }];
  const keys = Object.keys(sets);
  const done = await env.DB.prepare(`UPDATE material_requests SET status=?,history=?,updated_at=?${keys.map((k) => `,${k}=?`).join('')} WHERE id=? AND status=?`)
    .bind(to, JSON.stringify(history), now, ...keys.map((k) => sets[k]), id, row.status).run();
  if (done.meta.changes !== 1) fail(409, 'Cette demande a déjà avancé : actualisez.');
  const updated = await env.DB.prepare(`SELECT ${REQUEST_COLUMNS} FROM material_requests WHERE id=?`).bind(id).first();
  return reply({ request: publicRequest(updated, user) });
}
// Ce que le téléphone de la direction doit inscrire dans ses données : le bon de commande, puis la réception.
async function requestsToApply(request, env) {
  const user = await requireManager(request, env);
  const { results } = await env.DB.prepare(`SELECT ${REQUEST_COLUMNS} FROM material_requests WHERE company_id=? AND apply_error IS NULL AND ((status IN ('commande','livre','recu') AND order_applied_at IS NULL) OR (status IN ('livre','recu') AND delivery_applied_at IS NULL)) ORDER BY updated_at`).bind(user.companyId).all();
  return reply({ requests: results.map((row) => ({ ...publicRequest(row, user), deliveredBy: (JSON.parse(row.history || '[]').find((h) => h.step === 'livre') || {}).by || '' })) });
}
async function markRequestApplied(request, env, id) {
  const user = await requireManager(request, env);
  const body = await readJson(request);
  let result;
  if (body.error) result = await env.DB.prepare('UPDATE material_requests SET apply_error=? WHERE id=? AND company_id=?').bind(shortText(body.error, 300, 'Erreur'), id, user.companyId).run();
  else if (body.phase === 'order') result = await env.DB.prepare("UPDATE material_requests SET order_applied_at=?,order_number=? WHERE id=? AND company_id=? AND order_applied_at IS NULL AND status IN ('commande','livre','recu')").bind(new Date().toISOString(), shortText(body.number, 40, 'Numéro'), id, user.companyId).run();
  else if (body.phase === 'delivery') result = await env.DB.prepare("UPDATE material_requests SET delivery_applied_at=? WHERE id=? AND company_id=? AND delivery_applied_at IS NULL AND order_applied_at IS NOT NULL AND status IN ('livre','recu')").bind(new Date().toISOString(), id, user.companyId).run();
  else fail(400, 'Étape inconnue.');
  if (result.meta.changes !== 1) fail(409, 'Déjà enregistré.');
  return reply({ ok: true });
}

// ---- Fil de messages (incident ou demande de matériel) ----
async function threadAllowed(env, user, id) {
  const { ids } = await visibleProjects(env, user);
  const entry = await env.DB.prepare('SELECT kind,project_id,user_id FROM entries WHERE id=? AND company_id=?').bind(id, user.companyId).first();
  if (entry) return entryAllowed(entry, user, ids);
  const req = await env.DB.prepare('SELECT project_id,user_id FROM material_requests WHERE id=? AND company_id=?').bind(id, user.companyId).first();
  return !!req && requestAllowed(req, user, ids);
}
async function listMessages(request, env, id) {
  const user = await requireUser(request, env);
  if (!await threadAllowed(env, user, id)) fail(404, 'Discussion introuvable.');
  // Les 300 derniers messages, remis dans l'ordre chronologique.
  const { results } = await env.DB.prepare('SELECT id,user_id,user_name,role,text,created_at FROM messages WHERE thread_id=? AND company_id=? ORDER BY created_at DESC, rowid DESC LIMIT 300').bind(id, user.companyId).all();
  return reply({ messages: results.reverse().map((m) => ({ id: m.id, userName: m.user_name, role: m.role, text: m.text, at: m.created_at, mine: m.user_id === user.id })) });
}
async function postMessage(request, env, id) {
  const user = await requireUser(request, env);
  const body = await readJson(request);
  if (!await threadAllowed(env, user, id)) fail(404, 'Discussion introuvable.');
  const text = shortText(body.text, 1000, 'Message');
  if (!text) fail(400, 'Écrivez un message.');
  const msgId = typeof body.id === 'string' && /^[\w-]{8,64}$/.test(body.id) ? body.id : crypto.randomUUID();
  await env.DB.prepare('INSERT OR IGNORE INTO messages(id,thread_id,user_id,user_name,role,text,created_at,company_id) VALUES(?,?,?,?,?,?,?,?)')
    .bind(msgId, id, user.id, user.name, user.role, text, new Date().toISOString(), user.companyId).run();
  const saved = await env.DB.prepare('SELECT user_id,thread_id FROM messages WHERE id=?').bind(msgId).first();
  if (saved.user_id !== user.id || saved.thread_id !== id) fail(409, 'Identifiant déjà utilisé.');
  return reply({ ok: true }, 201);
}

// ---- Pointage : « Je suis arrivé » sur le chantier, avec l'heure du serveur et la position si elle est donnée ----
const PRESENCE_ROLES = ['gestionnaire', 'chef', 'ouvrier'];
const publicPresence = (r) => ({ id: r.id, projectId: r.project_id, userId: r.user_id, userName: r.user_name, role: r.role, date: r.date, time: r.time, lat: r.lat, lng: r.lng, note: r.note || '' });
async function createPresence(request, env) {
  const user = await requireUser(request, env);
  if (!PRESENCE_ROLES.includes(user.role)) fail(403, 'Le pointage est réservé à l’équipe de chantier.');
  const body = await readJson(request);
  const { current, ids } = await visibleProjects(env, user);
  if (!current) fail(409, 'Les données de l’entreprise ne sont pas encore disponibles.');
  if (typeof body.projectId !== 'string' || !ids.has(body.projectId)) fail(403, 'Chantier non autorisé.');
  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  const id = typeof body.id === 'string' && /^[\w-]{8,64}$/.test(body.id) ? body.id : crypto.randomUUID();
  // Un seul pointage par personne, par chantier et par jour : un second envoi renvoie le premier.
  const already = await env.DB.prepare('SELECT * FROM presences WHERE user_id=? AND project_id=? AND date=?').bind(user.id, body.projectId, date).first();
  if (already) return reply({ presence: publicPresence(already) }, 200);
  let lat = null, lng = null;
  const la = Number(body.lat), lo = Number(body.lng);
  if (body.lat != null && body.lng != null && Number.isFinite(la) && Number.isFinite(lo) && Math.abs(la) <= 90 && Math.abs(lo) <= 180) { lat = Math.round(la * 100000) / 100000; lng = Math.round(lo * 100000) / 100000; }
  await env.DB.prepare('INSERT OR IGNORE INTO presences(id,project_id,user_id,user_name,role,date,time,lat,lng,note,created_at,company_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
    .bind(id, body.projectId, user.id, user.name, user.role, date, now.toISOString().slice(11, 16), lat, lng, shortText(body.note, 200, 'Note'), now.toISOString(), user.companyId).run();
  const row = await env.DB.prepare('SELECT * FROM presences WHERE user_id=? AND project_id=? AND date=?').bind(user.id, body.projectId, date).first();
  return reply({ presence: publicPresence(row) }, 201);
}
async function listPresence(request, env, url) {
  const user = await requireUser(request, env);
  const date = validDate(url.searchParams.get('date') || undefined);
  const { results } = await env.DB.prepare('SELECT * FROM presences WHERE date=? AND company_id=? ORDER BY time').bind(date, user.companyId).all();
  const { ids } = await visibleProjects(env, user);
  // Direction et gestionnaire voient tout le monde ; le chef, ses chantiers ; l'ouvrier, lui-même.
  const visible = results.filter((r) => (seesMoney(user) ? true : user.role === 'chef' ? ids.has(r.project_id) : r.user_id === user.id));
  return reply({ date, presences: visible.map(publicPresence) });
}

// ---- Espace client : lien de suivi d'un chantier, en lecture seule, sans compte ----
// Le lien contient un jeton aléatoire enregistré sur le chantier par la direction.
// Le client ne voit que son chantier : avancement, montants de son contrat, notes d'avancement et photos.
// Seules ces notes du journal sont montrées au client ; « Note » et « Incident » restent internes.
const CLIENT_NOTES = ['Avancement', 'Réception'];
export function clientView(data, token) {
  if (typeof token !== 'string' || !/^[\w-]{20,64}$/.test(token)) return null;
  const project = data?.projects?.find((p) => p.shareToken === token && p.status !== 'Supprimé');
  if (!project) return null;
  const live = (rows) => (rows || []).filter((x) => !x.void);
  // Mêmes calculs que l'application, pour que le client voie exactement les mêmes montants.
  const invoices = live(data.invoices).filter((i) => i.projectId === project.id);
  const billed = invoices.reduce((n, i) => n + docTotal(i), 0);
  const retained = invoices.reduce((n, i) => n + retainedOf(i), 0);
  const paid = live(data.payments).filter((x) => invoices.some((i) => i.id === x.invoiceId)).reduce((n, x) => n + Number(x.amount || 0), 0);
  const client = data.clients.find((c) => c.id === project.clientId);
  const journal = (data.journal || []).filter((j) => j.projectId === project.id && CLIENT_NOTES.includes(j.kind)).slice(-20).reverse().map((j) => ({ date: j.date || '', kind: j.kind || 'Note', note: String(j.note || '').slice(0, 1000) }));
  const photos = (data.attachments || []).filter((a) => a.entityType === 'projects' && a.entityId === project.id && /^data:image\/(jpeg|png|webp);base64,/.test(a.url)).slice(-8).reverse().map((a) => ({ url: a.url, date: a.date || '', name: a.name || '' }));
  const s = data.settings || {};
  return {
    company: { name: s.company || '', phone: s.phone || '', email: s.email || '', logo: /^data:image\/(png|jpeg|webp);base64,/.test(s.logo || '') ? s.logo : '' },
    client: client?.name || '',
    project: { name: project.name, status: project.status || '', address: project.address || '', startDate: project.startDate || '', expectedEndDate: project.expectedEndDate || '', progress: Number(project.progress || 0) },
    money: { contract: Number(project.contractAmount || 0), billed, paid, retained, due: Math.max(0, billed - retained - paid) },
    payments: live(data.payments).filter((x) => invoices.some((i) => i.id === x.invoiceId)).slice(-10).reverse().map((x) => ({ date: x.date || '', amount: Number(x.amount || 0), method: x.method || '', number: x.number || '' })),
    journal, photos,
  };
}
async function findShared(env, token) {
  if (typeof token !== 'string' || !/^[\w-]{20,64}$/.test(token)) return null;
  const needle = '%"shareToken":"' + token.replace(/[\\%_]/g, (c) => '\\' + c) + '"%';
  const main = await env.DB.prepare("SELECT payload FROM workspace WHERE id=1 AND payload LIKE ? ESCAPE '\\'").bind(needle).first();
  if (main) return JSON.parse(main.payload);
  const other = await env.DB.prepare("SELECT w.payload FROM workspaces w JOIN companies c ON c.id=w.company_id WHERE c.active=1 AND w.payload LIKE ? ESCAPE '\\' LIMIT 1").bind(needle).first();
  return other ? JSON.parse(other.payload) : null;
}
async function clientFollow(env, token) {
  const data = await findShared(env, token);
  const view = data && clientView(data, token);
  if (!view) fail(404, 'Ce lien de suivi n’existe pas ou a été arrêté.');
  return reply(view);
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
    if (method === 'POST' && path === '/api/companies') return await createCompany(request, env, url);
    if (method === 'POST' && path === '/api/auth/invite/info') return await inviteInfo(request, env);
    if (method === 'POST' && path === '/api/auth/invite/redeem') return await redeemInvite(request, env, url);
    if (method === 'POST' && path === '/api/auth/pin') return await pinLogin(request, env, url);
    if (method === 'GET' && path === '/api/auth/google/start') return googleStart(env, url);
    if (method === 'GET' && path === '/api/auth/google/callback') return await googleCallback(request, env, url);
    if (method === 'POST' && path === '/api/auth/logout') return await logout(request, env, url);
    if (method === 'GET' && path === '/api/config') return reply({ google: !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET), signup: env.SIGNUP === '1' });
    if (method === 'POST' && path === '/api/presence') return await createPresence(request, env);
    if (method === 'GET' && path === '/api/presence') return await listPresence(request, env, url);
    const follow = path.match(/^\/api\/suivi\/([\w-]{1,64})$/);
    if (follow && method === 'GET') return await clientFollow(env, follow[1]);
    if (method === 'GET' && path === '/api/me') return reply({ user: await requireUser(request, env) });
    if (method === 'GET' && path === '/api/workspace') return await workspace(request, env);
    if (method === 'PUT' && path === '/api/workspace') return await importWorkspace(request, env);
    if (method === 'POST' && path === '/api/actions') return await action(request, env);
    if (method === 'GET' && path === '/api/users') return await listUsers(request, env);
    if (method === 'POST' && path === '/api/users') return await createUser(request, env);
    if (method === 'POST' && path === '/api/entries') return await createEntry(request, env);
    if (method === 'GET' && path === '/api/entries') return await listEntries(request, env);
    if (method === 'GET' && path === '/api/entries/to-apply') return await entriesToApply(request, env);
    const entry = path.match(/^\/api\/entries\/([\w-]{1,64})\/(photo|audio|decision|applied)$/);
    if (entry && method === 'GET' && entry[2] === 'photo') return await entryPhoto(request, env, entry[1]);
    if (entry && method === 'GET' && entry[2] === 'audio') return await entryAudio(request, env, entry[1]);
    if (entry && method === 'POST' && entry[2] === 'decision') return await decideEntry(request, env, entry[1]);
    if (entry && method === 'POST' && entry[2] === 'applied') return await markApplied(request, env, entry[1]);
    if (method === 'POST' && path === '/api/requests') return await createRequest(request, env);
    if (method === 'GET' && path === '/api/requests') return await listRequests(request, env);
    if (method === 'GET' && path === '/api/requests/to-apply') return await requestsToApply(request, env);
    const req = path.match(/^\/api\/requests\/([\w-]{1,64})\/(step|applied)$/);
    if (req && method === 'POST' && req[2] === 'step') return await stepRequest(request, env, req[1]);
    if (req && method === 'POST' && req[2] === 'applied') return await markRequestApplied(request, env, req[1]);
    const thread = path.match(/^\/api\/threads\/([\w-]{1,64})$/);
    if (thread && method === 'GET') return await listMessages(request, env, thread[1]);
    if (thread && method === 'POST') return await postMessage(request, env, thread[1]);
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
