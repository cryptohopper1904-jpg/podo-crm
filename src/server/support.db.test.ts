/** Support-Freigaben (Break-Glass): nur mit gültiger, nicht widerrufener Freigabe der eigenen Praxis (RLS). */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { fixtures, TEST_DB } from "./__tests__/db-fixtures";

(TEST_DB ? describe : describe.skip)("Support-Freigaben (DB)", () => {
  const f = fixtures(TEST_DB!);
  let session: typeof import("@/lib/auth/session");

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB;
    session = await import("@/lib/auth/session");
  });
  afterAll(async () => {
    await f.end();
    const { db } = await import("@/db");
    await (db.$client as { end: () => Promise<void> }).end();
  });

  const grant = async (org: string, by: string, o: { hours?: number; grantee?: string | null; revoked?: boolean; scope?: string } = {}) =>
    f.asOrg(org, async (c) =>
      (
        await c.query(
          "insert into support_grants (organization_id, granted_by, grantee_user_id, reason, scope, expires_at, revoked_at) values ($1,$2,$3,'Ticket 42',$4, now() + make_interval(hours => $5), $6) returning id",
          [org, by, o.grantee ?? null, o.scope ?? "read", o.hours ?? 2, o.revoked ? new Date() : null],
        )
      ).rows[0].id as string,
    );

  it("findet nur aktive Freigaben der jeweiligen Praxis; Ablauf und Widerruf beenden den Zugriff", async () => {
    const orgA = await f.org();
    const orgB = await f.org();
    const owner = await f.user();
    const admin = await f.user();
    expect(await session.findActiveSupportGrant(orgA, admin)).toBeNull();

    const id = await grant(orgA, owner);
    const g = await session.findActiveSupportGrant(orgA, admin);
    expect(g).toMatchObject({ grantId: id, scope: "read" });
    // Freigabe gilt nicht für andere Praxen
    expect(await session.findActiveSupportGrant(orgB, admin)).toBeNull();
    // nach Ablauf nicht mehr gültig
    expect(await session.findActiveSupportGrant(orgA, admin, new Date(Date.now() + 3 * 3600_000))).toBeNull();
    // Widerruf
    await f.asOrg(orgA, (c) => c.query("update support_grants set revoked_at = now() where id = $1", [id]));
    expect(await session.findActiveSupportGrant(orgA, admin)).toBeNull();
  });

  it("Freigabe für eine bestimmte Person gilt nur für diese", async () => {
    const org = await f.org();
    const owner = await f.user();
    const admin1 = await f.user();
    const admin2 = await f.user();
    await grant(org, owner, { grantee: admin1 });
    await grant(org, owner, { revoked: true });
    expect(await session.findActiveSupportGrant(org, admin1)).not.toBeNull();
    expect(await session.findActiveSupportGrant(org, admin2)).toBeNull();
  });

  it("RLS: Freigaben sind ohne Mandantenkontext unsichtbar", async () => {
    const org = await f.org();
    await grant(org, await f.user());
    const r = await f.pool.query("select count(*)::int n from support_grants where organization_id = $1", [org]);
    expect(r.rows[0].n).toBe(0);
  });
});
