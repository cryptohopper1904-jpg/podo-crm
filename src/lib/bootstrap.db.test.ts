/** Bootstrap per Umgebung: idempotent, Passwörter nur aus der Umgebung, vorhandene Konten bleiben unverändert. */
import { afterAll, describe, expect, it } from "vitest";
import path from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "../db/schema";
import { verifyPassword } from "./auth/password";
import { BootstrapError, DEMO_PRACTICE_NAME, DEMO_PRACTICE_SLUG, loadPracticeSpec, runBootstrap, slugify } from "./bootstrap";

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
    // Podologie Kiehne behandelt Privatpatient:innen & Selbstzahler
    expect(spec.billingMode).toBe("private_only");
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
    const env = { BOOTSTRAP_ADMIN_EMAIL: email, BOOTSTRAP_ADMIN_NAME: "Admin Test", BOOTSTRAP_ADMIN_PASSWORD: "erstes-passwort-123", BOOTSTRAP_ADMIN_DEMO: "false" };
    const first = await runBootstrap(db, env);
    expect(first).toMatchObject({ admin: "created", demo: "skipped" });
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
    expect(org.settings.billingMode).toBe("private_only");

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

  it("billingMode: auf vorhandene Praxis nur gesetzt, wenn noch keiner gesetzt ist (idempotent)", async () => {
    const slug = `kiehne-bm-${sfx()}`;
    const ownerEmail = `owner-${sfx()}@example.org`;
    const spec = { ...loadPracticeSpec("deploy/bootstrap/kiehne.json", ROOT), slug, owner: { email: ownerEmail, name: "Sven Test" } };
    const env = { BOOTSTRAP_PRACTICE_JSON: JSON.stringify(spec), BOOTSTRAP_PRACTICE_OWNER_PASSWORD: "inhaber-passwort-123" };
    expect((await runBootstrap(db, env)).practice).toBe("created");
    // Bestandspraxis aus einer älteren Bootstrap-Version: ohne billingMode
    await pool.query("update organizations set settings = settings - 'billingMode' where slug = $1", [slug]);
    const second = await runBootstrap(db, env);
    expect(second).toMatchObject({ practice: "exists", billingMode: "set" });
    const mode = async () => (await pool.query("select settings->>'billingMode' m from organizations where slug = $1", [slug])).rows[0].m;
    expect(await mode()).toBe("private_only");
    expect((await runBootstrap(db, env)).billingMode).toBe("kept");
    // Praxis stellt in den Einstellungen um → Bootstrap überschreibt das nie
    await pool.query("update organizations set settings = settings || '{\"billingMode\":\"with_gkv\"}'::jsonb where slug = $1", [slug]);
    expect((await runBootstrap(db, env)).billingMode).toBe("kept");
    expect(await mode()).toBe("with_gkv");
    const orgId = (await pool.query("select id from organizations where slug = $1", [slug])).rows[0].id;
    const c = await pool.connect();
    try {
      await c.query("begin");
      await c.query("select set_config('app.org_id', $1, true)", [orgId]);
      const audits = await c.query("select count(*)::int n from audit_log where organization_id = $1 and action = 'bootstrap.billing_mode'", [orgId]);
      expect(audits.rows[0].n).toBe(1);
      await c.query("commit");
    } finally {
      c.release();
    }
  });

  it("Demo-Praxis: einmal mit erfundenen Daten angelegt, Admin als aktive:r Inhaber:in; weitere Läufe sichern nur die Mitgliedschaft", async () => {
    const asDemoOrg = async <T,>(orgId: string, fn: (c: import("pg").PoolClient) => Promise<T>) => {
      const c = await pool.connect();
      try {
        await c.query("begin");
        await c.query("select set_config('app.org_id', $1, true)", [orgId]);
        const r = await fn(c);
        await c.query("commit");
        return r;
      } finally {
        c.release();
      }
    };
    const email = `admin-${sfx()}@example.org`;
    const env = { BOOTSTRAP_ADMIN_EMAIL: email, BOOTSTRAP_ADMIN_NAME: "Admin Demo", BOOTSTRAP_ADMIN_PASSWORD: "erstes-passwort-123" };
    const orgsBefore = (await pool.query("select count(*)::int n from organizations")).rows[0].n;
    const first = await runBootstrap(db, env);
    expect(first.admin).toBe("created");
    expect(["created", "exists"]).toContain(first.demo); // die Demo-Praxis kann aus früheren Testläufen stammen
    const orgs = await pool.query("select id, name, plan, subscription_status, trial_ends_at, settings from organizations where slug = $1", [DEMO_PRACTICE_SLUG]);
    expect(orgs.rowCount).toBe(1);
    const org = orgs.rows[0];
    expect(org).toMatchObject({ name: DEMO_PRACTICE_NAME, plan: "internal", subscription_status: "active", trial_ends_at: null });
    expect(org.settings.demo).toBe(true);
    expect(org.settings.billingMode ?? "with_gkv").toBe("with_gkv"); // Demo-Praxis bleibt mit Kassenzulassung
    expect((await pool.query("select count(*)::int n from organizations")).rows[0].n).toBe(orgsBefore + (first.demo === "created" ? 1 : 0));

    const admin = (await pool.query("select id from users where email = $1", [email])).rows[0];
    const m = await pool.query("select organization_id, role, active from memberships where user_id = $1", [admin.id]);
    expect(m.rows).toEqual([{ organization_id: org.id, role: "owner", active: true }]);

    const counts = async () =>
      asDemoOrg(org.id, async (c) => {
        const q = async (t: string) => (await c.query(`select count(*)::int n from ${t} where organization_id = $1`, [org.id])).rows[0].n as number;
        const fake = await c.query("select count(*)::int n from patients where organization_id = $1 and (source <> 'demo' or email not like '%@example.org')", [org.id]);
        return { patients: await q("patients"), appointments: await q("appointments"), records: await q("treatment_records"), invoices: await q("invoices"), services: await q("services"), notDemo: fake.rows[0].n as number };
      });
    const c1 = await counts();
    expect(c1.patients).toBe(8);
    expect(c1.appointments).toBeGreaterThanOrEqual(16);
    expect(c1.records).toBeGreaterThanOrEqual(10);
    expect(c1.invoices).toBeGreaterThanOrEqual(10);
    expect(c1.services).toBeGreaterThan(0);
    expect(c1.notDemo).toBe(0);

    // zweiter Lauf: nichts doppelt; deaktivierte Mitgliedschaft wird wieder aktiv
    await pool.query("update memberships set active = false, role = 'therapist' where user_id = $1", [admin.id]);
    expect((await runBootstrap(db, env)).demo).toBe("exists");
    expect((await pool.query("select role, active from memberships where user_id = $1", [admin.id])).rows).toEqual([{ role: "owner", active: true }]);
    expect(await counts()).toEqual(c1);
    expect((await pool.query("select count(*)::int n from organizations where slug = $1", [DEMO_PRACTICE_SLUG])).rows[0].n).toBe(1);

    // ein zweiter Plattform-Admin wird Inhaber:in derselben Demo-Praxis – Daten bleiben unverändert
    const email2 = `admin-${sfx()}@example.org`;
    expect((await runBootstrap(db, { ...env, BOOTSTRAP_ADMIN_EMAIL: email2 })).demo).toBe("exists");
    const m2 = await pool.query("select m.role from memberships m join users u on u.id = m.user_id where u.email = $1 and m.organization_id = $2", [email2, org.id]);
    expect(m2.rows).toEqual([{ role: "owner" }]);
    expect(await counts()).toEqual(c1);

    // BOOTSTRAP_ADMIN_DEMO=false → keine Mitgliedschaft
    const email3 = `admin-${sfx()}@example.org`;
    expect((await runBootstrap(db, { ...env, BOOTSTRAP_ADMIN_EMAIL: email3, BOOTSTRAP_ADMIN_DEMO: "false" })).demo).toBe("skipped");
    expect((await pool.query("select 1 from memberships m join users u on u.id = m.user_id where u.email = $1", [email3])).rowCount).toBe(0);
  });
});
