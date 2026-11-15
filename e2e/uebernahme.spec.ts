/**
 * Übernahme-Assistent (Einstellungen → Import → Daten übernehmen) mit den erfundenen Tinana-Fixtures:
 * Upload mehrerer Dateien → automatische Erkennung + Vorschau → Import → Patient:innen sichtbar → erneuter Upload legt nichts doppelt an.
 */
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { loginDemoWithFreshTotp } from "./support";

const FIX = path.resolve(__dirname, "../src/lib/import/__fixtures__/tinana");
const FILES = [
  "patients_export_2026-01-15.csv",
  "appointments_export_2026-01-15.csv",
  "prescriptions_export_2026-01-15.csv",
  "doctors_export_2026-01-15.csv",
  "invoices_export_2026-01-15.csv",
  "Umsatz_nach_Termin_Januar_2026.csv",
].map((f) => path.join(FIX, f));

test.describe.configure({ mode: "serial" });

async function preview(page: Page) {
  await page.goto("/einstellungen/import");
  await expect(page.getByRole("heading", { name: "Daten übernehmen" })).toBeVisible();
  await page.getByLabel(/Exportdateien Ihrer bisherigen Software/).setInputFiles(FILES);
  await page.getByRole("button", { name: "Dateien prüfen" }).click();
  await expect(page.getByRole("heading", { name: "Erkannte Dateien" })).toBeVisible();
}

test("Tinana-Export hochladen, Vorschau prüfen, importieren – Patient:innen sind sichtbar", async ({ page }) => {
  await loginDemoWithFreshTotp(page);
  await preview(page);
  const files = page.getByRole("heading", { name: "Erkannte Dateien" }).locator("..");
  await expect(files.getByText("Tinana – Patienten · 4 Datensätze → Patient:innen")).toBeVisible();
  await expect(files.getByText(/Tinana – Termine · 3 Datensätze/)).toBeVisible();
  await expect(files.getByText(/Tinana – Verordnungen · 2 Datensätze/)).toBeVisible();
  await expect(files.getByText(/Tinana – Umsatzbericht/)).toBeVisible();
  await expect(files.getByText(/Bericht \(Auswertung\), kein Datenexport/)).toBeVisible();

  // Beim ersten Lauf (frische Datenbank) gibt es etwas zu übernehmen; bei einem lokalen Wiederholungslauf ist schon alles da
  const runButton = page.getByRole("button", { name: "Import ausführen" });
  if (await runButton.isVisible()) {
    await expect(page.getByRole("heading", { name: "Beispiele (pseudonymisiert)" })).toBeVisible();
    // keine Klarnamen in den Beispielzeilen
    await expect(page.getByRole("heading", { name: "Beispiele (pseudonymisiert)" }).locator("..")).not.toContainText("Musterfrau");
    await runButton.click();
    await expect(page.getByText("Übernahme abgeschlossen.")).toBeVisible();
    await expect(page.getByText(/Angelegt: \d+ Patient:(in|innen), \d+ Termine?, \d+ Verordnung(en)?/)).toBeVisible();
  }

  // erneuter Upload derselben Dateien: nichts Neues
  await preview(page);
  await expect(page.getByText("Nichts Neues zu übernehmen.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Import ausführen" })).toHaveCount(0);

  await page.goto("/kunden?q=Musterfrau");
  await expect(page.getByRole("link", { name: /Musterfrau/ }).first()).toBeVisible();
  await page.goto("/kunden?q=Mustermann");
  await expect(page.getByRole("link", { name: /Mustermann/ }).first()).toBeVisible();
});

test("unbekannte Datei: klare Meldung mit den unterstützten Formaten", async ({ page }) => {
  await loginDemoWithFreshTotp(page);
  await page.goto("/einstellungen/import");
  await page.getByLabel(/Exportdateien Ihrer bisherigen Software/).setInputFiles({ name: "liste.csv", mimeType: "text/csv", buffer: Buffer.from("Name;Telefon\nA;1\n") });
  await page.getByRole("button", { name: "Dateien prüfen" }).click();
  await expect(page.getByText(/Format nicht erkannt\. Unterstützt werden: Tinana/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Import ausführen" })).toHaveCount(0);
});
