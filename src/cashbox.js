import { active, balance, find, sum, projectStats } from './domain.js';

// Catégorie utilisée pour les paiements de l'équipe dans les répartitions.
export const PAY_CATEGORY = 'Paie ouvriers';

// Toutes les sorties d'argent : dépenses (chantier, entreprise, personnel) et paiements de l'équipe.
export function outflows(s) {
  return [
    ...active(s.expenses).map((e) => ({ id: e.id, table: 'expenses', date: e.date || '', amount: Number(e.amount) || 0, accountId: e.accountId, scope: e.scope || 'Chantier', projectId: e.scope === 'Chantier' || !e.scope ? e.projectId || '' : '', category: e.category || 'Autres', label: e.description || 'Dépense', by: e.enteredBy || '' })),
    ...active(s.teamPayments).map((p) => ({ id: p.id, table: 'teamPayments', date: p.date || '', amount: Number(p.amount) || 0, accountId: p.accountId, scope: 'Chantier', projectId: p.projectId || '', category: PAY_CATEGORY, label: find(s, 'tasks', p.taskId)?.description || 'Paiement équipe', by: p.enteredBy || '' })),
  ];
}

export const scopeName = (s, r) => (r.scope === 'Personnel' ? 'Dépenses personnelles' : r.scope === 'Entreprise' ? 'Entreprise (hors chantier)' : find(s, 'projects', r.projectId)?.name || 'Chantier');

function group(rows, key, name) {
  const map = new Map();
  for (const r of rows) {
    const k = key(r);
    const g = map.get(k) || { key: k, name: name(r), amount: 0, count: 0 };
    g.amount += r.amount; g.count++;
    map.set(k, g);
  }
  return [...map.values()].sort((a, b) => b.amount - a.amount);
}

// Dépenses d'une période (par défaut un seul jour), réparties par chantier, par catégorie et par caisse.
export function spending(s, from, to = from) {
  const rows = outflows(s).filter((r) => r.date >= from && r.date <= to).sort((a, b) => b.amount - a.amount);
  return {
    rows,
    total: sum(rows),
    bySite: group(rows, (r) => (r.scope === 'Chantier' ? 'p:' + r.projectId : r.scope), (r) => scopeName(s, r)),
    byCategory: group(rows, (r) => r.category, (r) => r.category),
    byAccount: group(rows, (r) => r.accountId, (r) => find(s, 'accounts', r.accountId)?.name || 'Caisse'),
  };
}

// Fiche d'une caisse : ce qu'elle a reçu, ce qui est parti pour son chantier, pour d'autres chantiers,
// pour l'entreprise (par catégorie) et en dépenses personnelles. Une caisse peut être négative :
// le responsable a alors avancé l'argent.
export function cashbox(s, id) {
  const account = find(s, 'accounts', id);
  if (!account) return null;
  const out = outflows(s).filter((r) => r.accountId === id);
  const cash = active(s.cashEntries).filter((c) => c.accountId === id);
  const given = sum(active(s.transfers).filter((t) => t.toId === id));
  const received = given + sum(cash.filter((c) => c.amount > 0)) + sum(active(s.payments).filter((p) => p.accountId === id));
  const back = sum(active(s.transfers).filter((t) => t.fromId === id)) - sum(cash.filter((c) => c.amount < 0));
  const ownSite = (r) => r.scope === 'Chantier' && (!account.projectId || r.projectId === account.projectId);
  const otherSites = out.filter((r) => r.scope === 'Chantier' && !ownSite(r));
  const company = out.filter((r) => r.scope === 'Entreprise');
  return {
    account,
    opening: Number(account.opening) || 0,
    given,
    received,
    back,
    site: sum(out.filter(ownSite)),
    siteByCategory: group(out.filter(ownSite), (r) => r.category, (r) => r.category),
    otherSites: group(otherSites, (r) => r.projectId, (r) => scopeName(s, r)),
    company: group(company, (r) => r.category, (r) => r.category),
    companyTotal: sum(company),
    personal: sum(out.filter((r) => r.scope === 'Personnel')),
    spent: sum(out),
    balance: balance(s, id),
    out: out.sort((a, b) => String(b.date).localeCompare(String(a.date))),
  };
}

// Où l'on dépense trop : chantiers au-delà de leur budget et caisses passées en négatif.
export function overspending(s) {
  const sites = s.projects.map((p) => {
    const v = projectStats(s, p.id);
    return { project: p, spent: v.forecast, budget: v.budget, over: v.budget > 0 ? v.forecast - v.budget : 0 };
  }).filter((x) => x.over > 0).sort((a, b) => b.over - a.over);
  const boxes = s.accounts.map((a) => ({ account: a, balance: balance(s, a.id) })).filter((x) => x.balance < 0).sort((a, b) => a.balance - b.balance);
  return { sites, boxes };
}

// Caisses tenues par une fiche de l'équipe (le chef de chantier ou le gestionnaire).
export const heldBy = (s, employeeId) => (employeeId ? s.accounts.filter((a) => a.holderId === employeeId) : []);
