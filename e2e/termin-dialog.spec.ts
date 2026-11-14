/**
 * Kalender: „Neuer Termin“ als Fenster über dem Kalender (Desktop) bzw. Vollbild-Blatt (iPhone SE).
 * Freie Zeit anklicken → Fenster vorbefüllt → (Desktop) anderen Slot anklicken übernimmt Datum/Uhrzeit →
 * neue Patient:in direkt anlegen → speichern → Fenster zu, Termin steht im Kalender, Meldung mit Link.
 * Termine in ferner Zukunft (keine Seed-Termine); erfundene Namen.
 */
import { devices, expect, test, type Browser, type BrowserContext, type BrowserContextOptions, type Page } from "@playwright/test";
import { Pool } from "pg";
import { DEMO_EMAIL, loginDemoWithFreshTotp } from "./support";

test.describe.configure({ mode: "serial" });

function profile(name: string): BrowserContextOptions {
  const { defaultBrowserType, ...rest } = devices[name] as BrowserContextOptions & { defaultBrowserType?: string };
  void defaultBrowserType;
  return rest;
}

let storageState: Awaited<ReturnType<BrowserContext["storageState"]>>;

async function open(browser: Browser, opts: BrowserContextOptions) {
  const context = await browser.newContext({ ...opts, storageState, locale: "de-DE", timezoneId: "Europe/Berlin" });
  const page = await context.newPage();
  return { context, page };
}

/** SQL in der Demo-Praxis (RLS über app.org_id) */
async function demoSql<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const pool = new Pool({ connectionString: process.env.E2E_DATABASE_URL ?? process.env.DATABASE_URL ?? "", max: 1 });
  const c = await pool.connect();
  try {
    const r = await c.query("select m.organization_id from memberships m join users u on u.id = m.user_id where u.email = $1 order by m.created_at limit 1", [DEMO_EMAIL]);
    const org = r.rows[0].organization_id as string;
    await c.query("begin");
    await c.query("select set_config('app.org_id', $1, true)", [org]);
    const out = await c.query(sql.replaceAll("$org", "$1"), [org, ...params]);
    await c.query("commit");
    return out.rows as T[];
  } finally {
    c.release();
    await pool.end();
  }
}

/** Termine und Patient:innen früherer Läufe entfernen (sonst sind die Zeiten belegt) – nur die erfundenen Test-Personen */
async function cleanup() {
  await demoSql("delete from appointments where organization_id = $org and patient_id in (select id from patients where organization_id = $org and last_name like 'Dialogtest%')");
  await demoSql("delete from patients where organization_id = $org and last_name like 'Dialogtest%'");
}
const countPatients = async (lastName: string) => (await demoSql<{ n: number }>("select count(*)::int n from patients where organization_id = $org and last_name = $2", [lastName]))[0].n;
const sfx = () => Date.now().toString(36);

test.beforeAll(async ({ browser }) => {
  await cleanup();
  const context = await browser.newContext({ locale: "de-DE", timezoneId: "Europe/Berlin" });
  const page = await context.newPage();
  await loginDemoWithFreshTotp(page);
  storageState = await context.storageState();
  await context.close();
});
test.afterAll(cleanup);

/** Kalender öffnen und auf eine freie Zeit klicken → Fenster „Neuer Termin“ */
async function openDialog(page: Page, day: string, view: "woche" | "tag", time: string) {
  await page.goto(`/kalender?modus=voll&ansicht=${view}&datum=${day}`);
  // Seite fertig gestreamt (sonst liegt das Raster noch im verborgenen Ladeteil)
  await expect(page.getByRole("region", { name: view === "tag" ? "Tagesplan" : "Wochenplan" })).toBeVisible();
  if (await page.locator("dialog[open]").count()) await page.keyboard.press("Escape");
  const label = `Neuer Termin am ${Number(day.slice(8))}.${Number(day.slice(5, 7))}. um ${time} Uhr`;
  const slot = page.locator(`a[aria-label="${label}"]`).first();
  await slot.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await slot.click({ force: true });
  const dlg = page.locator("[data-termin-dialog]");
  await expect(dlg).toBeVisible();
  await expect(dlg.getByRole("combobox", { name: "Patient:in" })).toBeFocused();
  return { dlg, label };
}
const focusInDialog = (page: Page) => page.evaluate(() => !!document.activeElement?.closest("[data-termin-dialog]"));

const CASES: [string, BrowserContextOptions, string][] = [
  ["Desktop", { viewport: { width: 1280, height: 800 } }, "woche"],
  ["iPhone SE", { ...profile("iPhone SE (3rd gen)"), viewport: { width: 375, height: 667 } }, "tag"],
];

