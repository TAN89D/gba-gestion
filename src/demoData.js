// Entreprise fictive de la démonstration SoBara. Aucune donnée réelle.
// Les dates sont calculées à partir d'aujourd'hui pour que la démo paraisse toujours « vivante ».
import { empty, apply, validate } from './domain.js';

export const DEMO_SHARE_TOKEN = 'demo-suivi-villa-kati-2026';
export const DEMO_USERS = [
  { id: 'demo-direction', name: 'Patron (démo)', role: 'direction', employeeId: null, projectIds: [] },
  { id: 'demo-gestionnaire', name: 'Fatou Keïta', role: 'gestionnaire', employeeId: 'e-fatou', projectIds: [] },
  { id: 'demo-chef', name: 'Adama Traoré', role: 'chef', employeeId: 'e-adama', projectIds: ['p-villa', 'p-boutique'] },
  { id: 'demo-ouvrier', name: 'Moussa Diarra', role: 'ouvrier', employeeId: 'e-moussa', projectIds: ['p-villa'] },
];

export function demoCompany(now = new Date()) {
  const day = (n) => new Date(now.getTime() + n * 86400000).toISOString().slice(0, 10);
  let s = empty();
  const save = (table, data) => { s = apply(s, { type: 'save', table, data }); };
  const run = (type, data) => { s = apply(s, { type, data }); };
  s.settings = { ...s.settings, company: 'BTP DÉMO SARL', address: 'Bamako, Mali', phone: '+223 00 00 00 00', email: 'contact@exemple.com', website: '', quotePrefix: 'DEMO-D', invoicePrefix: 'DEMO-F', receiptPrefix: 'DEMO-R', footer: 'Données fictives de démonstration' };
  s.accounts = [{ id: 'main', name: 'Caisse entreprise', opening: 0 }];

  save('clients', { id: 'c-diallo', name: 'M. Diallo (vit à Paris)', phone: '+33 6 00 00 00 00', whatsapp: '+33600000000', address: 'Paris, France' });
  save('clients', { id: 'c-immo', name: 'Société Immobilière Fictive', phone: '+223 20 00 00 00', address: 'ACI 2000, Bamako' });
  save('clients', { id: 'c-coulibaly', name: 'Mme Coulibaly', phone: '+223 70 00 00 00', whatsapp: '+22370000000', address: 'Hippodrome, Bamako' });

  save('employees', { id: 'e-adama', name: 'Adama Traoré', role: 'Chef de chantier', phone: '+223 76 00 00 01' });
  save('employees', { id: 'e-fatou', name: 'Fatou Keïta', role: 'Gestionnaire', phone: '+223 76 00 00 02' });
  save('employees', { id: 'e-moussa', name: 'Moussa Diarra', role: 'Maçon', phone: '+223 76 00 00 03' });
  save('employees', { id: 'e-ibrahim', name: 'Ibrahim Koné', role: 'Ferrailleur', phone: '+223 76 00 00 04' });
  save('employees', { id: 'e-seydou', name: 'Seydou Sangaré', role: 'Électricien', phone: '+223 76 00 00 05' });

  save('suppliers', { id: 'f-quinc', name: 'Quincaillerie du Marché (fictive)', phone: '+223 66 00 00 00' });
  save('suppliers', { id: 'f-sable', name: 'Sable & Gravier Transport (fictif)', phone: '+223 65 00 00 00' });
  save('materials', { id: 'm-ciment', description: 'Ciment CPA 45', category: 'Gros œuvre', unit: 'sac', lastPrice: 5000, opening: 120, threshold: 50 });
  save('materials', { id: 'm-fer', description: 'Fer de 12', category: 'Gros œuvre', unit: 'barre', lastPrice: 4500, opening: 60, threshold: 80 });
  save('materials', { id: 'm-sable', description: 'Sable de rivière', category: 'Gros œuvre', unit: 'voyage', lastPrice: 60000, opening: 4, threshold: 2 });

  save('projects', { id: 'p-villa', name: 'Villa R+1 à Kati', clientId: 'c-diallo', address: 'Kati', contractAmount: 45000000, budget: 30000000, managerBudget: 3000000, startDate: day(-75), expectedEndDate: day(120), status: 'En cours', progress: 45, shareToken: DEMO_SHARE_TOKEN });
  save('projects', { id: 'p-immeuble', name: 'Immeuble R+3, ACI 2000', clientId: 'c-immo', address: 'ACI 2000, Bamako', contractAmount: 120000000, budget: 85000000, managerBudget: 5000000, startDate: day(-40), expectedEndDate: day(300), status: 'En cours', progress: 20 });
  save('projects', { id: 'p-boutique', name: 'Rénovation boutique Coulibaly', clientId: 'c-coulibaly', address: 'Hippodrome, Bamako', contractAmount: 6500000, budget: 4000000, startDate: day(-30), expectedEndDate: day(10), status: 'En cours', progress: 90 });

  // Devis puis factures par étapes (situations de travaux).
  save('quotes', { id: 'q-villa', clientId: 'c-diallo', projectId: 'p-villa', date: day(-90), validUntil: day(-60), subject: 'Construction villa R+1', status: 'Accepté', tax: 0, discount: 0, lines: [{ description: 'Gros œuvre', quantity: 1, unit: 'forfait', unitPrice: 30000000 }, { description: 'Second œuvre et finitions', quantity: 1, unit: 'forfait', unitPrice: 15000000 }] });
  save('quotes', { id: 'q-garage', clientId: 'c-coulibaly', date: day(-2), validUntil: day(28), subject: 'Extension garage', status: 'Envoyé', tax: 0, discount: 0, lines: [{ description: 'Dalle et murs du garage', quantity: 1, unit: 'forfait', unitPrice: 2800000 }] });
  run('invoice', { id: 'i-villa-1', clientId: 'c-diallo', projectId: 'p-villa', date: day(-60), dueDate: day(-45), tax: 0, discount: 0, lines: [{ description: 'Situation n°1 : travaux réalisés à 30 % (cumul)', quantity: 1, unit: 'forfait', unitPrice: 13500000 }] });
  run('invoice', { id: 'i-villa-2', clientId: 'c-diallo', projectId: 'p-villa', date: day(-8), dueDate: day(7), tax: 0, discount: 0, lines: [{ description: 'Situation n°2 : travaux réalisés à 45 % (cumul)', quantity: 1, unit: 'forfait', unitPrice: 6750000 }] });
  run('invoice', { id: 'i-immeuble-1', clientId: 'c-immo', projectId: 'p-immeuble', date: day(-40), dueDate: day(-30), tax: 0, discount: 0, lines: [{ description: 'Acompte au démarrage (20 %)', quantity: 1, unit: 'forfait', unitPrice: 24000000 }] });
  run('invoice', { id: 'i-boutique', clientId: 'c-coulibaly', projectId: 'p-boutique', date: day(-30), dueDate: day(-5), tax: 0, discount: 0, lines: [{ description: 'Rénovation complète de la boutique', quantity: 1, unit: 'forfait', unitPrice: 6500000 }] });
  run('payment', { id: 'pay-1', invoiceId: 'i-villa-1', accountId: 'main', amount: 13500000, method: 'Virement', reference: 'VIR-PARIS-001', date: day(-50) });
  run('payment', { id: 'pay-2', invoiceId: 'i-villa-2', accountId: 'main', amount: 4000000, method: 'Orange Money', reference: 'OM-48213', date: day(-3) });
  run('payment', { id: 'pay-3', invoiceId: 'i-immeuble-1', accountId: 'main', amount: 24000000, method: 'Virement', date: day(-35) });
  run('payment', { id: 'pay-4', invoiceId: 'i-boutique', accountId: 'main', amount: 4000000, method: 'Wave', reference: 'WAVE-7781', date: day(-20) });

  // Caisses confiées au chef de chantier et à la gestionnaire.
  save('accounts', { id: 'k-adama', name: 'Caisse Adama – Villa Kati', opening: 0, projectId: 'p-villa', holderId: 'e-adama' });
  save('accounts', { id: 'k-fatou', name: 'Caisse Fatou – Immeuble', opening: 0, projectId: 'p-immeuble', holderId: 'e-fatou' });
  run('transfer', { id: 'tr-1', fromId: 'main', toId: 'k-adama', amount: 1500000, date: day(-6), label: 'Budget Villa Kati' });
  run('transfer', { id: 'tr-2', fromId: 'main', toId: 'k-fatou', amount: 2000000, date: day(-10), label: 'Budget Immeuble' });

  const spend = (id, d) => save('expenses', { id, method: 'Espèces', ...d });
  spend('x-fer-villa', { description: 'Fer de 12 et de 10 (fondations)', amount: 8200000, scope: 'Chantier', projectId: 'p-villa', accountId: 'main', category: 'Matériaux', supplierId: 'f-quinc', method: 'Virement', date: day(-55) });
  spend('x-ciment-villa', { description: 'Ciment 600 sacs', amount: 3000000, scope: 'Chantier', projectId: 'p-villa', accountId: 'main', category: 'Matériaux', supplierId: 'f-quinc', method: 'Virement', date: day(-40) });
  spend('x-sable-villa', { description: 'Sable et gravier, 8 voyages', amount: 640000, scope: 'Chantier', projectId: 'p-villa', accountId: 'main', category: 'Transport', supplierId: 'f-sable', method: 'Orange Money', reference: 'OM-39120', date: day(-20) });
  spend('x-ciment-jour', { description: 'Ciment 50 sacs', amount: 250000, scope: 'Chantier', projectId: 'p-villa', accountId: 'k-adama', category: 'Matériaux', supplierId: 'f-quinc', date: day(0) });
  spend('x-gasoil-jour', { description: 'Gasoil bétonnière', amount: 35000, scope: 'Chantier', projectId: 'p-villa', accountId: 'k-adama', category: 'Carburant', date: day(0) });
  spend('x-repas-jour', { description: 'Repas de l’équipe', amount: 15000, scope: 'Chantier', projectId: 'p-villa', accountId: 'k-adama', category: 'Nourriture / divers', date: day(0) });
  spend('x-perso-jour', { description: 'Avance personnelle', amount: 20000, scope: 'Personnel', accountId: 'k-adama', category: 'Autres', date: day(0) });
  spend('x-grue-jour', { description: 'Location grue, 1 journée', amount: 750000, scope: 'Chantier', projectId: 'p-immeuble', accountId: 'k-fatou', category: 'Location matériel', method: 'Moov Money', reference: 'MOOV-5521', date: day(0) });
  spend('x-immeuble-terr', { description: 'Terrassement et fouilles', amount: 9500000, scope: 'Chantier', projectId: 'p-immeuble', accountId: 'main', category: 'Sous-traitance', method: 'Virement', date: day(-30) });
  spend('x-boutique-mat', { description: 'Carrelage, peinture et plâtre', amount: 3100000, scope: 'Chantier', projectId: 'p-boutique', accountId: 'main', category: 'Matériaux', method: 'Virement', date: day(-25) });
  spend('x-boutique-elec', { description: 'Câbles et tableau électrique', amount: 800000, scope: 'Chantier', projectId: 'p-boutique', accountId: 'main', category: 'Matériaux', method: 'Wave', reference: 'WAVE-6630', date: day(-12) });
  spend('x-loyer', { description: 'Loyer du bureau', amount: 300000, scope: 'Entreprise', accountId: 'main', category: 'Loyer', method: 'Virement', date: day(-5) });
  spend('x-courant', { description: 'Facture d’électricité du bureau', amount: 85000, scope: 'Entreprise', accountId: 'main', category: 'Énergie', method: 'Orange Money', date: day(0) });

  save('tasks', { id: 't-moussa', employeeId: 'e-moussa', projectId: 'p-villa', description: 'Maçonnerie du rez-de-chaussée', agreedAmount: 1200000, status: 'En cours', startDate: day(-45) });
  save('tasks', { id: 't-ibrahim', employeeId: 'e-ibrahim', projectId: 'p-immeuble', description: 'Ferraillage des poteaux', agreedAmount: 900000, status: 'En cours', startDate: day(-20) });
  save('tasks', { id: 't-seydou', employeeId: 'e-seydou', projectId: 'p-boutique', description: 'Installation électrique', agreedAmount: 300000, status: 'Terminé', startDate: day(-15) });
  run('teamPayment', { id: 'tp-1', taskId: 't-moussa', accountId: 'main', amount: 600000, method: 'Orange Money', date: day(-15) });
  run('teamPayment', { id: 'tp-2', taskId: 't-ibrahim', accountId: 'k-fatou', amount: 300000, method: 'Espèces', date: day(-2) });

  save('orders', { id: 'o-villa', supplierId: 'f-quinc', projectId: 'p-villa', description: 'Ciment : 100 sac ; Fer de 10 : 40 barre', amount: 680000, date: day(-1), expectedDate: day(2), status: 'Commandé' });
  save('journal', { id: 'j-1', projectId: 'p-villa', date: day(-60), kind: 'Réception', note: 'Fondations terminées et contrôlées.' });
  save('journal', { id: 'j-2', projectId: 'p-villa', date: day(-20), kind: 'Avancement', note: 'Murs du rez-de-chaussée montés à 100 %.' });
  save('journal', { id: 'j-3', projectId: 'p-villa', date: day(-2), kind: 'Avancement', note: 'Coffrage de la dalle du 1er étage en cours. Coulage prévu la semaine prochaine.' });
  save('journal', { id: 'j-4', projectId: 'p-immeuble', date: day(-7), kind: 'Avancement', note: 'Poteaux du sous-sol coulés.' });
  save('journal', { id: 'j-5', projectId: 'p-boutique', date: day(-1), kind: 'Avancement', note: 'Peinture terminée, reste la pose des luminaires.' });
  s.audit = [];
  return validate(s);
}
