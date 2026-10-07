import {empty,validate} from './domain.js';
const KEY='gba-web-v3';
export function load(){let raw=localStorage.getItem(KEY);return raw?validate(JSON.parse(raw)):empty();}
export function persist(s){const raw=JSON.stringify(s);if(raw.length>4200000)throw Error('Sauvegarde locale presque pleine. Exportez vos données et réduisez les pièces jointes.');localStorage.setItem(KEY,raw);}
export function download(name,text,type='application/json'){const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([text],{type}));a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);}
export const backup=s=>download('GBA_Sauvegarde_'+new Date().toISOString().replace(/[:.]/g,'-')+'.json',JSON.stringify(s,null,2));
export function csv(s){const rows=[['Date','Type','Désignation','Chantier','Caisse','Montant FCFA']];for(const t of ['payments','expenses','teamPayments','cashEntries'])for(const x of s[t].filter(x=>!x.void))rows.push([x.date,t,x.description||x.label||x.number||'',s.projects.find(p=>p.id===x.projectId)?.name||'',s.accounts.find(a=>a.id===x.accountId)?.name||'',x.amount]);const cell=x=>'"'+String(x??'').replace(/^[=+@-]/,"'$&").replaceAll('"','""')+'"';download('GBA_Mouvements.csv','\uFEFF'+rows.map(r=>r.map(cell).join(';')).join('\r\n'),'text/csv;charset=utf-8');}
