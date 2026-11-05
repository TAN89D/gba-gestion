import { TABLES } from './domain.js';

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
    view.projects = projects.map((p) => pick(p, [...PROJECT_BASE, 'budget']));
    view.employees = state.employees.map((x) => pick(x, FIELDS.employees));
    view.suppliers = state.suppliers.map((x) => pick(x, FIELDS.suppliers));
    view.materials = state.materials.map((x) => pick(x, FIELDS.materials));
    view.expenses = live(state.expenses).filter(onSite).map((x) => pick(x, FIELDS.expenses));
    view.tasks = state.tasks.filter(onSite).map((x) => pick(x, FIELDS.tasks));
    view.teamPayments = live(state.teamPayments).filter(onSite).map((x) => pick(x, FIELDS.teamPayments));
    view.stockMoves = state.stockMoves.filter(onSite).map((x) => pick(x, FIELDS.stockMoves));
    view.orders = state.orders.filter(onSite).map((x) => pick(x, FIELDS.orders));
    view.deliveries = state.deliveries.filter(onSite).map((x) => pick(x, FIELDS.deliveries));
    view.journal = state.journal.filter(onSite).map((x) => pick(x, FIELDS.journal));
    view.accounts = state.accounts.map((x) => pick(x, ['id', 'name']));
  } else if (user.role === 'chef') {
    // Suivi du terrain sur ses chantiers : tâches, équipe et journal, sans aucun montant.
    const tasks = state.tasks.filter(onSite);
    const crew = new Set(tasks.map((x) => x.employeeId));
    view.projects = projects.map((p) => pick(p, PROJECT_BASE));
    view.tasks = tasks.map((x) => pick(x, FIELDS.tasksChef));
    view.employees = state.employees.filter((x) => crew.has(x.id)).map((x) => pick(x, FIELDS.employeesChef));
    view.journal = state.journal.filter(onSite).map((x) => pick(x, FIELDS.journal));
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
