/* Draft Day service worker — offline resilience for bad draft-party wifi.
 *
 * Scope: /draftday/ only (the landing page stays plain).
 * - Navigations: network-first; offline serves the cached app shell.
 * - Hashed build assets (/assets/): immutable, cache-first.
 * - /api/rankings: network-first, falling back to the last good response.
 * - CSVs / manifest / icons: stale-while-revalidate.
 * - Cross-origin (api.sleeper.app) is left alone — the app caches that
 *   itself in localStorage.
 *
 * Bump VERSION to drop all cached entries on the next visit.
 */
const VERSION = "draftday-sw-v1";
const BASE = "/draftday/";

async function putInCache(request, response) {
  try {
    const cache = await caches.open(VERSION);
    await cache.put(request, response);
  } catch (e) {
    /* storage full or opaque response — skip caching */
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      .then((cache) => cache.addAll([BASE]))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin || !url.pathname.startsWith(BASE)) return;

  /* Navigations: fresh when online, cached shell when not */
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) putInCache(req, res.clone());
          return res;
        })
        .catch(async () => (await caches.match(req)) || caches.match(BASE))
    );
    return;
  }

  /* Hashed build assets: content-addressed, safe to serve from cache */
  if (url.pathname.startsWith(BASE + "assets/")) {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            if (res.ok) putInCache(req, res.clone());
            return res;
          })
      )
    );
    return;
  }

  /* Rankings API: live when online, last good response when not */
  if (url.pathname.startsWith(BASE + "api/")) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) putInCache(req, res.clone());
          return res;
        })
        .catch(async () => {
          const hit = await caches.match(req);
          return (
            hit ||
            new Response(
              JSON.stringify({
                error: "Offline — no cached rankings for this request.",
              }),
              {
                status: 503,
                headers: { "content-type": "application/json" },
              }
            )
          );
        })
    );
    return;
  }

  /* CSVs, manifest, icons: serve cache immediately, refresh in background */
  event.respondWith(
    caches.match(req).then((cached) => {
      const fromNet = fetch(req)
        .then((res) => {
          if (res.ok) putInCache(req, res.clone());
          return res;
        })
        .catch(
          () =>
            cached ||
            new Response("", { status: 504, statusText: "Offline" })
        );
      return cached || fromNet;
    })
  );
});
