/**
 * Formular-Meldungen (src/components/form-error.tsx) im Browser:
 *  - eine Meldung, die schon beim Laden da ist, wird weder angesprungen noch fokussiert,
 *  - eine Fehlermeldung nach dem Absenden wird in den sichtbaren Bereich geholt und fokussiert (Handy: man steht unten
 *    am Knopf, die Meldung steht oben im Formular),
 *  - Wartelisten-Angebot im Portal: nach dem Annehmen verschwindet der Knopf, die Meldung bekommt den Fokus (nicht <body>).
 */
import { Pool } from "pg";
import { expect, test, type BrowserContext } from "@playwright/test";
import { hashPortalToken, newPortalToken } from "../src/lib/portal";
import { DEMO_EMAIL, loginDemoWithFreshTotp } from "./support";

let storageState: Awaited<ReturnType<BrowserContext["storageState"]>>;

test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext({ locale: "de-DE", timezoneId: "Europe/Berlin" });
  await loginDemoWithFreshTotp(await context.newPage());
  storageState = await context.storageState();
  await context.close();
});

const phone = { viewport: { width: 375, height: 667 }, isMobile: true, hasTouch: true, locale: "de-DE", timezoneId: "Europe/Berlin" };

test("Meldung beim Laden: kein Sprung, kein Fokus", async ({ browser }) => {
  const context = await browser.newContext({ ...phone, storageState });
  const page = await context.newPage();
  // „Von“ nach „Bis“ → die Seite rendert sofort eine FormError
  await page.goto("/kasse/export?from=2026-05-01&to=2026-01-01");
  const alert = page.getByRole("alert").filter({ hasText: "„Von“ liegt nach „Bis“." });
  await expect(alert).toBeVisible();
  await page.waitForTimeout(500);
  await expect(alert).not.toBeFocused();
  expect(await page.evaluate(() => scrollY)).toBe(0);
  await context.close();
});

test("Fehler nach dem Absenden wird angesprungen und fokussiert", async ({ browser }) => {
  const context = await browser.newContext({ ...phone, storageState });
  const page = await context.newPage();
  await page.goto("/kalender/neu");
  // Feld mit Einheit: die Einheit gehört zum zugänglichen Namen (Field schreibt sie ins <label>)
  await expect(page.getByRole("spinbutton", { name: "Dauer in Minuten", exact: true })).toBeVisible();
  // Pflichtfeld leeren und die Browser-Prüfung abschalten → die Server Action meldet den Fehler
  await page.locator('input[name="time"]').fill("");
  await page.evaluate(() => {
    (document.querySelector('input[name="time"]') as HTMLInputElement).form!.noValidate = true;
  });
  const submit = page.getByRole("button", { name: "Termin eintragen" });
  await submit.scrollIntoViewIfNeeded();
  await submit.click();
  const alert = page.locator("main p[role=alert]");
  await expect(alert).toBeVisible();
  await expect(alert).toBeFocused();
  await expect(alert).toBeInViewport();
  await context.close();
});

/**
 * Wartelisten-Angebot direkt anlegen (wie src/server/waitlist.ts offerFreedSlot, ohne Versand) – für eine eigene,
 * am Ende wieder entfernte Testperson: abgesagter Termin in ferner Zukunft (Zufalls-Offset, nachts) + Einmal-Link.
 * `block()` legt danach einen überlappenden Termin an (vergeben). `cleanup()` entfernt alles, was der Test bzw. die
 * Annahme angelegt hat (Termine, Link, Posteingang, Testperson) und schließt die Verbindung.
 */
