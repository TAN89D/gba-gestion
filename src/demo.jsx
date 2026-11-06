// Écran d'accueil de la démonstration SoBara : on choisit un rôle et on essaie, sans compte ni code.
import React, { useState } from 'react';
import { Crown, HardHat, Wrench, Briefcase, Eye, ArrowsClockwise } from '@phosphor-icons/react';
import { BRAND, DEMO } from './brand.js';
import { writeSync } from './sync.js';
import { DEMO_SHARE_TOKEN } from './demoData.js';

const ROLE_KEY = 'sobara-demo-role';
const CLEAR = ['gba-web-v3', 'gba-sync', 'gba-member', 'gba-device', 'gba-logout-pending', 'gba-cloud-revision'];
export const demoRole = () => { try { return localStorage.getItem(ROLE_KEY) || ''; } catch { return ''; } };
const ROLES = [
  ['direction', 'Patron', 'Toute l’entreprise : caisses, chantiers, devis, factures, dépenses du jour.', Crown],
  ['chef', 'Chef de chantier', 'Sa caisse, ses dépenses, le pointage, les besoins de matériel.', HardHat],
  ['ouvrier', 'Ouvrier', 'Ses paiements, « Je suis arrivé », un problème, un besoin de matériel.', Wrench],
  ['gestionnaire', 'Gestionnaire', 'Les budgets confiés, les achats, la paie de l’équipe.', Briefcase],
  ['client', 'Client', 'Ce que voit le client : avancement, paiements, photos.', Eye],
];
export const ROLE_NAMES = Object.fromEntries(ROLES.map(([k, l]) => [k, l]));

async function post(path, body) {
  const r = await fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw Error(d.error || 'Démonstration indisponible.');
  return d;
}
// Ce code ne s'exécute que sur le site de démonstration (adresse et données séparées de l'application réelle).
const onlyDemo = () => { if (!DEMO) throw Error('Réservé au site de démonstration.'); };
function clearLocal() { onlyDemo(); for (const k of CLEAR) localStorage.removeItem(k); }

export async function enterDemo(role) {
  onlyDemo();
  if (role === 'client') { clearLocal(); localStorage.setItem(ROLE_KEY, 'client'); location.replace('/#suivi=' + DEMO_SHARE_TOKEN); location.reload(); return; }
  const r = await post('/api/demo/enter', { role });
  // On ne vide l'appareil qu'une fois l'entrée acceptée par le serveur de démonstration.
  clearLocal();
  if (role === 'direction') {
    localStorage.setItem('gba-web-v3', JSON.stringify(r.workspace.data));
    // La démo du patron est reliée à la base commune de la démo : ce qu'il fait, l'équipe le voit.
    writeSync({ enabled: true, revision: r.workspace.revision, syncedAt: r.workspace.data.updatedAt });
  } else localStorage.setItem('gba-member', '1');
  localStorage.setItem(ROLE_KEY, role);
  location.replace('/');
}
export async function leaveDemo() {
  onlyDemo();
  try { await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }); } catch { /* sans réseau */ }
  clearLocal();
  localStorage.removeItem(ROLE_KEY);
  location.replace('/');
}

export function DemoGate() {
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const go = async (role) => { setBusy(role); setError(''); try { await enterDemo(role); } catch (e) { setError(e.message); setBusy(''); } };
  return <main className="demo-gate">
    <img className="demo-logo" src={BRAND.logo} alt="" />
    <h1>SoBara</h1>
    <p className="demo-tagline">La gestion de chantier simple, pensée pour l’Afrique.</p>
    <p className="subtle">Choisissez qui vous voulez être. Tout est fictif : essayez librement, rien ne peut être cassé.</p>
    <div className="demo-roles">{ROLES.map(([k, label, text, Icon]) => <button key={k} type="button" disabled={!!busy} onClick={() => go(k)}><Icon size={34} /><span><b>{busy === k ? 'Ouverture…' : label}</b><small>{text}</small></span></button>)}</div>
    {error && <p className="error" role="alert">{error}</p>}
    <p className="subtle demo-note">Conseil : ouvrez « Ouvrier » sur un téléphone et « Patron » sur un autre, et regardez les informations circuler. La démonstration est remise à zéro chaque nuit.</p>
    <button type="button" className="text" disabled={!!busy} onClick={async () => { setBusy('reset'); try { await post('/api/demo/reset'); setError(''); alert('La démonstration est repartie de zéro.'); } catch (e) { setError(e.message); } setBusy(''); }}><ArrowsClockwise /> Remettre la démonstration à zéro</button>
  </main>;
}

export function DemoBar() {
  const role = demoRole();
  if (!role) return null;
  return <div className="demo-bar" role="note"><span>Démo · <b>{ROLE_NAMES[role] || role}</b></span><button type="button" onClick={leaveDemo}>Changer de rôle</button></div>;
}
