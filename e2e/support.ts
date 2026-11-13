import { Pool } from "pg";
import type { Page } from "@playwright/test";
import { totpCode } from "../src/lib/auth/totp";

/** Demo-Zugang anmelden inkl. Pflicht-2FA-Einrichtung (setzt die 2FA vorher zurück). Endet auf /heute. */
export async function loginDemoWithFreshTotp(page: Page): Promise<void> {
  await resetDemoTotp();
  await page.goto("/login");
  await page.getByLabel("E-Mail", { exact: true }).fill(DEMO_EMAIL);
  await page.getByLabel("Passwort", { exact: true }).fill(DEMO_PASSWORD);
  await page.getByRole("button", { name: "Anmelden" }).click();
  await page.waitForURL(/\/login\/2fa-einrichten/);
  await page.getByRole("button", { name: "Jetzt einrichten" }).click();
  const secret = (await page.locator("code").innerText()).replace(/\s/g, "");
  await page.getByLabel("Code", { exact: true }).fill(totpCode(secret));
  await page.getByRole("button", { name: "Bestätigen" }).click();
  await page.waitForURL(/\/heute/);
}

export const DEMO_EMAIL = "demo@podocrm.local";
export const DEMO_PASSWORD = "demo-passwort-123";

function dbUrl(): string {
  const url = process.env.E2E_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL (bzw. E2E_DATABASE_URL) fehlt.");
  return url;
}

/**
 * 2FA der Demo-Inhaber:in zurücksetzen: Inhaber:innen haben Pflicht-2FA (Gesamt-Review H1) – der Test richtet
 * sie bei jedem Lauf über /login/2fa-einrichten neu ein (users hat keine RLS).
 */
export async function resetDemoTotp(): Promise<void> {
  const pool = new Pool({ connectionString: dbUrl(), max: 1 });
  try {
    await pool.query("update users set totp_enabled = false, totp_secret_enc = null, totp_last_step = null where email = $1", [DEMO_EMAIL]);
  } finally {
    await pool.end();
  }
}

/** Slug der Demo-Praxis (scripts/seed-demo.ts erzeugt ihn zufällig) – organizations hat keine RLS. */
export async function demoSlug(): Promise<string> {
  const pool = new Pool({ connectionString: dbUrl(), max: 1 });
  try {
    const r = await pool.query(
      "select o.slug from organizations o join memberships m on m.organization_id = o.id join users u on u.id = m.user_id where u.email = $1 order by o.created_at limit 1",
      [DEMO_EMAIL],
    );
    if (!r.rows[0]) throw new Error("Demo-Praxis nicht gefunden – bitte `pnpm db:seed` ausführen.");
    return r.rows[0].slug as string;
  } finally {
    await pool.end();
  }
}
