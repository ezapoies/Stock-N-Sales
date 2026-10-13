const CACHE_NAME = "stock-n-sales-shell-v2";
const APP_SHELL = [
    "/",
    "/index.html",
    "/manifest.json",
    "/css/style.css",
    "/js/chart.umd.min.js",
    "/js/mobile-store.js",
    "/js/app.js",
    "/js/pwa.js",
    "/Logo.png",
    "/icons/app-icon-192.png",
    "/icons/app-icon-512.png",
    "/icons/app-icon-maskable-512.png"
];

self.addEventListener("install", event => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => cache.addAll(APP_SHELL))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener("activate", event => {
    event.waitUntil(
        caches.keys()
            .then(keys => Promise.all(
                keys
                    .filter(key => key.startsWith("stock-n-sales-") && key !== CACHE_NAME)
                    .map(key => caches.delete(key))
            ))
            .then(() => self.clients.claim())
    );
});

self.addEventListener("fetch", event => {
    const request = event.request;
    const url = new URL(request.url);
    if (request.method !== "GET" || url.origin !== self.location.origin) {
        return;
    }

    if (url.pathname.startsWith("/api/")) {
        return;
    }

    if (request.mode === "navigate") {
        event.respondWith(
            fetch(request)
                .then(response => {
                    if (response.ok) {
                        const copy = response.clone();
                        caches.open(CACHE_NAME).then(cache => cache.put("/", copy));
                    }
                    return response;
                })
                .catch(async () => {
                    const cached = await caches.match("/");
                    return cached || Response.error();
                })
        );
        return;
    }

    event.respondWith(
        caches.match(request)
            .then(cached => cached || fetch(request).then(response => {
                if (response.ok && response.type === "basic") {
                    const copy = response.clone();
                    caches.open(CACHE_NAME).then(cache => cache.put(request, copy));
                }
                return response;
            }))
    );
});
