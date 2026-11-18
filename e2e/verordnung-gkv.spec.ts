/**
 * GKV-Grundlagen (docs/GKV.md): Verordnungsformular mit Pflichtangaben nach Anlage 3 (Prüfziffer-Hinweis LANR,
 * fehlender Arztstempel → Fehler „Behandlung darf nicht beginnen“) und Termin auf eine Verordnung mit Warnung
 * (Termin nach dem spätesten Behandlungsbeginn). Erfundene Daten, Person „VOtest…“ wird je Lauf neu angelegt.
 */
import { expect, test, type BrowserContext } from "@playwright/test";
import { Pool } from "pg";
import { DEMO_EMAIL, loginDemoWithFreshTotp } from "./support";

test.describe.configure({ mode: "serial" });

let storageState: Awaited<ReturnType<BrowserContext["storageState"]>>;

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

const berlinToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin" }).format(new Date());
const addDays = (iso: string, n: number) => new Date(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10) + n)).toISOString().slice(0, 10);

let patientId: string;

test.beforeAll(async ({ browser }) => {
  await demoSql("delete from appointments where organization_id = $org and patient_id in (select id from patients where organization_id = $org and last_name like 'VOtest%')");
  await demoSql("delete from prescriptions where organization_id = $org and patient_id in (select id from patients where organization_id = $org and last_name like 'VOtest%')");
  // Personen nur über podo_delete_patient (App-Rolle ohne DELETE auf patients, Migration 0067)
  await demoSql("select podo_delete_patient(id) from patients where organization_id = $org and last_name like 'VOtest%'");
  const [p] = await demoSql<{ id: string }>(
    `insert into patients (organization_id, number, last_name, first_name, birth_date, insurance_type, insurer_name, insurer_ik, insurance_number, insured_status)
     values ($org, (select coalesce(max(number), 0) + 1 from patients where organization_id = $org), $2, 'Erika', '1950-03-01', 'gkv', 'Beispiel-BKK', '109911114', 'A000500015', '1') returning id`,
    [`VOtest${Date.now().toString(36)}`],
  );
  patientId = p.id;
  const context = await browser.newContext({ locale: "de-DE", timezoneId: "Europe/Berlin" });
  const page = await context.newPage();
  await loginDemoWithFreshTotp(page);
  storageState = await context.storageState();
  await context.close();
});

test("Verordnungsformular: Personalienfeld vorbelegt, LANR-Prüfziffer, fehlender Arztstempel als Fehler", async ({ browser }) => {
  const context = await browser.newContext({ storageState, locale: "de-DE", timezoneId: "Europe/Berlin" });
  const page = await context.newPage();
  await page.goto(`/kunden/${patientId}/verordnungen?neu=1`);
  // nur das Verordnungsformular (die Karte „Zuzahlungsbefreiung“ hat ebenfalls ein IK-Feld)
  const form = page.locator("form", { has: page.getByRole("button", { name: "Verordnung anlegen" }) });
  await expect(form.getByLabel("Versichertennummer (KVNR)")).toHaveValue("A000500015");
  await expect(form.getByLabel("IK der Krankenkasse")).toHaveValue("109911114");
  await form.getByLabel("ICD-10", { exact: true }).fill("E11.74");
  await form.getByLabel("Leitsymptomatik", { exact: true }).selectOption("c");
  await form.getByLabel("LANR").fill("123456701");
  await form.getByLabel("BSNR").fill("123456789");
  await form.getByLabel("BSNR").focus();
  await expect(form.getByText(/LANR 123456701: Prüfziffer/)).toBeVisible();
  await form.getByLabel("Positionsnr.").fill("78020");
  await form.getByLabel("Bezeichnung").fill("Podologische Behandlung (groß)");
  // Arztstempel/Unterschrift bewusst NICHT anhaken
  await page.getByRole("button", { name: "Verordnung anlegen" }).click();
  await page.waitForURL(/gespeichert=/);
  await expect(page.getByText(/Fehler \(Behandlung darf nicht beginnen\): Arztstempel und Unterschrift fehlen/).first()).toBeVisible();
  await expect(page.getByText(/Bitte prüfen: LANR 123456701/).first()).toBeVisible();
  const [vo] = await demoSql<{ doctor_signed: boolean | null; insurer_ik: string; rules_version: string }>("select doctor_signed, insurer_ik, rules_version from prescriptions where organization_id = $org and patient_id = $2", [patientId]);
  expect(vo).toMatchObject({ doctor_signed: false, insurer_ik: "109911114" });
  await context.close();
});

test("Termin auf Verordnung: Auswahl vorgeschlagen, Warnung nach Beginnfrist, Zuordnung gespeichert", async ({ browser }) => {
  const context = await browser.newContext({ storageState, locale: "de-DE", timezoneId: "Europe/Berlin" });
  const page = await context.newPage();
  const date = addDays(berlinToday(), 40);
  await page.goto(`/kalender/neu?patient=${patientId}&datum=${date}&zeit=07:05`);
  const picker = page.getByTestId("termin-verordnung");
  await expect(picker.getByLabel("Verordnung (GKV)")).toBeVisible();
  await expect(picker.getByText(/nach dem spätesten Behandlungsbeginn/)).toBeVisible();
  await page.getByRole("button", { name: "Termin eintragen" }).click();
  // Konflikte (Arbeitszeit/Sperrzeit) ggf. bewusst übergehen
  const force = page.getByLabel(/Trotzdem eintragen/);
  if (await force.isVisible({ timeout: 3000 }).catch(() => false)) {
    await force.check();
    await page.getByRole("button", { name: "Termin eintragen" }).click();
  }
  await page.waitForURL(/\/kalender\?datum=/);
  const rows = await demoSql<{ prescription_id: string | null }>("select a.prescription_id from appointments a where a.organization_id = $org and a.patient_id = $2", [patientId]);
  expect(rows).toHaveLength(1);
  expect(rows[0].prescription_id).not.toBeNull();
  await context.close();
});
