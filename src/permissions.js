import { TABLES } from './domain.js';
import { cashbox, heldBy } from './cashbox.js';

// Résumé des caisses confiées à ce compte (via sa fiche dans l'équipe) : montants et dernières sorties.
function ownCashboxes(state, user) {
  return heldBy(state, user.employeeId).map((a) => {
    const c = cashbox(state, a.id);
    const site = (id) => state.projects.find((p) => p.id === id)?.name || '';
    return {
      id: a.id, name: a.name, projectId: a.projectId || '', projectName: site(a.projectId),
      opening: c.opening, received: c.received, back: c.back, site: c.site, siteByCategory: c.siteByCategory,
      otherSites: c.otherSites, company: c.company, companyTotal: c.companyTotal, personal: c.personal, spent: c.spent, balance: c.balance,
      recent: c.out.slice(0, 40).map((r) => ({ id: r.id, date: r.date, label: r.label, amount: r.amount, scope: r.scope, category: r.category, site: r.scope === 'Chantier' ? site(r.projectId) : '' })),
    };
  });
}

export const ROLES = {
  direction: 'Direction',
  gestionnaire: 'Gestionnaire de chantier',
  chef: 'Chef de chantier',
  ouvrier: 'Ouvrier',
};

// Listes de champs autorisés : un champ non listé n'est jamais envoyé.
const pick = (row, keys) => Object.fromEntries(keys.filter((k) => k in row).map((k) => [k, row[k]]));
const live = (rows) => rows.filter((x) => !x.void);

const PROJECT_BASE = ['id', 'name', 'address', 'status', 'startDate', 'expectedEndDate'];
const FIELDS = {
  employees: ['id', 'name', 'phone', 'role', 'specialty'],
  suppliers: ['id', 'name', 'phone', 'email', 'address'],
  materials: ['id', 'description', 'category', 'unit', 'lastPrice', 'opening', 'threshold'],
  employeesChef: ['id', 'name', 'phone', 'role', 'specialty'],
  tasksChef: ['id', 'description', 'employeeId', 'projectId', 'status', 'startDate', 'expectedEndDate'],
  expenses: ['id', 'description', 'amount', 'scope', 'projectId', 'accountId', 'category', 'supplierId', 'method', 'date', 'notes'],
  tasks: ['id', 'description', 'employeeId', 'projectId', 'agreedAmount', 'status', 'startDate', 'expectedEndDate'],
  tasksWorker: ['id', 'description', 'projectId', 'agreedAmount', 'status', 'startDate', 'expectedEndDate'],
  paymentsWorker: ['id', 'taskId', 'projectId', 'amount', 'method', 'date'],
  teamPayments: ['id', 'taskId', 'employeeId', 'projectId', 'accountId', 'amount', 'method', 'date'],
  stockMoves: ['id', 'materialId', 'type', 'quantity', 'projectId', 'date', 'notes'],
  orders: ['id', 'number', 'supplierId', 'projectId', 'description', 'amount', 'date', 'expectedDate', 'status'],
  deliveries: ['id', 'number', 'orderId', 'supplierId', 'projectId', 'date', 'notes'],
  journal: ['id', 'projectId', 'date', 'kind', 'note'],
};

function blankView(state, role) {
  return {
    schema: state.schema,
    app: state.app,
    viewOnly: true,
    role,
    settings: pick(state.settings || {}, ['company']),
    ...Object.fromEntries(TABLES.map((t) => [t, []])),
  };
}

// Calcule ce qu'un compte a le droit de recevoir. Le serveur l'applique avant tout envoi.
export function viewFor(state, user) {
  if (user.role === 'direction') return state;
  const view = blankView(state, user.role);
  const assigned = new Set(user.projectIds || []);
  const onSite = (row) => assigned.has(row.projectId);
  const projects = state.projects.filter((p) => assigned.has(p.id));

  if (user.role === 'gestionnaire') {
    // Tous les chantiers, mais jamais le budget général ni le contrat : seulement le budget confié.
    const anySite = (row) => !!row.projectId;
    view.projects = state.projects.map((p) => pick(p, [...PROJECT_BASE, 'managerBudget']));
    view.employees = state.employees.map((x) => pick(x, FIELDS.employees));
    view.suppliers = state.suppliers.map((x) => pick(x, FIELDS.suppliers));
    view.materials = state.materials.map((x) => pick(x, FIELDS.materials));
    view.expenses = live(state.expenses).filter(anySite).map((x) => pick(x, FIELDS.expenses));
    view.tasks = state.tasks.filter(anySite).map((x) => pick(x, FIELDS.tasks));
    view.teamPayments = live(state.teamPayments).filter(anySite).map((x) => pick(x, FIELDS.teamPayments));
    view.stockMoves = state.stockMoves.filter(anySite).map((x) => pick(x, FIELDS.stockMoves));
    view.orders = state.orders.filter(anySite).map((x) => pick(x, FIELDS.orders));
    view.deliveries = state.deliveries.filter(anySite).map((x) => pick(x, FIELDS.deliveries));
    view.journal = state.journal.filter(anySite).map((x) => pick(x, FIELDS.journal));
    view.accounts = state.accounts.map((x) => pick(x, ['id', 'name']));
    view.cashboxes = ownCashboxes(state, user);
  } else if (user.role === 'chef') {
    // Suivi du terrain sur ses chantiers : tâches, équipe et journal, sans aucun montant.
    const tasks = state.tasks.filter(onSite);
    const crew = new Set(tasks.map((x) => x.employeeId));
    view.projects = projects.map((p) => pick(p, PROJECT_BASE));
    view.tasks = tasks.map((x) => pick(x, FIELDS.tasksChef));
    view.employees = state.employees.filter((x) => crew.has(x.id)).map((x) => pick(x, FIELDS.employeesChef));
    view.journal = state.journal.filter(onSite).map((x) => pick(x, FIELDS.journal));
    // Le chef voit les montants de sa propre caisse uniquement, jamais ceux du chantier.
    view.cashboxes = ownCashboxes(state, user);
  } else if (user.role === 'ouvrier') {
    // L'ouvrier voit toutes ses propres tâches et ce qui lui a été payé, sur tous ses chantiers.
    const own = user.employeeId ? state.tasks.filter((x) => x.employeeId === user.employeeId) : [];
    const ownIds = new Set(own.map((x) => x.id));
    const ownSites = new Set(own.map((x) => x.projectId));
    view.projects = state.projects.filter((p) => assigned.has(p.id) || ownSites.has(p.id)).map((p) => pick(p, PROJECT_BASE));
    view.tasks = own.map((x) => pick(x, FIELDS.tasksWorker));
    view.teamPayments = live(state.teamPayments).filter((x) => ownIds.has(x.taskId)).map((x) => pick(x, FIELDS.paymentsWorker));
    view.journal = state.journal.filter(onSite).map((x) => pick(x, FIELDS.journal));
  }
  return view;
}

// Phase 1 : seule la direction modifie les données. La saisie de l'équipe,
// avec validation, arrivera aux phases 3 et 4.
export const canWrite = (user) => user.role === 'direction';
export const canManageTeam = (user) => user.role === 'direction';