for (const [label, opts, view] of CASES) {
  test(`${label}: freie Zeit → Fenster vorbefüllt → neue Patient:in → Termin im Kalender`, async ({ browser }) => {
    const { context, page } = await open(browser, opts);
    const day = label === "Desktop" ? "2031-07-08" : "2031-07-15";
    await page.goto(`/kalender?modus=voll&ansicht=${view}&datum=${day}`);
    // Seite fertig gestreamt (sonst liegt das Raster noch im verborgenen Ladeteil)
    await expect(page.getByRole("region", { name: view === "tag" ? "Tagesplan" : "Wochenplan" })).toBeVisible();
    if (await page.locator("dialog[open]").count()) await page.keyboard.press("Escape");
    const dm = `${Number(day.slice(8))}.${Number(day.slice(5, 7))}.`;
    const slot = page.locator(`a[aria-label="Neuer Termin am ${dm} um 16:00 Uhr"]`).first();
    await slot.evaluate((el) => el.scrollIntoView({ block: "center" }));
    await slot.click({ force: true });
    const dlg = page.locator("[data-termin-dialog]");
    await expect(dlg).toBeVisible();
    await expect(page).toHaveURL(/\/kalender\?/); // kein Seitenwechsel
    await expect(dlg.locator('input[name="date"]')).toHaveValue(day);
    await expect(dlg.locator('input[name="time"]')).toHaveValue("16:00");
    let time = "16:00";
    if (label === "Desktop") {
      // Fenster bleibt im Bild, auch wenn weit nach links oben gezogen
      const bar = (await dlg.getByRole("heading", { name: "Neuer Termin" }).boundingBox())!;
      await page.mouse.move(bar.x + 10, bar.y + 10);
      await page.mouse.down();
      await page.mouse.move(-500, -500, { steps: 5 });
      await page.mouse.up();
      const box = (await dlg.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.y).toBeGreaterThanOrEqual(0);
      // anderen freien Platz (nächster Tag) anklicken → Datum/Uhrzeit übernommen, Fenster bleibt offen
      const next = `2031-07-09`;
      const other = page.locator(`a[aria-label="Neuer Termin am 9.7. um 17:30 Uhr"]`).first();
      await other.evaluate((el) => el.scrollIntoView({ block: "center", inline: "center" }));
      await other.click({ force: true });
      await expect(dlg.locator('input[name="date"]')).toHaveValue(next);
      await expect(dlg.locator('input[name="time"]')).toHaveValue("17:30");
      time = "17:30";
    }
    const last = `Dialogtest${Date.now().toString(36)}`;
    await dlg.getByRole("combobox", { name: "Patient:in" }).fill(`Erfunda ${last}`);
    await dlg.getByRole("button", { name: /Neue:n Patient:in/ }).click();
    await expect(dlg.getByLabel("Nachname")).toHaveValue(last);
    await dlg.getByLabel("Telefon (mobil)").fill(`0151 ${Date.now().toString().slice(-7)}`);
    await dlg.getByRole("button", { name: "Anlegen und auswählen" }).click();
    await expect(dlg.getByText(new RegExp(`${last}, Erfunda`))).toBeVisible();
    await dlg.getByRole("button", { name: "Termin eintragen" }).click();
    await expect(dlg).toBeHidden({ timeout: 15_000 });
    await expect(page.getByText(/Termin angelegt/)).toBeVisible();
    await expect(page.locator(`[data-appt], a[href^="/kalender/termin/"]`).filter({ hasText: last }).first()).toBeVisible({ timeout: 15_000 });
    await expect(page.locator(`[data-appt]`).filter({ hasText: last }).first()).toHaveAttribute("title", new RegExp(time));
    await context.close();
  });
}

