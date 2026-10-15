// Modo sin conexión: la app se sirve desde la caché si no hay internet,
// y se actualiza sola cuando hay conexión.
const CACHE = "pichanga-v6";
const APP = ["./", "./index.html", "./manifest.webmanifest", "./icons/icon-192.png", "./icons/icon-512.png", "./icons/apple-touch-icon.png"];
const ESPERA_RED = 3000; // con señal débil, pasados 3 s se abre la copia guardada

// Solo la página de la app (/ y /index.html) puede reemplazar la copia offline
const RAIZ = new URL("./", self.location).pathname;
const esApp = (url) => url.pathname === RAIZ || url.pathname === RAIZ + "index.html";

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(APP)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  // Solo se borran las versiones antiguas de esta app: en github.io el origen se comparte con otros proyectos
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k.startsWith("pichanga-") && k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  const fonts = url.host === "fonts.googleapis.com" || url.host === "fonts.gstatic.com";
  if (url.origin !== location.origin && !fonts) return;

  if (req.mode === "navigate") {
    // La red y la caché compiten: gana la red si responde bien en menos de 3 s.
    // Nunca se guarda una página de error (404/5xx), una redirección ni otra página del sitio.
    let guardar = Promise.resolve();
    const red = fetch(req).then((r) => {
      if (r.ok && r.type === "basic" && !r.redirected && esApp(url)) {
        const copia = r.clone();
        guardar = caches.open(CACHE).then((c) => c.put("./index.html", copia));
      }
      return r;
    });
    e.waitUntil(red.then(() => guardar, () => {}));
    const copia = () => caches.open(CACHE).then((c) => c.match("./index.html"));
    const timeout = new Promise((ok) => setTimeout(ok, ESPERA_RED, "timeout"));
    const app = esApp(url);
    e.respondWith(Promise.race([red, app ? timeout : red]).then(
      async (r) => {
        if (r === "timeout") return (await copia()) || red;
        if (!r.ok && app) return (await copia()) || r;
        return r;
      },
      async () => (await copia()) || Response.error()
    ));
    return;
  }

  // Archivos: primero la caché y se actualiza en segundo plano (solo con respuestas válidas)
  let guardar = Promise.resolve();
  const red = fetch(req).then((r) => {
    if (r.ok || (fonts && r.type === "opaque")) {
      const copia = r.clone();
      guardar = caches.open(CACHE).then((c) => c.put(req, copia));
    }
    return r;
  });
  e.waitUntil(red.then(() => guardar, () => {}));
  e.respondWith(caches.open(CACHE).then((c) => c.match(req)).then((hit) => hit || red));
});
