/**
 * Online-Anamnese gegen PostgreSQL (nur mit TEST_DATABASE_URL; erfundene Daten):
 * Ein Einmal-Link kann nur EINMAL eingelöst werden – auch nicht parallel, nicht nach Ablauf/Widerruf.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => {}) }));
import { Pool } from "pg";
import { generateLinkToken } from "@/lib/patient-link";
import { parseAnamnesis } from "@/lib/anamnesis";

const url = process.env.TEST_DATABASE_URL;

(url ? describe : describe.skip)("Online-Anamnese-Link (DB)", () => {
  let pool: Pool;
  let orgId: string, patientId: string;
  let submit: typeof import("@/server/anamnesis").submitOnlineAnamnesis;
  const data = (() => {
    const r = parseAnamnesis({ diabetes: "on", diabetesType: "2", medications: "Beispielmedikament" }, "online");
    if (!r.ok) throw new Error("parse");
    return r.data;
  })();

  async function asOrg<T>(sqlText: string, params: unknown[]): Promise<T[]> {
    const c = await pool.connect();
    try {
      await c.query("begin");
      await c.query("select set_config('app.org_id', $1, true)", [orgId]);
      const r = await c.query(sqlText, params);
      await c.query("commit");
      return r.rows as T[];
    } finally {
      c.release();
    }
  }

  async function newLink(opts: { expiresInMs?: number; revoked?: boolean } = {}) {
    const { token, tokenHash } = generateLinkToken();
    await pool.query(
      "insert into patient_links (organization_id, patient_id, purpose, token_hash, expires_at, revoked_at) values ($1,$2,'anamnesis',$3,$4,$5)",
      [orgId, patientId, tokenHash, new Date(Date.now() + (opts.expiresInMs ?? 7 * 86400_000)), opts.revoked ? new Date() : null],
    );
    return token;
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    pool = new Pool({ connectionString: url });
    orgId = (await pool.query("insert into organizations (name, slug) values ('Anamnese-Test', $1) returning id", [`an-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`])).rows[0].id;
    patientId = (await asOrg<{ id: string }>("insert into patients (organization_id, number, last_name, first_name) values ($1, 1, 'Muster', 'Erika') returning id", [orgId]))[0].id;
    submit = (await import("@/server/anamnesis")).submitOnlineAnamnesis;
  });

  afterAll(async () => {
    await pool?.end();
    await (globalThis as unknown as { pool?: Pool }).pool?.end();
  });

  it("speichert einmal und verweigert die zweite Nutzung", async () => {
    const token = await newLink();
    expect(await submit(token, data, ["sms_reminders"], { ip: "203.0.113.7" })).toEqual({ ok: true });
    expect(await submit(token, data, ["sms_reminders"])).toEqual({ ok: false });

    const an = await asOrg<{ data: { source: string; diabetes: boolean } }>("select data from anamneses where patient_id = $1", [patientId]);
    expect(an).toHaveLength(1);
    expect(an[0].data).toMatchObject({ source: "online", diabetes: true });
    const cons = await asOrg<{ type: string; via: string; granted: boolean }>("select type, via, granted from consents where patient_id = $1 order by type", [patientId]);
    // jede Online-Einwilligung mit tatsächlichem Wert (nicht angehakt = false)
    expect(Object.fromEntries(cons.map((c) => [c.type, c.granted]))).toEqual({
      privacy_notice: true, sms_reminders: true, email_reminders: false, photo_documentation: false, whatsapp: false,
    });
    expect(cons.every((c) => c.via === "online-anamnese")).toBe(true);
    const aud = await asOrg<{ action: string; ip: string | null }>("select action, ip from audit_log where entity_id = $1 and action = 'anamnesis.online.submit'", [patientId]);
    expect(aud).toHaveLength(1);
    expect(aud[0].ip).toBe("203.0.113.7");
    const msg = await asOrg<{ subject: string; body: string }>("select subject, body from messages where patient_id = $1", [patientId]);
    expect(msg).toHaveLength(1);
    expect(msg[0].subject).toBe("Anamnesebogen eingegangen");
    expect(msg[0].body).not.toContain("Beispielmedikament");
  });

  it("parallele Einlösung: genau eine gewinnt", async () => {
    const token = await newLink();
    const results = await Promise.all([submit(token, data, []), submit(token, data, []), submit(token, data, [])]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
  });

  it("abgelaufene, widerrufene und unbekannte Links werden abgewiesen", async () => {
    expect(await submit(await newLink({ expiresInMs: -1000 }), data, [])).toEqual({ ok: false });
    expect(await submit(await newLink({ revoked: true }), data, [])).toEqual({ ok: false });
    expect(await submit(generateLinkToken().token, data, [])).toEqual({ ok: false });
    expect(await submit("kaputt", data, [])).toEqual({ ok: false });
  });

  it("parallele Link-Erzeugung hinterlässt genau einen gültigen Link", async () => {
    const { createAnamnesisLink } = await import("@/server/anamnesis");
    const { can } = await import("@/lib/auth/permissions");
    const userId = (await pool.query("insert into users (email, name, password_hash) values ($1, 'T', 'x') returning id", [`an-${Date.now()}@example.org`])).rows[0].id;
    const auth = { sessionId: "s", user: { id: userId, email: "t@example.org", name: "T", totpEnabled: false }, organization: { id: orgId, name: "P", slug: "p", smallBusiness: false, state: "BB" }, role: "owner" as const, can: (p: Parameters<typeof can>[1]) => can("owner", p) };
    const results = await Promise.all(Array.from({ length: 5 }, () => createAnamnesisLink(auth, patientId)));
    expect(results.filter((r) => "token" in r).length).toBeGreaterThanOrEqual(1);
    const active = await pool.query("select count(*)::int n from patient_links where patient_id = $1 and purpose = 'anamnesis' and used_at is null and revoked_at is null", [patientId]);
    expect(active.rows[0].n).toBe(1);
  });

  it("anamneses bleiben unveränderbar (Versionen)", async () => {
    await expect(asOrg("update anamneses set data = '{}'::jsonb where patient_id = $1", [patientId])).rejects.toThrow(/unveränderbar/);
  });
});
