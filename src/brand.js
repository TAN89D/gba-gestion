// Nom et logo affichés. L'application réelle reste « GBA Gestion » ;
// le site de démonstration est construit avec VITE_DEMO=1 et porte le nom SoBara.
const env = import.meta.env || {};
export const DEMO = env.VITE_DEMO === '1';
export const BRAND = DEMO
  ? { name: 'SoBara', logo: '/sobara-icon.svg', alt: 'SoBara' }
  : { name: 'GBA Gestion', logo: '/logo.jpg', alt: 'GBA' };
