/**
 * Navigation/Kopfzeile auf Handy, Tablet und Desktop (Review-Befunde A1–A5, A9) – gegen den Produktions-Build:
 *  - in JEDER Ansicht (Einfach/Kompakt/Komplex) sind auf iPhone und iPad hochkant alle erlaubten Bereiche über die
 *    untere Leiste + „Mehr“ erreichbar (Vergleich mit /bereiche), am Desktop über die linke Navigation,
 *  - Kopfzeile bleibt auf 320 px einzeilig ohne Überlauf; Konto-Menü mit Neuigkeiten, Einstellungen, Abmelden,
 *  - Installationshinweis nur auf „Heute“, untere Leiste weg, solange die Bildschirmtastatur offen ist.
 * Rollen/Praxis-Modi ohne eigenes Demo-Konto deckt der Unit-Test src/server/nav.test.ts ab.
 */
import { Pool } from "pg";
import { devices, expect, test, type Browser, type BrowserContext, type BrowserContextOptions, type Page } from "@playwright/test";
import { DEMO_EMAIL, loginDemoWithFreshTotp } from "./support";
import type { ViewLevel } from "../src/lib/view-level";

test.describe.configure({ mode: "serial" });

function profile(name: string): BrowserContextOptions {
  const { defaultBrowserType, ...rest } = devices[name];
  void defaultBrowserType;
  return rest;
}
const iphoneSE = profile("iPhone SE (3rd gen)");
const MOBILE: [string, BrowserContextOptions][] = [
  ["iPhone SE 320", { ...iphoneSE, viewport: { width: 320, height: 568 }, screen: { width: 320, height: 568 } }],
  ["iPhone SE", iphoneSE],
  ["iPhone 15", profile("iPhone 15")],
  ["Pixel 7", profile("Pixel 7")],
  ["iPad Mini hoch", profile("iPad Mini")],
  ["iPad Pro 11 hoch", profile("iPad Pro 11")],
];

let storageState: Awaited<ReturnType<BrowserContext["storageState"]>>;

async function setLevel(level: ViewLevel | null) {
  const pool = new Pool({ connectionString: process.env.E2E_DATABASE_URL ?? process.env.DATABASE_URL, max: 1 });
  try {
    if (level) await pool.query("update users set prefs = jsonb_set(coalesce(prefs, '{}'::jsonb), '{view}', to_jsonb($2::text)) where email = $1", [DEMO_EMAIL, level]);
    else await pool.query("update users set prefs = coalesce(prefs, '{}'::jsonb) - 'view' where email = $1", [DEMO_EMAIL]);
  } finally {
    await pool.end();
  }
}

async function newDevice(browser: Browser, opts: BrowserContextOptions) {
  const context = await browser.newContext({ ...opts, storageState, locale: "de-DE", timezoneId: "Europe/Berlin" });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`${page.url()}: ${m.text()}`);
  });
  page.on("pageerror", (e) => errors.push(`${page.url()}: ${e.message}`));
  return { context, page, errors };
}

const hrefs = (page: Page, selector: string) =>
  page.locator(selector).evaluateAll((as) => as.map((a) => a.getAttribute("href") ?? "").filter(Boolean));

/** Alle erlaubten Bereiche laut /bereiche (Desktop-Breite, unabhängig von der Navigation) */
async function expectedAreas(browser: Browser): Promise<string[]> {
  const { context, page } = await newDevice(browser, { viewport: { width: 1280, height: 900 } });
  await page.goto("/bereiche");
  // erst lesen, wenn die Seite wirklich da ist (nicht Ladezustand/Weiterleitung) – sonst flackert der Test mit „[]“
  await expect(page).toHaveURL(/\/bereiche$/);
  await page.locator("main section a").first().waitFor();
  const list = await hrefs(page, "main section a");
  await context.close();
  return [...new Set(list)].sort();
}

test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext({ locale: "de-DE", timezoneId: "Europe/Berlin" });
  const page = await context.newPage();
  await loginDemoWithFreshTotp(page);
  if (await page.locator("dialog[open]").count()) await page.keyboard.press("Escape");
  storageState = await context.storageState();
  await context.close();
});

test.afterAll(async () => {
  await setLevel(null);
});

