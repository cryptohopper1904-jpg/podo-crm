/**
 * Testdaten für echte DB-Tests (nur mit TEST_DATABASE_URL, erfundene Daten).
 * Legt Praxis, Benutzer, Personen und ausgestellte Rechnungen direkt per SQL an (App-Rolle, RLS aktiv).
 */
import { Pool, type PoolClient } from "pg";
import { vi } from "vitest";
import { addDaysIso } from "@/lib/calendar-grid";
import { berlinDateIso } from "@/lib/format";

export const TEST_DB = process.env.TEST_DATABASE_URL;

/**
 * Nach dem erneuten Einspielen einer ALTEN Migration in die gemeinsame Test-DB: Deren CREATE OR REPLACE FUNCTION setzt
 * den festen search_path zurück (Migration *_user_praxis_abgleich). Gleiche Anweisung wie dort – als Owner ausführen,
 * damit spätere Testdateien den Produktionsstand sehen.
 */
export const RESTORE_SEARCH_PATH_SQL = `DO $$
DECLARE fn regprocedure;
BEGIN
  FOR fn IN
    SELECT p.oid::regprocedure FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace AND p.prokind = 'f'
       AND pg_has_role(current_user, p.proowner, 'USAGE')
       AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
       AND NOT coalesce(p.proconfig, '{}'::text[]) @> ARRAY['search_path=pg_catalog, public, pg_temp']
  LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path = pg_catalog, public, pg_temp', fn);
  END LOOP;
END $$`;

/**
 * Altbestand nachstellen, den heutige Trigger nicht mehr zulassen (z. B. Support-Freigabe ohne Person): als Owner mit
 * session_replication_role = replica (Trigger aus). Braucht einen Superuser (TEST_OWNER_DATABASE_URL); sonst `false`
 * (Test dann überspringen).
 */
export async function insertLegacy(sql: string, params: unknown[]): Promise<boolean> {
  const url = process.env.TEST_OWNER_DATABASE_URL ?? (TEST_DB ?? "").replace(/\/\/[^:@/]+(:[^@/]*)?@/, "//podo_owner:podo_owner@");
  const pool = new Pool({ connectionString: url, max: 1 });
  try {
    if (!(await pool.query("select rolsuper from pg_roles where rolname = current_user")).rows[0]?.rolsuper) return false;
    const c = await pool.connect();
    try {
      await c.query("begin");
      await c.query("set local session_replication_role = replica");
      await c.query(sql, params);
      await c.query("commit");
    } finally {
      c.release();
    }
    return true;
  } finally {
    await pool.end();
  }
}

/**
 * Feste Systemzeit für zeitabhängige DB-Tests: mit `TEST_NOW` (ISO-Zeitpunkt, z. B. 2026-11-13T23:30:00Z) läuft
 * `Date` auf diesem Zeitpunkt – so lassen sich Tagesgrenzen (UTC-Abend = Berliner Folgetag) gezielt prüfen.
 * Nur `Date` wird ersetzt; Timer und die DB-Uhr laufen normal weiter.
 */
export function useTestClock() {
  const at = process.env.TEST_NOW;
  if (!at) return;
  const now = new Date(at);
  if (Number.isNaN(now.getTime())) throw new Error(`TEST_NOW ungültig: ${at}`);
  vi.useFakeTimers({ toFake: ["Date"], now });
}

/** Berliner Kalendertag relativ zu heute (`Date`, also auch unter `TEST_NOW`) – statt SQL `current_date` (Zeitzone der DB-Sitzung). */
export const berlinDay = (offsetDays = 0) => addDaysIso(berlinDateIso(), offsetDays);

