/**
 * Kalender-Anzeige: Raster unter Einstellungen → Kalender umstellen (Zeitachse beschriftet jede Rasterzeile),
 * Symbole N (Neupatient:in) und R (Rechnung offen) im Termin-Block, Anzeige-Filter „Hausbesuche“ samt „Alle einblenden“,
 * dieselben Markierungen wie auf „Heute“ (N/R + Kürzel der Behandler:in) auch in der Liste („Einfach“) und in Tag/Woche,
 * Auswahl „Raster“ direkt in der Kalender-Werkzeugleiste.
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

/** Kalender-Einstellungen der Demo-Person zurücksetzen (Raster, Anzeige-Optionen, Ansicht) – users hat keine RLS */
async function resetPrefs() {
  await pool.query("update users set prefs = prefs #- '{calendar,slotMin}' #- '{calendar,options}' #- '{calendar,mode}' where email = $1", [DEMO_EMAIL]);
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
  await expect(page.locator(`[data-zeitachse="09:15"]`).first()).toBeAttached();
  await expect(page.locator(`[data-zeitachse="09:15"]`).first()).toHaveText("15");
  await expect(page.locator(`[data-zeitachse="09:00"]`).first()).toHaveText("09:00");
  await expect(page.locator(`[data-zeitachse="09:05"]`)).toHaveCount(0);
});

