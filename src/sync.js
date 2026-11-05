import { TABLES } from './domain.js';

// Envoi à sens unique : téléphone de la direction -> base commune.
// Rien ici n'écrit jamais dans les données locales de l'application.
const KEY = 'gba-sync';
export const SYNC_LIMIT = 1750000;
const RETRY_MS = 60000;
const DEBOUNCE_MS = 1500;

export function readSync() {
  try { return JSON.parse(localStorage.getItem(KEY)) || { enabled: false }; } catch { return { enabled: false }; }
}
export function writeSync(next) { localStorage.setItem(KEY, JSON.stringify(next)); }
export function setSyncRevision(revision) {
  const cfg = readSync();
  if (cfg.enabled) writeSync({ ...cfg, revision });
}

const byteSize = (text) => new TextEncoder().encode(text).length;
export function buildPayload(state, revision) {
  let data = state;
  let body = JSON.stringify({ revision, data });
  let withoutAttachments = false;
  if (byteSize(body) > SYNC_LIMIT) {
    data = { ...state, attachments: [] };
    // Le serveur garde alors les pièces jointes qu'il possède déjà.
    body = JSON.stringify({ revision, data, attachmentsOmitted: true });
    withoutAttachments = true;
  }
  return { body, data, withoutAttachments, tooBig: byteSize(body) > SYNC_LIMIT };
}
// Compare les données, sans les pièces jointes si elles n'ont pas été envoyées.
const comparable = (data, withoutAttachments) => JSON.stringify(withoutAttachments ? { ...data, attachments: [] } : data);
// Un onglet resté ouvert ne doit jamais envoyer une version plus ancienne que celle de l'appareil.
export function localIsCurrent(raw, state) {
  if (raw === null || raw === undefined) return true;
  try { return JSON.parse(raw).updatedAt === state.updatedAt; } catch { return false; }
}
export function counts(state) {
  return Object.fromEntries(TABLES.filter((t) => t !== 'audit').map((t) => [t, (state?.[t] || []).length]));
}
// Une base sans client, chantier ni facture ne doit jamais remplacer une base en ligne.
export const looksEmpty = (state) => !state?.clients?.length && !state?.projects?.length && !state?.invoices?.length;

async function send(body) {
  return fetch('/api/workspace', { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body });
}
async function readRemote() {
  const res = await fetch('/api/workspace', { credentials: 'same-origin' });
  if (!res.ok) throw Object.assign(Error('Lecture du serveur impossible.'), { status: res.status });
  return res.json();
}
const failure = (message, status) => Object.assign(Error(message), { status });

// Transfert complet, avec relecture : la copie en ligne doit être identique à ce qui a été envoyé.
export async function transferAll(getState, { overwriteRevision } = {}) {
  const remote = await readRemote();
  const cfg = readSync();
  const state = getState();
  // La confirmation ne vaut que pour la version qui a été présentée à l'utilisateur.
  if (remote.data && overwriteRevision !== remote.revision && cfg.revision !== remote.revision) {
    return { needsConfirm: true, remoteRevision: remote.revision, remoteCounts: counts(remote.data), remoteUpdatedAt: remote.updatedAt };
  }
  if (looksEmpty(state) && remote.data && !looksEmpty(remote.data)) throw failure('Cet appareil est vide : le transfert remplacerait les données en ligne. Transfert annulé.');
  const payload = buildPayload(state, remote.revision || 0);
  if (payload.tooBig) throw failure('Les données sont trop volumineuses pour être transférées, même sans les pièces jointes.');
  const res = await send(payload.body);
  if (!res.ok) {
    let message = 'Le serveur a refusé le transfert.';
    try { message = (await res.json()).error || message; } catch { /* réponse illisible */ }
    throw failure(message, res.status);
  }
  const saved = await res.json();
  const check = await readRemote();
  if (check.revision !== saved.revision || comparable(check.data, payload.withoutAttachments) !== comparable(payload.data, payload.withoutAttachments)) {
    throw failure('La vérification a échoué : la copie en ligne est différente. L’envoi automatique n’a pas été activé.');
  }
  writeSync({ enabled: true, revision: saved.revision, at: saved.updatedAt, syncedAt: state.updatedAt, withoutAttachments: payload.withoutAttachments });
  return { done: true, sent: counts(payload.data), withoutAttachments: payload.withoutAttachments, attachmentsKept: state.attachments.length };
}

export function createSyncEngine({ getState, canRun = () => true, onStatus = () => {}, timers = { setTimeout: (...a) => setTimeout(...a), clearTimeout: (...a) => clearTimeout(...a) } }) {
  let timer = null;
  let running = false;
  let again = false;
  const later = (ms) => {
    if (timer) timers.clearTimeout(timer);
    timer = timers.setTimeout(() => { timer = null; run(); }, ms);
  };
  async function run() {
    const cfg = readSync();
    if (!cfg.enabled || !canRun()) return 'off';
    if (running) { again = true; return 'busy'; }
    const state = getState();
    if (cfg.syncedAt && cfg.syncedAt === state.updatedAt) { onStatus('ok', cfg); return 'ok'; }
    if (looksEmpty(state)) { onStatus('empty', cfg); return 'empty'; }
    const payload = buildPayload(state, cfg.revision);
    if (payload.tooBig) { onStatus('tooBig', cfg); return 'tooBig'; }
    running = true;
    onStatus('sending', cfg);
    let result;
    try {
      const res = await send(payload.body);
      if (res.ok) {
        const saved = await res.json();
        const next = { ...cfg, revision: saved.revision, at: saved.updatedAt, syncedAt: state.updatedAt, withoutAttachments: payload.withoutAttachments };
        writeSync(next);
        onStatus('ok', next);
        result = 'ok';
      } else if (res.status === 409) { onStatus('conflict', cfg); result = 'conflict'; }
      else if (res.status === 401 || res.status === 403) { onStatus('auth', cfg); result = 'auth'; }
      else if (res.status === 400 || res.status === 413) { onStatus('refused', cfg); result = 'refused'; }
      else { onStatus('offline', cfg); later(RETRY_MS); result = 'retry'; }
    } catch {
      onStatus('offline', cfg);
      later(RETRY_MS);
      result = 'retry';
    } finally {
      running = false;
    }
    if (again) { again = false; later(DEBOUNCE_MS); }
    return result;
  }
  return { schedule: () => later(DEBOUNCE_MS), runNow: run, canRun };
}
