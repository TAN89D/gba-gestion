// Installer l'application sur l'écran d'accueil du téléphone, en un geste.
import React, { useEffect, useState } from 'react';
import { DownloadSimple, X } from '@phosphor-icons/react';
import { BRAND } from './brand.js';

let deferred = null;
const listeners = new Set();
if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e; listeners.forEach((f) => f()); });
}
const HIDE_KEY = 'gba-installer-masque';
const installed = () => window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;
const isIphone = () => /iphone|ipad|ipod/i.test(navigator.userAgent);

export function InstallCard() {
  const [, refresh] = useState(0);
  const [hidden, setHidden] = useState(() => { try { return localStorage.getItem(HIDE_KEY) === '1'; } catch { return false; } });
  useEffect(() => { const f = () => refresh((n) => n + 1); listeners.add(f); return () => listeners.delete(f); }, []);
  if (hidden || installed() || (!deferred && !isIphone())) return null;
  const hide = () => { try { localStorage.setItem(HIDE_KEY, '1'); } catch { /* sans stockage */ } setHidden(true); };
  return <section className="install-card">
    <button type="button" className="install-close" aria-label="Masquer" onClick={hide}><X size={18} /></button>
    <b>Installer {BRAND.name} sur ce téléphone</b>
    {deferred
      ? <><small>Elle s’ouvrira comme une vraie application, même avec peu de réseau.</small><button type="button" className="primary" onClick={async () => { deferred.prompt(); await deferred.userChoice.catch(() => null); deferred = null; hide(); }}><DownloadSimple size={20} /> Installer</button></>
      : <small>Sur iPhone : touchez le bouton <b>Partager</b> (le carré avec une flèche), puis <b>« Sur l’écran d’accueil »</b>.</small>}
  </section>;
}
