/**
 * GKV-Härtung (Migration 0067) gegen PostgreSQL (App-Rolle, RLS aktiv, erfundene Daten):
 * 1. Abrechnungslauf: Anzahl und Summen werden beim Commit gegen die darin abgerechneten Verordnungen geprüft
 *    (CONSTRAINT TRIGGER, aufgeschoben); Altläufe (vor 0067, ohne Prüfung angelegt) bleiben unberührt.
 * 2. Abgerechnete Verordnungen (billed_at oder Lauf gesetzt) sind nicht löschbar – außer im Löschlauf der Person, den
 *    podo_delete_patient bei abgerechneten Verordnungen ohnehin verweigert.
 * 3. Zweiter gleichzeitiger Export eines Laufs: kein Fehler, Übergabezeitpunkt bleibt der erste.
 */
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => {}) }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
import { addDaysIso } from "@/lib/calendar-grid";
import { berlinDateIso } from "@/lib/format";
import { RULES_VERSION } from "@/lib/rules/prescription";
import { fixtures, insertLegacy, TEST_DB } from "./__tests__/db-fixtures";

(TEST_DB ? describe : describe.skip)("GKV-Härtung 0067 (DB)", () => {
  const fx = fixtures(TEST_DB ?? "");
  const today = berlinDateIso();
  let presc: typeof import("./prescriptions");
  let dbm: typeof import("@/db");

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB;
    presc = await import("./prescriptions");
    dbm = await import("@/db");
  });
  afterAll(async () => {
    await fx.end();
    await (dbm.db.$client as { end: () => Promise<void> }).end();
  });

  const world = async () => {
    const org = await fx.org();
    const user = await fx.user(org);
    const patient = await fx.patient(org, { lastName: "Musterfrau", firstName: "Erika" });
    await fx.pool.query("update organizations set ik = '109911114' where id = $1", [org]);
    const auth = {
      organization: { id: org, name: "Testpraxis", slug: "t", smallBusiness: false, state: "BB", billingMode: "with_gkv" },
      user: { id: user, name: "Anna Test" },
      role: "owner",
      readOnly: false,
      support: null,
      can: () => true,
    } as never;
    const q = <T = Record<string, unknown>>(text: string, params: unknown[] = []) => fx.asOrg(org, async (c) => (await c.query(text, params)).rows as T[]);
    return { org, user, patient, auth, q };
  };

  /** abgerechnete Verordnung im Lauf (INSERT mit Lauf nur in einen eben angelegten Lauf, 0066) */
  const VO_BILLED = `insert into prescriptions (organization_id, patient_id, issued_at, diagnosis_group, units, status, billed_at, billing_batch_id, remedy_cost_cents, copayment_cents,
       positions, rules_version, icd10, insurer_ik, insurance_number, insured_status, prescription_kind, prescription_kind_confirmed_at)
     values ($1,$2,$3,'DF',1,'billed',now(),$4,$5,$6,'[{"position":"78020","label":"groß","units":1}]',$7,'E11.74','109911114','A000500015','1','03',now()) returning id`;

  describe("1. Summenprüfung beim Commit", () => {
    const run = (w: Awaited<ReturnType<typeof world>>, batch: { count: number; total: number; copay: number | null; remedy: number | null }, vos: { remedy: number | null; copay: number | null }[]) =>
      fx.asOrg(w.org, async (c) => {
        const b = (
          await c.query("insert into billing_batches (organization_id, prescription_count, total_cents, copayment_total_cents, remedy_total_cents) values ($1,$2,$3,$4,$5) returning id", [
            w.org,
            batch.count,
            batch.total,
            batch.copay,
            batch.remedy,
          ])
        ).rows[0].id as string;
        for (const v of vos) await c.query(VO_BILLED, [w.org, w.patient, addDaysIso(today, -20), b, v.remedy, v.copay, RULES_VERSION]);
        return b;
      });

    it("passende Anzahl und Summen: Lauf wird angelegt (fehlende Beträge zählen 0)", async () => {
      const w = await world();
      const b = await run(w, { count: 2, total: 1712, copay: 1712, remedy: 7110 }, [
        { remedy: 7110, copay: 1712 },
        { remedy: null, copay: null },
      ]);
      expect(await w.q("select prescription_count from billing_batches where id = $1", [b])).toEqual([{ prescription_count: 2 }]);
    });

    it.each([
      ["Anzahl", { count: 2, total: 1712, copay: 1712, remedy: 7110 }],
      ["Zuzahlungssumme (total_cents)", { count: 1, total: 1700, copay: 1712, remedy: 7110 }],
      ["Zuzahlungssumme (copayment_total_cents)", { count: 1, total: 1712, copay: 1700, remedy: 7110 }],
      ["Heilmittelkosten", { count: 1, total: 1712, copay: 1712, remedy: 7000 }],
      ["Heilmittelkosten fehlen", { count: 1, total: 1712, copay: 1712, remedy: null }],
      ["Zuzahlungssumme fehlt", { count: 1, total: 1712, copay: null, remedy: 7110 }],
    ])("abweichende %s: Commit abgelehnt, nichts gespeichert", async (_, batch) => {
      const w = await world();
      await expect(run(w, batch, [{ remedy: 7110, copay: 1712 }])).rejects.toThrow(/Abrechnungslauf passt nicht zu den abgerechneten Verordnungen/);
      expect(await w.q("select id from billing_batches")).toEqual([]);
      expect(await w.q("select id from prescriptions where status = 'billed'")).toEqual([]);
    });

    it("Lauf ohne Verordnungen abgelehnt (auch mit Anzahl 0); Verordnung, die den Lauf im selben Vorgang verlässt, zählt nicht", async () => {
      const w = await world();
      await expect(run(w, { count: 0, total: 0, copay: 0, remedy: 0 }, [])).rejects.toThrow(/passt nicht/);
      await expect(run(w, { count: 1, total: 0, copay: 0, remedy: 0 }, [])).rejects.toThrow(/passt nicht/);
      // nur Verordnungen im Status „abgerechnet“ zählen: Korrektur im selben Vorgang → Lauf passt nicht mehr
      await expect(
        fx.asOrg(w.org, async (c) => {
          const b = (await c.query("insert into billing_batches (organization_id, prescription_count, total_cents, copayment_total_cents, remedy_total_cents) values ($1, 1, 1712, 1712, 7110) returning id", [w.org])).rows[0].id as string;
          const id = (await c.query(VO_BILLED, [w.org, w.patient, addDaysIso(today, -20), b, 7110, 1712, RULES_VERSION])).rows[0].id as string;
          await c.query("insert into prescription_corrections (organization_id, prescription_id, patient_id, reason, created_by) values ($1,$2,$3,'ICD falsch',$4)", [w.org, id, w.patient, w.user]);
          await c.query("update prescriptions set status = 'correction_needed' where id = $1", [id]);
        }),
      ).rejects.toThrow(/passt nicht/);
    });

    it("Altlauf (vor 0067, ohne Prüfung angelegt) bleibt unberührt: Übergabe weiter möglich", async (ctx) => {
      const w = await world();
      const legacy = "00000000-0000-4000-8000-" + Math.random().toString(16).slice(2, 14).padEnd(12, "0");
      if (!(await insertLegacy("insert into billing_batches (id, organization_id, prescription_count, total_cents) values ($1, $2, 5, 999)", [legacy, w.org]))) ctx.skip();
      await w.q("update billing_batches set exported_at = now(), status = 'exported' where id = $1", [legacy]);
      expect(await w.q("select status from billing_batches where id = $1", [legacy])).toEqual([{ status: "exported" }]);
    });

    it("createBillingBatch erfüllt die Prüfung (Weg der Anwendung)", async () => {
      const w = await world();
      // abrechnungsreif mit vollständigem Preis-Snapshot (wie nach „Abrechnungsreif“), ohne Behandlungen
      const ids = [];
      for (const [remedy, copay] of [
        [7110, 1712],
        [4000, null],
      ])
        ids.push(
          (
            await w.q<{ id: string }>(
              `insert into prescriptions (organization_id, patient_id, issued_at, diagnosis_group, units, status, remedy_cost_cents, copayment_cents, price_snapshot, prescription_kind, prescription_kind_confirmed_at, rules_version)
               values ($1,$2,$3,'DF',1,'billing_ready',$4,$5,'{"complete": true, "lines": [], "notes": []}','03',now(),$6) returning id`,
              [w.org, w.patient, addDaysIso(today, -20), remedy, copay, RULES_VERSION],
            )
          )[0].id,
        );
      const batch = await presc.createBillingBatch(w.auth, ids, { partner: "manual" });
      expect(batch).toMatchObject({ count: 2 });
      expect(await w.q("select prescription_count, total_cents, copayment_total_cents, remedy_total_cents from billing_batches")).toEqual([
        { prescription_count: 2, total_cents: 1712, copayment_total_cents: 1712, remedy_total_cents: 11110 },
      ]);
    });
  });

  describe("2. Lösch-Guard für abgerechnete Verordnungen", () => {
    it("abgerechnete Verordnung (Lauf) bzw. mit billed_at nicht löschbar; offene schon", async () => {
      const w = await world();
      const inBatch = await fx.asOrg(w.org, async (c) => {
        const b = (await c.query("insert into billing_batches (organization_id, prescription_count, total_cents, copayment_total_cents, remedy_total_cents) values ($1, 1, 0, 0, 0) returning id", [w.org])).rows[0].id as string;
        return (await c.query(VO_BILLED, [w.org, w.patient, today, b, null, null, RULES_VERSION])).rows[0].id as string;
      });
      const billedAt = (await w.q<{ id: string }>("insert into prescriptions (organization_id, patient_id, issued_at, diagnosis_group, units, status, billed_at) values ($1,$2,$3,'DF',1,'cancelled',now()) returning id", [w.org, w.patient, today]))[0].id;
      const open = (await w.q<{ id: string }>("insert into prescriptions (organization_id, patient_id, issued_at, diagnosis_group, units) values ($1,$2,$3,'DF',1) returning id", [w.org, w.patient, today]))[0].id;
      for (const id of [inBatch, billedAt]) await expect(w.q("delete from prescriptions where id = $1", [id])).rejects.toThrow(/abgerechnete Verordnung kann nicht gelöscht werden/);
      await w.q("delete from prescriptions where id = $1", [open]);
      expect((await w.q<{ id: string }>("select id from prescriptions")).map((r) => r.id).sort()).toEqual([inBatch, billedAt].sort());
    });

    it("Lauf ohne billed_at (INSERT in eben angelegten Lauf) sperrt die Löschung der Person; ohne Abrechnung wird gelöscht", async () => {
      const w = await world();
      // Verordnung mit Lauf, aber ohne billed_at (vom INSERT-Guard zugelassen)
      await fx.asOrg(w.org, async (c) => {
        const b = (await c.query("insert into billing_batches (organization_id, prescription_count, total_cents, copayment_total_cents, remedy_total_cents) values ($1, 1, 0, 0, 0) returning id", [w.org])).rows[0].id as string;
        await c.query("insert into prescriptions (organization_id, patient_id, issued_at, diagnosis_group, units, status, billing_batch_id) values ($1,$2,$3,'DF',1,'billed',$4)", [w.org, w.patient, today, b]);
      });
      await expect(w.q("select podo_delete_patient($1::uuid)", [w.patient])).rejects.toThrow(/Aufbewahrungspflichtige Daten/);
      expect(await w.q("select count(*)::int as n from prescriptions where patient_id = $1", [w.patient])).toEqual([{ n: 1 }]);
      // Person nur mit offener Verordnung: vollständige Löschung (Kaskade, Guard lässt nicht abgerechnete Verordnungen durch)
      const plain = await fx.patient(w.org, { lastName: "Ohne" });
      await w.q("insert into prescriptions (organization_id, patient_id, issued_at, diagnosis_group, units) values ($1,$2,$3,'DF',1)", [w.org, plain, today]);
      expect(await w.q("select podo_delete_patient($1::uuid) as ok", [plain])).toEqual([{ ok: true }]);
      expect(await w.q("select count(*)::int as n from prescriptions where patient_id = $1", [plain])).toEqual([{ n: 0 }]);
    });

    it("Kaskade über die Person ohne Löschlauf (podo.patient_delete nicht gesetzt) wird abgewiesen", async (ctx) => {
      const w = await world();
      await w.q("insert into prescriptions (organization_id, patient_id, issued_at, diagnosis_group, units, status, billed_at) values ($1,$2,$3,'DF',1,'cancelled',now())", [w.org, w.patient, today]);
      // als Eigentümer (umgeht podo_delete_patient): Löschen der Person kaskadiert auf die Verordnung → Guard
      const owner = new Pool({ connectionString: process.env.TEST_OWNER_DATABASE_URL ?? (TEST_DB ?? "").replace(/\/\/[^:@/]+(:[^@/]*)?@/, "//podo_owner:podo_owner@"), max: 1 });
      try {
        const c = await owner.connect().catch(() => null);
        if (!c) ctx.skip();
        try {
          await c!.query("begin");
          await c!.query("select set_config('app.org_id', $1, true)", [w.org]);
          await expect(c!.query("delete from patients where id = $1", [w.patient])).rejects.toThrow(/abgerechnete Verordnung kann nicht gelöscht werden/);
          await c!.query("rollback");
        } finally {
          c!.release();
        }
      } finally {
        await owner.end();
      }
    });
  });

  describe("3. Export", () => {
    it("zweiter gleichzeitiger Export: kein Fehler, Übergabezeitpunkt bleibt der erste", async () => {
      const w = await world();
      const b = await fx.asOrg(w.org, async (c) => {
        const b = (await c.query("insert into billing_batches (organization_id, prescription_count, total_cents, copayment_total_cents, remedy_total_cents) values ($1, 1, 1712, 1712, 7110) returning id", [w.org])).rows[0].id as string;
        await c.query(VO_BILLED, [w.org, w.patient, addDaysIso(today, -20), b, 7110, 1712, RULES_VERSION]);
        return b;
      });
      // erster Export hält die Zeilensperre (Übergabe vermerkt, noch nicht committet); der zweite liest „nicht übergeben“
      // und wartet beim UPDATE – nach dem Commit des ersten darf er nichts mehr ändern (statt Guard-Fehler)
      const first = await fx.pool.connect();
      try {
        await first.query("begin");
        await first.query("select set_config('app.org_id', $1, true)", [w.org]);
        const [{ exported_at: at }] = (await first.query("update billing_batches set exported_at = now(), status = 'exported' where id = $1 returning exported_at", [b])).rows;
        const second = presc.billingBatchExport(w.auth, b);
        await new Promise((r) => setTimeout(r, 500));
        await first.query("commit");
        const exp = await second;
        expect(exp).not.toBeNull();
        expect(await w.q("select status, exported_at from billing_batches where id = $1", [b])).toEqual([{ status: "exported", exported_at: at }]);
      } finally {
        first.release();
      }
    });
  });
});
