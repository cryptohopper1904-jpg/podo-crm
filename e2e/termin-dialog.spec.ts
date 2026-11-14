/**
 * Kalender: „Neuer Termin“ als Fenster über dem Kalender (Desktop) bzw. Vollbild-Blatt (iPhone SE).
 * Freie Zeit anklicken → Fenster vorbefüllt → (Desktop) anderen Slot anklicken übernimmt Datum/Uhrzeit →
 * neue Patient:in direkt anlegen → speichern → Fenster zu, Termin steht im Kalender, Meldung mit Link.
 * Termine in ferner Zukunft (keine Seed-Termine); erfundene Namen.
 */
import { devices, expect, test, type Browser, type BrowserContextOptions } from "@playwright/test";
import { Pool } from "pg";
import { DEMO_EMAIL, loginDemoWithFreshTotp } from "./support";

test.describe.configure({ mode: "serial" });

function profile(name: string): BrowserContextOptions {
  const { defaultBrowserType, ...rest } = devices[name] as BrowserContextOptions & { defaultBrowserType?: string };
  void defaultBrowserType;
  return rest;
}

async function open(browser: Browser, opts: BrowserContextOptions) {
  const context = await browser.newContext({ ...opts, locale: "de-DE", timezoneId: "Europe/Berlin" });
  const page = await context.newPage();
  await loginDemoWithFreshTotp(page);
  return { context, page };
}

/** Termine früherer Läufe entfernen (sonst sind die Zeiten belegt) – nur die erfundenen Test-Personen */
test.beforeAll(async () => {
  const pool = new Pool({ connectionString: process.env.E2E_DATABASE_URL ?? process.env.DATABASE_URL ?? "", max: 1 });
  const c = await pool.connect();
  try {
    const r = await c.query("select m.organization_id from memberships m join users u on u.id = m.user_id where u.email = $1 order by m.created_at limit 1", [DEMO_EMAIL]);
    await c.query("begin");
    await c.query("select set_config('app.org_id', $1, true)", [r.rows[0].organization_id]);
    await c.query(
      "delete from appointments where organization_id = $1 and patient_id in (select id from patients where organization_id = $1 and last_name like 'Dialogtest%')",
      [r.rows[0].organization_id],
    );
    await c.query("commit");
  } finally {
    c.release();
    await pool.end();
  }
});

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

test("ohne JavaScript bleibt /kalender/neu die Formularseite", async ({ browser }) => {
  const { context, page } = await open(browser, { viewport: { width: 1280, height: 800 } });
  await page.goto("/kalender/neu?datum=2031-07-08&zeit=10:00");
  await expect(page.getByRole("heading", { name: "Neuer Termin" })).toBeVisible();
  await expect(page.locator('input[name="time"]')).toHaveValue("10:00");
  await context.close();
});
