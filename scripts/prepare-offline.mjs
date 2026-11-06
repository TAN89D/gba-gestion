import{readdir,writeFile}from'node:fs/promises';import{existsSync}from'node:fs';
// Le dossier construit est « dist » pour l'application, « dist-demo » pour la démonstration.
const dir=process.argv[2]||'dist';
const assets=await readdir(dir+'/assets');const base=['/','/index.html','/logo.jpg','/icon-192.png','/icon-512.png','/manifest.webmanifest','/sobara-icon.svg','/sobara-192.png','/sobara-512.png','/sobara.webmanifest'].filter(p=>p==='/'||existsSync(dir+p));const paths=[...base,...assets.map(x=>'/assets/'+x)];const version='gba-'+Date.now();
await writeFile(dir+'/sw.js',`const CACHE=${JSON.stringify(version)},FILES=${JSON.stringify(paths)};
self.addEventListener('install',e=>e.waitUntil(caches.open(CACHE).then(c=>c.addAll(FILES))));
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith('gba-')&&k!==CACHE).map(k=>caches.delete(k))))));
self.addEventListener('fetch',e=>{const u=new URL(e.request.url);if(e.request.method!=='GET'||u.origin!==location.origin||u.pathname.startsWith('/api/'))return;e.respondWith(caches.open(CACHE).then(async c=>{if(e.request.mode==='navigate'){try{return await fetch(e.request)}catch{return await c.match('/index.html')}}return await c.match(e.request)||fetch(e.request)}));});`);
