/**
 * Installierbare Web-App (PWA) auf Handy und Tablet – gegen den Produktions-Build (`next start`, Service Worker nur dort):
 *  - Manifest ladbar und verlinkt (Praxis-App), nicht auf Patientenseiten,
 *  - wichtigste Seiten in den Geräteprofilen iPhone 15, iPad Pro 11 (hoch/quer) und Pixel 7: kein horizontales
 *    Scrollen, keine Konsolenfehler (Touch-Ziele < 44 px werden nur als Hinweis gemeldet),
 *  - Service Worker registriert, cacht nur statische Dateien, Offline-Ersatzseite greift (context.setOffline),
 *  - Installationshinweis: Android-Knopf (beforeinstallprompt), iOS-Anleitung, nichts in der installierten App.
 *
 * Geräteprofile laufen in Chromium (Viewport, Pixeldichte, Touch, User-Agent) – WebKit-/iOS-Eigenheiten
 * (Safe-Area, Startbilder, Zoom bei Eingaben) lassen sich nur auf echten Geräten prüfen.
 *
 * Optional: E2E_SHOTS_DIR=/pfad → Bildschirmfotos für Menschen; PWA_MANIFEST_SHOTS=1 → erzeugt die
 * Manifest-Bildschirmfotos public/screenshots/app-*.png (Demo-Praxis, keine echten Patientendaten).
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { devices, expect, test, type Browser, type BrowserContext, type BrowserContextOptions, type Page } from "@playwright/test";
import { loginDemoWithFreshTotp } from "./support";

test.describe.configure({ mode: "serial" });

const SHOTS = process.env.E2E_SHOTS_DIR;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

/** Geräteprofile ohne Browserwahl (alle in Chromium) */
function profile(name: string): BrowserContextOptions {
  const { defaultBrowserType, ...rest } = devices[name];
  void defaultBrowserType;
  return rest;
}
const DEVICES: [string, BrowserContextOptions][] = [
  ["iPhone 15", profile("iPhone 15")],
  ["iPad Pro 11 hoch", profile("iPad Pro 11")],
  ["iPad Pro 11 quer", profile("iPad Pro 11 landscape")],
  ["Pixel 7", profile("Pixel 7")],
];

let storageState: Awaited<ReturnType<BrowserContext["storageState"]>>;
const ids = { patient: "", appointment: "" };

async function newDevice(browser: Browser, opts: BrowserContextOptions, extra: BrowserContextOptions = {}) {
  // Bildschirmfotos für Menschen einheitlich mit Pixeldichte 2
  const context = await browser.newContext({ ...opts, ...(SHOTS ? { deviceScaleFactor: 2 } : {}), storageState, locale: "de-DE", timezoneId: "Europe/Berlin", ...extra });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`${page.url()}: ${m.text()}`);
  });
  page.on("pageerror", (e) => errors.push(`${page.url()}: ${e.message}`));
  return { context, page, errors };
}

/** „Neu in PodoHero“ erscheint einmal je Anmeldung – für Prüfungen/Bildschirmfotos schließen */
async function closeChangelog(page: Page) {
  const dlg = page.locator("dialog[open]");
  if (await dlg.count()) await page.keyboard.press("Escape");
}

async function noHorizontalScroll(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
}

/** Sichtbare, anklickbare Elemente unter 44 px (nur Hinweis) */
async function smallTargets(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>("main a, main button, main input, main select, nav a, header a, header button"))) {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height || getComputedStyle(el).visibility === "hidden") continue;
      if (el.matches("input[type=checkbox], input[type=radio]")) continue;
      if (r.height < 43.5 && r.width < 43.5) out.push(`${el.tagName.toLowerCase()} „${(el.innerText || el.getAttribute("aria-label") || "").trim().slice(0, 30)}“ ${Math.round(r.width)}×${Math.round(r.height)}`);
    }
    return out.slice(0, 15);
  });
}

/** Chrome feuert beforeinstallprompt in Tests nicht von selbst – nachstellen (prompt() merkt sich den Aufruf) */
async function fakeInstallPrompt(page: Page) {
  await page.evaluate(() => {
    const e = new Event("beforeinstallprompt", { cancelable: true }) as Event & { prompt?: () => Promise<void>; userChoice?: Promise<{ outcome: string }> };
    e.prompt = async () => {
      (window as unknown as { __promptCalled: boolean }).__promptCalled = true;
    };
    e.userChoice = Promise.resolve({ outcome: "dismissed" });
    window.dispatchEvent(e);
  });
}

