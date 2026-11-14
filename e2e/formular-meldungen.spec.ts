/**
 * Formular-Meldungen (src/components/form-error.tsx) im Browser:
 *  - eine Meldung, die schon beim Laden da ist, wird weder angesprungen noch fokussiert,
 *  - eine Fehlermeldung nach dem Absenden wird in den sichtbaren Bereich geholt und fokussiert (Handy: man steht unten
 *    am Knopf, die Meldung steht oben im Formular).
 */
import { expect, test, type BrowserContext } from "@playwright/test";
import { loginDemoWithFreshTotp } from "./support";

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
