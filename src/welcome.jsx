// Accueil du site SoBara : une entreprise crée son espace en une minute, ou un membre rejoint son équipe.
import React, { useState } from 'react';
import { Buildings, QrCode, ArrowLeft, CheckCircle } from '@phosphor-icons/react';
import { BRAND } from './brand.js';
import { writeSync } from './sync.js';
import { InstallCard } from './install.jsx';

export function Welcome() {
  const [step, setStep] = useState('choice');
  const [form, setForm] = useState({ company: '', name: '', phone: '', pin: '', pin2: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const submit = async (e) => {
    e.preventDefault();
    setError('');
    if (!/^\d{4}$/.test(form.pin)) { setError('Le code doit avoir 4 chiffres.'); return; }
    if (form.pin !== form.pin2) { setError('Les deux codes sont différents.'); return; }
    setBusy(true);
    try {
      const res = await fetch('/api/companies', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ company: form.company, name: form.name, phone: form.phone, pin: form.pin }) });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw Error(d.error || 'Inscription impossible pour le moment.');
      // Les données de l'entreprise vivent sur ce téléphone et partent toutes seules vers son espace en ligne.
      localStorage.setItem('gba-web-v3', JSON.stringify(d.workspace.data));
      writeSync({ enabled: true, revision: d.workspace.revision, syncedAt: d.workspace.data.updatedAt, companyId: d.user.companyId });
      localStorage.setItem('gba-device', d.deviceSecret);
      location.replace('/');
    } catch (x) { setError(x.message === 'Failed to fetch' ? 'Pas de connexion Internet. Réessayez.' : x.message); setBusy(false); }
  };
  return <main className="demo-gate welcome">
    <img className="demo-logo" src={BRAND.logo} alt="" />
    <h1>SoBara</h1>
    <p className="demo-tagline">La gestion de chantier simple, pensée pour l’Afrique.</p>
    {step === 'choice' && <>
      <ul className="welcome-points">{['Caisses des chefs de chantier et dépenses du jour', 'Devis, factures, situations de travaux', 'Pointage, photos et besoins de matériel de l’équipe', 'Un lien pour que vos clients suivent leur chantier'].map((t) => <li key={t}><CheckCircle size={22} weight="fill" />{t}</li>)}</ul>
      <div className="demo-roles">
        <button type="button" onClick={() => setStep('signup')}><Buildings size={34} /><span><b>Créer l’espace de mon entreprise</b><small>Gratuit pour commencer. Vous ajouterez votre logo et votre équipe ensuite.</small></span></button>
        <button type="button" onClick={() => setStep('join')}><QrCode size={34} /><span><b>Je fais partie d’une équipe</b><small>Chef de chantier, gestionnaire ou ouvrier : rejoignez votre entreprise.</small></span></button>
      </div>
      <InstallCard />
    </>}
    {step === 'join' && <div className="welcome-box">
      <button type="button" className="member-back" onClick={() => setStep('choice')}><ArrowLeft size={20} /> Retour</button>
      <h2>Rejoindre mon équipe</h2>
      <p>Demandez à votre patron de vous inviter : dans SoBara, il ouvre <b>Paramètres → Équipe & accès</b>, crée votre compte et touche <b>« Inviter »</b>.</p>
      <p>Scannez ensuite le code QR qu’il vous montre avec l’appareil photo de ce téléphone, puis choisissez votre code à 4 chiffres.</p>
    </div>}
    {step === 'signup' && <form className="welcome-box member-form" onSubmit={submit}>
      <button type="button" className="member-back" onClick={() => setStep('choice')}><ArrowLeft size={20} /> Retour</button>
      <h2>Mon entreprise</h2>
      <label>Nom de l’entreprise<input required maxLength="80" value={form.company} onChange={(e) => set('company', e.target.value)} placeholder="Ex. : Bâtiments du Sahel SARL" /></label>
      <label>Votre nom<input required maxLength="80" value={form.name} onChange={(e) => set('name', e.target.value)} /></label>
      <label>Téléphone (facultatif)<input type="tel" maxLength="30" value={form.phone} onChange={(e) => set('phone', e.target.value)} /></label>
      <label>Choisissez un code à 4 chiffres<input required inputMode="numeric" type="password" maxLength="4" value={form.pin} onChange={(e) => set('pin', e.target.value.replace(/\D/g, ''))} /></label>
      <label>Répétez le code<input required inputMode="numeric" type="password" maxLength="4" value={form.pin2} onChange={(e) => set('pin2', e.target.value.replace(/\D/g, ''))} /></label>
      <p className="subtle">Ce code vous reconnecte si votre session expire. Notez-le. Vos données restent sur ce téléphone et sont copiées dans votre espace en ligne.</p>
      {error && <p className="error" role="alert">{error}</p>}
      <button className="primary wide" type="submit" disabled={busy}>{busy ? 'Création…' : 'Créer mon espace'}</button>
    </form>}
  </main>;
}
