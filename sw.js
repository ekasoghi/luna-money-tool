/* Luna Money Tool — service worker
   Membuat aplikasi bisa dibuka tanpa internet setelah kunjungan pertama.
   Naikkan VERSION setiap kali Anda meng-upload versi baru index.html. */
const VERSION = "luna-v2.1.0";
const SHELL = ["./", "./index.html", "./config.js", "./manifest.webmanifest", "./icons/icon-192.png", "./icons/icon-512.png", "./icons/apple-touch-icon.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  // Jangan pernah cache panggilan API Supabase
  if (url.hostname.endsWith("supabase.co")) return;

  // Halaman aplikasi & config.js: ambil versi terbaru dulu, pakai cache saat offline
  const isConfig = url.origin === location.origin && url.pathname.endsWith("/config.js");
  if (req.mode === "navigate" || isConfig) {
    const key = isConfig ? "./config.js" : "./index.html";
    e.respondWith(
      fetch(req).then((res) => { if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(key, copy)); } return res; })
        .catch(() => caches.match(key))
    );
    return;
  }

  // Pustaka CDN, font, dan data OCR: cache dulu, perbarui di belakang
  e.respondWith(
    caches.match(req).then((hit) => {
      const net = fetch(req).then((res) => {
        if (res && (res.ok || res.type === "opaque")) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
        return res;
      }).catch(() => hit);
      return hit || net;
    })
  );
});