async function shot(page: Page, name: string) {
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `webapp-${name}.png`) });
}

test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext({ locale: "de-DE", timezoneId: "Europe/Berlin" });
  const page = await context.newPage();
  await loginDemoWithFreshTotp(page);
  await closeChangelog(page);
  storageState = await context.storageState();
  // Beispiel-Patient:in und -Termin der Demo-Praxis
  await page.goto("/kunden");
  ids.patient = (await page.locator('a[href^="/kunden/"]').evaluateAll((as) => as.map((a) => a.getAttribute("href") ?? "").find((h) => /^\/kunden\/[0-9a-f-]{36}$/.test(h)) ?? "")).split("/").pop() ?? "";
  await page.goto("/kalender?modus=einfach&ansicht=woche");
  ids.appointment = (await page.locator('a[href^="/kalender/termin/"]').first().getAttribute("href").catch(() => null))?.split("/").pop()?.split("?")[0] ?? "";
  await context.close();
  expect(ids.patient, "Demo-Patient:in gefunden").not.toBe("");
});

test("Manifest ist ladbar und nur in der Praxis-App verlinkt", async ({ request, page }) => {
  const res = await request.get("/manifest.webmanifest");
  expect(res.ok()).toBe(true);
  const m = await res.json();
  expect(m.start_url).toBe("/heute");
  for (const icon of [...m.icons, ...m.screenshots]) expect((await request.get(icon.src)).ok(), icon.src).toBe(true);
  await page.goto("/login");
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute("href", "/manifest.webmanifest");
  expect(await page.locator('link[rel="apple-touch-startup-image"]').count()).toBeGreaterThan(30);
  // Patientenseiten: kein „PodoHero“-Manifest
  await page.goto("/portal");
  await expect(page.locator('link[rel="manifest"]')).toHaveCount(0);
  const sw = await request.get("/sw.js");
  expect(sw.headers()["cache-control"]).toContain("no-store");
  expect(sw.headers()["content-type"]).toContain("javascript");
});

for (const [name, opts] of DEVICES) {
  test(`${name}: wichtigste Seiten ohne horizontales Scrollen und ohne Konsolenfehler`, async ({ browser }) => {
    const { context, page, errors } = await newDevice(browser, opts);
    const pages = [
      "/heute",
      "/kalender?modus=einfach&ansicht=tag",
      "/kalender?modus=voll&ansicht=tag",
      "/kalender?modus=voll&ansicht=woche",
      "/kunden",
      `/kunden/${ids.patient}`,
      `/kunden/${ids.patient}/doku/neu`,
      "/rechnungen/neu",
      "/kasse",
      "/einstellungen/app",
      ...(ids.appointment ? [`/kalender/termin/${ids.appointment}`] : []),
    ];
    const overflow: string[] = [];
    for (const p of pages) {
      const r = await page.goto(p);
      expect(r?.status(), p).toBeLessThan(400);
      await closeChangelog(page);
      const over = await noHorizontalScroll(page);
      if (over > 1) overflow.push(`${p}: ${over}px`);
      if (process.env.E2E_SHOTS_ALL && SHOTS) await page.screenshot({ path: path.join(SHOTS, "webapp-check", `${name.replace(/\W+/g, "-")}${p.replace(/[^a-z0-9]+/gi, "_").slice(0, 60)}.png`), fullPage: true });
      const small = await smallTargets(page);
      if (small.length) test.info().annotations.push({ type: "Touch-Ziele < 44 px", description: `${name} ${p}: ${small.join("; ")}` });
    }
    expect(overflow, "horizontales Scrollen").toEqual([]);
    expect(errors, "Konsolenfehler").toEqual([]);
    await context.close();
  });
}

