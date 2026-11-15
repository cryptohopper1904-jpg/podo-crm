/**
 * Kalender-Anzeige: Raster unter Einstellungen → Kalender umstellen (Zeitachse beschriftet jede Rasterzeile),
 * Symbole N (Neupatient:in) und R (Rechnung offen) im Termin-Block, Anzeige-Filter „Hausbesuche“ samt „Alle einblenden“.
 * Termine werden direkt in der DB angelegt (Woche in ferner Zukunft, erfundene Person).
 */
import { expect, test, type Page } from "@playwright/test";
import { Pool, type PoolClient } from "pg";
import { DEMO_EMAIL, loginDemoWithFreshTotp } from "./support";

test.describe.configure({ mode: "serial" });

const dbUrl = () => process.env.E2E_DATABASE_URL ?? process.env.DATABASE_URL ?? "";
let page: Page;
let pool: Pool;
let org = "";
let user = "";
let patient = "";
const ids: Record<string, string> = {};
// Montag einer Woche in ferner Zukunft (keine Seed-Termine, keine Feiertage)
const MONDAY = "2031-06-16";

async function asOrg<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query("select set_config('app.org_id', $1, true)", [org]);
    const r = await fn(c);
    await c.query("commit");
    return r;
  } catch (e) {
    await c.query("rollback");
    throw e;
  } finally {
    c.release();
  }
}

/** Kalender-Einstellungen der Demo-Person zurücksetzen (Raster, Anzeige-Optionen) – users hat keine RLS */
async function resetPrefs() {
  await pool.query("update users set prefs = prefs #- '{calendar,slotMin}' #- '{calendar,options}' where email = $1", [DEMO_EMAIL]);
}

async function cleanup() {
  await asOrg(async (c) => {
    await c.query("delete from appointments where organization_id = $1 and title like 'E2E Anzeige%'", [org]);
    await c.query("delete from patients where organization_id = $1 and last_name = 'E2E-Anzeige'", [org]);
  });
}

test.beforeAll(async ({ browser }) => {
  pool = new Pool({ connectionString: dbUrl(), max: 2 });
  const r = await pool.query(
    "select m.organization_id, m.user_id from memberships m join users u on u.id = m.user_id where u.email = $1 and m.role = 'owner' order by m.created_at limit 1",
    [DEMO_EMAIL],
  );
  org = r.rows[0].organization_id;
  user = r.rows[0].user_id;
  await cleanup();
  await resetPrefs();
  await asOrg(async (c) => {
    const n = (await c.query("select coalesce(max(number), 0) + 1 as n from patients where organization_id = $1", [org])).rows[0].n;
    patient = (await c.query("insert into patients (organization_id, number, last_name, first_name) values ($1,$2,'E2E-Anzeige','Nina') returning id", [org, n])).rows[0].id;
    const ins = (title: string, start: string, status: string, homeVisit = false) =>
      c
        .query(
          "insert into appointments (organization_id, patient_id, therapist_id, starts_at, ends_at, status, source, title, home_visit) values ($1,$2,$3,$4::timestamptz,$4::timestamptz + interval '45 minutes',$5,'phone',$6,$7) returning id",
          [org, patient, user, start, status, title, homeVisit],
        )
        .then((x) => x.rows[0].id as string);
    // Di 17.06. 09:05 (nicht auf dem 15er-Raster): erster Besuch, erledigt → N und R grau
    ids.first = await ins("E2E Anzeige erster", "2031-06-17T07:05:00Z", "done");
    // Mi 18.06. 09:00: zweiter Besuch, erledigt → nur R grau
    ids.second = await ins("E2E Anzeige zweiter", "2031-06-18T07:00:00Z", "done");
    // Do 19.06. 10:00: Hausbesuch, geplant (Zukunft) → kein R
    ids.home = await ins("E2E Anzeige Hausbesuch", "2031-06-19T08:00:00Z", "planned", true);
  });
  page = await (await browser.newContext()).newPage();
  await loginDemoWithFreshTotp(page);
});

