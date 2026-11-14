/**
 * Durchgang durch die wichtigsten Abläufe mit der Demo-Praxis (scripts/seed-demo.ts):
 * Login → Patient anlegen → Doku mit 2D-Fußpunkt → Rechnung ausstellen → Zahlung erfassen (Zahlungsbeleg) → öffentliche Buchung →
 * Patientenportal per Link (buchen + verschieben) → Posteingang → Kasse (Kassenbuch, Export-Seite) → Abmelden.
 * Dazu: geschützte Routen leiten ohne Sitzung zum Login um, und im Browser gibt es keine Konsolenfehler.
 */
import { expect, test, type ConsoleMessage, type Page } from "@playwright/test";
import { totpCode } from "../src/lib/auth/totp";
import { demoSlug, DEMO_EMAIL, DEMO_PASSWORD, insertAppointment, insertLowStockProduct, resetDemoTotp } from "./support";

const run = Date.now().toString(36);
const firstName = "Erna";
const lastName = `E2E-${run}`;

test.describe.configure({ mode: "serial" });

let page: Page;
const consoleErrors: string[] = [];
let patientUrl = "";

test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext();
  page = await context.newPage();
  page.on("console", (m: ConsoleMessage) => {
    if (m.type() === "error") consoleErrors.push(`${page.url()}: ${m.text()}`);
  });
  page.on("pageerror", (e) => consoleErrors.push(`${page.url()}: ${e.message}`));
});

test.afterAll(async () => {
  await page.context().close();
});

test("geschützte Routen leiten ohne Sitzung zum Login", async () => {
  for (const p of ["/heute", "/kunden", "/rechnungen", "/kalender", "/posteingang"]) {
    await page.goto(p);
    await expect(page).toHaveURL(/\/login$/);
  }
});

test("Login mit Demo-Zugang: Pflicht-2FA für Inhaber:innen wird eingerichtet", async () => {
  await resetDemoTotp();
  await page.goto("/login");
  await page.getByLabel("E-Mail", { exact: true }).fill(DEMO_EMAIL);
  await page.getByLabel("Passwort", { exact: true }).fill(DEMO_PASSWORD);
  await page.getByRole("button", { name: "Anmelden" }).click();
  // Ohne 2FA kein Praxis-Zugriff (Gesamt-Review H1): jede Praxis-Seite leitet zur Einrichtung
  await expect(page).toHaveURL(/\/login\/2fa-einrichten/);
  await page.goto("/kunden");
  await expect(page).toHaveURL(/\/login\/2fa-einrichten/);
  expect((await page.request.get("/api/export/doctolib")).status()).toBe(403);
  await page.getByRole("button", { name: "Jetzt einrichten" }).click();
  const secret = (await page.locator("code").innerText()).replace(/\s/g, "");
  await page.getByLabel("Code", { exact: true }).fill(totpCode(secret));
  await page.getByRole("button", { name: "Bestätigen" }).click();
  await expect(page).toHaveURL(/\/heute/);
});

test("Patient anlegen", async () => {
  await page.goto("/kunden/neu");
  await page.getByLabel("Vorname", { exact: true }).fill(firstName);
  await page.getByLabel("Nachname *", { exact: true }).fill(lastName);
  await page.getByLabel("Mobil", { exact: true }).fill(`0151 ${String(Date.now()).slice(-8)}`);
  await page.getByLabel("E-Mail", { exact: true }).fill(`erna.${run}@example.org`);
  await page.getByRole("button", { name: "Speichern" }).click();
  // Dubletten-Hinweis (z. B. bei wiederholtem Lauf gegen dieselbe Datenbank) bewusst übergehen
  const dup = page.getByLabel("Trotzdem neu anlegen");
  await expect(page.getByRole("heading", { name: new RegExp(lastName) }).or(dup)).toBeVisible();
  if (await dup.isVisible()) {
    await dup.check();
    await page.getByRole("button", { name: "Speichern" }).click();
  }
  await expect(page).toHaveURL(/\/kunden\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { name: new RegExp(lastName) })).toBeVisible();
  patientUrl = new URL(page.url()).pathname;
});

test("Behandlung dokumentieren mit 2D-Fußpunkt", async () => {
  await page.goto(`${patientUrl}/doku/neu`);
  await page.getByRole("button", { name: /^PK · / }).click();
  await page.getByLabel("Befund", { exact: true }).fill("Hyperkeratose plantar, Nagel D1 verdickt (E2E)");
  const rightFoot = page.locator("figure").filter({ has: page.getByRole("group", { name: "Fuß rechts" }) });
  const n1 = rightFoot.getByRole("button", { name: "N1", exact: true });
  await n1.click();
  await expect(n1).toHaveAttribute("aria-pressed", "true");
  await page.getByLabel(/Ich habe die Angaben geprüft/).check();
  await page.getByRole("button", { name: /Prüfen und abschließen/ }).click();
  await expect(page).toHaveURL(/\/doku\/[0-9a-f-]{36}\?gespeichert=1/);
  await expect(page.getByText(/Nagel D1/).first()).toBeVisible();
});

