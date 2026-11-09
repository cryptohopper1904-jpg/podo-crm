/**
 * Sitzungen gegen PostgreSQL (Phase 4):
 * - neues Token bei Praxiswechsel, Support betreten/verlassen (altes Token wertlos, 2FA-Status/Ablauf bleiben)
 * - Entzug: 2FA-Sperre, Deaktivierung, Löschen beenden laufende Sitzungen; Passwort-Fehlversuche NICHT (DoS)
 * - Support-Freigaben nur noch personengebunden (Plattform-Admin mit 2FA)
 */
import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));

const jar = vi.hoisted(() => new Map<string, string>());
const hdrs = vi.hoisted(() => ({ method: "POST", path: "/test" }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (n: string) => (jar.has(n) ? { name: n, value: jar.get(n)! } : undefined),
    set: (n: string, v: string, o?: { maxAge?: number }) => (o?.maxAge === 0 || v === "" ? jar.delete(n) : jar.set(n, v)),
    delete: (n: string) => jar.delete(n),
  }),
  headers: async () => new Headers({ "x-podo-method": hdrs.method, "x-podo-path": hdrs.path, "user-agent": "vitest" }),
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

(TEST_DB ? describe : describe.skip)("Sitzungen: Rotation und Entzug (DB)", () => {
  const f = fixtures(TEST_DB!);
  let session: typeof import("@/lib/auth/session");
  let support: typeof import("@/server/support");
  let authActions: typeof import("@/app/(auth)/actions");
  let settingsActions: typeof import("@/app/(app)/einstellungen/actions");
  let secrets: typeof import("@/lib/secrets");
  let totp: typeof import("@/lib/auth/totp");
  let password: typeof import("@/lib/auth/password");

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB;
    session = await import("@/lib/auth/session");
    support = await import("@/server/support");
    authActions = await import("@/app/(auth)/actions");
    settingsActions = await import("@/app/(app)/einstellungen/actions");
    secrets = await import("@/lib/secrets");
    totp = await import("@/lib/auth/totp");
    password = await import("@/lib/auth/password");
  });
  afterAll(async () => {
    await f.end();
    const { db } = await import("@/db");
    await (db.$client as { end: () => Promise<void> }).end();
  });
  beforeEach(() => {
    jar.clear();
    hdrs.method = "POST";
  });

  const activeOrg = async () => {
    const org = await f.org();
    await f.pool.query("update organizations set plan = 'internal', subscription_status = 'active' where id = $1", [org]);
    return org;
  };
  const member = async (org: string, user: string, role = "owner") =>
    (await f.pool.query("insert into memberships (organization_id, user_id, role) values ($1,$2,$3) returning id", [org, user, role])).rows[0].id as string;
  /** Sitzung direkt anlegen; gibt das Token zurück (nur sha256 steht in der DB). */
  const newSession = async (user: string, org: string | null, o: { verified?: boolean; expiresInMs?: number } = {}) => {
    const token = randomBytes(24).toString("base64url");
    await f.pool.query("insert into sessions (id, user_id, organization_id, verified, expires_at) values ($1,$2,$3,$4,$5)", [
      sha(token),
      user,
      org,
      o.verified ?? true,
      new Date(Date.now() + (o.expiresInMs ?? 3 * 3600_000)),
    ]);
    return token;
  };
  const useToken = (t: string) => jar.set(session.SESSION_COOKIE, t);
  const row = async (token: string) => (await f.pool.query("select * from sessions where id = $1", [sha(token)])).rows[0] ?? null;
  const countSessions = async (user: string) => (await f.pool.query("select count(*)::int n from sessions where user_id = $1", [user])).rows[0].n as number;
  const platformAdmin = async (o: { totp?: boolean } = {}) => {
    const u = await f.user();
    // Name sortiert vorne: die Admin-Liste ist auf 100 Einträge begrenzt, die Test-DB sammelt über Läufe Admins an
    await f.pool.query("update users set is_platform_admin = true, totp_enabled = $2, name = '  Test-Admin ' || left(id::text, 8) where id = $1", [u, o.totp ?? true]);
    // ältere Test-Admins aus früheren Läufen zurücksetzen, damit die Liste nicht volläuft
    await f.pool.query("update users set is_platform_admin = false where is_platform_admin and name like '  Test-Admin %' and created_at < now() - interval '1 hour'");
    return u;
  };
  const grant = (org: string, by: string, grantee: string | null) =>
    f.asOrg(org, (c) =>
      c.query("insert into support_grants (organization_id, granted_by, grantee_user_id, reason, scope, expires_at) values ($1,$2,$3,'Ticket 7','read', now() + interval '2 hours')", [org, by, grantee]),
    );

  describe("Rotation", () => {
    it("Praxiswechsel: neues Token, altes wertlos, Status und Ablauf bleiben", async () => {
      const a = await activeOrg();
      const b = await activeOrg();
      const u = await f.user();
      await member(a, u);
      await member(b, u, "therapist");
      const old = await newSession(u, a, { expiresInMs: 5 * 3600_000 });
      const before = await row(old);
      useToken(old);
      const form = new FormData();
      form.set("organizationId", b);
      expect(await redirectOf(authActions.switchOrganizationAction(form))).toBe("/heute");

      const fresh = jar.get(session.SESSION_COOKIE)!;
      expect(fresh).toBeTruthy();
      expect(fresh).not.toBe(old);
      expect(await row(old)).toBeNull();
      const r = await row(fresh);
      expect(r).toMatchObject({ user_id: u, organization_id: b, verified: true });
      expect(new Date(r.expires_at).getTime()).toBe(new Date(before.expires_at).getTime());
      // altes Token: keine Sitzung mehr
      useToken(old);
      expect(await session.getSession()).toBeNull();
      useToken(fresh);
      expect((await session.getSession())?.session.organizationId).toBe(b);
    });

    it("Wechsel in eine Praxis ohne Mitgliedschaft ändert nichts", async () => {
      const a = await activeOrg();
      const foreign = await activeOrg();
      const u = await f.user();
      await member(a, u);
      const t = await newSession(u, a);
      useToken(t);
      const form = new FormData();
      form.set("organizationId", foreign);
      await redirectOf(authActions.switchOrganizationAction(form));
      expect(jar.get(session.SESSION_COOKIE)).toBe(t);
      expect((await row(t)).organization_id).toBe(a);
    });

    it("Support betreten und verlassen: jeweils neues Token; fremde Sitzung lässt sich nicht rotieren", async () => {
      const own = await activeOrg();
      const practice = await activeOrg();
      const owner = await f.user();
      await member(practice, owner);
      const admin = await platformAdmin();
      await member(own, admin);
      await grant(practice, owner, admin);
      const t0 = await newSession(admin, own);
      useToken(t0);
      const user = { id: admin, isPlatformAdmin: true, totpEnabled: true };

      expect(await support.enterSupport(user, sha(t0), practice)).toBe(true);
      const t1 = jar.get(session.SESSION_COOKIE)!;
      expect(t1).not.toBe(t0);
      expect(await row(t0)).toBeNull();
      expect((await row(t1)).organization_id).toBe(practice);

      expect(await support.exitSupport(admin, sha(t1), practice)).toBe(true);
      const t2 = jar.get(session.SESSION_COOKIE)!;
      expect(t2).not.toBe(t1);
      expect(await row(t1)).toBeNull();
      expect((await row(t2)).organization_id).toBe(own);

      // Sitzungs-ID einer anderen Person: keine Rotation, keine Änderung
      const otherUser = await f.user();
      const foreign = await newSession(otherUser, own);
      expect(await session.rotateSession(sha(foreign), admin, practice)).toBe(false);
      expect((await row(foreign)).organization_id).toBe(own);
    });

    it("Freigabe für eine andere Person: kein Zutritt, Sitzung bleibt unverändert", async () => {
      const own = await activeOrg();
      const practice = await activeOrg();
      const owner = await f.user();
      const admin = await platformAdmin();
      const colleague = await platformAdmin();
      await member(own, admin);
      await grant(practice, owner, colleague);
      const t = await newSession(admin, own);
      useToken(t);
      expect(await support.enterSupport({ id: admin, isPlatformAdmin: true, totpEnabled: true }, sha(t), practice)).toBe(false);
      expect(jar.get(session.SESSION_COOKIE)).toBe(t);
      expect((await row(t)).organization_id).toBe(own);
    });
  });

  describe("Entzug", () => {
    it("2FA-Sperre (Passwort war bekannt) beendet ALLE Sitzungen der Person", async () => {
      const org = await activeOrg();
      const u = await f.user();
      await member(org, u);
      const secret = totp.generateTotpSecret();
      await f.pool.query("update users set totp_enabled = true, totp_secret_enc = $2 where id = $1", [u, secrets.encryptSecret(secret)]);
      const realDevice = await newSession(u, org, { verified: true });
      const attacker = await newSession(u, org, { verified: false, expiresInMs: 10 * 60_000 });
      useToken(attacker);
      let last: string | null = null;
      for (let i = 0; i < 5; i++) {
        const form = new FormData();
        form.set("code", "000000" === totp.totpCode(secret) ? "111111" : "000000");
        last = await redirectOf(authActions.verifyTotpAction(undefined, form));
      }
      expect(last).toBe("/login");
      expect(await row(realDevice)).toBeNull();
      expect(await row(attacker)).toBeNull();
      expect(await countSessions(u)).toBe(0);
      const locked = (await f.pool.query("select locked_until from users where id = $1", [u])).rows[0].locked_until;
      expect(new Date(locked).getTime()).toBeGreaterThan(Date.now());
    });

    it("Passwort-Fehlversuche sperren nur neue Anmeldungen – bestehende Sitzung bleibt (kein DoS)", async () => {
      const org = await activeOrg();
      const u = await f.user();
      await member(org, u);
      const email = (await f.pool.query("select email from users where id = $1", [u])).rows[0].email as string;
      await f.pool.query("update users set password_hash = $2 where id = $1", [u, await password.hashPassword("Richtig-Lang-Passwort-2026")]);
      const t = await newSession(u, org);
      for (let i = 0; i < 8; i++) {
        const form = new FormData();
        form.set("email", email);
        form.set("password", "falsch");
        await authActions.loginAction(undefined, form);
      }
      const locked = (await f.pool.query("select locked_until from users where id = $1", [u])).rows[0].locked_until;
      expect(locked && new Date(locked).getTime()).toBeGreaterThan(Date.now());
      useToken(t);
      expect((await session.getSession())?.user.id).toBe(u);
    });

    it("Deaktivierung der Mitgliedschaft beendet die Sitzungen in DIESER Praxis", async () => {
      const org = await activeOrg();
      const other = await activeOrg();
      const owner = await f.user();
      const staff = await f.user();
      await member(org, owner);
      // Inhaber:innen brauchen Pflicht-2FA (Gesamt-Review H1)
      await f.pool.query("update users set totp_enabled = true where id = $1", [owner]);
      const mId = await member(org, staff, "therapist");
      await member(other, staff, "therapist");
      const staffHere = await newSession(staff, org);
      const staffElsewhere = await newSession(staff, other);
      useToken(await newSession(owner, org));
      const form = new FormData();
      form.set("id", mId);
      form.set("active", "0");
      await settingsActions.updateMemberAction(form);
      expect((await f.pool.query("select active from memberships where id = $1", [mId])).rows[0].active).toBe(false);
      expect(await row(staffHere)).toBeNull();
      expect(await row(staffElsewhere)).not.toBeNull();
    });

    it("Passwortwechsel beendet alle anderen Sitzungen, die aktuelle bleibt", async () => {
      const org = await activeOrg();
      const u = await f.user();
      await member(org, u, "therapist");
      await f.pool.query("update users set password_hash = $2 where id = $1", [u, await password.hashPassword("Altes-Passwort-sehr-lang-1")]);
      const other = await newSession(u, org);
      const current = await newSession(u, org);
      useToken(current);
      const form = new FormData();
      form.set("current", "Altes-Passwort-sehr-lang-1");
      form.set("next", "Neues-Passwort-sehr-lang-2!");
      const res = await settingsActions.changePasswordAction(undefined, form);
      expect(res?.ok).toBeTruthy();
      expect(await row(other)).toBeNull();
      expect(await row(current)).not.toBeNull();
    });

    it("Gelöschte Person: Sitzungen verschwinden mit (FK cascade)", async () => {
      const u = await f.user();
      const t = await newSession(u, null);
      await f.pool.query("delete from users where id = $1", [u]);
      expect(await row(t)).toBeNull();
      useToken(t);
      expect(await session.getSession()).toBeNull();
    });

    it("revokeUserSessions filtert nach Praxis und lässt die aktuelle Sitzung aus", async () => {
      const a = await activeOrg();
      const b = await activeOrg();
      const u = await f.user();
      const s1 = await newSession(u, a);
      const s2 = await newSession(u, a);
      const s3 = await newSession(u, b);
      expect(await session.revokeUserSessions(u, { organizationId: a, exceptSessionId: sha(s1) })).toBe(1);
      expect(await row(s1)).not.toBeNull();
      expect(await row(s2)).toBeNull();
      expect(await row(s3)).not.toBeNull();
    });
  });

  describe("Support-Freigaben personengebunden", () => {
    const ownerAuth = (org: string, user: string) =>
      ({ role: "owner", support: null, organization: { id: org }, user: { id: user } }) as unknown as import("@/lib/auth/session").AuthContext;
    const input = (granteeUserId: string) => ({ reason: "Ticket 4711", hours: 2, scope: "read" as const, granteeUserId });

    it("ohne ausgewählte Person keine Freigabe", () => {
      expect(support.validateGrantInput({ reason: "Ticket 4711", hours: 2, scope: "read", granteeUserId: "" })).toMatch(/Person/);
      expect(support.validateGrantInput({ reason: "Ticket 4711", hours: 2, scope: "read" } as never)).toMatch(/Person/);
    });

    it("nur Plattform-Admins mit 2FA; Freigabe gilt nur für diese Person", async () => {
      const org = await activeOrg();
      const owner = await f.user();
      await member(org, owner);
      const ok = await platformAdmin();
      const noTotp = await platformAdmin({ totp: false });
      const normal = await f.user();
      const other = await platformAdmin();

      const admins = (await support.listSupportAdmins()).map((a) => a.id);
      expect(admins).toContain(ok);
      expect(admins).not.toContain(noTotp);
      expect(admins).not.toContain(normal);
      const listed = (await support.listSupportAdmins()).find((a) => a.id === ok)!;
      expect(Object.keys(listed).sort()).toEqual(["email", "id", "name"]);

      await expect(support.createSupportGrant(ownerAuth(org, owner), input(noTotp))).rejects.toThrow();
      await expect(support.createSupportGrant(ownerAuth(org, owner), input(normal))).rejects.toThrow();
      const g = await support.createSupportGrant(ownerAuth(org, owner), input(ok));
      expect(g.granteeUserId).toBe(ok);
      expect(await session.findActiveSupportGrant(org, ok)).not.toBeNull();
      expect(await session.findActiveSupportGrant(org, other)).toBeNull();
    });

    it("alte Freigaben ohne Person bleiben bis zum Ablauf gültig und werden als solche gelistet", async () => {
      const org = await activeOrg();
      const owner = await f.user();
      await member(org, owner);
      const admin = await platformAdmin();
      await grant(org, owner, null);
      expect(await session.findActiveSupportGrant(org, admin)).not.toBeNull();
      const [legacy] = await support.listSupportGrants(ownerAuth(org, owner));
      expect(legacy.g.granteeUserId).toBeNull();
      expect(legacy.granteeName).toBeNull();
    });

    it("Übersicht der Freigaben nur für Inhaber:in bzw. settings.manage, nie für den Support", async () => {
      const org = await activeOrg();
      const owner = await f.user();
      await member(org, owner);
      const staff = { role: "staff", support: null, organization: { id: org }, user: { id: owner }, can: () => false } as unknown as import("@/lib/auth/session").AuthContext;
      await expect(support.listSupportGrants(staff)).rejects.toThrow(/Praxisinhaber/);
      const supportAuth = { role: "owner", support: { grantId: "x", scope: "write" }, organization: { id: org }, user: { id: owner }, can: () => true } as unknown as import("@/lib/auth/session").AuthContext;
      await expect(support.listSupportGrants(supportAuth)).rejects.toThrow(/Praxisinhaber/);
      const manager = { role: "admin", support: null, organization: { id: org }, user: { id: owner }, can: (p: string) => p === "settings.manage" } as unknown as import("@/lib/auth/session").AuthContext;
      await expect(support.listSupportGrants(manager)).resolves.toEqual([]);
    });
  });

  describe("Pflicht-2FA (Gesamt-Review H1)", () => {
    const withTotp = (u: string) => f.pool.query("update users set totp_enabled = true, totp_secret_enc = $2 where id = $1", [u, secrets.encryptSecret(totp.generateTotpSecret())]);

    it("Inhaber:in ohne 2FA: kein Praxis-Zugriff, Weiterleitung zur Einrichtung; mit 2FA normal", async () => {
      hdrs.method = "GET";
      const org = await activeOrg();
      const u = await f.user();
      await member(org, u, "owner");
      useToken(await newSession(u, org));
      expect(await session.getAuthState()).toEqual({ auth: null, twoFactorSetupRequired: true });
      expect(await redirectOf(session.requireAuth())).toBe("/login/2fa-einrichten");
      // nach der Einrichtung (neue Anfrage → neuer Cache) Zugriff
      await withTotp(u);
      vi.resetModules();
      const fresh = await import("@/lib/auth/session");
      expect((await fresh.getAuth())?.organization.id).toBe(org);
    });

    it("Team-Mitglied ohne 2FA: Zugriff, solange die Praxis keine Pflicht für alle festlegt", async () => {
      hdrs.method = "GET";
      const org = await activeOrg();
      const u = await f.user();
      await member(org, u, "therapist");
      useToken(await newSession(u, org));
      vi.resetModules();
      let s = await import("@/lib/auth/session");
      expect((await s.getAuth())?.role).toBe("therapist");
      await f.pool.query(`update organizations set settings = settings || '{"security":{"require2faAllRoles":true}}' where id = $1`, [org]);
      vi.resetModules();
      s = await import("@/lib/auth/session");
      expect(await s.getAuthState()).toEqual({ auth: null, twoFactorSetupRequired: true });
    });

    it("Plattform-Admin mit Praxis-Mitgliedschaft ohne 2FA: Pflicht", async () => {
      hdrs.method = "GET";
      const org = await activeOrg();
      const admin = await platformAdmin({ totp: false });
      await member(org, admin, "reception");
      useToken(await newSession(admin, org));
      vi.resetModules();
      const s = await import("@/lib/auth/session");
      expect((await s.getAuthState()).twoFactorSetupRequired).toBe(true);
    });

    it("Login einer Inhaber:in ohne 2FA leitet zur Einrichtung", async () => {
      const org = await activeOrg();
      const u = await f.user();
      await member(org, u, "owner");
      const pw = "ein-sehr-langes-passwort-1";
      await f.pool.query("update users set password_hash = $2 where id = $1", [u, await password.hashPassword(pw)]);
      const { rows } = await f.pool.query("select email from users where id = $1", [u]);
      const form = new FormData();
      form.set("email", rows[0].email);
      form.set("password", pw);
      expect(await redirectOf(authActions.loginAction(undefined, form))).toBe("/login/2fa-einrichten");
    });
  });
});
