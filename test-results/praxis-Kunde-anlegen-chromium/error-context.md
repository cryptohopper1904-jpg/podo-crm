# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: praxis.spec.ts >> Kunde anlegen
- Location: e2e/praxis.spec.ts:48:1

# Error details

```
Error: expect(page).toHaveURL(expected) failed

Expected pattern: /\/kunden\/[0-9a-f-]{36}$/
Received string:  "http://localhost:3117/kunden/neu"
Timeout: 10000ms

Call log:
  - Expect "toHaveURL" with timeout 10000ms
    24 × locator resolved to <html lang="de" data-theme="light" class="h-full antialiased">…</html>
       - unexpected value "http://localhost:3117/kunden/neu"

```

```yaml
- complementary:
  - link "PodoCRM":
    - /url: /heute
  - navigation "Hauptnavigation":
    - link "Heute":
      - /url: /heute
    - link "Kalender":
      - /url: /kalender
    - link "Kunden":
      - /url: /kunden
    - link "Behandlung":
      - /url: /doku
    - link "Posteingang 4":
      - /url: /posteingang
    - link "Verordnungen":
      - /url: /verordnungen
    - link "Pflegeheime":
      - /url: /pflegeheime
    - link "Rechnungen":
      - /url: /rechnungen
    - link "Gutscheine":
      - /url: /gutscheine
    - link "Telefon":
      - /url: /telefon
    - link "Bewertungen":
      - /url: /bewertungen
    - link "News":
      - /url: /news
    - link "Hygiene & Geräte":
      - /url: /hygiene
    - link "Team-Planung":
      - /url: /team
    - link "Auswertung":
      - /url: /auswertung
    - link "Einstellungen":
      - /url: /einstellungen
  - paragraph: Dana Demo
  - paragraph: Inhaber:in · Podologie Demo
- banner:
  - text: Suche
  - textbox "Suche":
    - /placeholder: Kunde suchen …
  - button "Dunklen Modus einschalten"
  - button "Abmelden"
- main:
  - heading "Neuer Kunde" [level=1]
  - alert: Möglicherweise gibt es diese Person schon. Bitte prüfen oder trotzdem anlegen.
  - paragraph: "Mögliche Dubletten:"
  - list:
    - listitem:
      - link "#9 Erna E2E-mw88vubi":
        - /url: /kunden/2a499deb-24fd-48d3-b791-fc0ab89b2981
  - checkbox "Trotzdem neu anlegen"
  - text: Trotzdem neu anlegen
  - heading "Person" [level=2]
  - text: Anrede
  - combobox "Anrede":
    - option "–" [selected]
    - option "Frau"
    - option "Herr"
    - option "Divers"
  - text: Titel
  - textbox "Titel"
  - text: Vorname
  - textbox "Vorname": Erna
  - text: Nachname *
  - textbox "Nachname *": E2E-mw88xosd
  - text: Geburtsdatum
  - textbox "Geburtsdatum TT.MM.JJJJ":
    - /placeholder: 01.02.1950
  - text: TT.MM.JJJJ Straße
  - textbox "Straße"
  - text: PLZ
  - textbox "PLZ"
  - text: Ort
  - textbox "Ort"
  - text: Mobil
  - textbox "Mobil": 0151 12345678
  - text: Festnetz
  - textbox "Festnetz"
  - text: E-Mail
  - textbox "E-Mail": erna.mw88xosd@example.org
  - text: Bevorzugter Kanal
  - combobox "Bevorzugter Kanal":
    - option "keine Angabe" [selected]
    - option "WhatsApp"
    - option "SMS"
    - option "E-Mail"
    - option "Telefon"
    - option "Brief"
  - text: Wunsch-Intervall (Wochen)
  - spinbutton "Wunsch-Intervall (Wochen)"
  - checkbox "Hausbesuch"
  - text: Hausbesuch
  - heading "Versicherung" [level=2]
  - text: Status
  - combobox "Status":
    - option "Selbstzahler" [selected]
    - option "Gesetzlich (GKV)"
    - option "Privat (PKV)"
    - option "Beihilfe"
  - text: Krankenkasse
  - textbox "Krankenkasse"
  - text: Versichertennummer
  - textbox "Versichertennummer"
  - text: Hausarzt
  - textbox "Hausarzt"
  - heading "Risiken" [level=2]
  - paragraph: Werden in der Akte und im Kalender immer oben angezeigt.
  - checkbox "Diabetes mellitus"
  - text: Diabetes mellitus
  - checkbox "Blutverdünner (Antikoagulation)"
  - text: Blutverdünner (Antikoagulation)
  - checkbox "pAVK / Durchblutungsstörung"
  - text: pAVK / Durchblutungsstörung
  - checkbox "Neuropathie"
  - text: Neuropathie
  - checkbox "MRSA / multiresistente Keime"
  - text: MRSA / multiresistente Keime Diabetes-Typ
  - textbox "Diabetes-Typ":
    - /placeholder: z. B. Typ 2, insulinpflichtig
  - text: Allergien
  - textbox "Allergien":
    - /placeholder: z. B. Latex, Jod
  - text: Hinweis (organisatorisch, keine Befunde)
  - textbox "Hinweis (organisatorisch, keine Befunde)"
  - button "Speichern"
  - link "Abbrechen":
    - /url: /kunden
- alert
```