for (const level of ["komplex", "kompakt", "einfach"] as const) {
  test(`Ansicht „${level}“: auf Handy und iPad hochkant alle erlaubten Bereiche über Leiste + „Mehr“`, async ({ browser }) => {
    await setLevel(level);
    const expected = await expectedAreas(browser);
    expect(expected).toEqual(expect.arrayContaining(["/heute", "/rechnungen", "/kasse", "/produkte", "/hygiene", "/telefon", "/auswertung", "/team", "/einstellungen"]));
    for (const [name, opts] of MOBILE) {
      const { context, page, errors } = await newDevice(browser, opts);
      await page.goto("/heute");
      // Sidebar erst ab lg – hier nicht sichtbar, also muss alles über die untere Leiste gehen
      await expect(page.getByRole("navigation", { name: "Hauptnavigation" })).toBeHidden();
      const bar = page.getByRole("navigation", { name: "Schnellnavigation" });
      await expect(bar).toBeVisible();
      const barLinks = await hrefs(page, 'nav[aria-label="Schnellnavigation"] a');
      expect(barLinks.length, `${name}: höchstens 4 Bereiche + „Mehr“`).toBeLessThanOrEqual(4);
      await bar.getByRole("button", { name: /^Mehr/ }).click();
      const sheet = page.getByRole("dialog", { name: "Alle Bereiche" });
      await expect(sheet).toBeVisible();
      const sheetLinks = await hrefs(page, "dialog[open] a");
      const reachable = new Set([...barLinks, ...sheetLinks]);
      const missing = expected.filter((h) => !reachable.has(h));
      expect(missing, `${name} (${level}): nicht erreichbar`).toEqual([]);
      // alle Kacheln liegen im sichtbaren (scrollbaren) Blatt, nichts seitlich abgeschnitten
      const sheetOverflow = await page.locator("dialog[open]").evaluate((d) => d.scrollWidth - d.clientWidth);
      expect(sheetOverflow, `${name}: Blatt seitlich`).toBeLessThanOrEqual(1);
      await page.keyboard.press("Escape");
      await expect(sheet).toBeHidden();
      // Kopfzeile einzeilig, nichts läuft über (A2)
      const header = await page.locator("header").first().evaluate((h) => ({ over: h.scrollWidth - h.clientWidth, height: h.getBoundingClientRect().height }));
      expect(header.over, `${name}: Kopfzeile läuft über`).toBeLessThanOrEqual(1);
      expect(header.height, `${name}: Kopfzeile einzeilig`).toBeLessThan(80);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), `${name}: Seite scrollt seitlich`).toBeLessThanOrEqual(1);
      expect(errors, `${name}: Konsolenfehler`).toEqual([]);
      await context.close();
    }
  });
}

