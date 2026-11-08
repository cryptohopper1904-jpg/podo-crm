/**
 * Durchgang durch die wichtigsten Abläufe mit der Demo-Praxis (scripts/seed-demo.ts):
 * Login → Kunde anlegen → Doku mit 2D-Fußpunkt → Rechnung ausstellen → öffentliche Buchung →
 * Kundenportal per Link (buchen + verschieben) → Posteingang → Abmelden.
 * Dazu: geschützte Routen leiten ohne Sitzung zum Login um, und im Browser gibt es keine Konsolenfehler.
 */
import { expect, test, type ConsoleMessage, type Page } from "@playwright/test";
import { demoSlug, DEMO_EMAIL, DEMO_PASSWORD } from "./support";

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

test("Login mit Demo-Zugang", async () => {
  await page.goto("/login");
  await page.getByLabel("E-Mail", { exact: true }).fill(DEMO_EMAIL);
  await page.getByLabel("Passwort", { exact: true }).fill(DEMO_PASSWORD);
  await page.getByRole("button", { name: "Anmelden" }).click();
  await expect(page).toHaveURL(/\/heute/);
});

test("Kunde anlegen", async () => {
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
  const pos = page.getByLabel("Pos. 1: Leistung");
  const value = await pos.locator("option", { hasText: /^PK · / }).first().getAttribute("value");
  await pos.selectOption(value!);
  const confirm = page.locator('input[name="therapeuticConfirmed"]');
  if (await confirm.isVisible()) await confirm.check();
  await page.getByRole("button", { name: "Rechnung ausstellen" }).click();
  await expect(page).toHaveURL(/\/rechnungen\/[0-9a-f-]{36}$/);
  await expect(page.getByText(/R\d{4}-\d{4}/).first()).toBeVisible();
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

test("Kundenportal: Link erzeugen, Termin buchen und verschieben", async ({ browser }) => {
  await page.goto(patientUrl);
  await page.getByRole("button", { name: /Kundenportal-Link/ }).click();
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
  await expect(page.getByText("Neue Buchung über das Kundenportal").first()).toBeVisible();
  await expect(page.getByText("Terminverschiebung über das Kundenportal").first()).toBeVisible();
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
