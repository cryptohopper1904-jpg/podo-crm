/** „Passwort vergessen“ gegen PostgreSQL: Einmal-Token, Ablauf, keine Konten-Erkennung, Sitzungen beendet, Drosselung. */
import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined, set: () => undefined }), headers: async () => new Headers() }));
import { MockMailAdapter } from "@/integrations/mail/mail";
import { fixtures, TEST_DB } from "./__tests__/db-fixtures";

(TEST_DB ? describe : describe.skip)("Passwort vergessen (DB)", () => {
  const f = fixtures(TEST_DB!);
  let pr: typeof import("./password-reset");
  let pw: typeof import("@/lib/auth/password");

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB;
    pr = await import("./password-reset");
    pw = await import("@/lib/auth/password");
  });
  beforeEach(() => pr._resetPasswordResetLimits());
  afterAll(async () => {
    await f.end();
    const { db } = await import("@/db");
    await (db.$client as { end: () => Promise<void> }).end();
  });

  const account = async () => {
    const id = await f.user();
    const { rows } = await f.pool.query("select email from users where id = $1", [id]);
    return { id, email: rows[0].email as string };
  };
  const meta = (ip = `198.51.100.${Math.floor(Math.random() * 200)}`) => ({ ip, key: ip });
  const tokenFrom = (port: MockMailAdapter) => new URL(/https?:\/\/\S+/.exec(port.sent.at(-1)!.text)![0]).searchParams.get("token")!;
  const request = async (email: string, port: MockMailAdapter, m = meta()) => {
    const r = await pr.requestPasswordReset(email, m, { port });
    if (r.send) await r.send();
    return r;
  };

  it("gleiche Antwort mit und ohne Konto; nur der sha256 des Tokens steht in der DB", async () => {
    const a = await account();
    const port = new MockMailAdapter();
    const known = await request(a.email.toUpperCase(), port);
    const unknown = await request(`niemand-${Date.now()}@example.org`, port);
    expect(known.message).toBe(unknown.message);
    expect(unknown.send).toBeNull();
    expect(port.sent).toHaveLength(1);
    expect(port.sent[0].to).toBe(a.email);
    const token = tokenFrom(port);
    expect(token.length).toBeGreaterThanOrEqual(43);
    const { rows } = await f.pool.query("select token_hash, expires_at from password_resets where user_id = $1", [a.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0].token_hash).toBe(createHash("sha256").update(token).digest("hex"));
    expect(rows[0].token_hash).not.toContain(token);
    expect(new Date(rows[0].expires_at).getTime() - Date.now()).toBeLessThanOrEqual(30 * 60_000 + 5_000);
  });

  it("Token einmalig; setzt Passwort, beendet ALLE Sitzungen, hebt Sperre auf, 2FA bleibt", async () => {
    const a = await account();
    await f.pool.query("update users set failed_logins = 5, locked_until = now() + interval '10 minutes', totp_enabled = true where id = $1", [a.id]);
    await f.pool.query("insert into sessions (id, user_id, verified, expires_at) values ($1,$2,true, now() + interval '1 hour'), ($3,$2,true, now() + interval '1 hour')", [`s1-${a.id}`, a.id, `s2-${a.id}`]);
    const port = new MockMailAdapter();
    await request(a.email, port);
    const token = tokenFrom(port);
    expect(await pr.resetTokenValid(token)).toBe(true);
    expect(await pr.resetPassword(token, "kurz")).toMatchObject({ ok: false });
    expect(await pr.resetPassword(token, "ein-neues-langes-passwort")).toEqual({ ok: true });
    const u = (await f.pool.query("select password_hash, failed_logins, locked_until, totp_enabled from users where id = $1", [a.id])).rows[0];
    expect(await pw.verifyPassword(u.password_hash, "ein-neues-langes-passwort")).toBe(true);
    expect(u).toMatchObject({ failed_logins: 0, locked_until: null, totp_enabled: true });
    expect((await f.pool.query("select count(*)::int n from sessions where user_id = $1", [a.id])).rows[0].n).toBe(0);
    // zweite Verwendung
    expect(await pr.resetPassword(token, "noch-ein-anderes-passwort")).toEqual({ ok: false, error: pr.RESET_INVALID });
    expect(await pr.resetTokenValid(token)).toBe(false);
  });

  it("abgelaufenes Token und entwertete ältere Tokens werden abgelehnt", async () => {
    const a = await account();
    const port = new MockMailAdapter();
    await request(a.email, port);
    const first = tokenFrom(port);
    await request(a.email, port);
    const second = tokenFrom(port);
    expect(await pr.resetPassword(first, "ein-neues-langes-passwort")).toMatchObject({ ok: false });
    expect(await pr.resetPassword(second, "ein-neues-langes-passwort", new Date(Date.now() + 31 * 60_000))).toMatchObject({ ok: false });
    expect(await pr.resetPassword(second, "ein-neues-langes-passwort")).toEqual({ ok: true });
  });

  it("Drosselung je E-Mail-Adresse und je IP – Antwort bleibt neutral", async () => {
    const a = await account();
    const port = new MockMailAdapter();
    for (let i = 0; i < 5; i++) await request(a.email, port);
    expect(port.sent).toHaveLength(3);
    pr._resetPasswordResetLimits();
    const ip = meta("203.0.113.77");
    const results = [];
    for (let i = 0; i < 12; i++) results.push(await request(`x${i}-${a.email}`, port, ip));
    expect(new Set(results.map((r) => r.message)).size).toBe(1);
    const b = await account();
    await request(b.email, port, ip);
    expect(port.sent.at(-1)!.to).not.toBe(b.email);
  });

  it("Plattform-Admin kann einen Link schicken (nur mit 2FA), ohne das Passwort zu sehen", async () => {
    const a = await account();
    const port = new MockMailAdapter();
    await expect(pr.platformSendPasswordReset({ id: a.id, isPlatformAdmin: true, totpEnabled: false }, a.id, { port })).rejects.toThrow(/Zwei-Faktor/);
    const admin = await account();
    expect(await pr.platformSendPasswordReset({ id: admin.id, isPlatformAdmin: true, totpEnabled: true }, a.id, { port })).toEqual({ sent: true });
    expect(port.sent.at(-1)!.to).toBe(a.email);
    expect(port.sent.at(-1)!.text).not.toMatch(/Passwort:\s/);
  });
});
