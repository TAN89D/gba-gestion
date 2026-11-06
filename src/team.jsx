import React, { useEffect, useState } from 'react';
import qrcode from 'qrcode-generator';
import { HardHat, ListChecks, Notebook, Receipt, Package, SignOut, Backspace, GoogleLogo, UserPlus, QrCode, House, Users, CheckCircle, Warning, Camera, Plus, Money, ArrowLeft, Wallet, MapPin, HandWaving } from '@phosphor-icons/react';
import { ROLES } from './permissions.js';
import { money, fmtDate } from './domain.js';
import { readSync, writeSync, counts, transferAll } from './sync.js';
import { reservedOn } from './entries.js';
import { EntryForm, FORM_TITLES, MyEntries, PhotoGrid, ReportButton } from './entries.jsx';
import { RequestForm, RequestList, CashTab } from './requests.jsx';
import { BRAND, DEMO, SAAS, logoOf } from './brand.js';
import { InstallCard } from './install.jsx';
import { leaveDemo } from './demo.jsx';
import './team.css';

const DEVICE_KEY = 'gba-device';
const MEMBER_KEY = 'gba-member';
const OWNER_DATA_KEY = 'gba-web-v3';
const LOGOUT_PENDING_KEY = 'gba-logout-pending';

export async function api(path, { method = 'GET', body, headers = {} } = {}) {
  let res;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    throw Object.assign(Error('Connexion Internet indisponible.'), { status: 0 });
  }
  let data = {};
  try { data = await res.json(); } catch { /* réponse sans contenu lisible */ }
  if (!res.ok) throw Object.assign(Error(data.error || 'Service indisponible.'), { status: res.status });
  return data;
}
const read = (key) => { try { return localStorage.getItem(key); } catch { return null; } };
const hasOwnerData = () => !!read(OWNER_DATA_KEY);

function Brand({ title, subtitle, logo }) {
  return <div className="member-brand"><img src={logo || BRAND.logo} alt={BRAND.alt} /><div><h1>{title}</h1>{subtitle && <small>{subtitle}</small>}</div></div>;
}
function GoogleButton() {
  return <a className="primary wide" href="/api/auth/google/start"><GoogleLogo size={22} /> Continuer avec Google</a>;
}
function PinPad({ title, onDone, busy, error }) {
  const [pin, setPin] = useState('');
  const press = (d) => {
    if (busy || pin.length >= 4) return;
    const next = pin + d;
    setPin(next);
    if (next.length === 4) { onDone(next); setPin(''); }
  };
  return (
    <div>
      {title && <p style={{ textAlign: 'center', fontSize: 18 }}>{title}</p>}
      <div className="pin-dots" aria-label={pin.length + ' chiffres saisis sur 4'}>{[0, 1, 2, 3].map((i) => <span key={i} className={i < pin.length ? 'on' : ''} />)}</div>
      <div className="pinpad">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => <button type="button" key={d} disabled={busy} onClick={() => press(d)}>{d}</button>)}
        <span />
        <button type="button" disabled={busy} onClick={() => press('0')}>0</button>
        <button type="button" disabled={busy} aria-label="Effacer" onClick={() => setPin(pin.slice(0, -1))}><Backspace size={28} /></button>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
    </div>
  );
}

export function JoinScreen({ token, onJoined }) {
  const [info, setInfo] = useState(null);
  const [error, setError] = useState('');
  const [first, setFirst] = useState('');
  const [busy, setBusy] = useState(false);
  const blocked = hasOwnerData();
  useEffect(() => {
    if (blocked) return;
    api('/api/auth/invite/info', { method: 'POST', body: { token } }).then(setInfo).catch((e) => setError(e.message));
  }, []);
  if (blocked) {
    return <main className="member-screen"><Brand title={BRAND.name} /><p className="error">Cet appareil contient déjà les données de la direction. Ouvrez cette invitation sur le téléphone de la personne invitée.</p></main>;
  }
  const finish = async (pin) => {
    if (!first) { setFirst(pin); setError(''); return; }
    if (pin !== first) { setFirst(''); setError('Les deux codes sont différents. Recommencez.'); return; }
    setBusy(true);
    try {
      const r = await api('/api/auth/invite/redeem', { method: 'POST', body: { token, pin } });
      localStorage.setItem(DEVICE_KEY, r.deviceSecret);
      localStorage.setItem(MEMBER_KEY, '1');
      onJoined();
    } catch (e) { setFirst(''); setError(e.message); } finally { setBusy(false); }
  };
  return (
    <main className="member-screen">
      <Brand title={info ? 'Bienvenue ' + info.name : BRAND.name} subtitle={info && ROLES[info.role]} />
      {!info && !error && <p>Vérification de l’invitation…</p>}
      {info && info.hasEmail && <><GoogleButton /><p style={{ textAlign: 'center' }}>ou choisissez un code :</p></>}
      {info && <PinPad key={first ? 'confirm' : 'first'} title={first ? 'Répétez le code' : 'Choisissez un code à 4 chiffres'} onDone={finish} busy={busy} error={error} />}
      {!info && error && <p className="error" role="alert">{error}</p>}
    </main>
  );
}

