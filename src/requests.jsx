import React, { useEffect, useState } from 'react';
import { ArrowLeft, ChatCircle, Package, Plus, Trash, Wallet, Printer } from '@phosphor-icons/react';
import { api } from './team.jsx';
import { fmtDate, money, uid } from './domain.js';
import { itemsText } from './entries.js';

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const nameOf = (rows, id) => rows?.find((x) => x.id === id)?.name || '';

// ---- Fil de messages (incident ou demande de matériel) ----
export function Thread({ id, count = 0 }) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState(null);
  const [text, setText] = useState('');
  const [msgId, setMsgId] = useState(uid());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const load = () => api(`/api/threads/${id}`).then((r) => { setRows(r.messages); setError(''); }).catch((e) => setError(e.message));
  useEffect(() => { if (open) load(); }, [open]);
  const send = async (e) => {
    e.preventDefault();
    if (!text.trim()) return;
    setBusy(true); setError('');
    try {
      // Même identifiant si l'on renvoie après une coupure : pas de message en double.
      await api(`/api/threads/${id}`, { method: 'POST', body: { id: msgId, text } });
      setText(''); setMsgId(uid());
      await load();
    } catch (x) { setError(x.status === 0 ? 'Pas de réseau : touchez « Envoyer » à nouveau quand la connexion revient.' : x.message); } finally { setBusy(false); }
  };
  const shown = rows ? rows.length : count;
  if (!open) return <button type="button" className="member-thread-toggle" onClick={() => setOpen(true)}><ChatCircle size={20} /> {shown ? `Messages (${shown})` : 'Répondre / discuter'}</button>;
  return <div className="member-thread">
    {rows === null && !error && <small>Chargement…</small>}
    {rows?.length === 0 && <small>Aucun message pour le moment.</small>}
    {rows?.map((m) => <div key={m.id} className={'member-msg' + (m.mine ? ' mine' : '')}><small>{m.userName} · {fmtDate(m.at)} {String(m.at).slice(11, 16)}</small><p>{m.text}</p></div>)}
    <form onSubmit={send}><textarea rows="2" maxLength="1000" placeholder="Votre message…" value={text} onChange={(e) => setText(e.target.value)} /><button className="primary" type="submit" disabled={busy || !text.trim()}>{busy ? 'Envoi…' : 'Envoyer'}</button></form>
    {error && <p className="error" role="alert">{error}</p>}
    <button type="button" className="member-thread-toggle" onClick={() => setOpen(false)}>Fermer la discussion</button>
  </div>;
}

// ---- Demandes de matériel ----
export const REQUEST_STEPS = { besoin: 'Besoin signalé · à transmettre', demande: 'Envoyée à la direction', commande: 'Bon de commande', livre: 'Livré sur le chantier · à confirmer', recu: 'Matériel reçu', refuse: 'Refusée' };
export const requestStatus = (r) => (r.status === 'commande' ? (r.orderReady ? 'Bon de commande ' + r.orderNumber : 'Bon de commande en préparation') : REQUEST_STEPS[r.status]);

