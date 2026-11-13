/**
 * Kalender (vollständige Ansicht): Termin in der Wochenansicht per Zeiger ziehen → verschoben; „Rückgängig“ stellt
 * die alte Zeit wieder her. Termin wird direkt in der DB angelegt (weit in der Zukunft, ohne Überschneidung).
 */
import { expect, test, type Page } from "@playwright/test";
import { Pool } from "pg";
import { totpCode } from "../src/lib/auth/totp";
import { DEMO_EMAIL, DEMO_PASSWORD, resetDemoTotp } from "./support";

test.describe.configure({ mode: "serial" });

const dbUrl = () => process.env.E2E_DATABASE_URL ?? process.env.DATABASE_URL ?? "";
let page: Page;
let pool: Pool;
let org = "";
let apptId = "";
// Montag einer Woche in ferner Zukunft (keine Seed-Termine, keine Feiertage)
const MONDAY = "2031-06-02";

async function login(p: Page) {
  await resetDemoTotp();
  await p.goto("/login");
  await p.getByLabel("E-Mail", { exact: true }).fill(DEMO_EMAIL);
  await p.getByLabel("Passwort", { exact: true }).fill(DEMO_PASSWORD);
  await p.getByRole("button", { name: "Anmelden" }).click();
  await expect(p).toHaveURL(/\/login\/2fa-einrichten/, { timeout: 45_000 });
  await p.getByRole("button", { name: "Jetzt einrichten" }).click();
  const secret = (await p.locator("code").innerText()).replace(/\s/g, "");
  await p.getByLabel("Code", { exact: true }).fill(totpCode(secret));
  await p.getByRole("button", { name: "Bestätigen" }).click();
  await expect(p).toHaveURL(/\/heute/, { timeout: 45_000 });
}

async function startsAt(): Promise<string> {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query("select set_config('app.org_id', $1, true)", [org]);
    const r = await c.query("select starts_at from appointments where id = $1", [apptId]);
    await c.query("commit");
    return (r.rows[0].starts_at as Date).toISOString();
  } finally {
    c.release();
  }
}

test.beforeAll(async ({ browser }) => {
  pool = new Pool({ connectionString: dbUrl(), max: 2 });
  const r = await pool.query(
    "select m.organization_id, m.user_id from memberships m join users u on u.id = m.user_id where u.email = $1 and m.role = 'owner' order by m.created_at limit 1",
    [DEMO_EMAIL],
  );
  org = r.rows[0].organization_id;
  const user = r.rows[0].user_id;
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query("select set_config('app.org_id', $1, true)", [org]);
    await c.query("delete from appointments where organization_id = $1 and title = 'E2E Ziehen'", [org]);
    // Di 03.06.2031 10:00–10:30 (Berlin, Sommerzeit)
    apptId = (
      await c.query(
        "insert into appointments (organization_id, therapist_id, starts_at, ends_at, status, source, title) values ($1,$2,'2031-06-03T08:00:00Z','2031-06-03T08:30:00Z','planned','phone','E2E Ziehen') returning id",
        [org, user],
      )
    ).rows[0].id;
    await c.query("commit");
  } finally {
    c.release();
  }
  page = await (await browser.newContext()).newPage();
  await login(page);
});

test.afterAll(async () => {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query("select set_config('app.org_id', $1, true)", [org]);
    await c.query("delete from appointments where id = $1", [apptId]);
    await c.query("commit");
  } finally {
    c.release();
  }
  await pool.end();
  await page.context().close();
});

test("Wochenansicht: Termin per Zeiger auf Mittwoch 11:00 ziehen, dann Rückgängig", async () => {
  await page.goto(`/kalender?modus=voll&ansicht=woche&datum=${MONDAY}`);
  const block = page.locator(`[data-appt="${apptId}"]`);
  await expect(block).toHaveAttribute("data-movable", "1");
  await block.scrollIntoViewIfNeeded();
  const box = (await block.boundingBox())!;
  const tue = (await page.locator('[data-dnd-col][data-date="2031-06-03"]').boundingBox())!;
  const wed = (await page.locator('[data-dnd-col][data-date="2031-06-04"]').boundingBox())!;
  const x0 = box.x + box.width / 2, y0 = box.y + 4;
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  // eine Spalte nach rechts, eine Stunde (64 px) nach unten
  for (let i = 1; i <= 8; i++) await page.mouse.move(x0 + ((wed.x - tue.x) * i) / 8, y0 + (64 * i) / 8);
  await expect(page.locator('[data-dnd-ghost="drag"]')).toContainText("Mi 11:00–11:30");
  await page.mouse.up();
  await expect(page.locator("[data-dnd-toast]")).toContainText("verschoben auf Mi 4.6. 11:00–11:30 Uhr");
  await expect.poll(startsAt).toBe("2031-06-04T09:00:00.000Z");
  await expect(page).toHaveURL(/datum=2031-06-02/); // kein Öffnen des Termins nach dem Ziehen

  await page.locator("[data-dnd-toast]").getByRole("button", { name: "Rückgängig" }).click();
  await expect(page.locator("[data-dnd-toast]")).toContainText("Zurückgesetzt");
  await expect.poll(startsAt).toBe("2031-06-03T08:00:00.000Z");
});
