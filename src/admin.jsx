import React, { useEffect, useState } from 'react';
import { api, inviteUrl, qrImage, MemberForm } from './team.jsx';
import { ROLES } from './permissions.js';
import { money, fmtDate, today } from './domain.js';
import { overview, projectRows, invoiceRows, expenseRows, workerRows, activityRows } from './adminData.js';
import { ENTRY_LABELS, STATUS_LABELS, itemsText } from './entries.js';
import { PhotoGrid, PhotoView, ReportButton, MyEntries } from './entries.jsx';
import { Thread, requestStatus, printOrder } from './requests.jsx';
import { spending, overspending, cashbox } from './cashbox.js';
import './admin.css';

const TABS = [
  ['home', 'Vue d’ensemble'],
  ['queue', 'À valider'],
  ['material', 'Matériel'],
  ['cash', 'Caisses'],
  ['projects', 'Chantiers'],
  ['folders', 'Dossiers'],
  ['invoices', 'Factures'],
  ['expenses', 'Dépenses'],
  ['workers', 'Paie de l’équipe'],
  ['access', 'Accès & rôles'],
  ['activity', 'Activité'],
];
const ADMIN_LOGOUT_KEY = 'gba-admin-logout-pending';
const readFlag = (key) => { try { return localStorage.getItem(key); } catch { return null; } };
const dateTime = (d) => (d ? fmtDate(d) + ' ' + String(d).slice(11, 16) + ' UTC' : '—');

