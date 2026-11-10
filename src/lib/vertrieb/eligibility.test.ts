import { describe, expect, it } from "vitest";
import { MAX_PER_CLICK, MAX_PER_DAY } from "./constants";
import { eligibility, planBatch, type LeadForSend } from "./eligibility";

const now = new Date("2026-11-10T10:00:00Z");
const day = 86_400_000;
const delays = { delay2Days: 5, delay3Days: 10 };
const none = new Set<string>();
let n = 0;
const lead = (p: Partial<LeadForSend> = {}): LeadForSend => ({ id: `id-${++n}`, email: `p${n}@praxis.example`, status: "neu", step: 0, lastSentAt: null, ...p });
const opts = { now, delays, suppressed: none };

describe("eligibility", () => {
  it("neuer Lead → Mail 1", () => expect(eligibility(lead(), opts)).toEqual({ ok: true, step: 1 }));

  it("Abstand: Mail 2 erst nach 5 Tagen, Mail 3 erst 10 Tage nach Mail 2", () => {
    expect(eligibility(lead({ status: "in_sequenz", step: 1, lastSentAt: new Date(now.getTime() - 4 * day) }), opts)).toMatchObject({ ok: false });
    expect(eligibility(lead({ status: "in_sequenz", step: 1, lastSentAt: new Date(now.getTime() - 5 * day) }), opts)).toEqual({ ok: true, step: 2 });
    expect(eligibility(lead({ status: "in_sequenz", step: 2, lastSentAt: new Date(now.getTime() - 9 * day) }), opts)).toMatchObject({ ok: false, reason: expect.stringMatching(/Mail 3 erst ab/) });
    expect(eligibility(lead({ status: "in_sequenz", step: 2, lastSentAt: new Date(now.getTime() - 10 * day) }), opts)).toEqual({ ok: true, step: 3 });
    expect(eligibility(lead({ status: "in_sequenz", step: 1, lastSentAt: new Date(now.getTime() - 2 * day) }), { ...opts, delays: { delay2Days: 2, delay3Days: 3 } })).toEqual({ ok: true, step: 2 });
  });

  it("nach 3 Mails ist Schluss", () => expect(eligibility(lead({ step: 3, status: "in_sequenz", lastSentAt: new Date(0) }), opts)).toMatchObject({ ok: false }));

  it("Stopp-Status beenden die Sequenz", () => {
    for (const status of ["geantwortet", "interessiert", "kein_interesse", "abgemeldet", "kunde"]) expect(eligibility(lead({ status }), opts).ok, status).toBe(false);
    expect(eligibility(lead({ status: "unbekannt" }), opts).ok).toBe(false);
  });

  it("Sperrliste (ohne Groß/Klein) und fehlende/ungültige E-Mail", () => {
    expect(eligibility(lead({ email: "Info@Praxis.example" }), { ...opts, suppressed: new Set(["info@praxis.example"]) })).toMatchObject({ ok: false, reason: expect.stringMatching(/Sperrliste/) });
    expect(eligibility(lead({ email: null }), opts).ok).toBe(false);
    expect(eligibility(lead({ email: "kaputt" }), opts).ok).toBe(false);
  });
});

describe("planBatch: Obergrenzen", () => {
  it(`höchstens ${MAX_PER_CLICK} je Klick`, () => {
    const leads = Array.from({ length: MAX_PER_CLICK + 5 }, () => lead());
    const p = planBatch(leads, { ...opts, sentLast24h: 0 });
    expect(p.send).toHaveLength(MAX_PER_CLICK);
    expect(p.capped).toBe(5);
  });

  it(`Tageslimit ${MAX_PER_DAY} in 24 h`, () => {
    const p = planBatch([lead(), lead(), lead()], { ...opts, sentLast24h: MAX_PER_DAY - 2 });
    expect(p.send).toHaveLength(2);
    expect(p.skipped.at(-1)?.reason).toMatch(/Tageslimit/);
    expect(planBatch([lead()], { ...opts, sentLast24h: MAX_PER_DAY + 3 }).send).toHaveLength(0);
  });

  it("doppelte IDs und doppelte E-Mail-Adressen nur einmal; nicht fällige zählen nicht gegen das Limit", () => {
    const a = lead();
    const b = lead({ email: a.email!.toUpperCase() });
    const notDue = lead({ status: "in_sequenz", step: 1, lastSentAt: now });
    const p = planBatch([notDue, a, a, b], { ...opts, sentLast24h: 0, maxPerClick: 1 });
    expect(p.send.map((x) => x.lead.id)).toEqual([a.id]);
    expect(p.skipped.map((x) => x.lead.id)).toEqual([notDue.id, b.id]);
  });
});
