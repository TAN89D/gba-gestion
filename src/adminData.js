import { active, balance, docTotal, due, overdue, paid, projectStats, stock, sum, today, totals } from './domain.js';

const named = (rows, id, key = 'name') => rows.find((x) => x.id === id)?.[key] || '';
const paidOnTask = (s, id) => sum(active(s.teamPayments).filter((p) => p.taskId === id));

export function overview(s, now = today()) {
  const t = totals(s);
  const expenses = sum(active(s.expenses));
  const teamPaid = sum(active(s.teamPayments));
  const teamAgreed = sum(s.tasks, 'agreedAmount');
  const teamDue = s.tasks.reduce((n, x) => n + Math.max(0, Number(x.agreedAmount || 0) - paidOnTask(s, x.id)), 0);
  const stats = s.projects.map((p) => ({ project: p, stats: projectStats(s, p.id) }));
  return {
    cash: t.balance,
    invoiced: t.invoiced,
    received: sum(active(s.payments)),
    toCollect: t.due,
    expenses,
    teamPaid,
    teamAgreed,
    teamDue,
    margin: stats.reduce((n, x) => n + x.stats.margin, 0),
    activeProjects: s.projects.filter((p) => !['Terminé', 'Suspendu'].includes(p.status)).length,
    accounts: s.accounts.map((a) => ({ id: a.id, name: a.name, balance: balance(s, a.id) })),
    late: overdue(s, now).map((x) => ({ id: x.invoice.id, number: x.invoice.number, client: named(s.clients, x.invoice.clientId), date: x.date, amount: x.amount })),
    overBudget: stats.filter((x) => x.stats.budget > 0 && x.stats.forecast > x.stats.budget).map((x) => ({ id: x.project.id, name: x.project.name, over: x.stats.forecast - x.stats.budget })),
    lowStock: s.materials.filter((m) => Number(m.threshold) > 0 && stock(s, m.id) <= Number(m.threshold)).map((m) => ({ id: m.id, name: m.description, stock: stock(s, m.id), unit: m.unit })),
    updatedAt: s.updatedAt || '',
  };
}
export function projectRows(s) {
  return s.projects.map((p) => {
    const v = projectStats(s, p.id);
    return {
      id: p.id, name: p.name, client: named(s.clients, p.clientId), status: p.status || '',
      contract: Number(p.contractAmount) || 0, billed: v.billed, received: v.received, toCollect: v.due,
      cost: v.cost, forecast: v.forecast, budget: v.budget, used: v.budget > 0 ? Math.round((v.forecast / v.budget) * 100) : null, margin: v.margin,
    };
  });
}
export function invoiceRows(s) {
  return s.invoices.map((i) => ({
    id: i.id, number: i.number, client: named(s.clients, i.clientId), project: named(s.projects, i.projectId), date: i.date,
    total: docTotal(i), paid: paid(s, i.id), left: due(s, i),
    status: i.void ? 'Annulée' : due(s, i) === 0 ? 'Payée' : paid(s, i.id) > 0 ? 'Partiellement payée' : 'À payer',
  })).reverse();
}
export function expenseRows(s) {
  return s.expenses.map((x) => ({
    id: x.id, date: x.date, description: x.description, project: named(s.projects, x.projectId), scope: x.scope || '', category: x.category || '',
    account: named(s.accounts, x.accountId), amount: Number(x.amount) || 0, void: !!x.void,
  })).reverse();
}
export function workerRows(s) {
  return s.employees.map((e) => {
    const tasks = s.tasks.filter((t) => t.employeeId === e.id);
    const agreed = sum(tasks, 'agreedAmount');
    const paidTotal = tasks.reduce((n, t) => n + paidOnTask(s, t.id), 0);
    return {
      id: e.id, name: e.name, role: e.role || '', agreed, paid: paidTotal,
      left: tasks.reduce((n, t) => n + Math.max(0, Number(t.agreedAmount || 0) - paidOnTask(s, t.id)), 0),
      tasks: tasks.map((t) => ({ id: t.id, description: t.description, project: named(s.projects, t.projectId), status: t.status || '', agreed: Number(t.agreedAmount) || 0, paid: paidOnTask(s, t.id) })),
    };
  });
}
const ACTIONS = { save: 'Enregistrement', void: 'Annulation', payment: 'Paiement', teamPayment: 'Paiement équipe', transfer: 'Transfert', cash: 'Apport / retrait', stock: 'Mouvement de stock', delivery: 'Réception', invoice: 'Facture', convert: 'Devis transformé en facture', linkProject: 'Lien avec un chantier', projectFromDocument: 'Chantier créé', settings: 'Paramètres', removeAttachment: 'Pièce jointe supprimée' };
const TABLE_LABELS = { clients: 'Client', projects: 'Chantier', quotes: 'Devis', invoices: 'Facture', payments: 'Paiement', expenses: 'Dépense', employees: 'Équipe', tasks: 'Tâche', teamPayments: 'Paiement équipe', suppliers: 'Fournisseur', materials: 'Matériau', stockMoves: 'Stock', orders: 'Commande', deliveries: 'Livraison', journal: 'Journal', accounts: 'Caisse', transfers: 'Transfert', cashEntries: 'Caisse', schedules: 'Échéance', attachments: 'Pièce jointe' };
export function activityRows(s, limit = 200) {
  return s.audit.slice(-limit).reverse().map((x) => ({
    id: x.id, date: x.date, action: ACTIONS[x.type] || x.type, target: TABLE_LABELS[x.table] || '', reason: x.reason || '',
  }));
}
