// Activer ou couper les notifications « push » de ce téléphone.
const toBytes = (b64) => { const s = atob(b64.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (b64.length % 4)) % 4)); return Uint8Array.from(s, (c) => c.charCodeAt(0)); };
const isIphone = () => /iphone|ipad|ipod/i.test(navigator.userAgent);
const installed = () => window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;

export function pushSupport() {
  if (typeof window === 'undefined') return 'no';
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return isIphone() && !installed() ? 'install' : 'no';
  return Notification.permission === 'denied' ? 'denied' : 'yes';
}
export async function pushActive() {
  if (pushSupport() !== 'yes' || Notification.permission !== 'granted') return false;
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = await reg?.pushManager.getSubscription();
    if (!sub) return false;
    const res = await fetch('/api/push/subscribe', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(sub.toJSON()) });
    return res.ok;
  } catch { return false; }
}
export async function enablePush() {
  const support = pushSupport();
  if (support === 'install') throw Error('Sur iPhone : installez d’abord l’application (bouton Partager, puis « Sur l’écran d’accueil »), ouvrez-la depuis son icône, puis activez les alertes.');
  if (support === 'no') throw Error('Ce téléphone ou ce navigateur ne permet pas les alertes. Essayez avec Chrome.');
  if (support === 'denied') throw Error('Les alertes ont été refusées pour ce site. Autorisez-les dans les réglages du navigateur (Paramètres du site, puis Notifications).');
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw Error('Alertes non autorisées.');
  const reg = await navigator.serviceWorker.ready;
  const res = await fetch('/api/push/key', { credentials: 'same-origin' });
  if (!res.ok) throw Error('Connectez-vous d’abord, puis réessayez.');
  const { key } = await res.json();
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: toBytes(key) });
  const saved = await fetch('/api/push/subscribe', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(sub.toJSON()) });
  if (!saved.ok) throw Error('Activation impossible pour le moment. Réessayez.');
}
// À la déconnexion, ce téléphone ne doit plus recevoir les alertes de ce compte.
export async function disablePush() {
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    const sub = await reg?.pushManager.getSubscription();
    if (!sub) return;
    await fetch('/api/push/unsubscribe', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint: sub.endpoint }) }).catch(() => null);
    await sub.unsubscribe();
  } catch { /* rien à couper */ }
}
