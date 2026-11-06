import React, { useEffect, useState } from 'react';
import { Camera, ArrowLeft, FileText } from '@phosphor-icons/react';
import { api } from './team.jsx';
import { fmtDate, money, today, uid, EXPENSE_CATEGORIES, PAY_METHODS } from './domain.js';
import { ENTRY_LABELS, STATUS_LABELS } from './entries.js';
import { reportHtml } from './report.js';
import { Thread } from './requests.jsx';

const SCOPES = [['Chantier', 'Pour le chantier'], ['Entreprise', 'Pour l’entreprise'], ['Personnel', 'Dépense personnelle']];

async function compressPhoto(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise((ok, ko) => { img.onload = ok; img.onerror = () => ko(Error('Image illisible.')); img.src = url; });
    const r = Math.min(1, 1280 / Math.max(img.width, img.height));
    const c = document.createElement('canvas');
    c.width = Math.round(img.width * r); c.height = Math.round(img.height * r);
    const g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.65);
  } finally { URL.revokeObjectURL(url); }
}
export const FORM_TITLES = { expense: 'Ajouter une dépense', scan: 'Scanner une facture', teamPayment: 'Payer un ouvrier', incident: 'Signaler un incident', need: 'Besoin de matériel', photo: 'Photo du chantier', done: 'Travail fait' };