function Login({ onDone, forbidden, error: initialError }) {
  const [key, setKey] = useState('');
  const [error, setError] = useState(initialError || '');
  const [busy, setBusy] = useState(false);
  const [google, setGoogle] = useState(false);
  useEffect(() => { api('/api/config').then((c) => setGoogle(!!c.google)).catch(() => {}); }, []);
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      if (readFlag(ADMIN_LOGOUT_KEY)) { await api('/api/auth/logout', { method: 'POST' }); localStorage.removeItem(ADMIN_LOGOUT_KEY); }
      await api('/api/setup', { method: 'POST', body: {}, headers: { Authorization: 'Bearer ' + key.trim() } });
      setKey('');
      onDone();
    } catch (x) { setError(x.message); } finally { setBusy(false); }
  };
  return (
    <main className="admin admin-login">
      <img src="/logo.jpg" alt="GBA" />
      <h1>Tableau de bord général</h1>
      <p>{forbidden ? 'Ce compte n’a pas accès au tableau de bord. Connectez-vous avec la direction.' : 'Réservé à la direction.'}</p>
      {google && <a href="/api/auth/google/start" onClick={async (e) => {
        if (!readFlag(ADMIN_LOGOUT_KEY)) return;
        // Terminer d'abord l'ancienne déconnexion, pour ne pas annuler la nouvelle connexion.
        e.preventDefault();
        try { await api('/api/auth/logout', { method: 'POST' }); localStorage.removeItem(ADMIN_LOGOUT_KEY); location.href = '/api/auth/google/start'; } catch { setError('Connexion Internet indisponible.'); }
      }}>Continuer avec Google</a>}
      <form onSubmit={submit}>
        <label>Clé privée<input type="password" autoComplete="off" autoCapitalize="none" spellCheck="false" value={key} onChange={(e) => setKey(e.target.value)} /></label>
        <button type="submit" disabled={busy || !key}>{busy ? 'Connexion…' : 'Se connecter'}</button>
        {error && <p className="admin-error" role="alert">{error}</p>}
      </form>
      <a className="admin-back" href="/">Retour à l’application</a>
    </main>
  );
}
function Kpi({ label, value, tone }) {
  return <div className={'admin-kpi' + (tone ? ' ' + tone : '')}><small>{label}</small><b>{value}</b></div>;
}
function Box({ title, empty, rows, render }) {
  return <section className="admin-box"><h3>{title}</h3>{rows.length ? rows.map(render) : <p className="admin-empty">{empty}</p>}</section>;
}
function DayBox({ data }) {
  const [day, setDay] = useState(today());
  const [by, setBy] = useState('bySite');
  const v = spending(data, day);
  const over = overspending(data);
  return <div className="admin-cols">
    <section className="admin-box"><h3>Dépenses du <input type="date" aria-label="Jour affiché" value={day} onChange={(e) => setDay(e.target.value || today())} /> : {money(v.total)}</h3>
      <div className="admin-actions">{[['bySite', 'Par chantier'], ['byCategory', 'Par catégorie'], ['byAccount', 'Par caisse']].map(([k, l]) => <button key={k} className={by === k ? 'primary' : ''} aria-pressed={by === k} onClick={() => setBy(k)}>{l}</button>)}</div>
      {v[by].length ? v[by].map((g) => <div className="admin-line" key={g.key}><span>{g.name}<br /><small>{g.count} sortie(s)</small></span><b>{money(g.amount)}</b></div>) : <p className="admin-empty">Aucune dépense ce jour-là.</p>}
    </section>
    <section className="admin-box"><h3>Dépenses de trop</h3>
      {!over.sites.length && !over.boxes.length && <p className="admin-empty">Aucun dépassement.</p>}
      {over.sites.map((x) => <div className="admin-line" key={x.project.id}><span>{x.project.name}<br /><small>Budget dépassé</small></span><b style={{ color: '#c62828' }}>+ {money(x.over)}</b></div>)}
      {over.boxes.map((x) => <div className="admin-line" key={x.account.id}><span>{x.account.name}<br /><small>Caisse négative : argent avancé</small></span><b style={{ color: '#c62828' }}>{money(x.balance)}</b></div>)}
    </section>
  </div>;
}
function Home({ data, users, go, entries, requests }) {
  const o = overview(data);
  const toDo = entries.filter((e) => ['pending', 'open'].includes(e.status)).length;
  const toOrder = requests.filter((r) => r.status === 'demande').length;
  return <>
    {toDo > 0 && <div className="admin-note"><b>{toDo} élément(s) de l’équipe à traiter.</b> <button className="admin-link" onClick={() => go('queue')}>Voir</button></div>}
    {toOrder > 0 && <div className="admin-note"><b>{toOrder} demande(s) de matériel attendent un bon de commande.</b> <button className="admin-link" onClick={() => go('material')}>Voir</button></div>}
    <DayBox data={data} />
    <div className="admin-kpis">
      <Kpi label="Disponible en caisse" value={money(o.cash)} tone={o.cash < 0 ? 'bad' : 'good'} />
      <Kpi label="Facturé" value={money(o.invoiced)} />
      <Kpi label="Encaissé" value={money(o.received)} tone="good" />
      <Kpi label="Reste à encaisser" value={money(o.toCollect)} tone={o.toCollect > 0 ? 'warn' : ''} />
      <Kpi label="Dépenses" value={money(o.expenses)} />
      <Kpi label="Reste à payer à l’équipe" value={money(o.teamDue)} tone={o.teamDue > 0 ? 'warn' : ''} />
      <Kpi label="Marge estimée des chantiers" value={money(o.margin)} tone={o.margin < 0 ? 'bad' : ''} />
      <Kpi label="Chantiers actifs" value={o.activeProjects} />
    </div>
    <h2>À surveiller</h2>
    <div className="admin-cols">
      <Box title="Factures à relancer" empty="Aucune facture en retard." rows={o.late} render={(x) => <div className="admin-line" key={x.id}><span>{x.number} · {x.client}<br /><small>Échue le {fmtDate(x.date)}</small></span><b>{money(x.amount)}</b></div>} />
      <Box title="Budgets dépassés" empty="Aucun budget dépassé." rows={o.overBudget} render={(x) => <div className="admin-line" key={x.id}><span>{x.name}</span><b>+ {money(x.over)}</b></div>} />
      <Box title="Stock faible" empty="Aucune alerte de stock." rows={o.lowStock} render={(x) => <div className="admin-line" key={x.id}><span>{x.name}</span><b>{x.stock} {x.unit}</b></div>} />
    </div>
    <h2>Caisses et équipe</h2>
    <div className="admin-cols">
      <Box title="Caisses" empty="Aucune caisse." rows={o.accounts} render={(x) => <div className="admin-line" key={x.id}><span>{x.name}</span><b>{money(x.balance)}</b></div>} />
      <section className="admin-box"><h3>Accès à l’application</h3>
        {Object.entries(ROLES).map(([role, label]) => <div className="admin-line" key={role}><span>{label}</span><b>{users.filter((u) => u.role === role && u.active).length}</b></div>)}
        <div className="admin-actions"><button onClick={() => go('access')}>Gérer les accès</button></div>
      </section>
    </div>
  </>;
}
function Table({ columns, rows, search, emptyText = 'Aucune donnée pour le moment.' }) {
  const [query, setQuery] = useState('');
  const q = query.trim().toLocaleLowerCase('fr');
  const shown = q ? rows.filter((r) => search(r).toLocaleLowerCase('fr').includes(q)) : rows;
  return <>
    {search && <input className="admin-search" aria-label="Rechercher" placeholder="Rechercher…" value={query} onChange={(e) => setQuery(e.target.value)} />}
    <div className="admin-wrap"><table className="admin-table"><thead><tr>{columns.map((c) => <th key={c.label} className={c.num ? 'num' : ''}>{c.label}</th>)}</tr></thead>
      <tbody>{shown.map((r) => <tr key={r.id} className={r.void ? 'off' : ''}>{columns.map((c) => <td key={c.label} className={c.num ? 'num' : ''}>{c.render(r)}</td>)}</tr>)}
        {!shown.length && <tr><td colSpan={columns.length}>{emptyText}</td></tr>}</tbody></table></div>
  </>;
}
function Projects({ data }) {
  return <Table rows={projectRows(data)} search={(r) => r.name + ' ' + r.client} columns={[
    { label: 'Chantier', render: (r) => <><b>{r.name}</b><br /><small>{r.client}</small></> },
    { label: 'Statut', render: (r) => (r.status ? <span className="admin-tag">{r.status}</span> : '—') },
    { label: 'Contrat', num: true, render: (r) => money(r.contract) },
    { label: 'Encaissé', num: true, render: (r) => money(r.received) },
    { label: 'Reste facturé', num: true, render: (r) => money(r.toCollect) },
    { label: 'Coût engagé', num: true, render: (r) => money(r.forecast) },
    { label: 'Budget', render: (r) => (r.used === null ? 'Non défini' : <>{money(r.budget)} · {r.used} %<div className="admin-bar"><i style={{ width: Math.min(r.used, 100) + '%' }} className={r.used > 100 ? 'over' : ''} /></div></>) },
    { label: 'Confié au gestionnaire', num: true, render: (r) => (r.managerBudget ? money(r.managerBudget) : '—') },
    { label: 'Marge', num: true, render: (r) => <b style={{ color: r.margin < 0 ? '#c62828' : undefined }}>{money(r.margin)}</b> },
  ]} />;
}
function Invoices({ data }) {
  const tone = (s) => (s === 'Payée' ? 'good' : s === 'Annulée' ? 'bad' : '');
  return <Table rows={invoiceRows(data)} search={(r) => [r.number, r.client, r.project, r.status].join(' ')} columns={[
    { label: 'Facture', render: (r) => <b>{r.number}</b> },
    { label: 'Client', render: (r) => r.client },
    { label: 'Chantier', render: (r) => r.project || '—' },
    { label: 'Date', render: (r) => fmtDate(r.date) },
    { label: 'Total', num: true, render: (r) => money(r.total) },
    { label: 'Encaissé', num: true, render: (r) => money(r.paid) },
    { label: 'Reste', num: true, render: (r) => money(r.left) },
    { label: 'Statut', render: (r) => <span className={'admin-tag ' + tone(r.status)}>{r.status}</span> },
  ]} />;
}
function Expenses({ data }) {
  return <Table rows={expenseRows(data)} search={(r) => [r.description, r.project, r.scope, r.category, r.account].join(' ')} columns={[
    { label: 'Date', render: (r) => fmtDate(r.date) },
    { label: 'Désignation', render: (r) => <b>{r.description}</b> },
    { label: 'Chantier / type', render: (r) => r.project || r.scope || '—' },
    { label: 'Catégorie', render: (r) => r.category || '—' },
    { label: 'Caisse', render: (r) => r.account || '—' },
    { label: 'Montant', num: true, render: (r) => money(r.amount) },
  ]} />;
}
function Workers({ data }) {
  return <Table rows={workerRows(data)} search={(r) => [r.name, r.role, ...r.tasks.map((t) => t.description + ' ' + t.project)].join(' ')} columns={[
    { label: 'Membre', render: (r) => <><b>{r.name}</b><br /><small>{r.role}</small>{r.tasks.map((t) => <div className="admin-sub" key={t.id}>{t.description}{t.project ? ' · ' + t.project : ''} : payé {money(t.paid)} sur {money(t.agreed)}</div>)}</> },
    { label: 'Convenu', num: true, render: (r) => money(r.agreed) },
    { label: 'Payé', num: true, render: (r) => money(r.paid) },
    { label: 'Reste à payer', num: true, render: (r) => <b>{money(r.left)}</b> },
  ]} />;
}
function Activity({ data }) {
  return <Table rows={activityRows(data)} search={(r) => [r.action, r.target, r.reason].join(' ')} columns={[
    { label: 'Date', render: (r) => dateTime(r.date) },
    { label: 'Action', render: (r) => r.action },
    { label: 'Concerne', render: (r) => r.target || '—' },
    { label: 'Motif', render: (r) => r.reason || '—' },
  ]} />;
}
function EntryCard({ entry, data, reload }) {
  // La caisse proposée est celle confiée à la personne qui a fait la saisie.
  const [accountId, setAccountId] = useState(entry.accountId || data?.accounts?.[0]?.id || '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [showPhoto, setShowPhoto] = useState(false);
  const decide = async (decision, extra = {}) => {
    setBusy(true); setError('');
    try { await api(`/api/entries/${entry.id}/decision`, { method: 'POST', body: { decision, ...extra } }); await reload(); } catch (x) { setError(x.message); setBusy(false); }
  };
  const site = data?.projects?.find((p) => p.id === entry.projectId)?.name || 'Chantier inconnu';
  return <div className="admin-entry">
    <div className="admin-user-head"><b>{entry.data.description || entry.data.note || ENTRY_LABELS[entry.kind]}</b><span className="admin-tag">{ENTRY_LABELS[entry.kind]}</span><span className={'admin-tag' + (entry.status === 'rejected' ? ' bad' : '')}>{STATUS_LABELS[entry.status]}</span></div>
    <small>{entry.data.scope && entry.data.scope !== 'Chantier' ? (entry.data.scope === 'Entreprise' ? 'Pour l’entreprise' : 'Dépense personnelle') + ' (caisse du chantier ' + site + ')' : site} · {fmtDate(entry.data.date)} · {entry.userName}{entry.data.category ? ' · ' + entry.data.category : ''}{entry.data.method ? ' · ' + entry.data.method : ''}</small>
    {entry.data.amount && <div className="admin-line"><span>Montant</span><b>{money(entry.data.amount)}</b></div>}
    {entry.applyError && <p className="error" role="alert">Non enregistré sur le téléphone : {entry.applyError}</p>}
    {entry.hasPhoto && (showPhoto ? <PhotoView id={entry.id} alt="Pièce jointe" /> : <div className="admin-actions"><button onClick={() => setShowPhoto(true)}>Voir la photo</button></div>)}
    {entry.status === 'pending' && <div className="admin-actions">
      <select aria-label="Caisse à utiliser" value={accountId} onChange={(e) => setAccountId(e.target.value)}>{(data?.accounts || []).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select>
      <button className="primary" disabled={busy || !accountId} onClick={() => decide('approve', { accountId })}>Valider</button>
      <button className="danger" disabled={busy} onClick={() => { const reason = prompt('Motif du refus'); if (reason?.trim()) decide('reject', { reason }); }}>Refuser</button>
    </div>}
    {entry.applyError && <div className="admin-actions"><button disabled={busy} onClick={() => decide('retry')}>Réessayer</button><button className="danger" disabled={busy} onClick={() => { const reason = prompt('Motif de l’abandon'); if (reason?.trim()) decide('cancel', { reason }); }}>Abandonner cette saisie</button></div>}
    {entry.status === 'open' && <div className="admin-actions"><button disabled={busy} onClick={() => { const reason = prompt('Ce qui a été fait (facultatif)'); if (reason !== null) decide('resolve', { reason }); }}>Marquer comme résolu</button></div>}
    {entry.status === 'resolved' && <div className="admin-actions"><button disabled={busy} onClick={() => decide('reopen')}>Rouvrir</button></div>}
    {entry.kind === 'incident' && <Thread id={entry.id} count={entry.messages} />}
    {error && <p className="error" role="alert">{error}</p>}
  </div>;
}
function Queue({ entries, data, reload }) {
  const money = entries.filter((e) => e.status === 'pending');
  const open = entries.filter((e) => e.status === 'open');
  const stuck = entries.filter((e) => e.status === 'approved' && e.applyError);
  const waiting = entries.filter((e) => e.status === 'approved' && !e.appliedAt && !e.applyError);
  return <>
    {!!waiting.length && <p className="admin-note">{waiting.length} saisie(s) validée(s) attendent l’ouverture de l’application sur votre téléphone pour être enregistrées dans vos comptes.</p>}
    <h2>Dépenses et paiements à valider ({money.length})</h2>
    <div className="admin-queue">{money.length ? money.map((e) => <EntryCard key={e.id} entry={e} data={data} reload={reload} />) : <p className="admin-empty">Rien à valider.</p>}</div>
    <h2>Incidents à traiter ({open.length})</h2>
    <div className="admin-queue">{open.length ? open.map((e) => <EntryCard key={e.id} entry={e} data={data} reload={reload} />) : <p className="admin-empty">Aucun incident ouvert.</p>}</div>
    {!!stuck.length && <><h2>À vérifier ({stuck.length})</h2><div className="admin-queue">{stuck.map((e) => <EntryCard key={e.id} entry={e} data={data} reload={reload} />)}</div></>}
  </>;
}
function OrderForm({ r, data, reload }) {
  const [supplierId, setSupplierId] = useState('');
  const [amount, setAmount] = useState('');
  const [expectedDate, setExpectedDate] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const step = async (name, extra) => {
    setBusy(true); setError('');
    try { await api(`/api/requests/${r.id}/step`, { method: 'POST', body: { step: name, ...extra } }); await reload(); } catch (x) { setError(x.message); setBusy(false); }
  };
  if (!data.suppliers.length) return <p className="error">Ajoutez d’abord un fournisseur dans l’application pour établir le bon de commande.</p>;
  return <form onSubmit={(e) => { e.preventDefault(); step('order', { supplierId, amount: Number(amount), expectedDate: expectedDate || undefined }); }}>
    <div className="admin-form">
      <label>Fournisseur<select required value={supplierId} onChange={(e) => setSupplierId(e.target.value)}><option value="">Choisir…</option>{data.suppliers.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
      <label>Montant prévu (F)<input required type="number" min="1" step="1" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
      <label>Livraison prévue<input type="date" value={expectedDate} onChange={(e) => setExpectedDate(e.target.value)} /></label>
    </div>
    <div className="admin-actions"><button className="primary" type="submit" disabled={busy}>Établir le bon de commande</button><button type="button" className="danger" disabled={busy} onClick={() => { const reason = prompt('Motif du refus'); if (reason?.trim()) step('refuse', { reason }); }}>Refuser</button></div>
    {error && <p className="error" role="alert">{error}</p>}
  </form>;
}
function RequestAdminCard({ r, data, reload }) {
  const [error, setError] = useState('');
  const site = data.projects.find((p) => p.id === r.projectId)?.name || 'Chantier inconnu';
  const retry = async () => { try { await api(`/api/requests/${r.id}/step`, { method: 'POST', body: { step: 'retry' } }); await reload(); } catch (x) { setError(x.message); } };
  return <div className="admin-entry">
    <div className="admin-user-head"><b>{itemsText(r.items)}</b><span className={'admin-tag' + (r.status === 'refuse' ? ' bad' : r.status === 'recu' ? ' good' : '')}>{requestStatus(r)}</span></div>
    <small>{site} · demandé par {r.userName} le {fmtDate(r.createdAt)}{r.history.length > 1 ? ' · ' + r.history.slice(1).map((h) => h.by).join(' → ') : ''}</small>
    {r.note && <p>{r.note}</p>}
    {r.order && <div className="admin-line"><span>{r.order.supplierName}{r.order.expectedDate ? ' · livraison le ' + fmtDate(r.order.expectedDate) : ''}</span><b>{money(r.order.amount)}</b></div>}
    {r.status === 'commande' && !r.orderReady && !r.applyError && <p className="admin-note">Le bon de commande sera numéroté dès que l’application s’ouvrira sur votre téléphone.</p>}
    {r.applyError && <><p className="error" role="alert">Non enregistré sur le téléphone : {r.applyError}</p><div className="admin-actions"><button onClick={retry}>Réessayer</button></div></>}
    {r.reason && <small>Motif : {r.reason}</small>}
    {r.status === 'demande' && <OrderForm r={r} data={data} reload={reload} />}
    {r.orderReady && <div className="admin-actions"><button onClick={() => { if (!printOrder(r, data)) setError('Autorisez les fenêtres pour afficher le bon.'); }}>Imprimer le bon de commande</button></div>}
    <Thread id={r.id} count={r.messages} />
    {error && <p className="error" role="alert">{error}</p>}
  </div>;
}
function Material({ requests, data, reload }) {
  const groups = [
    ['À commander', requests.filter((r) => r.status === 'demande')],
    ['Besoins pas encore transmis par le chef de chantier', requests.filter((r) => r.status === 'besoin')],
    ['Commandés, en attente de livraison', requests.filter((r) => r.status === 'commande')],
    ['Livrés, en attente de confirmation', requests.filter((r) => r.status === 'livre')],
    ['Terminés', requests.filter((r) => ['recu', 'refuse'].includes(r.status)).slice(0, 30)],
  ];
  return <>{groups.map(([title, rows]) => <React.Fragment key={title}><h2>{title} ({rows.length})</h2><div className="admin-queue">{rows.length ? rows.map((r) => <RequestAdminCard key={r.id} r={r} data={data} reload={reload} />) : <p className="admin-empty">Aucune demande.</p>}</div></React.Fragment>)}</>;
}
function Cashboxes({ data }) {
  return <div className="admin-queue">{data.accounts.map((a) => {
    const c = cashbox(data, a.id);
    const holder = data.employees.find((e) => e.id === a.holderId)?.name;
    const site = data.projects.find((p) => p.id === a.projectId)?.name;
    return <div className="admin-entry" key={a.id}>
      <div className="admin-user-head"><b>{a.name}</b>{holder && <span className="admin-tag">{holder}</span>}{site && <span className="admin-tag">{site}</span>}</div>
      <div className="admin-line"><span>Reste en caisse</span><b style={{ color: c.balance < 0 ? '#c62828' : undefined }}>{money(c.balance)}</b></div>
      <div className="admin-line"><span>Reçu</span><b>{money(c.opening + c.received)}</b></div>
      <div className="admin-line"><span>{site ? 'Pour le chantier ' + site : 'Pour les chantiers'}</span><b>{money(c.site)}</b></div>
      {c.otherSites.map((g) => <div className="admin-line" key={g.key}><span>Autre chantier : {g.name}</span><b>{money(g.amount)}</b></div>)}
      <div className="admin-line"><span>Pour l’entreprise<br /><small>{c.company.map((g) => g.name + ' ' + money(g.amount)).join(' · ')}</small></span><b>{money(c.companyTotal)}</b></div>
      <div className="admin-line"><span>Dépenses personnelles</span><b>{money(c.personal)}</b></div>
      {c.back > 0 && <div className="admin-line"><span>Rendu / retiré</span><b>{money(c.back)}</b></div>}
    </div>;
  })}</div>;
}
function Folders({ data, entries }) {
  const [id, setId] = useState(data.projects[0]?.id || '');
  const rows = projectRows(data);
  const row = rows.find((r) => r.id === id);
  const project = data.projects.find((p) => p.id === id);
  if (!project) return <p className="admin-empty">Aucun chantier pour le moment.</p>;
  const site = entries.filter((e) => e.projectId === id);
  return <div className="admin-folder">
    <label>Chantier <select value={id} onChange={(e) => setId(e.target.value)}>{data.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
    <div className="admin-kpis">
      <Kpi label="Contrat" value={money(row.contract)} />
      <Kpi label="Encaissé" value={money(row.received)} tone="good" />
      <Kpi label="Coût engagé" value={money(row.forecast)} />
      <Kpi label="Confié au gestionnaire" value={row.managerBudget ? money(row.managerBudget) : '—'} />
      <Kpi label="Marge estimée" value={money(row.margin)} tone={row.margin < 0 ? 'bad' : ''} />
    </div>
    <ReportButton company={data.settings?.company} project={project} data={data} entries={entries} finance={{ contract: row.contract, received: row.received, toCollect: row.toCollect, margin: row.margin }} />
    <PhotoGrid key={id} entries={site} />
    <MyEntries entries={site} title="Saisies et incidents" />
    {!site.length && <p className="admin-empty">Aucune photo ni saisie de l’équipe sur ce chantier.</p>}
  </div>;
}
function EditMember({ user, data, isSelf, onClose, onSaved }) {
  const [form, setForm] = useState({ name: user.name, role: user.role, email: user.email, employeeId: user.employeeId, projectIds: user.projectIds });
  const [error, setError] = useState('');
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const toggle = (id) => set('projectIds', form.projectIds.includes(id) ? form.projectIds.filter((x) => x !== id) : [...form.projectIds, id]);
  return <form onSubmit={async (e) => {
    e.preventDefault();
    try { await api(`/api/users/${user.id}`, { method: 'PATCH', body: form }); onSaved(); } catch (x) { setError(x.message); }
  }}>
    <div className="admin-form">
      <label>Nom<input required maxLength="80" value={form.name} onChange={(e) => set('name', e.target.value)} /></label>
      <label>Rôle<select value={form.role} disabled={isSelf} onChange={(e) => set('role', e.target.value)}>{Object.entries(ROLES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
      <label>Adresse Gmail<input type="email" value={form.email} onChange={(e) => set('email', e.target.value)} /></label>
      {form.role !== 'direction' && <label>Fiche dans l’équipe (pour lui confier une caisse)<select value={form.employeeId} onChange={(e) => set('employeeId', e.target.value)}><option value="">Choisir…</option>{(data?.employees || []).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label>}
      {['chef', 'ouvrier'].includes(form.role) && <div className="admin-sites"><b>Chantiers autorisés</b>{(data?.projects || []).map((p) => <label key={p.id}><input type="checkbox" checked={form.projectIds.includes(p.id)} onChange={() => toggle(p.id)} />{p.name}</label>)}</div>}
    </div>
    {error && <p className="error" role="alert">{error}</p>}
    <div className="admin-actions"><button className="primary" type="submit">Enregistrer</button><button type="button" onClick={onClose}>Annuler</button></div>
  </form>;
}
function Access({ users, data, me, reload }) {
  const [editing, setEditing] = useState(null);
  const [invite, setInvite] = useState(null);
  const [error, setError] = useState('');
  const siteNames = (u) => u.projectIds.map((id) => data?.projects?.find((p) => p.id === id)?.name).filter(Boolean);
  const run = async (fn) => { try { setError(''); await fn(); await reload(); } catch (x) { setError(x.message); } };
  const makeInvite = (u) => run(async () => { const r = await api(`/api/users/${u.id}/invite`, { method: 'POST' }); setInvite({ id: u.id, name: u.name, url: inviteUrl(r.token) }); });
  const setActive = (u, active) => {
    if (!active && !confirm(`Couper immédiatement l’accès de ${u.name} ? Ses appareils seront déconnectés.`)) return;
    run(async () => { await api(`/api/users/${u.id}`, { method: 'PATCH', body: { active } }); if (!active && invite?.id === u.id) setInvite(null); });
  };
  return <>
    {error && <p className="error" role="alert">{error}</p>}
    {users.map((u) => <div key={u.id} className={'admin-user' + (u.active ? '' : ' off')}>
      <div className="admin-user-head"><b>{u.name}</b><span className="admin-tag">{ROLES[u.role]}</span>{!u.active && <span className="admin-tag bad">Accès coupé</span>}{u.id === me.id && <span className="admin-tag good">Vous</span>}</div>
      <small>{[u.email, ['direction', 'gestionnaire'].includes(u.role) ? 'Tous les chantiers' : (siteNames(u).join(', ') || 'Aucun chantier'), `${u.devices} appareil(s) · ${u.sessions} connexion(s) active(s)`].filter(Boolean).join(' · ')}</small>
      {editing === u.id
        ? <EditMember user={u} data={data} isSelf={u.id === me.id} onClose={() => setEditing(null)} onSaved={async () => { setEditing(null); await reload(); }} />
        : <div className="admin-actions">
            <button onClick={() => setEditing(u.id)}>{u.id === me.id ? 'Modifier mes informations' : 'Modifier le rôle et les chantiers'}</button>
            {u.active && u.id !== me.id && <button onClick={() => makeInvite(u)}>Inviter</button>}
            {u.id !== me.id && (u.active ? <button className="danger" onClick={() => setActive(u, false)}>Couper l’accès</button> : <button onClick={() => setActive(u, true)}>Réactiver</button>)}
          </div>}
      {invite?.id === u.id && <div className="qr-box"><b>Invitation de {invite.name}</b><p>À scanner une seule fois avec son téléphone. Valable 7 jours.</p><img src={qrImage(invite.url)} alt={'QR code d’invitation de ' + invite.name} /><code>{invite.url}</code><div className="admin-actions"><button onClick={() => navigator.clipboard?.writeText(invite.url)}>Copier le lien</button><button onClick={() => setInvite(null)}>Masquer</button></div></div>}
    </div>)}
    <MemberForm workspace={data} onSaved={reload} />
  </>;
}
export function AdminApp() {
  const [state, setState] = useState('loading');
  const [me, setMe] = useState(null);
  const [users, setUsers] = useState([]);
  const [ws, setWs] = useState(null);
  const [entries, setEntries] = useState([]);
  const [requests, setRequests] = useState([]);
  const [tab, setTab] = useState('home');
  const [error, setError] = useState('');
  const load = async () => {
    setError('');
    if (readFlag(ADMIN_LOGOUT_KEY)) {
      // Une déconnexion n'a pas encore atteint le serveur : on la termine avant d'ouvrir quoi que ce soit.
      try { await api('/api/auth/logout', { method: 'POST' }); localStorage.removeItem(ADMIN_LOGOUT_KEY); } catch { /* toujours sans réseau */ }
      setState('login');
      return;
    }
    try {
      const who = await api('/api/me');
      setMe(who.user);
      if (who.user.role !== 'direction') { setState('forbidden'); return; }
      const [list, workspace, saisies, demandes] = await Promise.all([api('/api/users'), api('/api/workspace'), api('/api/entries'), api('/api/requests')]);
      setUsers(list.users); setWs(workspace); setEntries(saisies.entries); setRequests(demandes.requests); setState('ready');
    } catch (x) {
      if (x.status === 401) { setState('login'); return; }
      setError(x.message); setState('error');
    }
  };
  useEffect(() => { document.title = 'Tableau de bord GBA'; load(); }, []);
  const logout = async () => {
    localStorage.setItem(ADMIN_LOGOUT_KEY, '1');
    try { await api('/api/auth/logout', { method: 'POST' }); localStorage.removeItem(ADMIN_LOGOUT_KEY); } catch { /* terminée au retour du réseau */ }
    setMe(null); setUsers([]); setWs(null); setEntries([]); setRequests([]); setState('login');
  };
  if (state === 'loading') return <main className="admin admin-login"><p>Chargement…</p></main>;
  if (state === 'login') return <Login onDone={load} />;
  if (state === 'forbidden') return <Login onDone={load} forbidden />;
  if (state === 'error') return <Login onDone={load} error={error} />;
  const data = ws?.data;
  const pendingCount = entries.filter((e) => ['pending', 'open'].includes(e.status)).length;
  const toOrder = requests.filter((r) => r.status === 'demande').length;
  const Page = { projects: Projects, invoices: Invoices, expenses: Expenses, workers: Workers, activity: Activity }[tab];
  return <div className="admin">
    <header className="admin-top"><img src="/logo.jpg" alt="GBA" /><div className="admin-grow"><h1>Tableau de bord général</h1><small>{data?.settings?.company || 'GBA Gestion'} · {me.name}</small></div><button onClick={load}>Actualiser</button><button onClick={logout}>Se déconnecter</button></header>
    <nav className="admin-tabs" aria-label="Sections">{TABS.map(([k, label]) => <button key={k} className={tab === k ? 'on' : ''} aria-current={tab === k ? 'page' : undefined} onClick={() => setTab(k)}>{label}{k === 'queue' && pendingCount > 0 ? ` (${pendingCount})` : ''}{k === 'material' && toOrder > 0 ? ` (${toOrder})` : ''}</button>)}</nav>
    <main className="admin-main">
      {tab !== 'access' && <p className="admin-note">{data ? <>Données reçues de votre téléphone. Dernière mise à jour : {dateTime(ws.updatedAt)}. Les saisies se font pour l’instant dans l’application.</> : 'Aucune donnée pour le moment : lancez le transfert depuis votre téléphone.'}</p>}
      {tab === 'access' ? <Access users={users} data={data} me={me} reload={load} /> : !data ? null : tab === 'home' ? <Home data={data} users={users} go={setTab} entries={entries} requests={requests} /> : tab === 'queue' ? <Queue entries={entries} data={data} reload={load} /> : tab === 'material' ? <Material requests={requests} data={data} reload={load} /> : tab === 'cash' ? <Cashboxes data={data} /> : tab === 'folders' ? <Folders data={data} entries={entries} /> : <Page data={data} />}
    </main>
  </div>;
}