test("Rechnung erstellen und ausstellen", async () => {
  await page.goto(`/rechnungen/neu?patient=${patientUrl.split("/").pop()}`);
  const pos = page.getByLabel("Pos. 1: Leistung auswählen");
  const value = await pos.locator("option", { hasText: /^PK · / }).first().getAttribute("value");
  // Schnelleingabe per Kürzel wählt dieselbe Leistung wie die Auswahlliste
  await page.getByLabel("Pos. 1: Leistung – Kürzel").fill("pk");
  await expect(pos).toHaveValue(value!);
  const confirm = page.locator('input[name="therapeuticConfirmed"]');
  if (await confirm.isVisible()) await confirm.check();
  await page.getByRole("button", { name: "Rechnung ausstellen" }).click();
  await expect(page).toHaveURL(/\/rechnungen\/[0-9a-f-]{36}$/);
  await expect(page.getByText(/R\d{4}-\d{4}/).first()).toBeVisible();
});

test("Zahlung erfassen (bar): Beleg über den Zahlungseingang, Rechnungs-PDF aus dem Beleg-Archiv", async () => {
  const invoiceUrl = page.url().split("?")[0];
  await page.getByRole("button", { name: "Zahlung erfassen" }).click();
  await page.getByLabel("Zahlung 1: Methode").selectOption("cash");
  await page.getByRole("button", { name: "Buchen" }).click();
  // Zahlungsbeleg wird direkt zum Aushändigen angeboten
  await expect(page).toHaveURL(/\?beleg=[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { name: "Zahlung erfasst – Zahlungsbeleg aushändigen" })).toBeVisible();
  const printHref = await page.getByRole("link", { name: /^Zahlungsbeleg ZB\d{4}-\d{4} drucken$/ }).getAttribute("href");
  expect((await page.request.get(printHref!)).status()).toBe(200);
  await expect(page.getByRole("heading", { name: "Zahlungseingang nach Ausstellung" })).toBeVisible();
  await expect(page.getByText(/Beleg ZB\d{4}-\d{4}/)).toBeVisible();
  const receiptHref = await page.getByRole("link", { name: "Anzeigen / Drucken" }).getAttribute("href");
  const receipt = await page.request.get(receiptHref!);
  expect(receipt.status()).toBe(200);
  expect(receipt.headers()["content-type"]).toBe("application/pdf");
  // Rechnung: archiviertes Original (zweimal abgerufen byte-gleich)
  const id = invoiceUrl.split("/").pop();
  const a = await page.request.get(`/api/invoices/${id}/pdf`);
  const b = await page.request.get(`/api/invoices/${id}/pdf`);
  expect(a.status()).toBe(200);
  expect(Buffer.compare(await a.body(), await b.body())).toBe(0);
  await expect(page.getByText(/Beleg-Archiv: Original vom/)).toBeVisible();
});

test("Rechnungsformular auf dem iPad (Hochformat) ohne horizontales Scrollen", async () => {
  await page.setViewportSize({ width: 1024, height: 1366 });
  try {
    await page.goto(`/rechnungen/neu?patient=${patientUrl.split("/").pop()}`);
    await expect(page.getByLabel("Pos. 1: Leistung auswählen")).toBeVisible();
    const { scroll, client } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
    expect(scroll).toBeLessThanOrEqual(client);
  } finally {
    await page.setViewportSize({ width: 1280, height: 720 });
  }
});

test("Terminseite: Rechnung/Quittung für erbrachte Behandlungen, nur Anzahlung für künftige Termine", async () => {
  const pid = patientUrl.split("/").pop()!;
  const past = await insertAppointment(pid, new Date(Date.now() - 3 * 86_400_000));
  const future = await insertAppointment(pid, new Date(Date.now() + 5 * 86_400_000));
  await page.goto(`/kalender/termin/${past}`);
  await expect(page.getByRole("link", { name: "Quittung", exact: true })).toBeVisible();
  await expect(page.getByText("Bezahlte Quittungen können später in die Sammelrechnung übernommen werden.")).toBeVisible();
  await expect(page.getByRole("link", { name: /Anzahlung|Sammelrechnung/ })).toHaveCount(0);
  // künftiger Termin: nur die Anzahlung (Vorauszahlung) – Rechnung/Quittung erst nach der Behandlung
  await page.goto(`/kalender/termin/${future}`);
  await expect(page.getByRole("link", { name: "Anzahlung (Vorauszahlung)" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Quittung", exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Rechnung erstellen" })).toHaveCount(0);
  // direkt aufgerufen: für den vergangenen Termin keine Anzahlung, sondern der Weg zur Quittung
  await page.goto(`/rechnungen/anzahlung?termin=${past}`);
  await expect(page.getByText(/Für erbrachte Behandlungen bitte eine Quittung erstellen\./).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Anzahlung quittieren" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Quittung erstellen" })).toBeVisible();
  // Einstieg „Anzahlung ohne Termin“: Rechnungsliste und Patientenakte (mit Person)
  await page.goto("/rechnungen");
  await expect(page.getByRole("link", { name: "Anzahlung ohne Termin" })).toHaveAttribute("href", "/rechnungen/anzahlung");
  await page.goto(patientUrl);
  await expect(page.getByRole("link", { name: "Anzahlung (Vorauszahlung)" })).toHaveAttribute("href", `/rechnungen/anzahlung?patient=${pid}`);
});

