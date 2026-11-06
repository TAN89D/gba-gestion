// Espace client : la page que le client ouvre avec son lien de suivi.
// Lecture seule, sans compte : avancement, argent de son contrat, nouvelles et photos.
import React, { useEffect, useState } from 'react';
import { HardHat, WhatsappLogo, CalendarBlank, Images, Notebook, Receipt } from '@phosphor-icons/react';
import { money, fmtDate } from './domain.js';
import { BRAND } from './brand.js';

export function ClientView({ token }) {
  const [view, setView] = useState(null);
  const [error, setError] = useState('');
  const [big, setBig] = useState(null);
  useEffect(() => {
    fetch('/api/suivi/' + encodeURIComponent(token), { credentials: 'omit' })
      .then(async (r) => { const d = await r.json().catch(() => ({})); if (!r.ok) throw Error(d.error || 'Suivi indisponible.'); setView(d); })
      .catch((e) => setError(e.message === 'Failed to fetch' ? 'Pas de connexion Internet. Réessayez plus tard.' : e.message));
  }, [token]);
  if (error) return <main className="client-page"><div className="client-head"><img src={BRAND.logo} alt="" /><b>Suivi de chantier</b></div><p className="error">{error}</p></main>;
  if (!view) return <main className="client-page"><p className="subtle">Chargement du suivi…</p></main>;
  const { company, project, money: m } = view;
  const paidPct = m.contract > 0 ? Math.min(100, Math.round((m.paid / m.contract) * 100)) : 0;
  const phone = String(company.phone || '').replace(/\D/g, '');
  return <main className="client-page">
    <div className="client-head"><img src={company.logo || BRAND.logo} alt="" /><div><b>{company.name}</b><small>Suivi de chantier pour {view.client}</small></div></div>
    <section className="client-hero">
      <div className="client-title"><HardHat size={30} /><div><h1>{project.name}</h1><small>{[project.address, project.status].filter(Boolean).join(' · ')}</small></div></div>
      <p className="client-big">{project.progress} %<small>des travaux réalisés</small></p>
      <div className="pbar big"><i style={{ width: Math.min(100, project.progress) + '%' }} /></div>
      <p className="client-dates"><CalendarBlank size={18} /> Début : {fmtDate(project.startDate) || '—'} · Fin prévue : {fmtDate(project.expectedEndDate) || '—'}</p>
    </section>
    <section className="client-card">
      <h2><Receipt size={22} /> Votre argent</h2>
      <div className="summary-grid">
        <div><small>Montant du contrat</small><b>{money(m.contract)}</b></div>
        <div><small>Déjà payé</small><b>{money(m.paid)}</b></div>
        <div><small>Facturé, reste à payer</small><b>{money(m.due)}</b></div>
        {m.retained > 0 && <div><small>Retenue de garantie (payée à la fin)</small><b>{money(m.retained)}</b></div>}
        <div><small>Reste du contrat à facturer</small><b>{money(Math.max(0, m.contract - m.billed))}</b></div>
      </div>
      <p className="subtle">Vous avez payé {paidPct} % du contrat. Les travaux sont réalisés à {project.progress} %.</p>
      {view.payments.length > 0 && <><h3>Vos paiements</h3>{view.payments.map((p, i) => <div className="row" key={i}><span className="rowtext"><b>{money(p.amount)}</b><small>{[fmtDate(p.date), p.method, p.number].filter(Boolean).join(' · ')}</small></span></div>)}</>}
    </section>
    <section className="client-card">
      <h2><Notebook size={22} /> Nouvelles du chantier</h2>
      {view.journal.length ? view.journal.map((j, i) => <div className="client-news" key={i}><small>{fmtDate(j.date)} · {j.kind}</small><p>{j.note}</p></div>) : <p className="subtle">Pas encore de nouvelles.</p>}
    </section>
    <section className="client-card">
      <h2><Images size={22} /> Photos</h2>
      {view.photos.length ? <div className="thumbs">{view.photos.map((p, i) => <button type="button" key={i} onClick={() => setBig(p)}><img src={p.url} alt={'Photo du ' + fmtDate(p.date)} /><small>{fmtDate(p.date)}</small></button>)}</div> : <p className="subtle">Les photos du chantier apparaîtront ici.</p>}
    </section>
    {phone && <a className="primary wide client-contact" href={'https://wa.me/' + phone + '?text=' + encodeURIComponent('Bonjour, je vous écris au sujet du chantier « ' + project.name + ' ».')} target="_blank" rel="noopener"><WhatsappLogo size={24} /> Écrire à l’entreprise sur WhatsApp</a>}
    <p className="subtle client-foot">Page de suivi fournie par {company.name}{BRAND.name !== company.name ? ' avec ' + BRAND.name : ''}. Elle se met à jour toute seule.</p>
    {big && <div className="modal-backdrop" onClick={() => setBig(null)}><img className="client-zoom" src={big.url} alt="Photo agrandie" /></div>}
  </main>;
}
