import{readdir,writeFile}from'node:fs/promises';
const assets=await readdir('dist/assets');const paths=['/','/index.html','/logo.jpg','/icon-192.png','/icon-512.png','/manifest.webmanifest',...assets.map(x=>'/assets/'+x)];const version='gba-'+Date.now();
await writeFile('dist/sw.js',`const CACHE=${JSON.stringify(version)},FILES=${JSON.stringify(paths)};
self.addEventListener('install',e=>e.waitUntil(caches.open(CACHE).then(c=>c.addAll(FILES))));
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith('gba-')&&k!==CACHE).map(k=>caches.delete(k))))));
self.addEventListener('fetch',e=>{const u=new URL(e.request.url);if(e.request.method!=='GET'||u.origin!==location.origin||u.pathname.startsWith('/api/'))return;e.respondWith(caches.open(CACHE).then(async c=>{if(e.request.mode==='navigate'){try{return await fetch(e.request)}catch{return await c.match('/index.html')}}return await c.match(e.request)||fetch(e.request)}));});`);