test("„Mehr“ führt zur Kasse; Konto-Menü mit Neuigkeiten, Einstellungen, Hell/Dunkel und Abmelden (iPhone SE)", async ({ browser }) => {
  await setLevel(null); // Standard „Alle Bereiche“ (komplex)
  const { context, page, errors } = await newDevice(browser, iphoneSE);
  await page.goto("/heute");
  await page.getByRole("button", { name: /^Mehr/ }).click();
  await page.getByRole("dialog", { name: "Alle Bereiche" }).getByRole("link", { name: "Kasse", exact: true }).click();
  await expect(page).toHaveURL(/\/kasse$/);
  await expect(page.getByRole("heading", { name: "Kasse", exact: true })).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Alle Bereiche" })).toBeHidden();
  // „Mehr“ ist hervorgehoben, wenn die aktuelle Seite darunter liegt
  await expect(page.getByRole("button", { name: /^Mehr/ })).toHaveClass(/text-primary/);

  const menu = page.getByRole("button", { name: "Konto-Menü" });
  await menu.click();
  await expect(menu).toHaveAttribute("aria-expanded", "true");
  for (const name of ["Neuigkeiten", "Einstellungen"]) await expect(page.getByRole("link", { name, exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: /^Ansicht: Alle Bereiche/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Abmelden" })).toBeVisible();
  // Hell/Dunkel schaltet um, Menü bleibt offen
  const before = await page.evaluate(() => document.documentElement.dataset.theme);
  await page.getByRole("button", { name: /Modus$/ }).click();
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).not.toBe(before);
  await expect(menu).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Abmelden" })).toBeHidden();
  // Tab aus dem Menü heraus schließt es
  await menu.click();
  await page.getByRole("button", { name: "Abmelden" }).focus();
  await page.keyboard.press("Tab");
  await expect(menu).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("button", { name: "Abmelden" })).toBeHidden();
  // Link im Menü schließt es und navigiert
  await menu.click();
  await page.getByRole("link", { name: "Neuigkeiten", exact: true }).click();
  await expect(page).toHaveURL(/\/neuigkeiten$/);
  await expect(menu).toHaveAttribute("aria-expanded", "false");
  expect(errors).toEqual([]);
  await context.close();
});

test("Bildschirmtastatur: untere Leiste verschwindet, solange ein Schreibfeld den Fokus hat (A5)", async ({ browser }) => {
  // Regeln (welche Felder) und Entprellung beim Feldwechsel prüft der Unit-Test src/lib/keyboard.test.ts
  const { context, page, errors } = await newDevice(browser, iphoneSE);
  await page.goto("/kalender/neu");
  const bar = page.getByRole("navigation", { name: "Schnellnavigation" });
  await expect(bar).toBeVisible();
  // Datum/Uhrzeit öffnen eine Auswahl, keine Schreibtastatur → Leiste bleibt
  for (const label of ["Datum", "Uhrzeit"]) {
    await page.getByLabel(label, { exact: true }).focus();
    await page.waitForTimeout(50);
    await expect(bar, label).toBeVisible();
    await expect(page.locator("html[data-keyboard]")).toHaveCount(0);
  }
  // Schreibfeld → Leiste weg, html[data-keyboard=open]
  const text = page.locator("main input[type=text], main input[type=search], main input:not([type]), main textarea").first();
  await text.focus();
  await expect(bar).toBeHidden();
  await expect(page.locator("html[data-keyboard=open]")).toHaveCount(1);
  // zurück auf ein Datumsfeld → Leiste wieder da
  await page.getByLabel("Datum", { exact: true }).focus();
  await expect(bar).toBeVisible();
  await text.focus();
  await expect(bar).toBeHidden();
  await text.blur();
  await expect(bar).toBeVisible();
  await expect(page.locator("html[data-keyboard]")).toHaveCount(0);
  expect(errors).toEqual([]);
  await context.close();
});

test("Installationshinweis: einzeilig und nur auf „Heute“ (A3)", async ({ browser }) => {
  const { context, page, errors } = await newDevice(browser, profile("iPhone 15"));
  await page.goto("/heute");
  const banner = page.getByRole("region", { name: "App installieren" });
  await expect(banner).toBeVisible();
  expect((await banner.boundingBox())!.height).toBeLessThanOrEqual(56);
  await page.goto("/kunden");
  await expect(page.getByRole("region", { name: "App installieren" })).toHaveCount(0);
  expect(errors).toEqual([]);
  await context.close();
});

test("Desktop 1280×800: Bereiche gruppiert, „Einstellungen“ ohne Scrollen sichtbar (A9)", async ({ browser }) => {
  const { context, page, errors } = await newDevice(browser, { viewport: { width: 1280, height: 800 } });
  await page.goto("/heute");
  const nav = page.getByRole("navigation", { name: "Hauptnavigation" });
  for (const g of ["Praxis", "Abrechnung", "Verwaltung"]) await expect(nav.getByRole("group", { name: g })).toBeVisible();
  const settings = page.locator("aside").getByRole("link", { name: "Einstellungen", exact: true });
  await expect(settings).toBeInViewport();
  await expect(page.getByRole("navigation", { name: "Schnellnavigation" })).toBeHidden();
  // Kopfzeile am Desktop wie bisher mit Einzelknöpfen
  await expect(page.getByRole("button", { name: "Abmelden" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Konto-Menü" })).toBeHidden();
  expect(errors).toEqual([]);
  await context.close();
});

test("Plattform-Routen: notFound() liefert eine echte 404 (keine gestreamte 200)", async ({ browser }) => {
  // Demo-Inhaber:in ist kein Plattform-Admin → requirePlatformAdmin() ruft notFound()
  const { context, page } = await newDevice(browser, { viewport: { width: 1280, height: 800 } });
  for (const p of ["/plattform", "/plattform/vertrieb", "/plattform/vertrieb/kein-lead", "/plattform/vertrieb/kampagnen/00000000-0000-0000-0000-000000000000"]) {
    const r = await page.request.get(p, { maxRedirects: 0 });
    expect(r.status(), p).toBe(404);
  }
  // Patientenseiten: unbekannte Praxis ebenfalls echte 404 (eigene Segment-404 ohne Manifest, Titel „Seite nicht gefunden“)
  for (const p of ["/buchen/gibt-es-nicht", "/p/gibt-es-nicht", "/p/gibt-es-nicht/impressum", "/p/gibt-es-nicht/datenschutz"]) {
    const r = await page.request.get(p, { maxRedirects: 0 });
    expect(r.status(), p).toBe(404);
    const html = await r.text();
    expect(html, p).toContain("<title>Seite nicht gefunden");
    expect(html, p).not.toContain('rel="manifest"');
  }
  // Praxis-Seiten dagegen weiter normal
  expect((await page.request.get("/heute", { maxRedirects: 0 })).status()).toBe(200);
  await context.close();
});

test("Plattform-Admin: /plattform mit 200 in der App-Hülle (Kopfzeile, Navigation mit „Plattform“)", async ({ browser }) => {
  const leadName = `E2E Praxis ${Date.now().toString(36)}`;
  const pool = new Pool({ connectionString: process.env.E2E_DATABASE_URL ?? process.env.DATABASE_URL, max: 1 });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "de-DE", timezoneId: "Europe/Berlin" });
  try {
    await pool.query("update users set is_platform_admin = true where email = $1", [DEMO_EMAIL]);
    // neue Sitzung als Plattform-Admin (inkl. 2FA – die Konsole verlangt sie)
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await loginDemoWithFreshTotp(page);
    if (await page.locator("dialog[open]").count()) await page.keyboard.press("Escape");
    const res = await page.goto("/plattform");
    expect(res?.status()).toBe(200);
    await expect(page.getByRole("heading", { level: 1, name: "Plattform" })).toBeVisible();
    // App-Hülle: Kopfzeile mit Suche/Abmelden, linke Navigation mit dem Punkt „Plattform“ als aktuelle Seite
    await expect(page.getByRole("button", { name: "Abmelden" })).toBeVisible();
    const nav = page.getByRole("navigation", { name: "Hauptnavigation" });
    await expect(nav.getByRole("link", { name: "Plattform", exact: true })).toHaveAttribute("aria-current", "page");
    expect((await page.request.get("/plattform/vertrieb", { maxRedirects: 0 })).status()).toBe(200);

    // Vertrieb (Rechtsprüfung): Quelle + Abrufdatum Pflicht, Löschfrist 6–12, Hinweis je Kanal, Telefonnummer ausgeblendet
    await page.goto("/plattform/vertrieb/neu");
    await page.getByLabel("Name der Praxis *").fill(leadName);
    await page.getByLabel("Telefon").fill("030 0000 9999");
    await expect(page.getByLabel("Abgerufen am *")).not.toHaveValue("");
    await expect(page.getByLabel("Löschfrist")).toHaveValue("12");
    await expect(page.getByLabel("Löschfrist").locator("option")).toHaveCount(7);
    await page.getByLabel("Quelle der Daten *").fill("OpenStreetMap");
    await page.getByRole("button", { name: "Anlegen" }).click();
    await page.waitForURL(/\/plattform\/vertrieb\/[0-9a-f-]{36}$/);
    await expect(page.getByText(/^Werbung per E-Mail nur mit vorheriger ausdrücklicher Einwilligung in E-Mails \(§ 7 Abs\. 2 Nr\. 2 UWG\)\./).first()).toBeVisible();
    await expect(page.getByText(/^OpenStreetMap · abgerufen \d{2}\.\d{2}\.\d{4}$/)).toBeVisible();
    await expect(page.getByText("ausgeblendet (nur mit Einwilligung in Anrufe oder bei Bestandskunden)")).toBeVisible();
    await expect(page.getByText(/^Erstbrief bis \d{2}\.\d{2}\.\d{4}/)).toBeVisible();
    expect(await page.content()).not.toContain("030 0000 9999");
    // Art.-14-Hinweis: Entwurfsvermerk nur in der Ansicht; Kopieren erst ohne offene Platzhalter
    await expect(page.getByText("ENTWURF – vor Verwendung rechtlich prüfen lassen").first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Text kopieren" })).toBeDisabled();
    await page.getByLabel("Firma (Verantwortlicher)").fill("Muster GmbH");
    await page.getByLabel("E-Mail für Widerspruch").fill("datenschutz@muster.example");
    await page.getByLabel("Datenschutzkontakt").fill("datenschutz@muster.example");
    await page.getByLabel("Aufsichtsbehörde").fill("Landesbeauftragte für den Datenschutz");
    await expect(page.getByRole("button", { name: "Text kopieren" })).toBeDisabled();
    await page.getByRole("checkbox", { name: "keine weiteren Dienstleister" }).check();
    await expect(page.getByRole("button", { name: "Text kopieren" })).toBeEnabled();
    await expect(page.getByText(/^Ihr Widerspruchsrecht \(Art\. 21 Abs\. 2 DSGVO\): .*Eine formlose Nachricht an Muster GmbH genügt/)).toBeVisible();
    await page.goto("/plattform/vertrieb");
    const row = page.getByRole("row", { name: new RegExp(leadName) });
    await expect(row.getByText("E-Mail: nein")).toBeVisible();
    await expect(row.getByText("Telefon: nein")).toBeVisible();
    await page.goto("/plattform/vertrieb/datenschutzhinweis");
    await expect(page.getByText(/Verantwortlich für die Verarbeitung ist (\{\{Firma\}\}|Muster GmbH)/)).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await pool.query("delete from sales_leads where name = $1", [leadName]).catch(() => undefined);
    await pool.query("update users set is_platform_admin = false where email = $1", [DEMO_EMAIL]).catch(() => undefined);
    await pool.end();
    await context.close();
  }
});