export function fixtures(url: string) {
  const pool = new Pool({ connectionString: url, max: 3 });
  const sfx = () => Math.random().toString(36).slice(2, 10);
  /** angelegte Plattform-Admins – in end() wieder zurückgestuft (s. platformAdmin) */
  const admins: string[] = [];

  async function asOrg<T>(org: string, fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await pool.connect();
    try {
      await c.query("begin");
      await c.query("select set_config('app.org_id', $1, true)", [org]);
      const r = await fn(c);
      await c.query("commit");
      return r;
    } catch (e) {
      await c.query("rollback");
      throw e;
    } finally {
      c.release();
    }
  }

  return {
    pool,
    asOrg,
    async org(opts: { settings?: unknown; phone?: string } = {}) {
      const r = await pool.query("insert into organizations (name, slug, phone, settings) values ('Testpraxis Fuß', $1, $2, $3) returning id", [
        `t-${sfx()}`,
        opts.phone ?? "030 1234567",
        JSON.stringify(opts.settings ?? {}),
      ]);
      return r.rows[0].id as string;
    },
    /**
     * Benutzer:in; mit `org` zugleich Mitglied dieser Praxis (Rolle `role`). Wer in einer Praxis handelt (created_by,
     * author_id …) oder ihr zugeordnet wird, muss dort Mitglied sein (Trigger podo_user_in_org, *_user_praxis_abgleich).
     */
    async user(org?: string, role = "owner") {
      const id = (await pool.query("insert into users (email, name, password_hash) values ($1, 'Test', 'x') returning id", [`u-${sfx()}@example.org`])).rows[0].id as string;
      if (org) await pool.query("insert into memberships (organization_id, user_id, role) values ($1,$2,$3)", [org, id, role]);
      return id;
    },
    async patient(org: string, p: { lastName?: string; firstName?: string; email?: string | null; phoneMobile?: string | null; preferredChannel?: string } = {}) {
      return asOrg(org, async (c) => {
        const n = (await c.query("select coalesce(max(number), 0) + 1 as n from patients where organization_id = $1", [org])).rows[0].n;
        return (
          await c.query(
            "insert into patients (organization_id, number, last_name, first_name, email, phone_mobile, preferred_channel) values ($1,$2,$3,$4,$5,$6,$7) returning id",
            [org, n, p.lastName ?? "Muster", p.firstName ?? "Erika", p.email ?? null, p.phoneMobile ?? null, p.preferredChannel ?? "none"],
          )
        ).rows[0].id as string;
      });
    },
    async consent(org: string, patientId: string, type: string, granted = true) {
      await asOrg(org, (c) => c.query("insert into consents (organization_id, patient_id, type, granted) values ($1,$2,$3,$4)", [org, patientId, type, granted]));
    },
    /** Ausgestellte Rechnung mit einer 0-%-Position */
    async invoice(org: string, patientId: string | null, totalCents = 6500) {
      return asOrg(org, async (c) => {
        const id = (await c.query("insert into invoices (organization_id, patient_id, status) values ($1,$2,'draft') returning id", [org, patientId])).rows[0].id as string;
        await c.query("insert into invoice_lines (organization_id, invoice_id, description, unit_price_cents, total_cents, vat_rate, position) values ($1,$2,'Podologische Behandlung',$3,$3,0,1)", [org, id, totalCents]);
        await c.query("update invoices set status='issued', number=$2, issued_at=$4, due_at=$5, total_cents=$3, net_cents=$3 where id=$1", [id, `T${sfx()}`, totalCents, berlinDay(), berlinDay(14)]);
        return id;
      });
    },
    /**
     * Plattform-Admin (Support) ohne Mitgliedschaft. Wird in end() wieder zurückgestuft: listSupportAdmins() liefert
     * höchstens 100 Personen – angesammelte Test-Admins in der gemeinsamen Test-DB verdrängten sonst die anderer Tests.
     */
    async platformAdmin(totp = true) {
      const id = (await pool.query("insert into users (email, name, password_hash, is_platform_admin, totp_enabled) values ($1, 'Test', 'x', true, $2) returning id", [`a-${sfx()}@example.org`, totp]))
        .rows[0].id as string;
      admins.push(id);
      return id;
    },
    async end() {
      if (admins.length) await pool.query("update users set is_platform_admin = false where id = any($1::uuid[])", [admins]);
      await pool.end();
    },
  };
}
