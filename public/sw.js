// Pensieve's service worker: keeps the app's pages and code on the phone so it opens and studies
// offline. Card data and answers are handled by the app itself (src/components/offline.ts); this only
// caches what the browser loads.
//
// - Pages: from the network when possible (and saved), else the saved copy.
// - Built code and styles (/_next/static, names change with every deploy): saved copy first.
// - Icons, manifest and the like: the saved copy, refreshed in the background.
// - The API and other sites: never cached here.
// The app asks for every deck's study page to be saved after each sync ({type: "cache", urls}).

const PAGES = "pages-v1";
const STATIC = "static-v1";
const NAV_TIMEOUT_MS = 4000;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

const isHtml = (res) => (res.headers.get("content-type") || "").includes("text/html");

async function savePage(request, response) {
  // A redirect (e.g. to the login page) or an error isn't the page.
  if (response.ok && !response.redirected && isHtml(response)) {
    const cache = await caches.open(PAGES);
    await cache.put(new URL(request.url).pathname + new URL(request.url).search, response);
  }
}

async function savedPage(url) {
  const cache = await caches.open(PAGES);
  return (
    (await cache.match(url.pathname + url.search)) ||
    (await cache.match(url.pathname, { ignoreSearch: true })) ||
    (await cache.match("/"))
  );
}

function timeout(ms) {
  return new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms));
}

async function page(event) {
  const url = new URL(event.request.url);
  try {
    const response = await Promise.race([fetch(event.request), timeout(NAV_TIMEOUT_MS)]);
    event.waitUntil(savePage(event.request, response.clone()));
    return response;
  } catch {
    return (await savedPage(url)) || Response.error();
  }
}

async function staticFirst(request) {
  const cache = await caches.open(STATIC);
  const hit = await cache.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  if (response.ok) await cache.put(request, response.clone());
  return response;
}

async function refreshInBackground(event) {
  const cache = await caches.open(STATIC);
  const hit = await cache.match(event.request);
  const update = fetch(event.request)
    .then(async (response) => {
      if (response.ok) await cache.put(event.request, response.clone());
      return response;
    })
    .catch(() => undefined);
  if (hit) {
    event.waitUntil(update);
    return hit;
  }
  return (await update) || Response.error();
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname === "/sw.js") return;
  // Page data for in-app navigation: network only. If it fails, Next loads the page normally,
  // which the saved copy answers.
  if (request.headers.get("rsc") || url.searchParams.has("_rsc")) return;
  if (request.mode === "navigate") return event.respondWith(page(event));
  if (url.pathname.startsWith("/_next/static/")) return event.respondWith(staticFirst(request));
  event.respondWith(refreshInBackground(event));
});

// Save pages (and the code they load) so they open offline.
async function cachePages(urls) {
  const pages = await caches.open(PAGES);
  const statics = await caches.open(STATIC);
  for (const url of urls) {
    try {
      const response = await fetch(url, { credentials: "same-origin" });
      if (!response.ok || response.redirected || !isHtml(response)) continue;
      const html = await response.clone().text();
      await pages.put(url, response);
      const assets = new Set(html.match(/\/_next\/static\/[^"'\s)\\]+/g) || []);
      for (const asset of assets) {
        if (await statics.match(asset)) continue;
        const res = await fetch(asset).catch(() => undefined);
        if (res && res.ok) await statics.put(asset, res);
      }
    } catch {
      // Offline or a page that failed: try again next sync.
    }
  }
}

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "cache" && Array.isArray(event.data.urls)) {
    event.waitUntil(cachePages(event.data.urls));
  }
});