const REFUSED = {
  compte: 'Cette adresse Google n’a pas d’accès. Demandez à la direction de l’ajouter.',
  google: 'Google n’a pas pu confirmer cette adresse.',
  session: 'La connexion a expiré. Réessayez.',
  annulee: 'Connexion annulée.',
  configuration: 'La connexion Google n’est pas encore configurée.',
};
export function LoginScreen({ reason, onLogged }) {
  const device = read(DEVICE_KEY);
  const [error, setError] = useState(reason ? REFUSED[reason] || 'Connexion refusée.' : '');
  const [busy, setBusy] = useState(false);
  const login = async (pin) => {
    setBusy(true);
    try {
      if (read(LOGOUT_PENDING_KEY)) {
        await api('/api/auth/logout', { method: 'POST' });
        localStorage.removeItem(LOGOUT_PENDING_KEY);
      }
      await api('/api/auth/pin', { method: 'POST', body: { secret: device, pin } });
      setError('');
      onLogged();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };
  return (
    <main className="member-screen">
      <Brand title={BRAND.name} subtitle="Espace équipe" />
      {device ? <PinPad title="Entrez votre code" onDone={login} busy={busy} error={error} /> : <><GoogleButton />{error && <p className="error" role="alert">{error}</p>}</>}
    </main>
  );
}

// Pointage : « Je suis arrivé », avec la position du téléphone si la personne l'accepte.
function where() {
  return new Promise((ok) => {
    if (!navigator.geolocation) { ok(null); return; }
    navigator.geolocation.getCurrentPosition((p) => ok({ lat: p.coords.latitude, lng: p.coords.longitude }), () => ok(null), { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 });
  });
}
const mapLink = (p) => 'https://www.openstreetmap.org/?mlat=' + p.lat + '&mlon=' + p.lng + '#map=17/' + p.lat + '/' + p.lng;
function Presence({ user, data, onReload }) {
  const [site, setSite] = useState(data.projects.length === 1 ? data.projects[0].id : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const list = data.presences || [];
  const mine = list.filter((p) => p.userId === user.id);
  const arrive = async () => {
    if (!site) { setError('Choisissez le chantier.'); return; }
    setBusy(true); setError('');
    try {
      const pos = await where();
      await api('/api/presence', { method: 'POST', body: { projectId: site, ...(pos || {}) } });
      try { await onReload(); } catch { /* affiché à la prochaine actualisation */ }
    } catch (e) { setError(e.status === 0 ? 'Pas de réseau : réessayez dans un moment.' : e.message); } finally { setBusy(false); }
  };
  return <section className="presence">
    {mine.length ? mine.map((p) => <p className="presence-done" key={p.id}><CheckCircle size={26} weight="fill" /><span>Arrivé à <b>{p.time}</b> · {nameOf(data.projects, p.projectId)}{p.lat != null ? ' · position enregistrée' : ''}</span></p>)
      : <div className="presence-ask">
        {data.projects.length > 1 && <select aria-label="Chantier" value={site} onChange={(e) => setSite(e.target.value)}><option value="">Sur quel chantier ?</option>{data.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>}
        <button type="button" className="presence-btn" disabled={busy || !data.projects.length} onClick={arrive}><HandWaving size={34} />{busy ? 'Envoi…' : 'Je suis arrivé'}</button>
        <small>L’heure est enregistrée, et la position du téléphone si vous l’acceptez.</small>
      </div>}
    {error && <p className="error" role="alert">{error}</p>}
    {user.role !== 'ouvrier' && <><h2>Présents aujourd’hui ({list.length})</h2>
      {list.length ? list.map((p) => <div className="member-card member-presence" key={p.id}><Users size={26} /><div><b>{p.userName}</b><small>{p.time} · {nameOf(data.projects, p.projectId) || 'Chantier'}</small></div>{p.lat != null && <a href={mapLink(p)} target="_blank" rel="noopener" aria-label={'Position de ' + p.userName}><MapPin size={24} /></a>}</div>) : <p className="subtle">Personne n’a encore pointé aujourd’hui.</p>}</>}
  </section>;
}

function Card({ Icon, title, sub, tag }) {
  return <div className="member-card"><Icon size={34} /><div><b>{title}</b>{sub && <small>{sub}</small>}{tag && <div><span className="member-tag">{tag}</span></div>}</div></div>;
}
export function MemberApp({ reason }) {
  const [user, setUser] = useState(null);
  const [data, setData] = useState(null);
  const [state, setState] = useState('loading');
  const [error, setError] = useState('');
  const finishLogout = async () => {
    await api('/api/auth/logout', { method: 'POST' });
    localStorage.removeItem(LOGOUT_PENDING_KEY);
    if (!read(DEVICE_KEY)) localStorage.removeItem(MEMBER_KEY);
  };
  const reload = async () => {
    const [ws, list, req, pres] = await Promise.all([api('/api/workspace'), api('/api/entries'), api('/api/requests'), api('/api/presence').catch(() => ({ presences: [] }))]);
    setData(ws.data ? { ...ws.data, entries: list.entries, requests: req.requests, presences: pres.presences || [] } : null);
  };
  const refresh = async () => {
    setState('loading');
    if (read(LOGOUT_PENDING_KEY)) {
      // Une déconnexion n'a pas encore atteint le serveur : on la termine avant
      // d'ouvrir quoi que ce soit, pour ne jamais réutiliser l'ancienne session.
      try { await finishLogout(); } catch { /* toujours sans réseau */ }
      setState('login');
      return;
    }
    try {
      const me = await api('/api/me');
      if (me.user.role === 'direction') {
        if (SAAS && !hasOwnerData()) {
          const ws = await api('/api/workspace');
          if (ws.data) {
            localStorage.setItem(OWNER_DATA_KEY, JSON.stringify(ws.data));
            writeSync({ enabled: true, revision: ws.revision, syncedAt: ws.data.updatedAt });
            localStorage.removeItem(MEMBER_KEY);
            location.replace('/');
            return;
          }
        }
        // Un compte de direction invité ouvre le tableau de bord général, protégé par son code.
        localStorage.removeItem(MEMBER_KEY);
        location.replace('/admin');
        return;
      }
      if (hasOwnerData()) {
        localStorage.removeItem(MEMBER_KEY);
        location.replace('/');
        return;
      }
      localStorage.setItem(MEMBER_KEY, '1');
      setUser(me.user);
      await reload();
      setError('');
      setState('ready');
    } catch (e) {
      if (e.status === 401) { if (DEMO) { leaveDemo(); return; } setState('login'); return; }
      setError(e.message);
      setState('error');
    }
  };
  useEffect(() => { reason ? setState('login') : refresh(); }, []);
  const logout = async () => {
    if (DEMO) { await leaveDemo(); return; }
    localStorage.setItem(LOGOUT_PENDING_KEY, '1');
    try { await finishLogout(); } catch { /* terminée au prochain retour du réseau */ }
    setUser(null); setData(null); setState('login');
  };
  if (state === 'login') return <LoginScreen reason={reason} onLogged={refresh} />;
  if (state === 'loading') return <main className="member-screen"><Brand title={BRAND.name} /><p>Chargement…</p></main>;
  if (state === 'error') return <main className="member-screen"><Brand title={BRAND.name} /><p className="error" role="alert">{error}</p><button className="primary wide" onClick={refresh}>Réessayer</button></main>;
  return <MemberSpace user={user} data={data} onRefresh={refresh} onReload={reload} onLogout={logout} />;
}

const nameOf = (rows, id) => rows?.find((x) => x.id === id)?.name || '';
const when = (x, projects) => [fmtDate(x.date), nameOf(projects, x.projectId)].filter(Boolean).join(' · ');
const TABS = {
  ouvrier: [['home', 'Accueil', House], ['tasks', 'Mes tâches', ListChecks], ['pay', 'Paiements', Money], ['projects', 'Chantiers', HardHat], ['journal', 'Journal', Notebook]],
  gestionnaire: [['home', 'Accueil', House], ['projects', 'Chantiers', HardHat], ['expenses', 'Dépenses', Receipt], ['team', 'Équipe', Users], ['orders', 'Achats', Package]],
  chef: [['home', 'Accueil', House], ['projects', 'Chantiers', HardHat], ['tasks', 'Tâches', ListChecks], ['crew', 'Équipe', Users], ['journal', 'Journal', Notebook]],
};
// Avec une caisse confiée, l'onglet « Caisse » remplace l'onglet le moins utilisé.
const tabsFor = (user, data) => {
  const base = TABS[user.role] || TABS.ouvrier;
  if (!data?.cashboxes?.length) return base;
  const drop = user.role === 'chef' ? 'journal' : 'expenses';
  return base.flatMap((t) => (t[0] === drop ? [['cash', 'Caisse', Wallet]] : [t]));
};
const needsMe = (r) => r.status === 'besoin' || (r.status === 'commande' && r.orderReady) || r.status === 'livre';
function Tile({ Icon, label, value, onClick, tone }) {
  return <button type="button" className={'member-tile' + (tone ? ' member-tile-' + tone : '')} onClick={onClick}><Icon size={28} /><b>{value}</b><small>{label}</small></button>;
}
function Act({ Icon, label, onClick, tone }) {
  return <button type="button" className={'member-soon' + (tone ? ' tone-' + tone : '')} onClick={onClick}><Icon size={tone ? 48 : 30} weight={tone ? 'duotone' : 'regular'} /><span>{label}</span></button>;
}
function Empty({ text }) { return <p className="info">{text}</p>; }
const paidOn = (data, taskId) => data.teamPayments.filter((p) => p.taskId === taskId).reduce((n, p) => n + Number(p.amount || 0), 0);
const leftOn = (data, t) => Math.max(0, Number(t.agreedAmount || 0) - paidOn(data, t.id));
const sumOf = (rows, f) => rows.reduce((n, x) => n + f(x), 0);
// Ce qui consomme le budget confié : les dépenses du chantier et les paiements de l'équipe.
const usedOn = (data, projectId) => sumOf(data.expenses.filter((x) => x.projectId === projectId), (x) => Number(x.amount || 0)) + sumOf(data.teamPayments.filter((x) => x.projectId === projectId), (x) => Number(x.amount || 0)) + reservedOn(data.entries, projectId, data);
function PayLine({ agreed, paid, left }) {
  const pct = agreed > 0 ? Math.min(100, Math.round((paid / agreed) * 100)) : 0;
  return <div className="member-pay"><div className="member-bar"><i style={{ width: pct + '%' }} /></div><div className="member-pay-row"><span>Payé <b>{money(paid)}</b></span><span>Reste <b>{money(left)}</b></span></div><small>Convenu : {money(agreed)}</small></div>;
}
function PayTab({ data }) {
  if (!data.tasks.length) return <Empty text="Aucune tâche ne vous est attribuée." />;
  const sites = [...new Set(data.tasks.map((t) => t.projectId))];
  return <>
    <div className="member-tiles">
      <div className="member-tile"><Money size={28} /><b>{money(sumOf(data.tasks, (t) => paidOn(data, t.id)))}</b><small>Déjà payé</small></div>
      <div className="member-tile"><Money size={28} /><b>{money(sumOf(data.tasks, (t) => leftOn(data, t)))}</b><small>Reste à payer</small></div>
    </div>
    {sites.map((site) => {
      const tasks = data.tasks.filter((t) => t.projectId === site);
      return <section key={site}>
        <h2>{nameOf(data.projects, site) || 'Chantier'}</h2>
        <PayLine agreed={sumOf(tasks, (t) => Number(t.agreedAmount || 0))} paid={sumOf(tasks, (t) => paidOn(data, t.id))} left={sumOf(tasks, (t) => leftOn(data, t))} />
        {tasks.map((t) => <div className="member-card member-budget" key={t.id}><div><b>{t.description}</b><PayLine agreed={Number(t.agreedAmount || 0)} paid={paidOn(data, t.id)} left={leftOn(data, t)} />{data.teamPayments.filter((p) => p.taskId === t.id).map((p) => <small key={p.id} className="member-pay-item">{fmtDate(p.date)} · {money(p.amount)}{p.method ? ' · ' + p.method : ''}</small>)}</div></div>)}
      </section>;
    })}
  </>;
}
function CashTile({ data, go }) {
  const boxes = data.cashboxes || [];
  if (!boxes.length) return null;
  const left = sumOf(boxes, (b) => b.balance);
  return <Tile Icon={Wallet} label={left < 0 ? 'Avancé de ma poche' : 'Reste dans ma caisse'} value={money(Math.abs(left))} onClick={() => go('cash')} tone={left < 0 ? 'bad' : ''} />;
}
function HomeTab({ user, data, go, openSite, doAction, onReload }) {
  const active = (rows) => rows.filter((x) => x.status !== 'Terminé').length;
  const requests = data.requests || [];
  const todo = requests.filter(needsMe);
  const lists = <>
    {user.role !== 'ouvrier' && todo.length > 0 && <RequestList title={'Matériel à traiter (' + todo.length + ')'} requests={todo} user={user} data={data} onChanged={onReload} />}
    <RequestList title="Demandes de matériel" requests={user.role === 'ouvrier' ? requests : requests.filter((r) => !needsMe(r))} user={user} data={data} onChanged={onReload} />
  </>;
  if (user.role === 'ouvrier') {
    return <>
      <Presence user={user} data={data} onReload={onReload} />
      <div className="member-tiles">
        <Tile Icon={Money} label="Déjà payé" value={money(sumOf(data.tasks, (t) => paidOn(data, t.id)))} onClick={() => go('pay')} />
        <Tile Icon={Money} label="Reste à payer" value={money(sumOf(data.tasks, (t) => leftOn(data, t)))} onClick={() => go('pay')} />
        <Tile Icon={ListChecks} label="Tâches à faire" value={active(data.tasks)} onClick={() => go('tasks')} />
        <Tile Icon={HardHat} label="Mes chantiers" value={data.projects.length} onClick={() => go('projects')} />
      </div>
      <h2>Signaler</h2>
      <div className="member-soons big"><Act Icon={CheckCircle} label="Travail fait" tone="green" onClick={() => doAction('done')} /><Act Icon={Camera} label="Photo du chantier" tone="blue" onClick={() => doAction('photo')} /><Act Icon={Warning} label="Problème" tone="red" onClick={() => doAction('incident')} /><Act Icon={Package} label="Besoin de matériel" tone="orange" onClick={() => doAction('need')} /></div>
      {lists}
      <MyEntries entries={data.entries || []} />
    </>;
  }
  if (user.role === 'gestionnaire') {
    const paid = data.teamPayments.reduce((n, x) => n + Number(x.amount || 0), 0);
    const agreed = data.tasks.reduce((n, x) => n + Number(x.agreedAmount || 0), 0);
    const given = sumOf(data.projects, (p) => Number(p.managerBudget || 0));
    const usedTotal = sumOf(data.projects, (p) => usedOn(data, p.id));
    return <>
      <div className="member-tiles">
        <Tile Icon={Money} label="Budget confié" value={money(given)} onClick={() => go('projects')} />
        <Tile Icon={Receipt} label="Utilisé" value={money(usedTotal)} onClick={() => go('expenses')} />
        <Tile Icon={given - usedTotal < 0 ? Warning : Money} label={given - usedTotal < 0 ? 'Budget dépassé de' : 'Reste du budget'} value={money(Math.abs(given - usedTotal))} onClick={() => go('projects')} tone={given - usedTotal < 0 ? 'bad' : ''} />
        <Tile Icon={HardHat} label="Chantiers" value={data.projects.length} onClick={() => go('projects')} />
        <Tile Icon={Users} label="Reste à payer à l’équipe" value={money(Math.max(0, agreed - paid))} onClick={() => go('team')} />
        <Tile Icon={Package} label="Commandes en cours" value={data.orders.filter((o) => o.status !== 'Reçu').length} onClick={() => go('orders')} />
        <CashTile data={data} go={go} />
      </div>
      <Presence user={user} data={data} onReload={onReload} />
      <h2>Budget par chantier</h2>
      {data.projects.map((p) => {
        const used = usedOn(data, p.id);
        const budget = Number(p.managerBudget || 0);
        const pct = budget > 0 ? Math.round((used / budget) * 100) : 0;
        return <button type="button" className="member-link" key={p.id} onClick={() => openSite(p.id)}><div className="member-card member-budget"><div><b>{p.name}</b><small className={budget > 0 && used > budget ? 'member-over' : ''}>{budget > 0 ? money(used) + ' utilisés sur ' + money(budget) + (used > budget ? ' · dépassé de ' + money(used - budget) : '') : money(used) + ' utilisés · aucun budget confié'}</small><div className="member-bar"><i style={{ width: Math.min(pct, 100) + '%' }} className={pct > 100 ? 'over' : ''} /></div></div></div></button>;
      })}
      <h2>Actions</h2>
      <div className="member-soons"><Act Icon={Plus} label="Ajouter une dépense" onClick={() => doAction('expense')} /><Act Icon={Receipt} label="Scanner une facture" onClick={() => doAction('scan')} /><Act Icon={Money} label="Payer un ouvrier" onClick={() => doAction('teamPayment')} /><Act Icon={Warning} label="Signaler un incident" onClick={() => doAction('incident')} /><Act Icon={Camera} label="Photo du chantier" onClick={() => doAction('photo')} /><Act Icon={Package} label="Demande de matériel" onClick={() => doAction('need')} /></div>
      {lists}
      <MyEntries entries={data.entries || []} />
    </>;
  }
  return <>
    <div className="member-tiles">
      <CashTile data={data} go={go} />
      <Tile Icon={HardHat} label="Chantiers" value={data.projects.length} onClick={() => go('projects')} />
      <Tile Icon={ListChecks} label="Tâches en cours" value={active(data.tasks)} onClick={() => go('tasks')} />
      <Tile Icon={Users} label="Ouvriers" value={data.employees.length} onClick={() => go('crew')} />
      <Tile Icon={Notebook} label="Notes de chantier" value={data.journal.length} onClick={() => go('journal')} />
    </div>
    <Presence user={user} data={data} onReload={onReload} />
    <h2>Actions</h2>
    <div className="member-soons">{!!data.cashboxes?.length && <><Act Icon={Plus} label="Ajouter une dépense" onClick={() => doAction('expense')} /><Act Icon={Receipt} label="Scanner une facture" onClick={() => doAction('scan')} /></>}<Act Icon={Camera} label="Photo du chantier" onClick={() => doAction('photo')} /><Act Icon={Warning} label="Signaler un incident" onClick={() => doAction('incident')} /><Act Icon={Package} label="Demande de matériel" onClick={() => doAction('need')} /></div>
    {lists}
    <MyEntries entries={data.entries || []} />
  </>;
}
function SiteDetail({ project, data, user, onBack, doAction, onReload }) {
  const onSite = (x) => x.projectId === project.id;
  const siteEntries = (data.entries || []).filter(onSite);
  const money4 = user.role === 'gestionnaire';
  const ownBox = user.role === 'chef' && !!data.cashboxes?.length;
  const expenses = data.expenses.filter(onSite);
  const tasks = data.tasks.filter(onSite);
  const orders = data.orders.filter(onSite);
  const journal = data.journal.filter(onSite);
  const spent = usedOn(data, project.id);
  const budget = Number(project.managerBudget || 0);
  const showMoney = user.role === 'gestionnaire';
  const pct = budget > 0 ? Math.round((spent / budget) * 100) : 0;
  const part = (title, rows, render) => (rows.length ? <section key={title}><h2>{title}</h2>{rows.map(render)}</section> : null);
  return <>
    <button type="button" className="member-back" onClick={onBack}><ArrowLeft size={20} /> Retour</button>
    <div className="member-card member-budget"><div>
      <small>{[project.address, project.status].filter(Boolean).join(' · ')}</small>
      {showMoney && (budget > 0
        ? <><b className={budget - spent < 0 ? 'member-over' : ''}>{budget - spent < 0 ? 'Budget dépassé de ' + money(spent - budget) : 'Reste : ' + money(budget - spent)}</b><small>{money(spent)} utilisés sur {money(budget)} confiés ({pct} %)</small><div className="member-bar"><i style={{ width: Math.min(pct, 100) + '%' }} className={pct > 100 ? 'over' : ''} /></div></>
        : <><b>{money(spent)} utilisés</b><small>Aucun budget ne vous a encore été confié sur ce chantier.</small></>)}
    </div></div>
    <div className="member-soons">
      <Act Icon={Camera} label="Photo" onClick={() => doAction('photo', project.id)} />
      <Act Icon={Warning} label="Incident" onClick={() => doAction('incident', project.id)} />
      <Act Icon={Package} label="Matériel" onClick={() => doAction('need', project.id)} />
      {(money4 || ownBox) && <Act Icon={Plus} label="Dépense" onClick={() => doAction('expense', project.id)} />}
      {(money4 || ownBox) && <Act Icon={Receipt} label="Scanner" onClick={() => doAction('scan', project.id)} />}
      {money4 && <Act Icon={Money} label="Payer un ouvrier" onClick={() => doAction('teamPayment', project.id)} />}
    </div>
    <ReportButton company={data.settings?.company} project={project} data={data} entries={data.entries || []} />
    <RequestList requests={data.requests} projectId={project.id} user={user} data={data} onChanged={onReload} />
    <PhotoGrid entries={siteEntries} />
    <MyEntries entries={siteEntries} title="Saisies et incidents" />
    {part('Tâches', tasks, (t) => <Card key={t.id} Icon={ListChecks} title={t.description} sub={[nameOf(data.employees, t.employeeId), user.role === 'ouvrier' ? 'Reste à payer : ' + money(leftOn(data, t)) : showMoney ? 'Payé ' + money(paidOn(data, t.id)) + ' sur ' + money(t.agreedAmount) : ''].filter(Boolean).join(' · ')} tag={t.status} />)}
    {part('Dépenses', expenses, (x) => <Card key={x.id} Icon={Receipt} title={x.description} sub={fmtDate(x.date)} tag={money(x.amount)} />)}
    {part('Commandes', orders, (o) => <Card key={o.id} Icon={Package} title={o.description || o.number} sub={[o.number, nameOf(data.suppliers, o.supplierId)].filter(Boolean).join(' · ')} tag={o.status} />)}
    {part('Journal', journal, (j) => <Card key={j.id} Icon={Notebook} title={j.note} sub={fmtDate(j.date)} tag={j.kind} />)}
    {!tasks.length && !expenses.length && !orders.length && !journal.length && !siteEntries.length && <Empty text="Rien n’est encore enregistré sur ce chantier." />}
  </>;
}
function TabContent({ tab, user, data, go, openSite, doAction, onReload }) {
  const list = (rows, empty, render) => (rows.length ? rows.map(render) : <Empty text={empty} />);
  if (tab === 'home') return <HomeTab user={user} data={data} go={go} openSite={openSite} doAction={doAction} onReload={onReload} />;
  if (tab === 'cash') return <CashTab data={data} doAction={doAction} />;
  if (tab === 'pay') return <PayTab data={data} />;
  if (tab === 'tasks' && user.role === 'chef') return list(data.tasks, 'Aucune tâche sur vos chantiers.', (t) => <Card key={t.id} Icon={ListChecks} title={t.description} sub={[nameOf(data.employees, t.employeeId), nameOf(data.projects, t.projectId)].filter(Boolean).join(' · ')} tag={t.status} />);
  if (tab === 'crew') return list(data.employees, 'Aucun ouvrier sur vos chantiers.', (e) => <Card key={e.id} Icon={Users} title={e.name} sub={[e.role, e.phone].filter(Boolean).join(' · ')} tag={data.tasks.filter((t) => t.employeeId === e.id && t.status !== 'Terminé').length + ' tâche(s) en cours'} />);
  if (tab === 'tasks') return list(data.tasks, 'Aucune tâche ne vous est attribuée.', (t) => <Card key={t.id} Icon={ListChecks} title={t.description} sub={[nameOf(data.projects, t.projectId), 'Reste à payer : ' + money(leftOn(data, t))].filter(Boolean).join(' · ')} tag={t.status} />);
  if (tab === 'projects') return list(data.projects, 'Aucun chantier ne vous est encore attribué.', (p) => <button type="button" className="member-link" key={p.id} onClick={() => openSite(p.id)}><Card Icon={HardHat} title={p.name} sub={p.address} tag={p.status} /></button>);
  if (tab === 'journal') return list(data.journal, 'Aucune note pour le moment.', (j) => <Card key={j.id} Icon={Notebook} title={j.note} sub={when(j, data.projects)} tag={j.kind} />);
  if (tab === 'expenses') return list(data.expenses, 'Aucune dépense pour le moment.', (x) => <Card key={x.id} Icon={Receipt} title={x.description} sub={when(x, data.projects)} tag={money(x.amount)} />);
  if (tab === 'team') {
    return list(data.tasks, 'Aucune tâche sur vos chantiers.', (t) => {
      const paid = data.teamPayments.filter((p) => p.taskId === t.id).reduce((n, p) => n + Number(p.amount || 0), 0);
      return <Card key={t.id} Icon={Users} title={t.description} sub={[nameOf(data.employees, t.employeeId), nameOf(data.projects, t.projectId)].filter(Boolean).join(' · ')} tag={'Payé ' + money(paid) + ' sur ' + money(t.agreedAmount)} />;
    });
  }
  if (tab === 'orders') return list(data.orders, 'Aucune commande pour le moment.', (o) => <Card key={o.id} Icon={Package} title={o.description || o.number} sub={[o.number, nameOf(data.suppliers, o.supplierId), nameOf(data.projects, o.projectId)].filter(Boolean).join(' · ')} tag={o.status} />);
  return null;
}
function MemberSpace({ user, data, onRefresh, onReload, onLogout }) {
  const [tab, setTab] = useState('home');
  const [site, setSite] = useState(null);
  const [action, setAction] = useState(null);
  const [sent, setSent] = useState('');
  const doAction = (type, projectId) => { setAction({ type, projectId }); setSent(''); window.scrollTo(0, 0); };
  const tabs = tabsFor(user, data);
  const open = (k) => { setTab(k); setSite(null); setAction(null); setSent(''); window.scrollTo(0, 0); };
  const openSite = (id) => { setSite(id); window.scrollTo(0, 0); };
  const project = site && data?.projects.find((p) => p.id === site);
  const title = action ? FORM_TITLES[action.type] : project ? project.name : tabs.find(([k]) => k === tab)?.[1];
  return (
    <>
      <main className="member-screen member-with-tabs">
        <Brand title={!action && !project && tab === 'home' ? 'Bonjour ' + user.name : title} subtitle={[ROLES[user.role], data?.settings?.company].filter(Boolean).join(' · ')} logo={data?.settings?.logo ? logoOf(data.settings) : ''} />
        {!action && !project && tab === 'home' && <InstallCard />}
        {sent && !action && <p className="info" role="status">{sent}</p>}
        {!data && <Empty text="Les données de l’entreprise ne sont pas encore disponibles." />}
        {data && action?.type === 'need' && <RequestForm key={'need' + (action.projectId || '')} data={data} projectId={action.projectId} onCancel={() => setAction(null)} onDone={async () => { try { await onReload(); } catch { /* affiché à la prochaine actualisation */ } setAction(null); setSent(user.role === 'ouvrier' ? 'Envoyé. Votre chef de chantier va transmettre la demande.' : 'Envoyé. La direction va préparer le bon de commande.'); window.scrollTo(0, 0); }} />}
        {data && action && action.type !== 'need' && <EntryForm key={action.type + (action.projectId || '')} action={action} data={data} onCancel={() => setAction(null)} onDone={async (kind) => { try { await onReload(); } catch { /* l'envoi a réussi ; l'affichage se mettra à jour à la prochaine actualisation */ } setAction(null); setSent(['expense', 'teamPayment'].includes(kind) ? 'Envoyé. La direction doit maintenant valider cette saisie.' : 'Envoyé. C’est enregistré dans le dossier du chantier.'); window.scrollTo(0, 0); }} />}
        {!action && project && <SiteDetail project={project} data={data} user={user} onBack={() => setSite(null)} doAction={doAction} onReload={onReload} />}
        {!action && data && !project && <TabContent tab={tab} user={user} data={data} go={open} openSite={openSite} doAction={doAction} onReload={onReload} />}
        {!action && tab === 'home' && !project && <div className="chips member-actions"><button onClick={onRefresh}>Actualiser</button><button onClick={onLogout}><SignOut /> Se déconnecter</button></div>}
      </main>
      <nav className="bottom">{tabs.map(([k, label, Icon]) => <button key={k} className={tab === k && !site ? 'active' : ''} onClick={() => open(k)}><Icon size={25} weight={tab === k && !site ? 'fill' : 'regular'} /><span>{label}</span></button>)}</nav>
    </>
  );
}

const COUNT_LABELS = { clients: 'clients', projects: 'chantiers', quotes: 'devis', invoices: 'factures', payments: 'paiements', expenses: 'dépenses', employees: 'membres d’équipe', tasks: 'tâches', suppliers: 'fournisseurs', materials: 'matériaux' };
const countsText = (c) => Object.entries(COUNT_LABELS).filter(([k]) => c[k]).map(([k, label]) => c[k] + ' ' + label).join(' · ') || 'aucune donnée';
const SYNC_TEXT = {
  sending: 'Envoi en cours…',
  ok: 'À jour : l’équipe voit vos dernières données.',
  offline: 'Pas de réseau : l’envoi reprendra tout seul. Vos données restent sur cet appareil.',
  conflict: 'Une autre version existe en ligne : l’envoi automatique est en pause, rien n’a été remplacé.',
  auth: 'Votre connexion a expiré : rouvrez la gestion de l’équipe pour reprendre l’envoi.',
  refused: 'Le serveur a refusé les données : rien n’a été remplacé.',
  tooBig: 'Données trop volumineuses pour l’envoi automatique.',
  demo: 'Données de démonstration : rien n’est envoyé à l’équipe.',
  empty: 'Cet appareil est vide : rien n’a été envoyé.',
};
function TransferPanel({ getState, backupNow, engine, syncStatus, onDone }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [ask, setAsk] = useState(null);
  const [report, setReport] = useState(null);
  const cfg = readSync();
  const local = counts(getState());
  const go = async (overwriteRevision) => {
    setBusy(true); setError(''); setAsk(null);
    try {
      if (engine && !engine.canRun()) throw Error('Cet onglet n’est plus à jour. Rechargez la page avant de transférer.');
      backupNow();
      const r = await transferAll(getState, { overwriteRevision });
      if (r.needsConfirm) setAsk(r); else { setReport(r); onDone(); engine?.runNow(); }
    } catch (e) { setError(e.status === 0 || e instanceof TypeError ? 'Pas de réseau : réessayez plus tard. Vos données n’ont pas bougé.' : e.message); } finally { setBusy(false); }
  };
  return (
    <div className="team-member">
      <h4>Transfert vers la base commune</h4>
      {!cfg.enabled && !report && <p>Sur cet appareil : {countsText(local)}. Une sauvegarde sera téléchargée, puis une copie sera envoyée et vérifiée. Les données de cet appareil ne sont pas modifiées.</p>}
      {report && <div className="info" role="status"><b>Transfert réussi et vérifié.</b><br />{countsText(report.sent)}.{report.withoutAttachments ? ` Les ${report.attachmentsKept} pièce(s) jointe(s) restent uniquement sur cet appareil, car elles sont trop volumineuses.` : ''}</div>}
      {cfg.enabled && !report && <p role="status">{SYNC_TEXT[syncStatus] || SYNC_TEXT.ok}{cfg.at ? ' Dernier envoi : ' + fmtDate(cfg.at) + ' à ' + String(cfg.at).slice(11, 16) + ' (UTC).' : ''}{cfg.withoutAttachments ? ' Les pièces jointes restent uniquement sur cet appareil.' : ''}</p>}
      {ask && <div className="error" role="alert"><b>Des données existent déjà en ligne :</b> {countsText(ask.remoteCounts)}.<br />Elles ne viennent pas de cet appareil. Les remplacer par les données de cet appareil ({countsText(local)}) ?<div className="chips"><button className="danger" disabled={busy} onClick={() => go(ask.remoteRevision)}>Remplacer les données en ligne</button><button onClick={() => setAsk(null)}>Annuler</button></div></div>}
      {error && <p className="error" role="alert">{error}</p>}
      <div className="chips">
        {!cfg.enabled && !ask && <button className="primary" disabled={busy} onClick={() => go()}>{busy ? 'Transfert en cours…' : 'Transférer mes données'}</button>}
        {cfg.enabled && <button disabled={busy} onClick={() => engine?.runNow()}>Envoyer maintenant</button>}
        {cfg.enabled && syncStatus === 'conflict' && !ask && <button disabled={busy} onClick={() => go()}>Voir la version en ligne</button>}
      </div>
    </div>
  );
}

export function inviteUrl(token) { return location.origin + '/#invite=' + token; }
export function qrImage(text) { const q = qrcode(0, 'M'); q.addData(text); q.make(); return q.createDataURL(6, 8); }

export function MemberForm({ workspace, onSaved }) {
  const blank = { name: '', role: 'ouvrier', email: '', employeeId: '', projectIds: [] };
  const [form, setForm] = useState(blank);
  const [error, setError] = useState('');
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const toggle = (id) => set('projectIds', form.projectIds.includes(id) ? form.projectIds.filter((x) => x !== id) : [...form.projectIds, id]);
  return (
    <form className="team-member" onSubmit={async (e) => {
      e.preventDefault();
      try { await api('/api/users', { method: 'POST', body: form }); setForm(blank); setError(''); onSaved(); } catch (x) { setError(x.message); }
    }}>
      <h4><UserPlus /> Ajouter un membre</h4>
      <label>Nom<input required maxLength="80" value={form.name} onChange={(e) => set('name', e.target.value)} /></label>
      <label>Rôle<select value={form.role} onChange={(e) => set('role', e.target.value)}>{Object.entries(ROLES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
      <label>Adresse Gmail (facultatif)<input type="email" value={form.email} onChange={(e) => set('email', e.target.value)} /></label>
      {form.role !== 'direction' && !!workspace?.employees?.length && <label>Fiche dans l’équipe (nécessaire pour lui confier une caisse)<select value={form.employeeId} onChange={(e) => set('employeeId', e.target.value)}><option value="">Choisir…</option>{workspace.employees.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label>}
      {['chef', 'ouvrier'].includes(form.role) && !!workspace?.projects?.length && <div className="team-checks"><b>Chantiers autorisés</b>{workspace.projects.map((p) => <label key={p.id}><input type="checkbox" checked={form.projectIds.includes(p.id)} onChange={() => toggle(p.id)} />{p.name}</label>)}</div>}
      {error && <p className="error" role="alert">{error}</p>}
      <button className="primary wide" type="submit">Créer le compte</button>
    </form>
  );
}
function Reconnect({ onDone }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return <div className="team-member"><p>Votre connexion a expiré. Entrez votre code à 4 chiffres pour reprendre l’envoi de vos données.</p><PinPad title="" busy={busy} error={error} onDone={async (pin) => { setBusy(true); setError(''); try { await api('/api/auth/pin', { method: 'POST', body: { secret: read(DEVICE_KEY), pin } }); await onDone(); } catch (e) { setError(e.message); } finally { setBusy(false); } }} /></div>;
}
export function TeamAdmin({ getState, backupNow, engine, syncStatus }) {
  const [status, setStatus] = useState('loading');
  const [key, setKey] = useState('');
  const [users, setUsers] = useState([]);
  const [workspace, setWorkspace] = useState(null);
  const [invite, setInvite] = useState(null);
  const [error, setError] = useState('');
  const [meId, setMeId] = useState('');
  const load = async () => {
    try {
      const me = await api('/api/me');
      if (me.user.role !== 'direction') { setStatus('forbidden'); return; }
      setMeId(me.user.id);
      const [list, ws] = await Promise.all([api('/api/users'), api('/api/workspace')]);
      setUsers(list.users); setWorkspace(ws.data); setError(''); setStatus('ready');
    } catch (e) {
      if (e.status === 401) { setStatus('key'); return; }
      setError(e.message); setStatus('unavailable');
    }
  };
  useEffect(() => { load(); }, []);
  const openWithKey = async (e) => {
    e.preventDefault();
    try {
      await api('/api/setup', { method: 'POST', body: {}, headers: { Authorization: 'Bearer ' + key } });
      setKey(''); await load();
    } catch (x) { setError(x.message); }
  };
  const makeInvite = async (u) => {
    try { const r = await api(`/api/users/${u.id}/invite`, { method: 'POST' }); setInvite({ name: u.name, url: inviteUrl(r.token) }); setError(''); } catch (x) { setError(x.message); }
  };
  const setActive = async (u, active) => {
    if (!active && !confirm(`Couper immédiatement l’accès de ${u.name} ?`)) return;
    try { await api(`/api/users/${u.id}`, { method: 'PATCH', body: { active } }); if (!active) setInvite(null); await load(); } catch (x) { setError(x.message); }
  };
  return (
    <section>
      <h3>Équipe & accès</h3>
      {status === 'loading' && <p className="subtle">Vérification…</p>}
      {status === 'unavailable' && <p className="subtle">Service d’équipe indisponible pour le moment : {error}</p>}
      {status === 'forbidden' && <p className="subtle">Accès réservé à la direction.</p>}
      {status === 'key' && SAAS && read(DEVICE_KEY) && <Reconnect onDone={load} />}
      {status === 'key' && !(SAAS && read(DEVICE_KEY)) && <form onSubmit={openWithKey}><p className="subtle">Saisissez la clé privée Cloudflare pour ouvrir la gestion de l’équipe. Elle n’est pas conservée.</p><label>Clé privée<input type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} /></label>{error && <p className="error" role="alert">{error}</p>}<button className="secondary wide" type="submit" disabled={!key}>Ouvrir la gestion de l’équipe</button></form>}
      {status === 'ready' && <>
        <a className="secondary wide" href="/admin">Ouvrir le tableau de bord général</a>
        <TransferPanel getState={getState} backupNow={backupNow} engine={engine} syncStatus={syncStatus} onDone={load} />
        {users.map((u) => <div key={u.id} className={'team-member' + (u.active ? '' : ' off')}><b>{u.name}</b><br /><small>{ROLES[u.role]}{u.email ? ' · ' + u.email : ''}{['chef', 'ouvrier'].includes(u.role) ? ' · ' + u.projectIds.length + ' chantier(s)' : ''}{u.active ? '' : ' · Désactivé'}</small><div className="chips">{u.active && u.id !== meId && <button onClick={() => makeInvite(u)}><QrCode /> Inviter</button>}{u.role !== 'direction' && (u.active ? <button className="danger" onClick={() => setActive(u, false)}>Couper l’accès</button> : <button onClick={() => setActive(u, true)}>Réactiver</button>)}</div></div>)}
        {invite && <div className="qr-box"><b>Invitation de {invite.name}</b><p>À scanner une seule fois avec son téléphone. Valable 7 jours.</p><img src={qrImage(invite.url)} alt={'QR code d’invitation de ' + invite.name} /><code>{invite.url}</code><div className="chips"><button onClick={() => navigator.clipboard?.writeText(invite.url)}>Copier le lien</button><button onClick={() => setInvite(null)}>Masquer</button></div></div>}
        {error && <p className="error" role="alert">{error}</p>}
        <MemberForm workspace={workspace} onSaved={load} />
      </>}
    </section>
  );
}

// Choisit l'écran d'ouverture. L'application de la direction reste celle par défaut.
export function firstScreen() {
  const hash = location.hash || '';
  if (location.pathname === '/admin' || location.pathname === '/admin/') return { screen: 'admin' };
  const clean = () => history.replaceState(null, '', location.pathname);
  if (hash.startsWith('#suivi=')) return { screen: 'client', token: decodeURIComponent(hash.slice(7)) };
  if (hash.startsWith('#invite=')) { const token = decodeURIComponent(hash.slice(8)); clean(); return { screen: 'join', token }; }
  if (hash.startsWith('#connexion-refusee=')) { const reason = hash.slice(19); clean(); return { screen: 'member', reason }; }
  if (hash === '#connecte' || hash === '#connexion') { clean(); return { screen: 'member' }; }
  if (!hasOwnerData() && (read(DEVICE_KEY) || read(MEMBER_KEY))) return { screen: 'member' };
  return { screen: 'owner' };
}
