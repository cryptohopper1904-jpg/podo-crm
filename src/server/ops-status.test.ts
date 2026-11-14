/**
 * Zeitstempel-Prüfung für /api/health/deep: Cron „Ende des Nur-Lesen-Modus“ ohne Status-Datei bzw. abgeschaltet.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("@/db", () => ({ db: {} }));

describe("checkTimestamps: cronNurLesen", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "podo-status-"));
    process.env.STATUS_DIR = dir;
  });
  afterEach(async () => {
    delete process.env.STATUS_DIR;
    delete process.env.READONLY_EXPIRY_ENABLED;
    await rm(dir, { recursive: true, force: true });
  });

  it("abgeschaltet: „deaktiviert“ (skipped), auch ohne Datei und ohne STATUS_DIR", async () => {
    const { checkTimestamps } = await import("./ops-status");
    expect((await checkTimestamps()).cronNurLesen).toMatchObject({ status: "skipped", hint: expect.stringMatching(/deaktiviert/) });
    delete process.env.STATUS_DIR;
    expect((await checkTimestamps()).cronNurLesen).toMatchObject({ status: "skipped", hint: expect.stringMatching(/deaktiviert/) });
  });

  it("eingeschaltet: ohne Datei warn, mit frischem Zeitstempel ok", async () => {
    process.env.READONLY_EXPIRY_ENABLED = "1";
    const { checkTimestamps } = await import("./ops-status");
    expect((await checkTimestamps()).cronNurLesen.status).toBe("warn");
    await writeFile(path.join(dir, "cron-nur-lesen.last"), `${Math.floor(Date.now() / 1000) - 60}\n`);
    expect((await checkTimestamps()).cronNurLesen.status).toBe("ok");
  });
});

describe("checkStripeCustomerIndex (AppSec L-1)", () => {
  it("fehlender Unique-Index auf stripe_customer_id → fail, vorhanden → ok, nicht lesbar → fail", async () => {
    const { db } = (await import("@/db")) as unknown as { db: { execute?: () => Promise<unknown> } };
    const { checkStripeCustomerIndex } = await import("./ops-status");
    db.execute = async () => ({ rows: [] });
    expect(await checkStripeCustomerIndex()).toMatchObject({ status: "fail", hint: expect.stringMatching(/organizations_stripe_customer_id/) });
    db.execute = async () => ({ rows: [{ x: 1 }] });
    expect(await checkStripeCustomerIndex()).toEqual({ status: "ok" });
    db.execute = async () => {
      throw new Error("weg");
    };
    expect((await checkStripeCustomerIndex()).status).toBe("fail");
    delete db.execute;
  });
});