test("Raster unter Einstellungen → Kalender auf 5 Minuten: jede Zeile beschriftet, Termin bleibt an seiner Uhrzeit", async () => {
  await page.goto("/einstellungen/kalender");
  await page.getByRole("radio", { name: /^5 Minuten/ }).check();
  await page.getByRole("button", { name: "Speichern" }).click();
  await expect(page.getByText(/Raster „5 Minuten“ gespeichert/)).toBeVisible();

  await page.goto(`/kalender?modus=voll&ansicht=woche&datum=${MONDAY}`);
  const col = page.locator('[data-dnd-col][data-date="2031-06-17"]');
  await expect(col).toHaveAttribute("data-raster", "5");
  await expect(page.locator(`[data-zeitachse="09:05"]`).first()).toBeAttached();
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

/** Terminzeile der Liste („Einfach“) zu einem Termin */
const listRow = (id: string) => page.locator("[data-appt-row]").filter({ has: page.locator(`a[href^="/kalender/termin/${id}"]`) });

test("Liste („Einfach“): dieselben Markierungen wie auf „Heute“ – N/R und Kürzel der Behandler:in", async () => {
  await page.goto(`/kalender?modus=einfach&ansicht=woche&datum=${MONDAY}`);
  const first = listRow(ids.first);
  await expect(first.getByRole("img", { name: "Neupatient:in" })).toBeVisible();
  await expect(first.getByRole("img", { name: "Rechnung offen" })).toBeVisible();
  await expect(first.getByTestId("behandler-kuerzel")).toBeVisible();
  await expect(first.getByTestId("behandler-kuerzel")).toHaveAccessibleName(/^Behandler:in: /);
  // Legende N/R, sobald ein Symbol angezeigt wird
  await expect(page.getByTestId("symbol-legende")).toBeVisible();
  const second = listRow(ids.second);
  await expect(second.getByRole("img", { name: "Rechnung offen" })).toBeVisible();
  await expect(second.getByRole("img", { name: "Neupatient:in" })).toHaveCount(0);
  // künftiger Hausbesuch: kein R, aber das Kürzel
  await expect(listRow(ids.home).locator("[data-mark]")).toHaveCount(0);
  await expect(listRow(ids.home).getByTestId("behandler-kuerzel")).toBeVisible();
  // Anzeige-Filter „Hausbesuche“ wirkt auch hier (Markierungen nur für angezeigte Termine)
  await page.goto(`/kalender?modus=einfach&ansicht=woche&datum=${MONDAY}&hb=0`);
  await expect(listRow(ids.home)).toHaveCount(0);
  await expect(listRow(ids.first).getByRole("img", { name: "Neupatient:in" })).toBeVisible();
});

test("Woche: Kürzel der Behandler:in im Termin-Block neben N/R; Tag mit Spalten je Behandler:in: nur N/R", async () => {
  await page.goto(`/kalender?modus=voll&ansicht=woche&datum=2031-06-17`);
  let block = page.locator(`a[href="/kalender/termin/${ids.first}"]`);
  await expect(block.getByTestId("behandler-kuerzel")).toBeVisible();
  await expect(block.getByRole("img", { name: "Neupatient:in" })).toBeVisible();
  await expect(page.getByTestId("symbol-legende")).toBeVisible();
  // Tag: die Spalte steht schon für die Behandler:in – kein Kürzel in jedem Block
  await page.goto(`/kalender?modus=voll&ansicht=tag&datum=2031-06-17`);
  block = page.locator(`a[href="/kalender/termin/${ids.first}"]`);
  await expect(block.getByRole("img", { name: "Neupatient:in" })).toBeVisible();
  await expect(block.getByTestId("behandler-kuerzel")).toHaveCount(0);
});

test("Auswahl „Raster“ in der Werkzeugleiste: setzt die Einstellung, Ansicht und Datum bleiben", async () => {
  await page.goto(`/kalender?modus=voll&ansicht=woche&datum=${MONDAY}`);
  const raster = page.getByRole("combobox", { name: "Raster der Zeitachse" }).first();
  await raster.selectOption("60");
  await expect(page.locator('[data-dnd-col][data-date="2031-06-17"]')).toHaveAttribute("data-raster", "60");
  await expect(page).toHaveURL(new RegExp(`ansicht=woche&datum=${MONDAY}`));
  // nur volle Stunden beschriftet
  await expect(page.locator(`[data-zeitachse="09:30"]`)).toHaveCount(0);
  await expect(page.locator(`[data-zeitachse="09:00"]`).first()).toBeAttached();
  await expect(page.getByRole("combobox", { name: "Raster der Zeitachse" }).first()).toHaveValue("60");
  // dieselbe Einstellung wie unter Einstellungen → Kalender
  await page.goto("/einstellungen/kalender");
  await expect(page.getByRole("radio", { name: /^60 Minuten/ })).toBeChecked();
  // Monat hat keine Zeitachse → keine Auswahl
  await page.goto(`/kalender?modus=voll&ansicht=monat&datum=${MONDAY}`);
  await expect(page.getByRole("combobox", { name: "Raster der Zeitachse" })).toHaveCount(0);
});

test("Raster aus der Liste („Einfach“): wechselt in die vollständige Ansicht mit Zeitachse", async () => {
  // Platzhalter als aktueller Wert: auch das schon gespeicherte Raster (60 aus dem Test davor) wechselt in die Zeitachse
  await page.goto(`/kalender?modus=einfach&ansicht=tag&datum=2031-06-17`);
  const listRaster = page.getByRole("combobox", { name: "Raster der Zeitachse" }).first();
  await expect(listRaster).toHaveValue("");
  await expect(listRaster.locator("option:checked")).toHaveText(/öffnet Zeitachse/);
  await listRaster.selectOption("60");
  await expect(page.locator('[data-dnd-col][data-date="2031-06-17"]').first()).toHaveAttribute("data-raster", "60");
  await expect(page).toHaveURL(/ansicht=tag&datum=2031-06-17/);
  // anderes Raster aus der Liste
  await pool.query("update users set prefs = jsonb_set(prefs, '{calendar,mode}', '\"simple\"') where email = $1", [DEMO_EMAIL]);
  await page.goto(`/kalender?ansicht=tag&datum=2031-06-17`);
  await page.getByRole("combobox", { name: "Raster der Zeitachse" }).first().selectOption("30");
  await expect(page.locator('[data-dnd-col][data-date="2031-06-17"]').first()).toHaveAttribute("data-raster", "30");
  await expect(page).toHaveURL(/ansicht=tag&datum=2031-06-17/);
  await expect(page.locator(`[data-zeitachse="09:30"]`).first()).toBeAttached();
  // zurück auf „Einfach“: Einstellungsseite zeigt den Hinweis samt Knopf zur vollständigen Ansicht
  await pool.query("update users set prefs = jsonb_set(prefs, '{calendar,mode}', '\"simple\"') where email = $1", [DEMO_EMAIL]);
  await page.goto("/einstellungen/kalender");
  await expect(page.getByRole("status").filter({ hasText: "„Einfach“" })).toBeVisible();
  await page.getByRole("button", { name: "Vollständige Ansicht öffnen" }).click();
  await expect(page.locator("[data-dnd-col]").first()).toHaveAttribute("data-raster", "30");
});

