// The Point of Sale's own worker (Ferrum docs/plan/apps-ui.md §12.5), served at /pos/sw.js from
// this release: the till opens without a connection. It keeps the last till page the server sent
// (with its bootstrap) and the files pages load — this release's, the platform's runtime and theme
// — and answers from them only when the network cannot. It never answers the API: the till keeps
// what it could not send itself. Its caches are named "ferrum:pos:…", so the platform's worker
// that replaces this one when the person signs out, or may no longer use the app, clears them.

const PAGE = "ferrum:pos:page";
const FILES = "ferrum:pos:files";
// The server's responses vary by the request's origin and encoding; the till's page and files are
// the same whoever asks, and a request the page makes rarely carries what the warm-up's did.
const ANY = { ignoreVary: true };

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(warm().catch(() => {}));
});
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  const scope = new URL(self.registration.scope).pathname;
  if (req.mode === "navigate") {
    // The till's own page; the records pages need the server anyway.
    if (url.pathname === scope || `${url.pathname}/` === scope) event.respondWith(page(req, scope));
    return;
  }
  if (url.pathname.startsWith("/_ui/") || url.pathname.startsWith("/_shell/")) event.respondWith(file(req, url));
});

/** The till's page and the files it names, kept at once: the page that registered this worker
 *  loaded them before the worker could see them. */
async function warm() {
  const scope = new URL(self.registration.scope).pathname;
  const res = await fetch(scope, { credentials: "same-origin" });
  if (!res.ok || res.redirected || !(res.headers.get("content-type") || "").includes("text/html")) return;
  const html = await res.clone().text();
  await (await caches.open(PAGE)).put(scope, res);
  const cache = await caches.open(FILES);
  const urls = new Set([...html.matchAll(/(?:src|href)="(\/_(?:ui|shell)\/[^"]+)"/g)].map((m) => m[1]));
  await Promise.all([...urls].map((u) => cache.add(u).catch(() => {})));
}

/** The network's page, kept when it is the till's (not a sign-in page it was sent to); the kept
 *  one when the network fails. */
async function page(req, scope) {
  try {
    const res = await fetch(req);
    if (res.ok && !res.redirected && (res.headers.get("content-type") || "").includes("text/html")) {
      const cache = await caches.open(PAGE);
      await cache.put(scope, res.clone());
      void prune(await res.clone().text());
    }
    return res;
  } catch (e) {
    const kept = await (await caches.open(PAGE)).match(scope, ANY);
    if (kept) return kept;
    throw e;
  }
}

/** A release's files and the theme are named by their contents: from the cache first. The
 *  platform's other files change in place: from the network, the cache when it fails. */
async function file(req, url) {
  const cache = await caches.open(FILES);
  const named = url.pathname.startsWith("/_ui/") || url.pathname.startsWith("/_shell/theme/");
  if (named) {
    const hit = await cache.match(req, ANY);
    if (hit) return hit;
  }
  try {
    const res = await fetch(req);
    if (res.ok) await cache.put(req, res.clone());
    return res;
  } catch (e) {
    const hit = await cache.match(req, ANY);
    if (hit) return hit;
    throw e;
  }
}

/** Forgets the files of releases and themes the kept page no longer loads. */
async function prune(html) {
  const used = new Set([...html.matchAll(/\/_(?:ui\/[a-z0-9-]+\/[0-9a-f]{64}|shell\/theme\/[0-9a-f]+\.css)/g)].map((m) => m[0]));
  if (!used.size) return;
  const cache = await caches.open(FILES);
  for (const req of await cache.keys()) {
    const path = new URL(req.url).pathname;
    const release = path.match(/^\/_ui\/[a-z0-9-]+\/[0-9a-f]{64}/)?.[0];
    const theme = path.match(/^\/_shell\/theme\/[0-9a-f]+\.css$/)?.[0];
    if ((release && !used.has(release)) || (theme && !used.has(theme))) await cache.delete(req);
  }
}
