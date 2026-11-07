import{readdir,writeFile}from'node:fs/promises';import{existsSync}from'node:fs';
// Le dossier construit est « dist » pour l'application, « dist-demo » ou « dist-sobara » pour SoBara.
const dir=process.argv[2]||'dist';
const assets=await readdir(dir+'/assets');const base=['/','/index.html','/logo.jpg','/icon-192.png','/icon-512.png','/manifest.webmanifest','/sobara-icon.svg','/sobara-192.png','/sobara-512.png','/sobara.webmanifest','/sobara-app.webmanifest'].filter(p=>p==='/'||existsSync(dir+p));const paths=[...base,...assets.map(x=>'/assets/'+x)];const version='gba-'+Date.now();
const icon=dir==='dist'?'/icon-192.png':'/sobara-192.png';
await writeFile(dir+'/sw.js',`const CACHE=${JSON.stringify(version)},FILES=${JSON.stringify(paths)},ICON=${JSON.stringify(icon)};
self.addEventListener('install',e=>e.waitUntil(caches.open(CACHE).then(c=>c.addAll(FILES))));
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith('gba-')&&k!==CACHE).map(k=>caches.delete(k))))));
self.addEventListener('fetch',e=>{const u=new URL(e.request.url);if(e.request.method!=='GET'||u.origin!==location.origin||u.pathname.startsWith('/api/'))return;e.respondWith(caches.open(CACHE).then(async c=>{if(e.request.mode==='navigate'){try{return await fetch(e.request)}catch{return await c.match('/index.html')}}return await c.match(e.request)||fetch(e.request)}));});
// Notification push : le message est vide ; le téléphone lit lui-même la dernière nouveauté avec sa connexion.
self.addEventListener('push',e=>e.waitUntil((async()=>{let title='Nouvelle notification',body='Ouvrez l’application pour voir les nouveautés.',tag='gba-push',count=0;
 try{const r=await fetch('/api/notifications',{credentials:'same-origin'});if(r.ok){const d=await r.json();const x=d.items&&d.items[0];if(x){title=x.title;body=x.text||'';tag=x.id}count=(d.items||[]).length}}catch{}
 try{if(count&&self.navigator.setAppBadge)await self.navigator.setAppBadge(Math.min(count,99))}catch{}
 await self.registration.showNotification(title,{body,tag,icon:ICON,badge:ICON,renotify:true,vibrate:[200,100,200],data:{url:'/'}});})()));
self.addEventListener('notificationclick',e=>{e.notification.close();e.waitUntil((async()=>{const all=await self.clients.matchAll({type:'window',includeUncontrolled:true});for(const c of all){if('focus'in c)return c.focus()}return self.clients.openWindow((e.notification.data&&e.notification.data.url)||'/')})())});`);