# Test source

```ts
  1   | /**
  2   |  * Durchgang durch die wichtigsten Abläufe mit der Demo-Praxis (scripts/seed-demo.ts):
  3   |  * Login → Kunde anlegen → Doku mit 2D-Fußpunkt → Rechnung ausstellen → öffentliche Buchung →
  4   |  * Kundenportal per Link (buchen + verschieben) → Posteingang → Abmelden.
  5   |  * Dazu: geschützte Routen leiten ohne Sitzung zum Login um, und im Browser gibt es keine Konsolenfehler.
  6   |  */
  7   | import { expect, test, type ConsoleMessage, type Page } from "@playwright/test";
  8   | import { demoSlug, DEMO_EMAIL, DEMO_PASSWORD } from "./support";
  9   | 
  10  | const run = Date.now().toString(36);
  11  | const firstName = "Erna";
  12  | const lastName = `E2E-${run}`;
  13  | 
  14  | test.describe.configure({ mode: "serial" });
  15  | 
  16  | let page: Page;
  17  | const consoleErrors: string[] = [];
  18  | let patientUrl = "";
  19  | 
  20  | test.beforeAll(async ({ browser }) => {
  21  |   const context = await browser.newContext();
  22  |   page = await context.newPage();
  23  |   page.on("console", (m: ConsoleMessage) => {
  24  |     if (m.type() === "error") consoleErrors.push(`${page.url()}: ${m.text()}`);
  25  |   });
  26  |   page.on("pageerror", (e) => consoleErrors.push(`${page.url()}: ${e.message}`));
  27  | });
  28  | 
  29  | test.afterAll(async () => {
  30  |   await page.context().close();
  31  | });
  32  | 
  33  | test("geschützte Routen leiten ohne Sitzung zum Login", async () => {
  34  |   for (const p of ["/heute", "/kunden", "/rechnungen", "/kalender", "/posteingang"]) {
  35  |     await page.goto(p);
  36  |     await expect(page).toHaveURL(/\/login$/);
  37  |   }
  38  | });
  39  | 
  40  | test("Login mit Demo-Zugang", async () => {
  41  |   await page.goto("/login");
  42  |   await page.getByLabel("E-Mail", { exact: true }).fill(DEMO_EMAIL);
  43  |   await page.getByLabel("Passwort", { exact: true }).fill(DEMO_PASSWORD);
  44  |   await page.getByRole("button", { name: "Anmelden" }).click();
  45  |   await expect(page).toHaveURL(/\/heute/);
  46  | });
  47  | 
  48  | test("Kunde anlegen", async () => {
  49  |   await page.goto("/kunden/neu");
  50  |   await page.getByLabel("Vorname", { exact: true }).fill(firstName);
  51  |   await page.getByLabel("Nachname *", { exact: true }).fill(lastName);
  52  |   await page.getByLabel("Mobil", { exact: true }).fill("0151 12345678");
  53  |   await page.getByLabel("E-Mail", { exact: true }).fill(`erna.${run}@example.org`);
  54  |   await page.getByRole("button", { name: "Speichern" }).click();
> 55  |   await expect(page).toHaveURL(/\/kunden\/[0-9a-f-]{36}$/);
      |                      ^ Error: expect(page).toHaveURL(expected) failed
  56  |   await expect(page.getByRole("heading", { name: new RegExp(lastName) })).toBeVisible();
  57  |   patientUrl = new URL(page.url()).pathname;
  58  | });
  59  | 
  60  | test("Behandlung dokumentieren mit 2D-Fußpunkt", async () => {
  61  |   await page.goto(`${patientUrl}/doku/neu`);
  62  |   await page.getByRole("button", { name: /^PK · / }).click();
  63  |   await page.getByLabel("Befund", { exact: true }).fill("Hyperkeratose plantar, Nagel D1 verdickt (E2E)");
  64  |   const rightFoot = page.locator("figure").filter({ has: page.getByRole("group", { name: "Fuß rechts" }) });
  65  |   const n1 = rightFoot.getByRole("button", { name: "N1", exact: true });
  66  |   await n1.click();
  67  |   await expect(n1).toHaveAttribute("aria-pressed", "true");
  68  |   await page.getByLabel(/Ich habe die Angaben geprüft/).check();
  69  |   await page.getByRole("button", { name: /Prüfen und abschließen/ }).click();
  70  |   await expect(page).toHaveURL(/\/doku\/[0-9a-f-]{36}\?gespeichert=1/);
  71  |   await expect(page.getByText(/Nagel D1/).first()).toBeVisible();
  72  | });
  73  | 
  74  | test("Rechnung erstellen und ausstellen", async () => {
  75  |   await page.goto(`/rechnungen/neu?patient=${patientUrl.split("/").pop()}`);
  76  |   const pos = page.getByLabel("Pos. 1: Leistung");
  77  |   const value = await pos.locator("option", { hasText: /^PK · / }).first().getAttribute("value");
  78  |   await pos.selectOption(value!);
  79  |   const confirm = page.locator('input[name="therapeuticConfirmed"]');
  80  |   if (await confirm.isVisible()) await confirm.check();
  81  |   await page.getByRole("button", { name: "Rechnung ausstellen" }).click();
  82  |   await expect(page).toHaveURL(/\/rechnungen\/[0-9a-f-]{36}$/);
  83  |   await expect(page.getByText(/R\d{4}-\d{4}/).first()).toBeVisible();
  84  | });
  85  | 
  86  | test("öffentliche Online-Buchung", async ({ browser }) => {
  87  |   // eigener, anonymer Browser-Kontext (ohne Praxis-Sitzung)
  88  |   const ctx = await browser.newContext();
  89  |   const pub = await ctx.newPage();
  90  |   pub.on("console", (m) => m.type() === "error" && consoleErrors.push(`${pub.url()}: ${m.text()}`));
  91  |   pub.on("pageerror", (e) => consoleErrors.push(`${pub.url()}: ${e.message}`));
  92  |   await pub.goto(`/buchen/${await demoSlug()}`);
  93  |   await expect(pub.getByRole("heading", { name: "Termin buchen" })).toBeVisible();
  94  |   const card = (t: string) => pub.locator("section").filter({ has: pub.getByRole("heading", { name: t }) });
  95  |   await card("1. Leistung").getByRole("button").first().click();
  96  |   await card("2. Tag und Uhrzeit").locator("button:not([disabled])").first().click();
  97  |   await card("2. Tag und Uhrzeit").getByRole("button", { name: /^\d{2}:\d{2}$/ }).first().click();
  98  |   await pub.getByLabel("Vorname", { exact: true }).fill("Olga");
  99  |   await pub.getByLabel("Nachname", { exact: true }).fill(`Online-${run}`);
  100 |   await pub.getByLabel("Mobilnummer", { exact: true }).fill("0151 7654321");
  101 |   await pub.getByLabel("Ich habe die Datenschutzhinweise gelesen.").check();
  102 |   await pub.getByLabel(/Nicht rechtzeitig/).check();
  103 |   await pub.getByRole("button", { name: /Termin anfragen/ }).click();
  104 |   await expect(pub.getByText(/Deine Anfrage ist eingegangen/)).toBeVisible();
  105 |   await ctx.close();
  106 | });
  107 | 
  108 | test("Kundenportal: Link erzeugen, Termin buchen und verschieben", async ({ browser }) => {
  109 |   await page.goto(patientUrl);
  110 |   await page.getByRole("button", { name: /Kundenportal-Link/ }).click();
  111 |   const linkInput = page.locator("input[readonly]").first();
  112 |   await expect(linkInput).toHaveValue(/\/portal\/[A-Za-z0-9_-]{43}$/);
  113 |   const url = new URL((await linkInput.inputValue())!, page.url());
  114 | 
  115 |   // Portal in einem eigenen Kontext (wie auf dem Handy der Person)
  116 |   const ctx = await browser.newContext();
  117 |   const pp = await ctx.newPage();
  118 |   pp.on("console", (m) => m.type() === "error" && consoleErrors.push(`${pp.url()}: ${m.text()}`));
  119 |   pp.on("pageerror", (e) => consoleErrors.push(`${pp.url()}: ${e.message}`));
  120 |   await pp.goto(url.pathname);
  121 |   await expect(pp).toHaveURL(/\/portal$/);
  122 |   await expect(pp.getByRole("heading", { name: `Hallo ${firstName}!` })).toBeVisible();
  123 | 
  124 |   await pp.getByRole("link", { name: "Termin buchen" }).click();
  125 |   await expect(pp).toHaveURL(/\/portal\/buchen$/);
  126 |   await pp.getByRole("button", { name: /^PK|Komplex/ }).first().click();
  127 |   // ein paar Tage später (Verschieben/Absagen ist nur bis 24 h vorher möglich)
  128 |   await pp.getByRole("group", { name: "Tag wählen" }).locator("button:not([disabled])").nth(3).click();
  129 |   await pp.getByRole("group", { name: "Uhrzeit wählen" }).getByRole("button").first().click();
  130 |   await pp.getByRole("button", { name: /Verbindlich buchen/ }).click();
  131 |   await expect(pp.getByText(/ist gebucht/)).toBeVisible();
  132 | 
  133 |   await pp.goto("/portal");
  134 |   await pp.getByRole("link", { name: "Verschieben" }).first().click();
  135 |   await expect(pp.getByRole("heading", { name: "Termin verschieben" })).toBeVisible();
  136 |   const days = pp.getByRole("group", { name: "Tag wählen" }).locator("button:not([disabled])");
  137 |   await days.nth(5).click();
  138 |   await pp.getByRole("group", { name: "Uhrzeit wählen" }).getByRole("button").last().click();
  139 |   await pp.getByRole("button", { name: /Verschieben auf/ }).click();
  140 |   await expect(pp.getByText(/wurde auf .* verschoben/)).toBeVisible();
  141 |   await ctx.close();
  142 | 
  143 |   // Praxis sieht beides im Posteingang
  144 |   await page.goto("/posteingang");
  145 |   await expect(page.getByText("Neue Buchung über das Kundenportal").first()).toBeVisible();
  146 |   await expect(page.getByText("Terminverschiebung über das Kundenportal").first()).toBeVisible();
  147 | });
  148 | 
  149 | test("Abmelden", async () => {
  150 |   await page.goto("/heute");
  151 |   await page.getByRole("button", { name: "Abmelden" }).click();
  152 |   await expect(page).toHaveURL(/\/login/);
  153 |   await page.goto("/kunden");
  154 |   await expect(page).toHaveURL(/\/login$/);
  155 | });
```