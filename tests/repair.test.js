import test from 'node:test';
import assert from 'node:assert/strict';
import{empty,apply,validate,repair,overdue}from'../src/domain.js';
import{load}from'../src/storage.js';

const save=(s,t,d)=>apply(s,{type:'save',table:t,data:d});
const lines=[{description:'Travaux',quantity:1,unitPrice:1000000}];
function setup(){let s=empty();s=save(s,'clients',{id:'a',name:'Client A'});s=save(s,'clients',{id:'b',name:'Client B'});s=save(s,'projects',{id:'p',name:'Chantier',clientId:'a',budget:0,contractAmount:0});return apply(s,{type:'invoice',data:{id:'i',clientId:'a',projectId:'p',date:'2026-01-01',lines}});}

test('un chantier réaffecté par erreur retrouve le client de ses documents',()=>{const s=setup();s.projects[0].clientId='b';assert.throws(()=>validate(structuredClone(s)),/appartenir/);const r=repair(structuredClone(s));assert.equal(r.projects[0].clientId,'a');assert.equal(validate(r),r)});
test('au lancement, ces données s’ouvrent sans perte',()=>{const s=setup();s.projects[0].clientId='b';globalThis.localStorage={getItem:()=>JSON.stringify(s)};const d=load();assert.equal(d.projects[0].clientId,'a');assert.equal(d.invoices.length,1)});
test('la réparation ne touche pas à des données saines',()=>{const s=setup(),before=JSON.stringify(s);assert.equal(JSON.stringify(repair(s)),before)});
test('si les documents ne s’accordent pas, rien n’est deviné',()=>{const s=setup();s.quotes.push({id:'q',clientId:'b',projectId:'p',lines});repair(s);assert.equal(s.projects[0].clientId,'a');assert.throws(()=>validate(s),/appartenir/)});
test('la réparation accepte un fichier incomplet sans planter',()=>{assert.deepEqual(repair({}),{})});
test('l’échéancier a priorité sur l’échéance globale de la facture',()=>{let s=empty();s=save(s,'clients',{id:'a',name:'A'});s=apply(s,{type:'invoice',data:{id:'i',clientId:'a',date:'2026-10-01',dueDate:'2026-11-01',lines}});s=save(s,'schedules',{invoiceId:'i',dueDate:'2026-11-01',amount:300000});s=save(s,'schedules',{invoiceId:'i',dueDate:'2026-12-01',amount:700000});const r=overdue(s,'2026-11-04');assert.equal(r[0].amount,300000)});
test('une échéance future évite la relance automatique à 30 jours',()=>{let s=empty();s=save(s,'clients',{id:'a',name:'A'});s=apply(s,{type:'invoice',data:{id:'i',clientId:'a',date:'2026-01-01',dueDate:'2026-12-01',lines}});assert.equal(overdue(s,'2026-06-01').length,0)});
