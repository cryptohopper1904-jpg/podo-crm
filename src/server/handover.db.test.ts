/**
 * Übergabe-Modus (Gerät an Patient:in): Sitzung gesperrt → keine Praxisdaten, requireAuth leitet auf /entsperren;
 * Entsperren nur mit PIN/Passwort der angemeldeten Person, nach 5 Fehlversuchen bzw. 30 Minuten abgemeldet.
 */
import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));

const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (n: string) => (jar.has(n) ? { name: n, value: jar.get(n)! } : undefined),
    set: (n: string, v: string, o?: { maxAge?: number }) => (o?.maxAge === 0 || v === "" ? jar.delete(n) : jar.set(n, v)),
    delete: (n: string) => jar.delete(n),
  }),
  headers: async () => new Headers({ "x-podo-method": "GET", "x-podo-path": "/test", "user-agent": "vitest" }),
}));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw Object.assign(new Error(`REDIRECT ${to}`), { to });
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

import { fixtures, TEST_DB } from "./__tests__/db-fixtures";

const sha = (t: string) => createHash("sha256").update(t).digest("hex");
const redirectOf = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return (e as { to?: string }).to ?? Promise.reject(e);
  }
  return null;
};
const fd = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};

(TEST_DB ? describe : describe.skip)("Übergabe-Modus (DB)", () => {
  const f = fixtures(TEST_DB!);
  let session: typeof import("@/lib/auth/session");
  let unlock: typeof import("@/app/(auth)/entsperren/actions");
  let password: typeof import("@/lib/auth/password");
  let authActions: typeof import("@/app/(auth)/actions");

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB;
    session = await import("@/lib/auth/session");
    unlock = await import("@/app/(auth)/entsperren/actions");
    password = await import("@/lib/auth/password");
    authActions = await import("@/app/(auth)/actions");
  });
  afterAll(async () => {
    await f.end();
    const { db } = await import("@/db");
    await (db.$client as { end: () => Promise<void> }).end();
  });
  beforeEach(() => jar.clear());

  const setup = async () => {
    const org = await f.org();
    await f.pool.query("update organizations set plan = 'internal', subscription_status = 'active' where id = $1", [org]);
    const user = await f.user();
    await f.pool.query("update users set totp_enabled = true, password_hash = $2, unlock_pin_hash = $3 where id = $1", [
      user,
      await password.hashPassword("richtiges-passwort-123"),
      await password.hashPassword("4711"),
    ]);
    await f.pool.query("insert into memberships (organization_id, user_id, role) values ($1,$2,'owner')", [org, user]);
    const token = randomBytes(24).toString("base64url");
    await f.pool.query("insert into sessions (id, user_id, organization_id, verified, expires_at) values ($1,$2,$3,true,$4)", [sha(token), user, org, new Date(Date.now() + 3600_000)]);
    jar.set(session.SESSION_COOKIE, token);
    return { org, user, token };
  };
  const row = async (token: string) => (await f.pool.query("select * from sessions where id = $1", [sha(token)])).rows[0] ?? null;
  /** Token nach dem Sperren (wird dabei rotiert) */
  const current = () => jar.get(session.SESSION_COOKIE)!;

  it("gesperrt: keine Praxisdaten, requireAuth → /entsperren; PIN entsperrt und springt zurück", async () => {
    const { token } = await setup();
    expect(await session.getAuth()).not.toBeNull();
    expect(await session.lockCurrentSession("/kunden/abc/anamnese")).toBe(true);
    expect(current()).not.toBe(token);
    expect(await row(token)).toBeNull();
    expect(await session.getAuth()).toBeNull();
    expect(await session.getSession()).toBeNull();
    expect(await redirectOf(session.requireAuth("patients.read"))).toBe("/entsperren");

    expect(await unlock.unlockAction(undefined, fd({ secret: "0000" }))).toMatchObject({ error: expect.stringMatching(/Noch 4 Versuch/) });
    expect(await redirectOf(unlock.unlockAction(undefined, fd({ secret: "4711" })))).toBe("/kunden/abc/anamnese");
    expect(await row(current())).toMatchObject({ locked_at: null, unlock_failures: 0 });
    expect(await session.getAuth()).not.toBeNull();
  });

  it("Passwort entsperrt ebenfalls; fremde Rücksprungziele werden verworfen", async () => {
    await setup();
    await session.lockCurrentSession("//evil.example/x");
    expect((await row(current())).lock_return).toBe("/heute");
    expect(await redirectOf(unlock.unlockAction(undefined, fd({ secret: "richtiges-passwort-123" })))).toBe("/heute");
  });

  it("5 Fehlversuche beenden die Sitzung", async () => {
    await setup();
    await session.lockCurrentSession("/heute");
    const t = current();
    for (let i = 0; i < 4; i++) expect(await unlock.unlockAction(undefined, fd({ secret: "9999" }))).toHaveProperty("error");
    expect(await redirectOf(unlock.unlockAction(undefined, fd({ secret: "9999" })))).toBe("/login?entsperren=gesperrt");
    expect(await row(t)).toBeNull();
  });

  it("nach 30 Minuten Sperre ist die Sitzung beendet – auch die richtige PIN entsperrt nicht mehr", async () => {
    await setup();
    await session.lockCurrentSession("/heute");
    const t = current();
    await f.pool.query("update sessions set locked_at = now() - interval '31 minutes' where id = $1", [sha(t)]);
    expect(await redirectOf(unlock.unlockAction(undefined, fd({ secret: "4711" })))).toBe("/login");
    expect(await row(t)).toBeNull();
  });

  it("parallele Versuche: höchstens 5 Prüfungen je Sperre", async () => {
    await setup();
    await session.lockCurrentSession("/heute");
    const t = current();
    const results = await Promise.allSettled(Array.from({ length: 12 }, () => unlock.unlockAction(undefined, fd({ secret: "1111" }))));
    expect(results.filter((r) => r.status === "fulfilled").length).toBeLessThanOrEqual(4);
    expect(await row(t)).toBeNull();
  });

  it("gesperrte Sitzung lässt sich weder per 2FA-Einrichtung noch per Praxiswechsel entsperren", async () => {
    const { org, user } = await setup();
    await f.pool.query("update users set totp_enabled = false where id = $1", [user]);
    await session.lockCurrentSession("/heute");
    const t = current();
    // 2FA-Einrichtung sieht keine (entsperrte) Sitzung → zurück zur Anmeldung, kein Geheimnis
    expect(await redirectOf(authActions.startOwnTotpAction())).toBe("/login");
    const sw = new FormData();
    sw.set("organizationId", org);
    await redirectOf(authActions.switchOrganizationAction(sw));
    expect(current()).toBe(t);
    expect(await row(t)).toMatchObject({ locked_at: expect.any(Date) });
    expect(await session.rotateSession(sha(t), user, org)).toBe(false);
    expect(await session.getAuth()).toBeNull();
  });
});
