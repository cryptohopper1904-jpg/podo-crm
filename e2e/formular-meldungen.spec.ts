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
 * Wartelisten-Angebot direkt anlegen (wie src/server/waitlist.ts offerFreedSlot, ohne Versand): abgesagter Termin in
 * ferner Zukunft + Einmal-Link für eine Demo-Person. `blocker`: danach einen überlappenden Termin anlegen (vergeben).
 */
async function createOffer(patientIndex: number) {
  const pool = new Pool({ connectionString: process.env.E2E_DATABASE_URL ?? process.env.DATABASE_URL, max: 1 });
  const c = await pool.connect();
  try {
    const org = (await c.query("select o.id from organizations o join memberships m on m.organization_id = o.id join users u on u.id = m.user_id where u.email = $1 order by o.created_at limit 1", [DEMO_EMAIL])).rows[0].id as string;
    // eindeutiger Zeitpunkt je Lauf (2033+, nachts), damit frühere Läufe nichts blockieren
    const startsAt = new Date(Date.UTC(2033, 0, 1, 2, 0) + Math.floor(Math.random() * 3000) * 86_400_000 + patientIndex * 3_600_000);
    await c.query("begin");
    await c.query("select set_config('app.org_id', $1, true)", [org]);
    const patientId = (await c.query("select id from patients where organization_id = $1 and archived_at is null order by number offset $2 limit 1", [org, patientIndex])).rows[0].id as string;
    // evtl. offenes Angebot dieser Person aus früheren Läufen schließen (höchstens eines je Person)
    await c.query("update patient_links set revoked_at = now() where organization_id = $1 and patient_id = $2 and purpose = 'waitlist_offer' and used_at is null and revoked_at is null", [org, patientId]);
    const appt = (await c.query("insert into appointments (organization_id, starts_at, ends_at, status, title) values ($1, $2, $2::timestamptz + interval '30 minutes', 'cancelled', 'E2E Angebot') returning id", [org, startsAt.toISOString()])).rows[0].id as string;
    const token = newPortalToken();
    await c.query("insert into patient_links (organization_id, patient_id, purpose, token_hash, expires_at, appointment_id) values ($1, $2, 'waitlist_offer', $3, now() + interval '2 days', $4)", [org, patientId, hashPortalToken(token), appt]);
    await c.query("commit");
    const block = async () => {
      const d = await pool.connect();
      try {
        await d.query("begin");
        await d.query("select set_config('app.org_id', $1, true)", [org]);
        await d.query("insert into appointments (organization_id, starts_at, ends_at, status, title) values ($1, $2, $2::timestamptz + interval '30 minutes', 'planned', 'E2E belegt')", [org, startsAt.toISOString()]);
        await d.query("commit");
      } finally {
        d.release();
      }
    };
    return { token, block, end: () => pool.end() };
  } finally {
    c.release();
  }
}

test("Portal-Angebot annehmen: Knopf weg, Bestätigung fokussiert", async ({ browser }) => {
  const offer = await createOffer(0);
  const context = await browser.newContext(phone);
  const page = await context.newPage();
  await page.goto(`/portal/angebot/${offer.token}`);
  const accept = page.getByRole("button", { name: /^Termin annehmen/ });
  await accept.click();
  // Die Annahme lädt die Seite neu (revalidatePath) → Ansicht „angenommen“ statt Formular; sie bekommt den Fokus
  const done = page.locator("[data-offer-accepted]");
  await expect(done).toContainText("angenommen");
  await expect(done).toBeFocused();
  await expect(accept).toHaveCount(0);
  // später erneut geöffnet: nichts wird fokussiert
  await page.reload();
  await expect(done).toBeVisible();
  await expect(done).not.toBeFocused();
  await context.close();
  await offer.end();
});

test("Portal-Angebot schon vergeben: Knopf weg, Fehlermeldung fokussiert", async ({ browser }) => {
  const offer = await createOffer(1);
  const context = await browser.newContext(phone);
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
  await context.close();
  await offer.end();
});