test("öffentliche Online-Buchung", async ({ browser }) => {
  // eigener, anonymer Browser-Kontext (ohne Praxis-Sitzung)
  const ctx = await browser.newContext();
  const pub = await ctx.newPage();
  pub.on("console", (m) => m.type() === "error" && consoleErrors.push(`${pub.url()}: ${m.text()}`));
  pub.on("pageerror", (e) => consoleErrors.push(`${pub.url()}: ${e.message}`));
  await pub.goto(`/buchen/${await demoSlug()}`);
  await expect(pub.getByRole("heading", { name: "Termin buchen" })).toBeVisible();
  const card = (t: string) => pub.locator("section").filter({ has: pub.getByRole("heading", { name: t }) });
  await card("1. Leistung").getByRole("button").first().click();
  await card("2. Tag und Uhrzeit").locator("button:not([disabled])").first().click();
  await card("2. Tag und Uhrzeit").getByRole("button", { name: /^\d{2}:\d{2}$/ }).first().click();
  await pub.getByLabel("Vorname", { exact: true }).fill("Olga");
  await pub.getByLabel("Nachname", { exact: true }).fill(`Online-${run}`);
  await pub.getByLabel("Mobilnummer", { exact: true }).fill("0151 7654321");
  await pub.getByLabel("Ich habe die Datenschutzhinweise gelesen.").check();
  await pub.getByLabel(/Nicht rechtzeitig/).check();
  await pub.getByRole("button", { name: /Termin anfragen/ }).click();
  await expect(pub.getByText(/Deine Anfrage ist eingegangen/)).toBeVisible();
  await ctx.close();
});

test("Patientenportal: Link erzeugen, Termin buchen und verschieben", async ({ browser }) => {
  await page.goto(patientUrl);
  await page.getByRole("button", { name: /Patientenportal-Link/ }).click();
  const linkInput = page.locator("input[readonly]").first();
  await expect(linkInput).toHaveValue(/\/portal\/[A-Za-z0-9_-]{43}$/);
  const url = new URL((await linkInput.inputValue())!, page.url());

  // Portal in einem eigenen Kontext (wie auf dem Handy der Person)
  const ctx = await browser.newContext();
  const pp = await ctx.newPage();
  pp.on("console", (m) => m.type() === "error" && consoleErrors.push(`${pp.url()}: ${m.text()}`));
  pp.on("pageerror", (e) => consoleErrors.push(`${pp.url()}: ${e.message}`));
  await pp.goto(url.pathname);
  await expect(pp).toHaveURL(/\/portal$/);
  await expect(pp.getByRole("heading", { name: `Hallo ${firstName}!` })).toBeVisible();

  await pp.getByRole("link", { name: "Termin buchen" }).click();
  await expect(pp).toHaveURL(/\/portal\/buchen$/);
  await pp.getByRole("button", { name: /^PK|Komplex/ }).first().click();
  // ein paar Tage später (Verschieben/Absagen ist nur bis 24 h vorher möglich)
  await pp.getByRole("group", { name: "Tag wählen" }).locator("button:not([disabled])").nth(3).click();
  await pp.getByRole("group", { name: "Uhrzeit wählen" }).getByRole("button").first().click();
  await pp.getByRole("button", { name: /Verbindlich buchen/ }).click();
  await expect(pp.getByText(/ist gebucht/)).toBeVisible();

  await pp.goto("/portal");
  await pp.getByRole("link", { name: "Verschieben" }).first().click();
  await expect(pp.getByRole("heading", { name: "Termin verschieben" })).toBeVisible();
  const days = pp.getByRole("group", { name: "Tag wählen" }).locator("button:not([disabled])");
  await days.nth(5).click();
  await pp.getByRole("group", { name: "Uhrzeit wählen" }).getByRole("button").last().click();
  await pp.getByRole("button", { name: /Verschieben auf/ }).click();
  await expect(pp.getByText(/wurde auf .* verschoben/)).toBeVisible();
  await ctx.close();

  // Praxis sieht beides im Posteingang
  await page.goto("/posteingang");
  await expect(page.getByText("Neue Buchung über das Patientenportal").first()).toBeVisible();
  await expect(page.getByText("Terminverschiebung über das Patientenportal").first()).toBeVisible();
});

