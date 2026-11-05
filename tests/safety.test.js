import test from 'node:test';
import assert from 'node:assert/strict';
import{empty,apply,validate,demo}from'../src/domain.js';
import{load}from'../src/storage.js';
import{printDoc}from'../src/print.js';

const save=(s,t,d)=>apply(s,{type:'save',table:t,data:d});
function setup(){let s=empty();s=save(s,'clients',{id:'c',name:'Client A'});s=save(s,'clients',{id:'d',name:'Client B'});s=save(s,'projects',{id:'p',name:'Chantier',clientId:'c',budget:0,contractAmount:0});return s;}
function memoryStorage(value){return{getItem:()=>value};}
function printed(s,doc,type){let html='';globalThis.window={open:()=>({document:{write:h=>{html=h},close(){}}})};globalThis.location={origin:'https://exemple.test'};printDoc(s,doc,type);return html;}

test('le client d’un chantier lié à un document ne peut pas changer',()=>{let s=save(setup(),'quotes',{id:'q',clientId:'c',projectId:'p',lines:[{description:'Travaux',quantity:1,unitPrice:1000}]});assert.throws(()=>save(s,'projects',{id:'p',name:'Chantier',clientId:'d',budget:0,contractAmount:0}),/client ne peut pas être changé/);assert.equal(validate(s),s)});
test('le client d’un chantier sans document peut encore changer',()=>{let s=save(setup(),'projects',{id:'p',name:'Chantier',clientId:'d',budget:0,contractAmount:0});assert.equal(s.projects[0].clientId,'d');assert.equal(validate(s),s)});
test('modifier un chantier sans changer de client reste possible',()=>{let s=save(setup(),'quotes',{id:'q',clientId:'c',projectId:'p',lines:[{description:'Travaux',quantity:1,unitPrice:1000}]});s=save(s,'projects',{id:'p',name:'Nouveau nom',clientId:'c',budget:0,contractAmount:0});assert.equal(s.projects[0].name,'Nouveau nom')});
test('des données illisibles restent récupérables',()=>{const raw=JSON.stringify({schema:3,app:'autre'});globalThis.localStorage=memoryStorage(raw);assert.throws(load,e=>e.raw===raw)});
test('sans données enregistrées, l’application démarre vide',()=>{globalThis.localStorage=memoryStorage(null);assert.equal(load().clients.length,0)});
test('des données valides sont rechargées telles quelles',()=>{const d=demo();globalThis.localStorage=memoryStorage(JSON.stringify(d));assert.equal(load().invoices[0].id,'i1')});
test('un reçu affiche le montant même avec des lignes parasites déjà enregistrées',()=>{const d=demo(),html=printed(d,{...d.payments[0],lines:[{description:'',quantity:1,unit:'forfait',unitPrice:0}]},'Reçu de paiement');assert.match(html,/Montant reçu/);assert.doesNotMatch(html,/Total HT/)});
test('une facture imprime toujours ses lignes',()=>{const d=demo(),html=printed(d,d.invoices[0],'Facture');assert.match(html,/Aménagement intérieur/);assert.match(html,/Total HT/)});
test('un reçu annulé est marqué comme tel',()=>{const d=demo(),html=printed(d,{...d.payments[0],void:true,voidReason:'Erreur'},'Reçu de paiement');assert.match(html,/ANNULÉ : Erreur/)});