export function RequestForm({ data, projectId: initial, onDone, onCancel }) {
  const [projectId, setProjectId] = useState(initial || (data.projects.length === 1 ? data.projects[0].id : ''));
  const [items, setItems] = useState([{ description: '', quantity: 1, unit: '' }]);
  const [note, setNote] = useState('');
  const [id] = useState(uid());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const setItem = (i, k, v) => setItems(items.map((x, j) => (j === i ? { ...x, [k]: v } : x)));
  const submit = async (e) => {
    e.preventDefault();
    if (!projectId) { setError('Choisissez un chantier.'); return; }
    setBusy(true); setError('');
    try {
      await api('/api/requests', { method: 'POST', body: { id, projectId, note, items: items.map((x) => ({ ...x, quantity: Number(x.quantity) })) } });
    } catch (x) {
      setError(x.status === 0 ? 'Pas de réseau : l’envoi n’a pas pu être confirmé. Touchez « Envoyer » à nouveau : il ne sera pas compté deux fois.' : x.message);
      setBusy(false);
      return;
    }
    setBusy(false);
    await onDone('request');
  };
  return <form className="member-form" onSubmit={submit}>
    <button type="button" className="member-back" onClick={onCancel}><ArrowLeft size={20} /> Retour</button>
    <h2>Besoin de matériel</h2>
    <label>Chantier<select required value={projectId} onChange={(e) => setProjectId(e.target.value)}><option value="">Choisir…</option>{data.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
    {items.map((x, i) => <div className="member-item" key={i}>
      <label>Matériel<input required maxLength="200" placeholder="Ex. ciment, fer de 12…" value={x.description} onChange={(e) => setItem(i, 'description', e.target.value)} /></label>
      <div className="member-item-row">
        <label>Quantité<input required type="number" inputMode="decimal" min="0.01" step="any" value={x.quantity} onChange={(e) => setItem(i, 'quantity', e.target.value)} /></label>
        <label>Unité<input maxLength="20" placeholder="sac, barre…" value={x.unit} onChange={(e) => setItem(i, 'unit', e.target.value)} /></label>
        {items.length > 1 && <button type="button" className="icon" aria-label="Retirer cet article" onClick={() => setItems(items.filter((_, j) => j !== i))}><Trash size={22} /></button>}
      </div>
    </div>)}
    {items.length < 30 && <button type="button" className="member-back" onClick={() => setItems([...items, { description: '', quantity: 1, unit: '' }])}><Plus size={20} /> Ajouter un article</button>}
    <label>Précisions (facultatif)<textarea rows="2" maxLength="1000" value={note} onChange={(e) => setNote(e.target.value)} /></label>
    {error && <p className="error" role="alert">{error}</p>}
    <button className="primary wide" type="submit" disabled={busy}>{busy ? 'Envoi…' : 'Envoyer'}</button>
  </form>;
}

export function printOrder(r, data) {
  const win = window.open('', '_blank');
  if (!win) return false;
  const rows = r.items.map((x) => `<tr><td>${esc(x.description)}</td><td>${esc(x.quantity)} ${esc(x.unit)}</td></tr>`).join('');
  win.document.write(`<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>${esc(r.orderNumber || 'Bon de commande')}</title><style>body{font-family:Arial,sans-serif;margin:32px;color:#142e53}table{width:100%;border-collapse:collapse;margin:16px 0}td,th{border:1px solid #ccd;padding:8px;text-align:left}button{padding:10px 16px;font-size:16px}@media print{button{display:none}}</style></head><body>
<h1>${esc(data.settings?.company || '')}</h1><h2>Bon de commande ${esc(r.orderNumber)}</h2>
<p>Chantier : <b>${esc(nameOf(data.projects, r.projectId))}</b><br>Fournisseur : <b>${esc(r.order?.supplierName)}</b>${r.order?.expectedDate ? '<br>Livraison prévue : ' + esc(fmtDate(r.order.expectedDate)) : ''}${r.order?.amount ? '<br>Montant prévu : ' + esc(money(r.order.amount)) : ''}<br>Demandé par : ${esc(r.userName)} le ${esc(fmtDate(r.createdAt))}</p>
<table><tr><th>Matériel</th><th>Quantité</th></tr>${rows}</table>${r.note ? '<p>' + esc(r.note) + '</p>' : ''}<button id="print">Imprimer</button></body></html>`);
  win.document.close();
  win.document.getElementById('print')?.addEventListener('click', () => win.print());
  return true;
}

export function RequestCard({ r, user, data, onChanged }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const lead = ['chef', 'gestionnaire', 'direction'].includes(user.role);
  const step = async (name, extra = {}) => {
    setBusy(true); setError('');
    try { await api(`/api/requests/${r.id}/step`, { method: 'POST', body: { step: name, ...extra } }); await onChanged(); } catch (x) { setError(x.message); } finally { setBusy(false); }
  };
  const refuse = () => { const reason = prompt('Motif du refus'); if (reason) step('refuse', { reason }); };
  return <div className="member-card member-budget">
    <div>
      <b>{itemsText(r.items)}</b>
      <small>{[nameOf(data.projects, r.projectId), 'demandé par ' + r.userName, fmtDate(r.createdAt)].filter(Boolean).join(' · ')}</small>
      {r.note && <small>{r.note}</small>}
      {r.order && <small>Fournisseur : {r.order.supplierName}{r.order.expectedDate ? ' · livraison prévue le ' + fmtDate(r.order.expectedDate) : ''}{r.order.amount ? ' · ' + money(r.order.amount) : ''}</small>}
      <div><span className={'member-tag' + (r.status === 'refuse' ? ' member-tag-bad' : '')}>{requestStatus(r)}</span></div>
      {r.reason && <small>Motif : {r.reason}</small>}
      <div className="chips">
        {lead && r.status === 'besoin' && <><button className="primary" disabled={busy} onClick={() => step('forward')}>Transmettre à la direction</button><button disabled={busy} onClick={refuse}>Refuser</button></>}
        {lead && r.status === 'commande' && r.orderReady && <button className="primary" disabled={busy} onClick={() => step('deliver')}>Matériel arrivé sur le chantier</button>}
        {(r.mine || lead) && r.status === 'livre' && <button className="primary" disabled={busy} onClick={() => step('receive')}>J’ai reçu le matériel</button>}
        {lead && r.orderReady && <button disabled={busy} onClick={() => { if (!printOrder(r, data)) setError('Autorisez les fenêtres pour afficher le bon.'); }}><Printer size={18} /> Bon de commande</button>}
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      <Thread id={r.id} count={r.messages} />
    </div>
  </div>;
}

export function RequestList({ requests, user, data, onChanged, title = 'Demandes de matériel', projectId }) {
  const rows = (requests || []).filter((r) => !projectId || r.projectId === projectId);
  if (!rows.length) return null;
  const order = { besoin: 0, livre: 1, commande: 2, demande: 3, recu: 4, refuse: 5 };
  return <section><h2><Package size={22} /> {title}</h2>{[...rows].sort((a, b) => order[a.status] - order[b.status]).slice(0, 40).map((r) => <RequestCard key={r.id} r={r} user={user} data={data} onChanged={onChanged} />)}</section>;
}

// ---- Caisse confiée au chef de chantier ou au gestionnaire ----
export function CashTab({ data, doAction }) {
  const boxes = data.cashboxes || [];
  if (!boxes.length) return <p className="info">Aucune caisse ne vous est confiée pour le moment. La direction peut en créer une à votre nom.</p>;
  const pending = (id) => (data.entries || []).filter((e) => e.kind === 'expense' && e.status === 'pending' && e.accountId === id);
  const line = (label, value, sub) => <div className="member-cash-line" key={label}><span><b>{label}</b>{sub && <small>{sub}</small>}</span><b>{money(value)}</b></div>;
  return <>{boxes.map((c) => {
    const wait = pending(c.id);
    const waiting = wait.reduce((n, e) => n + Number(e.data.amount || 0), 0);
    return <section key={c.id}>
      <h2><Wallet size={22} /> {c.name}</h2>
      <div className="member-card member-budget"><div>
        <small>{c.projectName ? 'Chantier : ' + c.projectName : 'Caisse'}</small>
        <b className={c.balance < 0 ? 'member-over' : ''}>{c.balance < 0 ? 'Vous avez avancé ' + money(-c.balance) : 'Reste en caisse : ' + money(c.balance)}</b>
        <small>Reçu {money(c.opening + c.received)} · dépensé {money(c.spent)}{c.back ? ' · rendu ' + money(c.back) : ''}</small>
        {waiting > 0 && <small>{money(waiting)} en attente de validation par la direction</small>}
      </div></div>
      <button type="button" className="primary wide" onClick={() => doAction('expense', c.projectId || undefined)}><Plus size={20} /> Ajouter une dépense</button>
      <h3>Où est parti l’argent</h3>
      {line(c.projectName ? 'Pour le chantier' : 'Pour les chantiers', c.site, c.siteByCategory.map((g) => g.name + ' ' + money(g.amount)).join(' · '))}
      {c.otherSites.map((g) => line('Autre chantier : ' + g.name, g.amount))}
      {line('Pour l’entreprise', c.companyTotal, c.company.map((g) => g.name + ' ' + money(g.amount)).join(' · '))}
      {line('Dépenses personnelles', c.personal)}
      <h3>Dernières dépenses</h3>
      {wait.map((e) => <div className="member-cash-line" key={e.id}><span><b>{e.data.description}</b><small>{fmtDate(e.data.date)} · en attente de validation</small></span><b>{money(e.data.amount)}</b></div>)}
      {c.recent.length ? c.recent.map((r) => <div className="member-cash-line" key={r.id}><span><b>{r.label}</b><small>{[fmtDate(r.date), r.scope === 'Chantier' ? r.site : r.scope, r.category].filter(Boolean).join(' · ')}</small></span><b>{money(r.amount)}</b></div>) : !wait.length && <p className="subtle">Aucune dépense pour le moment.</p>}
    </section>;
  })}</>;
}