test("Kasse: Kassenbuch-Eintrag, Formel-Schutz, DSFinV-K-Exportseite", async () => {
  await page.goto("/kasse");
  await expect(page.getByRole("heading", { name: "Kasse", exact: true })).toBeVisible();
  const reason = page.getByLabel("Grund / Beleg *");
  await page.getByLabel("Betrag (€)").fill("1,00");
  await reason.fill("=HYPERLINK(1)");
  await page.getByRole("button", { name: "Im Kassenbuch erfassen" }).click();
  await expect(page.getByText(/darf nicht mit =, \+, - oder @ beginnen/)).toBeVisible();
  await page.getByLabel("Betrag (€)").fill("1,00");
  await reason.fill(`E2E Porto ${run}`);
  await page.getByRole("button", { name: "Im Kassenbuch erfassen" }).click();
  await expect(page.getByText("Im Kassenbuch erfasst.")).toBeVisible();
  await page.getByRole("link", { name: /DSFinV-K-Export/ }).click();
  await expect(page).toHaveURL(/\/kasse\/export/);
});

test("Leistungen: Kategorie umbenennen, Leistung archivieren gibt das Kürzel frei", async () => {
  const cat = `Kat ${run}`;
  await page.goto("/einstellungen/leistungen/kategorien");
  await page.getByLabel("Name", { exact: true }).fill(cat);
  await page.getByRole("button", { name: "Anlegen" }).click();
  await expect(page.getByRole("heading", { name: cat })).toBeVisible();
  const card = page.locator("li").filter({ has: page.getByRole("heading", { name: cat }) });
  await card.getByText("Umbenennen, verschieben oder löschen").click();
  await card.getByLabel(`Neuer Name für „${cat}“`).fill(`${cat} neu`);
  await card.getByRole("button", { name: "Umbenennen" }).click();
  await expect(page.getByRole("heading", { name: `${cat} neu` })).toBeVisible();

  // Leistung mit eigenem Kürzel in der neuen Kategorie anlegen, archivieren, Kürzel neu vergeben
  const code = `Z${run.slice(-4).toUpperCase()}`;
  const neu = async (name: string) => {
    await page.goto("/einstellungen/leistungen?neu=1");
    await page.getByLabel(/^Kürzel/).fill(code);
    await page.getByLabel("Bezeichnung", { exact: true }).fill(name);
    await page.getByLabel("Kategorie", { exact: true }).selectOption({ label: `${cat} neu` });
    await page.getByLabel("Preis (€, brutto)").fill("12,00");
    await page.getByRole("button", { name: "Anlegen" }).click();
    await expect(page.getByText("Gespeichert.")).toBeVisible();
  };
  await neu(`Erste ${run}`);
  await page.goto("/einstellungen/leistungen?sort=name");
  await page.getByRole("button", { name: `Erste ${run} archivieren` }).click();
  // Liste „Aktiv“ ohne den archivierten Eintrag = Aktion fertig
  await expect(page.getByRole("button", { name: `Erste ${run} archivieren` })).toHaveCount(0);
  await page.goto("/einstellungen/leistungen?status=archiviert&sort=name");
  await expect(page.getByText(`${code}_archiv`, { exact: true }).first()).toBeVisible();
  await neu(`Zweite ${run}`);
  await page.goto(`/einstellungen/leistungen?sort=name&q=${code}`);
  await expect(page.getByRole("heading", { name: `Zweite ${run}` })).toBeVisible();
});

test("Heute: Hinweis „Bestand knapp“ mit Link zum Nachbestellen", async () => {
  await insertLowStockProduct(`Fußcreme ${run}`, 0, 5);
  await page.goto("/heute");
  const hint = page.getByRole("status").filter({ hasText: "Bestand knapp" });
  await expect(hint).toContainText(`E2E Fußcreme ${run} (0 von mind. 5)`);
  await hint.getByRole("link", { name: "nachbestellen" }).click();
  await expect(page).toHaveURL(/\/produkte\/nachbestellen$/);
});

test("Abmelden", async () => {
  await page.goto("/heute");
  await page.getByRole("button", { name: "Abmelden" }).click();
  await expect(page).toHaveURL(/\/login/);
  await page.goto("/kunden");
  await expect(page).toHaveURL(/\/login$/);
});

test("keine Konsolenfehler", async () => {
  expect(consoleErrors).toEqual([]);
});