async function createOffer(label: string) {
  const pool = new Pool({ connectionString: process.env.E2E_DATABASE_URL ?? process.env.DATABASE_URL, max: 1 });
  const asOrg = async <T>(org: string, fn: (q: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>) => Promise<T>) => {
    const c = await pool.connect();
    try {
      await c.query("begin");
      await c.query("select set_config('app.org_id', $1, true)", [org]);
      const r = await fn((sql, params) => c.query(sql, params));
      await c.query("commit");
      return r;
    } catch (e) {
      await c.query("rollback").catch(() => {});
      throw e;
    } finally {
      c.release();
    }
  };
  const org = (await pool.query("select o.id from organizations o join memberships m on m.organization_id = o.id join users u on u.id = m.user_id where u.email = $1 order by o.created_at limit 1", [DEMO_EMAIL])).rows[0].id as string;
  // 2040–2048, 03:00 UTC: weit weg von Demo- und anderen Testterminen
  const startsAt = new Date(Date.UTC(2040, 0, 1, 3, 0) + Math.floor(Math.random() * 3000) * 86_400_000);
  const ids = { patient: "", offerAppt: "" };
  try {
    const token = newPortalToken();
    await asOrg(org, async (q) => {
      const n = (await q("select coalesce(max(number), 0) + 1 as n from patients where organization_id = $1", [org])).rows[0].n;
      ids.patient = (await q("insert into patients (organization_id, number, first_name, last_name) values ($1, $2, 'E2E', $3) returning id", [org, n, `Angebot ${label}`])).rows[0].id as string;
      ids.offerAppt = (await q("insert into appointments (organization_id, starts_at, ends_at, status, title) values ($1, $2, $2::timestamptz + interval '30 minutes', 'cancelled', 'E2E Angebot') returning id", [org, startsAt.toISOString()])).rows[0].id as string;
      await q("insert into patient_links (organization_id, patient_id, purpose, token_hash, expires_at, appointment_id) values ($1, $2, 'waitlist_offer', $3, now() + interval '2 days', $4)", [org, ids.patient, hashPortalToken(token), ids.offerAppt]);
    });
    const block = () =>
      asOrg(org, (q) => q("insert into appointments (organization_id, starts_at, ends_at, status, title) values ($1, $2, $2::timestamptz + interval '30 minutes', 'planned', 'E2E belegt')", [org, startsAt.toISOString()]));
    const cleanup = async () => {
      try {
        await asOrg(org, async (q) => {
          // alles im Zeitfenster dieses Tests (Angebot, Blocker, per Annahme angelegter Termin) und an der Testperson
          await q("delete from appointments where organization_id = $1 and (patient_id = $2 or (starts_at = $3 and title in ('E2E Angebot', 'E2E belegt')))", [org, ids.patient, startsAt.toISOString()]);
          await q("delete from messages where organization_id = $1 and patient_id = $2", [org, ids.patient]);
          await q("delete from patient_links where organization_id = $1 and patient_id = $2", [org, ids.patient]);
          await q("delete from patients where organization_id = $1 and id = $2", [org, ids.patient]);
        });
      } finally {
        await pool.end();
      }
    };
    return { token, block, cleanup };
  } catch (e) {
    await pool.end();
    throw e;
  }
}

test("Portal-Angebot annehmen: Knopf weg, Bestätigung fokussiert", async ({ browser }) => {
  const offer = await createOffer("annehmen");
  const context = await browser.newContext(phone);
  try {
    const page = await context.newPage();
    await page.goto(`/portal/angebot/${offer.token}`);
    const accept = page.getByRole("button", { name: /^Termin annehmen/ });
    await accept.click();
    // Die Annahme lädt die Seite neu (refresh()) → Ansicht „angenommen“ statt Formular; sie bekommt den Fokus.
    // Titel „Termin angenommen“ (in diesem Tab eben angenommen, Merker im sessionStorage), nicht „bereits angenommen“.
    const done = page.getByRole("region", { name: "Termin angenommen", exact: true });
    await expect(done).toBeVisible();
    await expect(done).toBeFocused();
    await expect(accept).toHaveCount(0);
    // später erneut geöffnet: nichts wird fokussiert
    await page.reload();
    await expect(done).toBeVisible();
    await expect(done).not.toBeFocused();
  } finally {
    await context.close();
    await offer.cleanup();
  }
});

test("Portal-Angebot schon vergeben: Knopf weg, Fehlermeldung fokussiert", async ({ browser }) => {
  const offer = await createOffer("vergeben");
  const context = await browser.newContext(phone);
  try {
    const page = await context.newPage();
    await page.goto(`/portal/angebot/${offer.token}`);
    const accept = page.getByRole("button", { name: /^Termin annehmen/ });
    await expect(accept).toBeVisible();
    await offer.block(); // jemand anderes war schneller
    await accept.click();
    const alert = page.getByRole("alert").filter({ hasText: "Leider schon vergeben" });
    await expect(alert).toBeVisible();
    await expect(alert).toBeFocused();
    await expect(accept).toHaveCount(0);
  } finally {
    await context.close();
    await offer.cleanup();
  }
});