test.afterAll(async () => {
  await cleanup();
  await resetPrefs();
  await pool.end();
  await page.context().close();
});

test("Symbole N und R im Termin-Block (Woche)", async () => {
  await page.goto(`/kalender?modus=voll&ansicht=woche&datum=${MONDAY}`);
  const first = page.locator(`a[href="/kalender/termin/${ids.first}"]`);
  await expect(first.getByRole("img", { name: "Neupatient:in" })).toBeVisible();
  await expect(first.getByRole("img", { name: "Rechnung offen" })).toBeVisible();
  const second = page.locator(`a[href="/kalender/termin/${ids.second}"]`);
  await expect(second.getByRole("img", { name: "Rechnung offen" })).toBeVisible();
  await expect(second.getByRole("img", { name: "Neupatient:in" })).toHaveCount(0);
  await expect(page.locator(`a[href="/kalender/termin/${ids.home}"] [data-mark]`)).toHaveCount(0);
  // Standard-Raster 15 Minuten: Zeile 09:15 beschriftet, 09:05 nicht
  await expect(page.locator('[data-dnd-col][data-date="2031-06-17"]')).toHaveAttribute("data-raster", "15");
  await expect(page.locator("[data-zeitachse]", { hasText: /^09:15$/ }).first()).toBeAttached();
  await expect(page.locator("[data-zeitachse]", { hasText: /^09:05$/ })).toHaveCount(0);
});

test("Raster unter Einstellungen → Kalender auf 5 Minuten: jede Zeile beschriftet, Termin bleibt an seiner Uhrzeit", async () => {
  await page.goto("/einstellungen/kalender");
  await page.getByRole("radio", { name: /^5 Minuten/ }).check();
  await page.getByRole("button", { name: "Speichern" }).click();
  await expect(page.getByText(/Raster „5 Minuten“ gespeichert/)).toBeVisible();

  await page.goto(`/kalender?modus=voll&ansicht=woche&datum=${MONDAY}`);
  const col = page.locator('[data-dnd-col][data-date="2031-06-17"]');
  await expect(col).toHaveAttribute("data-raster", "5");
  await expect(page.locator("[data-zeitachse]", { hasText: /^09:05$/ }).first()).toBeAttached();
  // 192 px je Stunde: der Termin um 09:05 liegt 125 Minuten nach 07:00 → 400 px unter der Spaltenoberkante
  await expect(col.locator(`a[href="/kalender/termin/${ids.first}"]`)).toHaveCSS("top", "400px");
  // Klickfläche „neuer Termin“ im 5-Minuten-Raster
  await expect(page.locator('a[aria-label="Neuer Termin am 16.6. um 08:35 Uhr"]')).toHaveCount(1);
});

test("Anzeige-Filter: Hausbesuche ausblenden", async () => {
  await page.goto(`/kalender?modus=voll&ansicht=woche&datum=${MONDAY}`);
  await expect(page.locator(`a[href="/kalender/termin/${ids.home}"]`)).toBeVisible();
  await page.locator("summary", { hasText: "Anzeige" }).first().click();
  await page.getByRole("switch", { name: "Hausbesuche" }).first().uncheck({ force: true });
  await expect(page.locator(`a[href="/kalender/termin/${ids.home}"]`)).toHaveCount(0);
  await expect(page.getByTestId("anzeige-filter-hinweis")).toContainText("1 Termin ist durch den Anzeige-Filter ausgeblendet (Hausbesuche)");
  // „Alle einblenden“ setzt den Anzeige-Filter zurück (gemerkt) – Anzeige-Panel vorher schließen
  await page.locator("summary", { hasText: "Anzeige" }).first().click();
  await page.getByTestId("anzeige-filter-hinweis").getByRole("button", { name: "Alle einblenden" }).click();
  await expect(page.locator(`a[href="/kalender/termin/${ids.home}"]`)).toBeVisible();
  await expect(page.getByTestId("anzeige-filter-hinweis")).toHaveCount(0);
  await page.reload();
  await expect(page.locator(`a[href="/kalender/termin/${ids.home}"]`)).toBeVisible();
});
