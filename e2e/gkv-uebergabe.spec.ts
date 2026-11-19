/**
 * GKV Paket E, Laufseite: Erst-Export des Übergabepakets ohne JSON-Seite. Fehler (hier 429/409 aus der Route,
 * nachgestellt per Request-Abfang) erscheinen als Meldung auf der Seite; der echte Erst-Export (POST, Pflicht-Häkchen)
 * startet den Download und zeigt danach ohne Neuladen den neuen Status. Erfundene Daten: leerer Lauf „E2E Übergabe …“
 * (Läufe sind nicht löschbar – je Lauf ein neuer).
 */
import { expect, test } from "@playwright/test";
import { loginDemoWithFreshTotp, withDemoOrg } from "./support";

let batchId: string;

test.beforeAll(async () => {
  batchId = await withDemoOrg(async (q, org) => {
    const r = await q("insert into billing_batches (organization_id, partner, note) values ($1, 'other', $2) returning id", [org, `E2E Übergabe ${Date.now().toString(36)}`]);
    return r.rows[0].id as string;
  });
});

test("Erst-Export: Fehler als Meldung, Erfolg lädt herunter und zeigt den Lauf als übergeben", async ({ page }) => {
  await loginDemoWithFreshTotp(page);
  await page.goto(`/verordnungen/abrechnung/${batchId}`);
  await expect(page.getByText("noch nicht übergeben")).toBeVisible();
  const submit = page.getByRole("button", { name: "Übergabepaket erzeugen und herunterladen" });
  const confirm = page.getByRole("checkbox", { name: /Ich übergebe diesen Abrechnungslauf/ });

  // Pflicht-Häkchen: ohne Bestätigung geht keine Anfrage raus
  let posts = 0;
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().endsWith(`/api/export/gkv-batch/${batchId}/paket`)) posts++;
  });
  await submit.click();
  await expect(page).toHaveURL(new RegExp(`/verordnungen/abrechnung/${batchId}$`));
  expect(posts).toBe(0);

  // Rate-Limit und Konflikt der Route → Meldung auf der Laufseite, keine JSON-Seite
  const paket = `**/api/export/gkv-batch/${batchId}/paket`;
  await page.route(paket, (route) =>
    route.request().method() === "POST"
      ? route.fulfill({ status: 429, contentType: "application/json", body: JSON.stringify({ error: "Zu viele Exporte in kurzer Zeit – bitte eine Minute warten und dann erneut versuchen." }) })
      : route.continue(),
  );
  await confirm.check();
  await submit.click();
  await expect(page.locator("#uebergabe-fehler")).toContainText("Zu viele Exporte in kurzer Zeit");
  await expect(page).toHaveURL(new RegExp(`/verordnungen/abrechnung/${batchId}$`));
  await page.unroute(paket);
  await page.route(paket, (route) =>
    route.request().method() === "POST" ? route.fulfill({ status: 409, contentType: "text/plain", body: "kaputt" }) : route.continue(),
  );
  await submit.click();
  await expect(page.locator("#uebergabe-fehler")).toContainText("Das Übergabepaket konnte nicht erzeugt werden.");
  await page.unroute(paket);
  await expect(page.getByText("noch nicht übergeben")).toBeVisible();

  // echter Erst-Export: Download startet, Seite zeigt ohne Neuladen „übergeben“ und den Nachdruck
  const download = page.waitForEvent("download");
  await submit.click();
  expect((await download).suggestedFilename()).toMatch(/^Uebergabe-\d{4}-\d{2}-\d{2}-[0-9a-f]{8}\.zip$/);
  await expect(page.getByRole("link", { name: "Übergabepaket (Nachdruck)" })).toBeVisible();
  await expect(page.getByText(/^übergeben \d{2}\.\d{2}\.\d{4}$/)).toBeVisible();
  await expect(submit).toHaveCount(0);
  await expect(page.locator("#uebergabe-fehler")).toBeHidden();
});
