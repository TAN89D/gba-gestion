import { apply, find } from './domain.js';

// Transforme une saisie validée par la direction en écriture normale de l'application.
export function entryToAction(entry) {
  const { data } = entry;
  if (entry.kind === 'expense') {
    return { type: 'save', table: 'expenses', data: { id: entry.id, scope: 'Chantier', projectId: entry.projectId, accountId: entry.accountId, description: data.description, amount: data.amount, category: data.category, method: data.method, date: data.date, notes: 'Saisi par ' + entry.userName, enteredBy: entry.userName } };
  }
  if (entry.kind === 'teamPayment') {
    return { type: 'teamPayment', data: { id: entry.id, taskId: data.taskId, accountId: entry.accountId, amount: data.amount, method: data.method, date: data.date, enteredBy: entry.userName } };
  }
  return null;
}
const TARGET = { expense: 'expenses', teamPayment: 'teamPayments' };

// Le téléphone de la direction reste la référence : c'est lui qui enregistre les saisies validées.
// Une saisie n'est marquée « enregistrée » qu'une fois envoyée vers la base commune : jusque-là elle
// continue de réserver le budget. Une panne locale (stockage plein, onglet périmé) se réessaie plus tard ;
// seul un refus des règles de gestion est signalé à la direction.
export async function pullApproved({ getState, commit, flush = async () => true, fetcher = fetch }) {
  const res = await fetcher('/api/entries/to-apply', { credentials: 'same-origin' });
  if (!res.ok) return { applied: 0, failed: 0, skipped: true };
  const { entries } = await res.json();
  const mark = (id, body) => fetcher(`/api/entries/${id}/applied`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const ready = [];
  let failed = 0;
  let retry = false;
  for (const entry of entries) {
    const state = getState();
    if (find(state, TARGET[entry.kind], entry.id)) { ready.push(entry.id); continue; }
    let next;
    try {
      if (entry.kind === 'teamPayment') {
        const task = find(state, 'tasks', entry.data.taskId);
        if (!task || task.projectId !== entry.projectId || !entry.data.employeeId || task.employeeId !== entry.data.employeeId) throw Error('La tâche a changé de chantier ou d’ouvrier depuis la saisie.');
      }
      next = apply(state, entryToAction(entry));
    } catch (e) {
      await mark(entry.id, { error: e.message || 'Enregistrement impossible.' });
      failed++;
      continue;
    }
    try {
      commit(next);
      ready.push(entry.id);
    } catch {
      retry = true;
      break;
    }
  }
  if (!ready.length) return { applied: 0, failed, retry };
  if (!await flush()) return { applied: 0, failed, retry: true };
  for (const id of ready) await mark(id, {});
  return { applied: ready.length, failed, retry };
}
// Montant engagé sur un chantier mais pas encore présent dans les données reçues de la direction.
export const reservedOn = (entries, projectId, data) => (entries || [])
  .filter((e) => e.projectId === projectId && ['expense', 'teamPayment'].includes(e.kind) && (e.status === 'pending' || (e.status === 'approved' && !e.appliedAt)))
  .filter((e) => !(data?.[TARGET[e.kind]] || []).some((x) => x.id === e.id))
  .reduce((n, e) => n + Number(e.data.amount || 0), 0);

export const ENTRY_LABELS = { expense: 'Dépense', teamPayment: 'Paiement d’ouvrier', incident: 'Incident', photo: 'Photo' };
export const STATUS_LABELS = { pending: 'À valider', approved: 'Validé', rejected: 'Refusé', open: 'À traiter', resolved: 'Résolu', info: 'Ajoutée' };