test("Desktop: nicht modal – F6 und „Zum Fenster“, keine Tab-Falle; Escape innen zuerst, Rückfrage, Fokus zurück", async ({ browser }) => {
  const { context, page } = await open(browser, { viewport: { width: 1280, height: 800 } });
  const { dlg, label } = await openDialog(page, "2031-07-10", "woche", "10:00");
  await expect(dlg).toHaveAttribute("aria-modal", "false");
  await expect(page.locator("main [inert]")).toHaveCount(0);

  // F6: Fenster ↔ Kalender; im Kalender (per Tastatur) erscheint „Zum Fenster“
  await page.keyboard.press("F6");
  expect(await focusInDialog(page)).toBe(false);
  const back = page.getByRole("button", { name: /Zum Fenster/ });
  await expect(back).toBeVisible();
  await page.keyboard.press("F6");
  expect(await focusInDialog(page)).toBe(true);
  await expect(back).toBeHidden();
  // keine Tab-Falle: Umschalt+Tab vom ersten Element verlässt das Fenster, „Zum Fenster“ holt zurück
  await dlg.getByRole("button", { name: "Schließen" }).focus();
  await page.keyboard.press("Shift+Tab");
  expect(await focusInDialog(page)).toBe(false);
  await back.click();
  expect(await focusInDialog(page)).toBe(true);

  // Escape im Suchfeld: erst Suchtext leeren, das Fenster bleibt
  const box = dlg.getByRole("combobox", { name: "Patient:in" });
  await box.fill("Zzqxkeinname");
  await expect(dlg.getByText("Keine Patient:in gefunden.", { exact: true })).toBeVisible();
  await box.press("Escape");
  await expect(box).toHaveValue("");
  await expect(dlg).toBeVisible();
  // leeres Formular: Escape schließt ohne Rückfrage, Fokus zurück auf die angeklickte Zeit
  await box.press("Escape");
  await expect(dlg).toBeHidden();
  await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe(label);

  // mit Eingaben: „Eingaben verwerfen?“ – Abbrechen lässt das Fenster offen, OK schließt
  await openDialog(page, "2031-07-10", "woche", "10:00");
  const time = dlg.locator('input[name="time"]');
  await time.fill("11:30");
  const asked: string[] = [];
  page.once("dialog", (d) => {
    asked.push(d.message());
    void d.dismiss();
  });
  await time.press("Escape");
  await expect.poll(() => asked).toEqual(["Eingaben verwerfen?"]);
  await expect(dlg).toBeVisible();
  page.once("dialog", (d) => void d.accept());
  await time.press("Escape");
  await expect(dlg).toBeHidden();
  await context.close();
});

test("Desktop: „Neu anlegen“ als letzte Vorschlagszeile, Dublettenwarnung mit Archiv und „Trotzdem neu anlegen“, Mehrfach-Enter legt genau eine Person an", async ({ browser }) => {
  const { context, page } = await open(browser, { viewport: { width: 1280, height: 800 } });
  const s = sfx();
  const known = `Dialogtest${s}a`;
  const phone = `0151 ${Date.now().toString().slice(-7)}`;
  await demoSql("insert into patients (organization_id, number, last_name, first_name, phone_mobile) values ($org, (select coalesce(max(number),0)+1 from patients where organization_id = $org), $2, 'Erika', $3)", [known, phone]);
  await demoSql(
    "insert into patients (organization_id, number, last_name, first_name, phone_mobile, archived_at) values ($org, (select coalesce(max(number),0)+1 from patients where organization_id = $org), $2, 'Ernst', $3, now())",
    [`Dialogtest${s}arch`, phone],
  );
  const { dlg } = await openDialog(page, "2031-07-11", "woche", "10:00");
  const box = dlg.getByRole("combobox", { name: "Patient:in" });

  // Treffer vorhanden → „Neue:n Patient:in … anlegen“ trotzdem als letzte Zeile, per Pfeiltaste erreichbar
  await box.fill(known);
  const options = dlg.getByRole("listbox", { name: "Vorschläge" }).getByRole("option");
  await expect(options.first()).toContainText(known);
  await expect(options.last()).toHaveText(`Neue:n Patient:in „${known}“ anlegen`);
  await box.press("ArrowDown");
  await expect(options.last()).toHaveAttribute("aria-selected", "true");
  // Escape schließt zuerst nur die Vorschläge
  await box.press("Escape");
  await expect(dlg.getByRole("listbox")).toBeHidden();
  await expect(box).toHaveValue(known);
  await expect(dlg).toBeVisible();
  await box.fill("");
  await box.fill(known);
  await box.press("ArrowDown");
  await box.press("Enter");
  await expect(dlg.getByLabel("Nachname")).toHaveValue(known);

  // gleiche Mobilnummer → „Meinten Sie …?“: aktive Person wählbar, archivierte gekennzeichnet und nicht wählbar
  await dlg.getByLabel("Vorname").fill("Erika");
  await dlg.getByLabel("Telefon (mobil)").fill(phone);
  await dlg.getByRole("button", { name: "Anlegen und auswählen" }).click();
  await expect(dlg.getByText("Meinten Sie …?")).toBeVisible();
  await expect(dlg.getByRole("button", { name: new RegExp(`Erika ${known}.*auswählen`) })).toBeVisible();
  await expect(dlg.getByText(/archiviert, nicht wählbar/)).toBeVisible();
  await expect(dlg.getByRole("button", { name: new RegExp(`Dialogtest${s}arch`) })).toHaveCount(0);
  expect(await countPatients(known)).toBe(1);
  await dlg.getByRole("button", { name: "Trotzdem neu anlegen" }).click();
  await expect(dlg.getByText(new RegExp(`${known}, Erika`))).toBeVisible();
  await expect.poll(() => countPatients(known)).toBe(2);

  // neue Person per Mehrfach-Enter – nur Name (ohne Telefon/E-Mail greift keine Dublettenprüfung, die es abfangen
  // könnte): Escape im Schnellformular fragt erst nach, dann dreimal Enter → genau ein Datensatz
  await dlg.getByRole("button", { name: /ändern/ }).click();
  const fresh = `Dialogtest${s}neu`;
  await box.fill(`Erfunda ${fresh}`);
  await dlg.getByRole("button", { name: /Neue:n Patient:in/ }).click();
  await expect(dlg.getByLabel("Telefon (mobil)")).toBeFocused();
  const first = dlg.getByLabel("Vorname");
  await first.fill("Erfundine");
  page.once("dialog", (d) => void d.dismiss());
  await first.press("Escape");
  await expect(first).toBeVisible(); // Rückfrage abgelehnt → Schnellformular und Fenster bleiben
  await expect(dlg).toBeVisible();
  // dreimal Enter direkt auf der Tastatur (ohne Locator-Warten – das Schnellformular schließt sich nach der Antwort)
  await first.focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await expect(dlg.getByText(new RegExp(`${fresh}, Erfundine`))).toBeVisible();
  await page.waitForTimeout(500); // etwaige Nachzügler-Anfragen abwarten
  expect(await countPatients(fresh)).toBe(1);
  // Fenster ohne Termin schließen (Rückfrage, da Patient:in gewählt)
  page.once("dialog", (d) => void d.accept());
  await dlg.getByRole("button", { name: "Schließen" }).click();
  await expect(dlg).toBeHidden();
  await context.close();
});