export function EntryForm({ action, data, onDone, onCancel }) {
  const { type, projectId: initial } = action;
  const kind = { scan: 'expense', need: 'incident', done: 'photo' }[type] || type;
  const [projectId, setProjectId] = useState(initial || (data.projects.length === 1 ? data.projects[0].id : ''));
  const boxes = data.cashboxes || [];
  const boxFor = (site) => (boxes.find((b) => b.projectId === site) || boxes[0])?.id || '';
  const [form, setForm] = useState({ id: uid(), date: today(), description: '', amount: '', scope: 'Chantier', accountId: boxFor(initial), category: 'Matériaux', method: 'Espèces', taskId: '', note: type === 'done' ? 'Travail fait' : '' });
  const [photo, setPhoto] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const siteTasks = data.tasks.filter((t) => t.projectId === projectId);
  const needsPhoto = kind === 'photo' || type === 'scan';
  const left = (t) => Number(t.agreedAmount || 0) - (data.teamPayments || []).filter((p) => p.taskId === t.id).reduce((n, p) => n + Number(p.amount || 0), 0);
  const pick = async (e) => {
    const input = e.target; const file = input.files[0];
    if (!file) return;
    setError('');
    try {
      if (!file.type.startsWith('image/')) throw Error('Choisissez une photo.');
      if (file.size > 25000000) throw Error('Image trop volumineuse.');
      setPhoto(await compressPhoto(file));
    } catch (x) { setError(x.message); } finally { input.value = ''; }
  };
  const submit = async (e) => {
    e.preventDefault();
    if (needsPhoto && !photo) { setError('Ajoutez une photo.'); return; }
    if (!projectId) { setError('Choisissez un chantier.'); return; }
    setBusy(true); setError('');
    try {
      // Le même identifiant est réutilisé si l'on renvoie : jamais de doublon.
      await api('/api/entries', { method: 'POST', body: { kind, projectId, id: form.id, date: form.date, description: form.description, amount: form.amount === '' ? undefined : Number(form.amount), scope: form.scope, accountId: form.accountId || undefined, category: form.category, method: form.method, reference: form.reference || undefined, taskId: form.taskId, note: form.note, type: type === 'need' ? 'Besoin de matériel' : 'Problème', photo: photo || undefined } });
    } catch (x) {
      setError(x.status === 0 ? 'Pas de réseau : l’envoi n’a pas pu être confirmé. Touchez « Envoyer » à nouveau quand la connexion revient : il ne sera pas compté deux fois.' : x.message);
      setBusy(false);
      return;
    }
    setBusy(false);
    await onDone(kind);
  };
  return <form className="member-form" onSubmit={submit}>
    <button type="button" className="member-back" onClick={onCancel}><ArrowLeft size={20} /> Retour</button>
    <h2>{FORM_TITLES[type]}</h2>
    <label>Chantier<select required value={projectId} onChange={(e) => { setProjectId(e.target.value); set('taskId', ''); if (boxes.length) set('accountId', boxFor(e.target.value)); }}><option value="">Choisir…</option>{data.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
    {kind === 'expense' && <><label>Désignation<input required maxLength="300" value={form.description} onChange={(e) => set('description', e.target.value)} /></label><label>Montant (F)<input required inputMode="numeric" type="number" min="1" step="1" value={form.amount} onChange={(e) => set('amount', e.target.value)} /></label><label>Cette dépense est<select value={form.scope} onChange={(e) => set('scope', e.target.value)}>{SCOPES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label><label>Catégorie<select value={form.category} onChange={(e) => set('category', e.target.value)}>{EXPENSE_CATEGORIES.map((x) => <option key={x}>{x}</option>)}</select></label></>}
    {['expense', 'teamPayment'].includes(kind) && boxes.length > 1 && <label>Caisse utilisée<select value={form.accountId} onChange={(e) => set('accountId', e.target.value)}>{boxes.map((b) => <option key={b.id} value={b.id}>{b.name} · reste {money(b.balance)}</option>)}</select></label>}
    {['expense', 'teamPayment'].includes(kind) && boxes.length === 1 && <p className="subtle">L’argent sort de votre caisse « {boxes[0].name} » (reste {money(boxes[0].balance)}).</p>}
    {kind === 'teamPayment' && <><label>Tâche et ouvrier<select required value={form.taskId} onChange={(e) => set('taskId', e.target.value)}><option value="">Choisir…</option>{siteTasks.map((t) => <option key={t.id} value={t.id} disabled={left(t) <= 0}>{t.description} · {data.employees?.find((x) => x.id === t.employeeId)?.name || ''} · reste {money(left(t))}</option>)}</select></label>{projectId && !siteTasks.length && <p className="info">Aucune tâche sur ce chantier. La direction doit d’abord la créer.</p>}<label>Montant versé (F)<input required inputMode="numeric" type="number" min="1" step="1" value={form.amount} onChange={(e) => set('amount', e.target.value)} /></label></>}
    {['expense', 'teamPayment'].includes(kind) && <><label>Mode de paiement<select value={form.method} onChange={(e) => set('method', e.target.value)}>{PAY_METHODS.map((x) => <option key={x}>{x}</option>)}</select></label>{form.method !== 'Espèces' && <label>Référence du paiement (facultatif)<input maxLength="60" value={form.reference || ''} onChange={(e) => set('reference', e.target.value)} /></label>}<label>Date<input required type="date" value={form.date} onChange={(e) => set('date', e.target.value)} /></label></>}
    {kind === 'incident' && <label>{type === 'need' ? 'De quoi avez-vous besoin ?' : 'Que se passe-t-il ?'}<textarea required rows="4" maxLength="2000" value={form.note} onChange={(e) => set('note', e.target.value)} /></label>}
    {kind === 'photo' && <label>Note (facultatif)<input maxLength="500" value={form.note} onChange={(e) => set('note', e.target.value)} /></label>}
    <label className="member-photo-pick"><Camera size={26} /> {photo ? 'Changer la photo' : type === 'scan' ? 'Prendre la facture en photo' : needsPhoto ? 'Prendre une photo' : 'Ajouter une photo (facultatif)'}<input className="file-input" type="file" accept="image/*" capture="environment" onChange={pick} /></label>
    {photo && <img className="member-preview" src={photo} alt="Aperçu" />}
    {['expense', 'teamPayment'].includes(kind) && <p className="subtle">Cette saisie sera envoyée à la direction pour validation.</p>}
    {error && <p className="error" role="alert">{error}</p>}
    <button className="primary wide" type="submit" disabled={busy}>{busy ? 'Envoi…' : 'Envoyer'}</button>
  </form>;
}
export function PhotoView({ id, alt }) {
  const [src, setSrc] = useState('');
  const [failed, setFailed] = useState(false);
  useEffect(() => { let live = true; api(`/api/entries/${id}/photo`).then((r) => { if (live) setSrc(r.photo); }).catch(() => { if (live) setFailed(true); }); return () => { live = false; }; }, [id]);
  if (failed) return <small>Photo indisponible.</small>;
  return src ? <img className="member-photo" src={src} alt={alt} /> : <div className="member-photo member-photo-wait" />;
}
export function PhotoGrid({ entries }) {
  const [count, setCount] = useState(6);
  const rows = entries.filter((e) => e.hasPhoto);
  if (!rows.length) return null;
  return <section><h2>Photos ({rows.length})</h2><div className="member-photos">{rows.slice(0, count).map((e) => <figure key={e.id}><PhotoView id={e.id} alt={ENTRY_LABELS[e.kind]} /><figcaption>{fmtDate(e.data.date)} · {e.userName}{e.data.note ? ' · ' + e.data.note : e.data.description ? ' · ' + e.data.description : ''}</figcaption></figure>)}</div>{rows.length > count && <button type="button" className="member-back" onClick={() => setCount(count + 6)}>Voir plus de photos</button>}</section>;
}
export function ReportButton({ company, project, data, entries, finance }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run = async () => {
    setError('');
    const win = window.open('', '_blank');
    if (!win) { setError('Autorisez les fenêtres pour afficher le rapport.'); return; }
    setBusy(true);
    try {
      const site = entries.filter((e) => e.projectId === project.id);
      const withPhoto = site.filter((e) => e.hasPhoto).slice(0, 24);
      const photos = await Promise.all(withPhoto.map(async (e) => ({ src: (await api(`/api/entries/${e.id}/photo`)).photo, date: e.data.date, note: e.data.note || e.data.description || '', by: e.userName })));
      win.document.write(reportHtml({ company, project, data, entries, photos, finance, origin: location.origin }));
      win.document.close();
      win.document.getElementById('print')?.addEventListener('click', () => win.print());
    } catch (x) { win.close(); setError(x.message); } finally { setBusy(false); }
  };
  return <><button type="button" className="secondary wide member-report" disabled={busy} onClick={run}><FileText size={22} /> {busy ? 'Préparation…' : 'Rapport du chantier'}</button>{error && <p className="error" role="alert">{error}</p>}</>;
}
export function MyEntries({ entries, title = 'Mes saisies et le suivi' }) {
  const rows = entries.filter((e) => e.kind !== 'photo');
  if (!rows.length) return null;
  return <section><h2>{title}</h2>{rows.slice(0, 30).map((e) => <div className="member-card member-budget" key={e.id}><div><b>{e.data.description || e.data.note || ENTRY_LABELS[e.kind]}</b><small>{ENTRY_LABELS[e.kind]} · {fmtDate(e.data.date)} · {e.userName}{e.data.amount ? ' · ' + money(e.data.amount) : ''}</small><div><span className={'member-tag' + (e.status === 'rejected' ? ' member-tag-bad' : '')}>{e.status === 'open' && e.messages > 0 ? 'En cours' : STATUS_LABELS[e.status]}</span></div>{e.reason && <small>{e.kind === 'incident' ? 'Réponse : ' : 'Motif : '}{e.reason}</small>}{e.kind === 'incident' && <Thread id={e.id} count={e.messages} />}</div></div>)}</section>;
}
