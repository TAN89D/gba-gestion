import {validate} from './src/domain.js';
const json=(data,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
export default {async fetch(request,env){const u=new URL(request.url);if(!u.pathname.startsWith('/api/'))return env.ASSETS.fetch(request);
 if(u.pathname!=='/api/backup')return json({error:'Adresse inconnue.'},404);
 if(!env.BACKUP_TOKEN||env.BACKUP_TOKEN.length<32||!env.DB)return json({error:'Sauvegarde cloud non configurée. Configurez DB et BACKUP_TOKEN.'},503);
 const secret=request.headers.get('Authorization')||'';const expected='Bearer '+env.BACKUP_TOKEN;const hash=async s=>new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s)));const [a,b]=await Promise.all([hash(secret),hash(expected)]);let diff=0;for(let i=0;i<a.length;i++)diff|=a[i]^b[i];if(diff)return json({error:'Clé privée incorrecte.'},401);
 if(request.headers.get('Origin')&&request.headers.get('Origin')!==u.origin)return json({error:'Origine refusée.'},403);
 try{if(request.method==='GET'){const row=await env.DB.prepare('SELECT revision,payload,updated_at FROM workspace WHERE id=1').first();return json(row?{revision:row.revision,data:JSON.parse(row.payload),updatedAt:row.updated_at}:{revision:0,data:null});}
 if(request.method!=='PUT')return json({error:'Méthode non autorisée.'},405);
 if(Number(request.headers.get('Content-Length')||0)>1800000)return json({error:'Sauvegarde cloud limitée à 1,8 Mo. Exportez localement les pièces volumineuses.'},413);
 const raw=await request.text();if(raw.length>1800000)return json({error:'Sauvegarde cloud limitée à 1,8 Mo. Exportez localement les pièces volumineuses.'},413);
 const {revision,data}=JSON.parse(raw);if(!Number.isInteger(revision)||revision<0)return json({error:'Révision invalide.'},400);validate(data);
 const payload=JSON.stringify(data),now=new Date().toISOString();let result;
 if(revision===0)result=await env.DB.prepare('INSERT OR IGNORE INTO workspace(id,revision,payload,updated_at) VALUES(1,1,?,?)').bind(payload,now).run();
 else result=await env.DB.prepare('UPDATE workspace SET revision=revision+1,payload=?,updated_at=? WHERE id=1 AND revision=?').bind(payload,now,revision).run();
 if(result.meta.changes!==1)return json({error:'Une autre version a été enregistrée. Exportez vos données locales puis restaurez la version distante avant de continuer.'},409);
 return json({revision:revision+1,updatedAt:now});
 }catch(e){if(e instanceof SyntaxError)return json({error:'JSON invalide.'},400);return json({error:e.message?.includes('SQL')?'Base cloud indisponible. Vérifiez la migration.':e.message||'Erreur de sauvegarde.'},400);}
}};
