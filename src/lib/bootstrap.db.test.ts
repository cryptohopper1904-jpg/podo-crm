/** Bootstrap per Umgebung: idempotent, Passwörter nur aus der Umgebung, vorhandene Konten bleiben unverändert. */
import { afterAll, describe, expect, it } from "vitest";
import path from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "../db/schema";
import { verifyPassword } from "./auth/password";
import { BootstrapError, loadPracticeSpec, runBootstrap, slugify } from "./bootstrap";

const TEST_DB = process.env.TEST_DATABASE_URL;
const ROOT = path.resolve(__dirname, "../..");
const sfx = () => Math.random().toString(36).slice(2, 8);

describe("Bootstrap-Datei deploy/bootstrap/kiehne.json", () => {
  it("ist gültig, enthält nur Geschäftsangaben und KEIN Passwort", () => {
    const spec = loadPracticeSpec("deploy/bootstrap/kiehne.json", ROOT);
    expect(spec.name).toBe("Podologie Kiehne");
    expect(spec.owner).toEqual({ email: "sven@podologie-kiehne.de", name: "Sven Kiehne" });
    expect(spec.openingHours.map((h) => h.weekday)).toEqual([2, 3]);
    expect(spec.homeVisitAreas).toContain("Berlin-Frohnau");
    expect(spec.services.map((s) => s.name)).toEqual(["Podologische Komplexbehandlung", "Nagelkorrekturspange", "Nagelprothetik", "Orthosen (individuell)", "Kaltplasma-Therapie", "Hausbesuch"]);
    expect(JSON.stringify(spec)).not.toMatch(/password|passwort/i);
  });
  it("lehnt unbekannte Felder ab (z. B. Patientenlisten)", () => {
    expect(() => loadPracticeSpec(JSON.stringify({ ...loadPracticeSpec("deploy/bootstrap/kiehne.json", ROOT), patients: [] }))).toThrow(BootstrapError);
  });
  it("slugify", () => expect(slugify("Podologie Müller & Söhne")).toBe("podologie-mueller-soehne"));
});

(TEST_DB ? describe : describe.skip)("Bootstrap (DB)", () => {
  const pool = new Pool({ connectionString: TEST_DB, max: 2 });
  const db = drizzle(pool, { schema });
  afterAll(() => pool.end());

  it("Plattform-Admin: einmal angelegt, ohne Mitgliedschaft; zweiter Lauf ändert das Passwort nicht", async () => {
    const email = `admin-${sfx()}@example.org`;
    const env = { BOOTSTRAP_ADMIN_EMAIL: email, BOOTSTRAP_ADMIN_NAME: "Admin Test", BOOTSTRAP_ADMIN_PASSWORD: "erstes-passwort-123" };
    expect((await runBootstrap(db, env)).admin).toBe("created");
    expect((await runBootstrap(db, { ...env, BOOTSTRAP_ADMIN_PASSWORD: "anderes-passwort-456" })).admin).toBe("exists");
    const rows = await pool.query("select id, is_platform_admin, totp_enabled, password_hash from users where email = $1", [email]);
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0]).toMatchObject({ is_platform_admin: true, totp_enabled: false });
    expect(await verifyPassword(rows.rows[0].password_hash, "erstes-passwort-123")).toBe(true);
    const m = await pool.query("select count(*)::int n from memberships where user_id = $1", [rows.rows[0].id]);
    expect(m.rows[0].n).toBe(0);
  });

  it("Plattform-Admin: zu kurzes Passwort → Fehler, nichts angelegt", async () => {
    const email = `admin-${sfx()}@example.org`;
    await expect(runBootstrap(db, { BOOTSTRAP_ADMIN_EMAIL: email, BOOTSTRAP_ADMIN_NAME: "X Y", BOOTSTRAP_ADMIN_PASSWORD: "kurz" })).rejects.toThrow(BootstrapError);
    expect((await pool.query("select 1 from users where email = $1", [email])).rowCount).toBe(0);
  });

  it("Praxis: idempotent über slug, Inhaber:in-Passwort nur aus der Umgebung", async () => {
    const slug = `kiehne-${sfx()}`;
    const ownerEmail = `owner-${sfx()}@example.org`;
    const spec = { ...loadPracticeSpec("deploy/bootstrap/kiehne.json", ROOT), slug, owner: { email: ownerEmail, name: "Sven Test", password: "aus-der-datei-123" } };
    const json = JSON.stringify(spec);
    // ohne Passwort in der Umgebung: Abbruch (das Passwort aus der Datei wird NICHT verwendet)
    await expect(runBootstrap(db, { BOOTSTRAP_PRACTICE_JSON: json })).rejects.toThrow(/BOOTSTRAP_PRACTICE_OWNER_PASSWORD/);
    expect((await pool.query("select 1 from organizations where slug = $1", [slug])).rowCount).toBe(0);

    const env = { BOOTSTRAP_PRACTICE_JSON: json, BOOTSTRAP_PRACTICE_OWNER_PASSWORD: "inhaber-passwort-123" };
    const first = await runBootstrap(db, env);
    expect(first).toMatchObject({ practice: "created", practiceSlug: slug });
    expect(first.warnings.join(" ")).toMatch(/owner.password.*ignoriert/);
    const second = await runBootstrap(db, { ...env, BOOTSTRAP_PRACTICE_OWNER_PASSWORD: "neues-passwort-456" });
    expect(second.practice).toBe("exists");

    const orgs = await pool.query("select id, plan, subscription_status, trial_ends_at, settings from organizations where slug = $1", [slug]);
    expect(orgs.rowCount).toBe(1);
    const org = orgs.rows[0];
    expect(org).toMatchObject({ plan: "trial", subscription_status: "trialing" });
    const days = (new Date(org.trial_ends_at).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29);
    expect(days).toBeLessThanOrEqual(30);
    expect(org.settings.openingHours).toEqual([{ weekday: 2, from: "08:00", to: "17:00" }, { weekday: 3, from: "08:00", to: "17:00" }]);
    expect(org.settings.opening).toEqual({ from: "08:00", to: "17:00" });
    expect(org.settings.homeVisitAreas).toHaveLength(6);
    expect(org.settings.servicePriceNotes.NP).toMatch(/Preis bitte prüfen/);
    expect(org.settings.website.enabled).toBe(false);

    const owner = await pool.query("select u.password_hash, m.role from users u join memberships m on m.user_id = u.id where u.email = $1 and m.organization_id = $2", [ownerEmail, org.id]);
    expect(owner.rowCount).toBe(1);
    expect(owner.rows[0].role).toBe("owner");
    expect(await verifyPassword(owner.rows[0].password_hash, "inhaber-passwort-123")).toBe(true);
    expect(await verifyPassword(owner.rows[0].password_hash, "aus-der-datei-123")).toBe(false);

    // Leistungen (RLS: nur im Mandantenkontext sichtbar) – genau einmal angelegt
    const c = await pool.connect();
    try {
      await c.query("begin");
      await c.query("select set_config('app.org_id', $1, true)", [org.id]);
      const svc = await c.query("select code, price_cents from services where organization_id = $1 order by code", [org.id]);
      expect(svc.rows.map((r) => r.code)).toEqual(["HB", "KP", "NP", "NS", "OI", "PK"]);
      expect(svc.rows.find((r) => r.code === "NP").price_cents).toBe(0);
      const loc = await c.query("select count(*)::int n from locations where organization_id = $1", [org.id]);
      expect(loc.rows[0].n).toBe(1);
      await c.query("commit");
    } finally {
      c.release();
    }
  });
});
