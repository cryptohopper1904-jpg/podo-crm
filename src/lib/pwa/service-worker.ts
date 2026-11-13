import { classifyRequest } from "./sw-rules";

/** Präfix aller Caches dieser App – beim Aktivieren werden alle anderen Versionen gelöscht */
export const SW_CACHE_PREFIX = "podo-static-";
export const OFFLINE_PATH = "/offline";

/** Cache-Name je Build-Version (Version aus next.config.ts → PODO_APP_VERSION) */
export const swCacheName = (version: string) => `${SW_CACHE_PREFIX}${version.replace(/[^a-zA-Z0-9._-]/g, "")}`;

/**
 * Quelltext des Service Workers (ausgeliefert von src/app/sw.js/route.ts). Bewusst klein und ohne Bibliothek:
 * - install: Offline-Seite + deren CSS/JS (aus /_next/static) vorab speichern. Die Offline-Seite wird ohne Cookies
 *   geladen und enthält keine Praxisdaten.
 * - activate: alte Caches löschen. (Kein Navigation-Preload: Seiten, die der SW nicht abfängt, würden sonst doppelt geladen.)
 * - fetch: Regeln aus classifyRequest (src/lib/pwa/sw-rules.ts) – nur statische Dateien cache-first, Seiten nur
 *   aus dem Netz mit Offline-Seite als Ersatz, alles andere unberührt.
 * - Aktualisierung: eine neue Version wartet, bis die Nutzer:in „Neu laden“ bestätigt (Nachricht SKIP_WAITING,
 *   siehe src/components/pwa/pwa-client.tsx) – kein ungefragtes Neuladen mitten in einer Dokumentation.
 * - Nachricht CLEAR_CACHES (beim Abmelden, src/components/pwa/logout-form.tsx): löscht alle Caches dieser App.
 */
export function buildServiceWorker(version: string): string {
  const cache = swCacheName(version);
  return `/* PodoHero Service Worker ${JSON.stringify(version)} – nur statische Dateien, keine Praxis-/Patientendaten */
"use strict";
var CACHE = ${JSON.stringify(cache)};
var PREFIX = ${JSON.stringify(SW_CACHE_PREFIX)};
var OFFLINE_URL = ${JSON.stringify(OFFLINE_PATH)};
var classifyRequest = ${classifyRequest.toString()};

function precache() {
  return caches.open(CACHE).then(function (cache) {
    return fetch(OFFLINE_URL, { cache: "no-store", credentials: "omit", redirect: "error" }).then(function (res) {
      if (!res.ok) throw new Error("Offline-Seite nicht ladbar: " + res.status);
      return res.clone().text().then(function (html) {
        var found = html.match(/\\/_next\\/static\\/[^"'\\s)<>\\\\]+/g) || [];
        var assets = found.filter(function (a, i) { return found.indexOf(a) === i; });
        return cache.put(OFFLINE_URL, res).then(function () {
          return Promise.all(assets.map(function (a) { return cache.add(a).catch(function () {}); }));
        });
      });
    });
  });
}

self.addEventListener("install", function (event) {
  event.waitUntil(precache());
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k.indexOf(PREFIX) === 0 && k !== CACHE; }).map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("message", function (event) {
  var type = event.data && event.data.type;
  if (type === "SKIP_WAITING") self.skipWaiting();
  if (type === "CLEAR_CACHES") {
    event.waitUntil(caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k.indexOf(PREFIX) === 0; }).map(function (k) { return caches.delete(k); }));
    }));
  }
});

function cacheFirst(request) {
  return caches.open(CACHE).then(function (cache) {
    return cache.match(request).then(function (hit) {
      if (hit) return hit;
      return fetch(request).then(function (res) {
        var cc = res.headers.get("Cache-Control") || "";
        // keine Weiterleitungen (z. B. zum Login) und nichts Privates speichern
        if (res.ok && !res.redirected && res.type === "basic" && !/no-store|private/i.test(cc)) cache.put(request, res.clone());
        return res;
      });
    });
  });
}

function networkWithOfflineFallback(request) {
  return fetch(request).catch(function () {
    return caches.open(CACHE).then(function (cache) { return cache.match(OFFLINE_URL); }).then(function (offline) {
      return offline || Response.error();
    });
  });
}

self.addEventListener("fetch", function (event) {
  var req = event.request;
  var decision = classifyRequest({ url: req.url, method: req.method, mode: req.mode, origin: self.location.origin });
  if (decision === "static") event.respondWith(cacheFirst(req));
  else if (decision === "navigate") event.respondWith(networkWithOfflineFallback(req));
  // "network": nicht eingreifen
});
`;
}
