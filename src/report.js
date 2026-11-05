import { fmtDate, money } from './domain.js';
import { STATUS_LABELS, ENTRY_LABELS, reservedOn } from './entries.js';

const esc = (x) => String(x ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const SAFE_IMAGE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;
const table = (headers, rows) => `<table><thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;

// Le rapport ne contient que ce que le compte a déjà le droit de recevoir.
export function reportHtml({ company, project, data, entries = [], photos = [], finance = null, now = new Date().toISOString(), origin = '' }) {
  const onSite = (x) => x.projectId === project.id;
  const name = (rows, id) => rows?.find((x) => x.id === id)?.name || '';
  const tasks = data.tasks.filter(onSite);
  const expenses = (data.expenses || []).filter((x) => onSite(x) && !x.void);
  const payments = (data.teamPayments || []).filter((x) => onSite(x) && !x.void);
  const journal = (data.journal || []).filter(onSite);
  const site = entries.filter(onSite);
  const incidents = site.filter((e) => e.kind === 'incident');
  const waiting = site.filter((e) => ['expense', 'teamPayment'].includes(e.kind) && e.status === 'pending');
  const showMoney = !!finance || data.role === 'gestionnaire';
  const spent = expenses.reduce((n, x) => n + Number(x.amount || 0), 0);
  const paid = payments.reduce((n, x) => n + Number(x.amount || 0), 0);
  const budget = Number(project.managerBudget || 0);
  const summary = [
    ['Statut', project.status || '—'],
    ['Adresse', project.address || '—'],
    ['Tâches', `${tasks.filter((t) => t.status === 'Terminé').length} terminée(s) sur ${tasks.length}`],
    ['Incidents', `${incidents.filter((i) => i.status === 'open').length} à traiter sur ${incidents.length}`],
    ['Photos', String(photos.length)],
  ];
  if (showMoney) {
    summary.push(['Dépenses', money(spent)], ['Paiements de l’équipe', money(paid)]);
    const held = reservedOn(entries, project.id, data);
    if (held > 0) summary.push(['En attente de validation', money(held)]);
    if (budget > 0) summary.push(['Budget confié', money(budget)], ['Reste du budget', money(budget - spent - paid - held)]);
  }
  if (finance) summary.push(['Contrat', money(finance.contract)], ['Encaissé', money(finance.received)], ['Reste facturé', money(finance.toCollect)], ['Marge estimée', money(finance.margin)]);
  const section = (title, body) => (body ? `<h2>${esc(title)}</h2>${body}` : '');
  const taskRows = tasks.map((t) => {
    const done = payments.filter((p) => p.taskId === t.id).reduce((n, p) => n + Number(p.amount || 0), 0);
    const base = [t.description, name(data.employees, t.employeeId), t.status || '—'];
    return 'agreedAmount' in t ? [...base, money(done), money(Math.max(0, Number(t.agreedAmount || 0) - done))] : base;
  });
  const taskHead = tasks.some((t) => 'agreedAmount' in t) ? ['Tâche', 'Ouvrier', 'Statut', 'Payé', 'Reste'] : ['Tâche', 'Ouvrier', 'Statut'];
  const logo = origin ? `<img class="logo" src="${esc(origin)}/logo.jpg" alt="">` : '';
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Rapport ${esc(project.name)}</title><style>body{font:14px Arial,sans-serif;color:#142e53;margin:32px}header{border-bottom:4px solid #0066cc;padding-bottom:12px;margin-bottom:16px}.logo{max-width:90px;max-height:60px}h1{color:#0066cc;margin:6px 0}h2{margin:22px 0 8px;font-size:17px;border-bottom:1px solid #dde4ee;padding-bottom:4px}table{width:100%;border-collapse:collapse}td,th{padding:7px 6px;border-bottom:1px solid #eef2f7;text-align:left;vertical-align:top}th{font-size:12px;color:#5b6b82}.grid{display:grid;grid-template-columns:repeat(2,1fr);gap:10px}.grid figure{margin:0;break-inside:avoid}.grid img{width:100%;border-radius:6px}figcaption{font-size:12px;color:#5b6b82;margin-top:3px}.pending{color:#b85c00}button{padding:12px;margin-bottom:12px}@media print{button{display:none}body{margin:12mm}}</style></head><body><button id="print">Imprimer / Enregistrer en PDF</button><header>${logo}<div>${esc(company || 'GBA Gestion')}</div><h1>Rapport de chantier : ${esc(project.name)}</h1><small>Établi le ${esc(fmtDate(now))}</small></header>${section('Synthèse', table(['Élément', 'Valeur'], summary))}${section('Tâches', taskRows.length ? table(taskHead, taskRows) : '')}${section('Dépenses', expenses.length ? table(['Date', 'Désignation', 'Montant'], expenses.map((x) => [fmtDate(x.date), x.description, money(x.amount)])) : '')}${section('En attente de validation', waiting.length ? table(['Type', 'Détail', 'Par', 'Montant'], waiting.map((e) => [ENTRY_LABELS[e.kind], e.data.description || '', e.userName, money(e.data.amount)])) : '')}${section('Incidents', incidents.length ? table(['Date', 'Type', 'Description', 'Signalé par', 'État'], incidents.map((e) => [fmtDate(e.data.date), e.data.type, e.data.note, e.userName, STATUS_LABELS[e.status]])) : '')}${section('Journal', journal.length ? table(['Date', 'Type', 'Note'], journal.map((j) => [fmtDate(j.date), j.kind || '', j.note])) : '')}${section('Photos du chantier', photos.length ? `<div class="grid">${photos.filter((p) => SAFE_IMAGE.test(p.src)).map((p) => `<figure><img src="${p.src}" alt=""><figcaption>${esc(fmtDate(p.date))}${p.note ? ' · ' + esc(p.note) : ''}${p.by ? ' · ' + esc(p.by) : ''}</figcaption></figure>`).join('')}</div>` : '')}</body></html>`;
}
