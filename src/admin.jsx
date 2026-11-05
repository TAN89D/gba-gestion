import React, { useEffect, useState } from 'react';
import { api, inviteUrl, qrImage, MemberForm } from './team.jsx';
import { ROLES } from './permissions.js';
import { money, fmtDate } from './domain.js';
import { overview, projectRows, invoiceRows, expenseRows, workerRows, activityRows } from './adminData.js';
import './admin.css';

const TABS = [
  ['home', 'Vue d’ensemble'],
  ['projects', 'Chantiers'],
  ['invoices', 'Factures'],
  ['expenses', 'Dépenses'],
  ['workers', 'Paie de l’équipe'],
  ['access', 'Accès & rôles'],
  ['activity', 'Activité'],
];
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
      {google && <a href="/api/auth/google/start">Continuer avec Google</a>}
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
function Home({ data, users, go }) {
  const o = overview(data);
  return <>
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
      {form.role === 'ouvrier' && <label>Fiche dans l’équipe<select value={form.employeeId} onChange={(e) => set('employeeId', e.target.value)}><option value="">Choisir…</option>{(data?.employees || []).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label>}
      {form.role !== 'direction' && <div className="admin-sites"><b>Chantiers autorisés</b>{(data?.projects || []).map((p) => <label key={p.id}><input type="checkbox" checked={form.projectIds.includes(p.id)} onChange={() => toggle(p.id)} />{p.name}</label>)}</div>}
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
      <small>{[u.email, u.role === 'direction' ? 'Tous les chantiers' : (siteNames(u).join(', ') || 'Aucun chantier'), `${u.devices} appareil(s) · ${u.sessions} connexion(s) active(s)`].filter(Boolean).join(' · ')}</small>
      {editing === u.id
        ? <EditMember user={u} data={data} isSelf={u.id === me.id} onClose={() => setEditing(null)} onSaved={async () => { setEditing(null); await reload(); }} />
        : <div className="admin-actions">
            <button onClick={() => setEditing(u.id)}>{u.id === me.id ? 'Modifier mes informations' : 'Modifier le rôle et les chantiers'}</button>
            {u.active && u.role !== 'direction' && <button onClick={() => makeInvite(u)}>Inviter</button>}
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
  const [tab, setTab] = useState('home');
  const [error, setError] = useState('');
  const load = async () => {
    setError('');
    try {
      const who = await api('/api/me');
      setMe(who.user);
      if (who.user.role !== 'direction') { setState('forbidden'); return; }
      const [list, workspace] = await Promise.all([api('/api/users'), api('/api/workspace')]);
      setUsers(list.users); setWs(workspace); setState('ready');
    } catch (x) {
      if (x.status === 401) { setState('login'); return; }
      setError(x.message); setState('error');
    }
  };
  useEffect(() => { document.title = 'Tableau de bord GBA'; load(); }, []);
  const logout = async () => { try { await api('/api/auth/logout', { method: 'POST' }); } catch { /* la session expirera */ } setMe(null); setUsers([]); setWs(null); setState('login'); };
  if (state === 'loading') return <main className="admin admin-login"><p>Chargement…</p></main>;
  if (state === 'login') return <Login onDone={load} />;
  if (state === 'forbidden') return <Login onDone={load} forbidden />;
  if (state === 'error') return <Login onDone={load} error={error} />;
  const data = ws?.data;
  const Page = { projects: Projects, invoices: Invoices, expenses: Expenses, workers: Workers, activity: Activity }[tab];
  return <div className="admin">
    <header className="admin-top"><img src="/logo.jpg" alt="GBA" /><div className="admin-grow"><h1>Tableau de bord général</h1><small>{data?.settings?.company || 'GBA Gestion'} · {me.name}</small></div><button onClick={load}>Actualiser</button><button onClick={logout}>Se déconnecter</button></header>
    <nav className="admin-tabs" aria-label="Sections">{TABS.map(([k, label]) => <button key={k} className={tab === k ? 'on' : ''} aria-current={tab === k ? 'page' : undefined} onClick={() => setTab(k)}>{label}</button>)}</nav>
    <main className="admin-main">
      {tab !== 'access' && <p className="admin-note">{data ? <>Données reçues de votre téléphone. Dernière mise à jour : {dateTime(ws.updatedAt)}. Les saisies se font pour l’instant dans l’application.</> : 'Aucune donnée pour le moment : lancez le transfert depuis votre téléphone.'}</p>}
      {tab === 'access' ? <Access users={users} data={data} me={me} reload={load} /> : !data ? null : tab === 'home' ? <Home data={data} users={users} go={setTab} /> : <Page data={data} />}
    </main>
  </div>;
}
