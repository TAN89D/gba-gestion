// Nom et logo affichés. L'application réelle reste « GBA Gestion ».
// VITE_DEMO=1 : site de démonstration SoBara. VITE_SAAS=1 : site SoBara ouvert aux entreprises.
const env = import.meta.env || {};
export const DEMO = env.VITE_DEMO === '1';
export const SAAS = env.VITE_SAAS === '1';
export const BRAND = DEMO || SAAS
  ? { name: 'SoBara', logo: '/sobara-icon.svg', alt: 'SoBara' }
  : { name: 'GBA Gestion', logo: '/logo.jpg', alt: 'GBA' };
// Le logo de l'entreprise s'il a été ajouté, sinon celui de l'application.
export const logoOf = (settings) => (/^data:image\/(png|jpeg|webp);base64,/.test(settings?.logo || '') ? settings.logo : BRAND.logo);