test("iPhone SE: Blatt ist modal – Hintergrund inert, Seite gesperrt; Escape schließt", async ({ browser }) => {
  const { context, page } = await open(browser, { ...profile("iPhone SE (3rd gen)"), viewport: { width: 375, height: 667 } });
  const { dlg } = await openDialog(page, "2031-07-17", "tag", "10:00");
  await expect(dlg).toHaveAttribute("aria-modal", "true");
  const plan = page.getByRole("region", { name: "Tagesplan" });
  expect(await plan.evaluate((el) => !!el.closest("[inert]"))).toBe(true);
  expect(await dlg.evaluate((el) => !!el.closest("[inert]"))).toBe(false);
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).overflow)).toBe("hidden");
  await page.keyboard.press("Escape");
  await expect(dlg).toBeHidden();
  expect(await plan.evaluate((el) => !!el.closest("[inert]"))).toBe(false);
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).overflow)).not.toBe("hidden");
  await context.close();
});

/**
 * Ohne JavaScript (javaScriptEnabled: false) prüfbar ist nur: der Deep-Link /kalender/neu wird serverseitig mit
 * Formular und Vorbelegung ausgeliefert, ein Fenster gibt es nicht. Bedienbar ist die Seite so nicht – der Inhalt
 * steht hinter dem Ladeteil von (app)/loading.tsx im verborgenen Streaming-Bereich, und die Patient:innen-Suche
 * braucht JavaScript. Darum hier toBeAttached statt toBeVisible.
 */
test("ohne JavaScript: Deep-Link /kalender/neu liefert die Formularseite aus (kein Fenster)", async ({ browser }) => {
  const context = await browser.newContext({ storageState, javaScriptEnabled: false, viewport: { width: 1280, height: 800 }, locale: "de-DE", timezoneId: "Europe/Berlin" });
  const page = await context.newPage();
  const res = await page.goto("/kalender/neu?datum=2031-07-08&zeit=10:00");
  expect(res?.status()).toBe(200);
  await expect(page).toHaveURL(/\/kalender\/neu\?/);
  await expect(page.locator("h1", { hasText: "Neuer Termin" })).toBeAttached();
  await expect(page.locator('form input[name="date"]')).toHaveValue("2031-07-08");
  await expect(page.locator('form input[name="time"]')).toHaveValue("10:00");
  await expect(page.locator("[data-termin-dialog]")).toHaveCount(0);
  await context.close();
});
