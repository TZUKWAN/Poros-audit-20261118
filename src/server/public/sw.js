const offlineCache = "poros-offline-v1";
const offlinePage = "/offline.html";
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(offlineCache).then((cache) => cache.addAll([offlinePage, "/icons/poros-192.png"])),
  );
});
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith("poros-offline-") && key !== offlineCache)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (
    url.origin !== self.location.origin ||
    url.pathname.startsWith("/api/") ||
    event.request.method !== "GET"
  )
    return;
  if (event.request.mode === "navigate") {
    event.respondWith(fetch(event.request).catch(() => caches.match(offlinePage)));
  } else if (url.pathname === "/icons/poros-192.png") {
    event.respondWith(fetch(event.request).catch(() => caches.match(event.request)));
  }
});