test("Service Worker: registriert, nur statische Dateien im Cache, Offline-Seite als Ersatz", async ({ browser }) => {
  const { context, page, errors } = await newDevice(browser, profile("Pixel 7"));
  await page.goto("/heute");
  await closeChangelog(page);
  const scope = await page.evaluate(async () => (await navigator.serviceWorker.ready).scope);
  expect(new URL(scope).pathname).toBe("/");
  // Inhalt der Caches: nur /offline und statische Dateien – keine Praxis-Seiten, keine API
  await expect
    .poll(async () => page.evaluate(async () => (await Promise.all((await caches.keys()).map(async (k) => (await (await caches.open(k)).keys()).map((r) => new URL(r.url).pathname)))).flat()))
    .toContain("/offline");
  await page.goto("/kunden"); // lädt weitere Bundles
  const cached = await page.evaluate(async () => (await Promise.all((await caches.keys()).map(async (k) => (await (await caches.open(k)).keys()).map((r) => new URL(r.url).pathname)))).flat());
  const notStatic = cached.filter((p) => p !== "/offline" && !/^\/(_next\/static|icons|splash|brand)\//.test(p));
  expect(notStatic, "nur statische Dateien im Cache").toEqual([]);
  // Seite ist nun vom Service Worker kontrolliert → offline greift die Ersatzseite
  await page.reload();
  await context.setOffline(true);
  await page.goto(`/kunden/${ids.patient}`);
  await expect(page.getByRole("heading", { name: "Keine Internetverbindung" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Erneut versuchen" })).toBeVisible();
  // keine Patientendaten aus einem Cache
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Keine Internetverbindung");
  await shot(page, "offline-seite");
  // Offline-Seite hydriert (Ereignis-Listener aktiv), dann wieder online → die Seite lädt von selbst neu
  await expect(page.locator("html[data-offline-ready]")).toHaveCount(1);
  await context.setOffline(false);
  await expect(page).toHaveURL(new RegExp(`/kunden/${ids.patient}$`));
  await expect(page.getByRole("heading", { name: "Keine Internetverbindung" })).toHaveCount(0);
  // Fehler beim Offline-Laden selbst (net::ERR_INTERNET_DISCONNECTED) sind erwartet
  expect(errors.filter((e) => !/ERR_INTERNET_DISCONNECTED|Failed to fetch|Failed to load resource/.test(e))).toEqual([]);
  await context.close();
});

test("Android: Installationsknopf über beforeinstallprompt, Hinweis lässt sich dauerhaft schließen", async ({ browser }) => {
  const { context, page, errors } = await newDevice(browser, profile("Pixel 7"));
  await page.goto("/heute");
  await closeChangelog(page);
  await fakeInstallPrompt(page);
  const banner = page.getByRole("region", { name: "App installieren" });
  await expect(banner.getByRole("button", { name: "Installieren" })).toBeVisible();
  await shot(page, "android-installationsbutton");
  await banner.getByRole("button", { name: "Installieren" }).click();
  expect(await page.evaluate(() => (window as unknown as { __promptCalled?: boolean }).__promptCalled)).toBe(true);
  // Einstellungen → App installieren: Knopf ist nach einmaliger Verwendung weg (Ereignis verbraucht), Anleitung bleibt
  await page.goto("/einstellungen/app");
  await expect(page.getByRole("heading", { name: /Android/ })).toBeVisible();
  await page.goto("/heute");
  await fakeInstallPrompt(page);
  await page.getByRole("button", { name: "Hinweis schließen" }).click();
  await page.reload();
  await expect(page.getByRole("region", { name: "App installieren" })).toHaveCount(0);
  expect(errors).toEqual([]);
  await context.close();
});

test("iPhone: Hinweis mit Anleitung im Browser, nichts in der installierten App", async ({ browser }) => {
  const iphone = profile("iPhone 15");
  // Browser-Safari
  const web = await newDevice(browser, iphone);
  await web.page.goto("/heute");
  await closeChangelog(web.page);
  await expect(web.page.getByRole("region", { name: "App installieren" }).getByRole("link", { name: "So geht’s" })).toBeVisible();
  await web.page.goto("/einstellungen/app");
  await expect(web.page.getByRole("heading", { name: /iPhone & iPad/ })).toBeVisible();
  await expect(web.page.getByText("Zum Home-Bildschirm").first()).toBeVisible();
  await shot(web.page, "installationsanleitung-iphone");
  expect(web.errors).toEqual([]);
  await web.context.close();

  // installierte App (Start vom Home-Bildschirm: navigator.standalone)
  const app = await newDevice(browser, iphone);
  await app.context.addInitScript(() => Object.defineProperty(Navigator.prototype, "standalone", { get: () => true }));
  await app.page.goto("/heute");
  await closeChangelog(app.page);
  await expect(app.page.getByRole("navigation", { name: "Schnellnavigation" })).toBeVisible();
  await expect(app.page.getByRole("region", { name: "App installieren" })).toHaveCount(0);
  await shot(app.page, "iphone-heute-installiert");
  await app.page.goto("/einstellungen/app");
  await expect(app.page.getByText("PodoHero läuft bereits als installierte App")).toBeVisible();
  expect(app.errors).toEqual([]);
  await app.context.close();
});

test("Bildschirmfotos: iPad quer Kalender (und auf Wunsch Manifest-Screenshots)", async ({ browser }) => {
  test.skip(!SHOTS && !process.env.PWA_MANIFEST_SHOTS, "nur mit E2E_SHOTS_DIR bzw. PWA_MANIFEST_SHOTS=1");
  const standalone = () => Object.defineProperty(Navigator.prototype, "standalone", { get: () => true });
  if (SHOTS) {
    const ipad = await newDevice(browser, profile("iPad Pro 11 landscape"));
    await ipad.context.addInitScript(standalone);
    await ipad.page.goto("/kalender?modus=voll&ansicht=woche");
    await closeChangelog(ipad.page);
    await shot(ipad.page, "ipad-quer-kalender");
    await ipad.context.close();
  }
  if (process.env.PWA_MANIFEST_SHOTS) {
    const out = path.resolve(__dirname, "../public/screenshots");
    const narrow = await newDevice(browser, { ...profile("iPhone 15"), viewport: { width: 390, height: 844 } }, { deviceScaleFactor: 2 });
    await narrow.context.addInitScript(standalone);
    // Woche mit Demo-Terminen (Termin-Liste)
    await narrow.page.goto("/kalender?modus=einfach&ansicht=woche");
    await closeChangelog(narrow.page);
    // zum Tag mit den meisten Demo-Terminen scrollen (unter der festen Kopfzeile)
    await narrow.page.evaluate(() => {
      const days = Array.from(document.querySelectorAll("main section")).filter((x) => x.querySelector('a[href^="/kalender/termin/"]'));
      const count = (x: Element) => x.querySelectorAll('a[href^="/kalender/termin/"]').length;
      const best = days.sort((a, b) => count(b) - count(a))[0];
      if (best) window.scrollTo(0, window.scrollY + best.getBoundingClientRect().top - 80);
    });
    await narrow.page.screenshot({ path: path.join(out, "app-kalender-narrow.png") });
    await narrow.context.close();
    const wide = await newDevice(browser, { ...profile("iPad Pro 11 landscape"), viewport: { width: 1280, height: 800 } }, { deviceScaleFactor: 1 });
    await wide.context.addInitScript(standalone);
    await wide.page.goto("/kalender?modus=voll&ansicht=woche");
    await closeChangelog(wide.page);
    await wide.page.screenshot({ path: path.join(out, "app-kalender-wide.png") });
    await wide.context.close();
  }
});

// Zuletzt: beendet die gemeinsame Sitzung der übrigen Tests
test("Abmelden leert die App-Caches, der Offline-Hinweis funktioniert danach weiter", async ({ browser }) => {
  const { context, page, errors } = await newDevice(browser, profile("Pixel 7"));
  await page.goto("/heute");
  await closeChangelog(page);
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.reload(); // jetzt vom Service Worker kontrolliert
  const cachedPaths = () =>
    page.evaluate(async () => (await Promise.all((await caches.keys()).map(async (k) => (await (await caches.open(k)).keys()).map((r) => new URL(r.url).pathname)))).flat());
  // Handy: Abmelden steht im Konto-Menü der Kopfzeile
  await page.getByRole("button", { name: "Konto-Menü" }).click();
  await page.getByRole("button", { name: "Abmelden" }).click();
  await expect(page).toHaveURL(/\/login/);
  // nach dem Leeren wieder abgelegt: Offline-Seite (+ deren Programmdateien), keine Praxis-Seiten
  await expect.poll(cachedPaths).toContain("/offline");
  expect((await cachedPaths()).filter((p) => p !== "/offline" && !/^\/(_next\/static|icons|splash|brand)\//.test(p))).toEqual([]);
  await context.setOffline(true);
  await page.goto("/kalender");
  await expect(page.getByRole("heading", { name: "Keine Internetverbindung" })).toBeVisible();
  await context.setOffline(false);
  expect(errors.filter((e) => !/ERR_INTERNET_DISCONNECTED|Failed to fetch|Failed to load resource/.test(e))).toEqual([]);
  await context.close();
});
