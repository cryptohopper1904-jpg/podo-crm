import { Pool } from "pg";

export const DEMO_EMAIL = "demo@podocrm.local";
export const DEMO_PASSWORD = "demo-passwort-123";

/** Slug der Demo-Praxis (scripts/seed-demo.ts erzeugt ihn zufällig) – organizations hat keine RLS. */
export async function demoSlug(): Promise<string> {
  const url = process.env.E2E_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL (bzw. E2E_DATABASE_URL) fehlt – für den Buchungs-Slug der Demo-Praxis.");
  const pool = new Pool({ connectionString: url, max: 1 });
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
