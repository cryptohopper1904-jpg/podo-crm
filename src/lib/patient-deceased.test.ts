import { describe, expect, it } from "vitest";
import { deceasedInfo, isDeceased, parseDeathDate } from "./patient-deceased";
import { chooseChannel, planReminders, type ReminderCandidates, type ReminderPatient } from "./reminders";

describe("Patient:in verstorben – Markierung in patients.extra", () => {
  it("liest die Markierung robust", () => {
    expect(deceasedInfo({})).toBeNull();
    expect(deceasedInfo(null)).toBeNull();
    expect(deceasedInfo({ deceased: null })).toBeNull();
    expect(deceasedInfo({ deceased: "ja" })).toBeNull();
    expect(deceasedInfo({ deceased: { date: "2026-10-01", markedAt: "2026-11-01T10:00:00.000Z", markedBy: "u1" } })).toEqual({
      date: "2026-10-01",
      markedAt: "2026-11-01T10:00:00.000Z",
      markedBy: "u1",
    });
    // ohne/ungültiges Datum bleibt die Markierung bestehen, das Datum wird null
    expect(deceasedInfo({ deceased: { date: "01.10.2026", markedAt: "x" } })).toEqual({ date: null, markedAt: "x", markedBy: null });
    expect(isDeceased({ no_reminders: true })).toBe(false);
    expect(isDeceased({ deceased: {} })).toBe(true);
  });

  it("prüft das optionale Sterbedatum", () => {
    const today = "2026-11-13";
    expect(parseDeathDate("", { today })).toEqual({ ok: true, date: null });
    expect(parseDeathDate(null, { today })).toEqual({ ok: true, date: null });
    expect(parseDeathDate("1.10.2026", { today })).toEqual({ ok: true, date: "2026-10-01" });
    expect(parseDeathDate("2026-11-13", { today })).toEqual({ ok: true, date: "2026-11-13" });
    expect(parseDeathDate("14.11.2026", { today }).ok).toBe(false);
    expect(parseDeathDate("31.02.2026", { today }).ok).toBe(false);
    expect(parseDeathDate("gestern", { today }).ok).toBe(false);
    expect(parseDeathDate("01.01.1940", { today, birthDate: "1941-05-05" }).ok).toBe(false);
  });
});

describe("Erinnerungen: Verstorbene werden nie angeschrieben", () => {
  const NOW = new Date("2026-11-08T10:00:00Z");
  const pat = (id: string, p: Partial<ReminderPatient> = {}): ReminderPatient => ({
    id,
    firstName: "Erika",
    email: "erika@example.org",
    phoneMobile: "+49 170 1234567",
    preferredChannel: "none",
    ...p,
  });
  const all = new Set(["email_reminders", "sms_reminders", "whatsapp"]);

  it("chooseChannel liefert für Verstorbene keinen Kanal – trotz Einwilligung", () => {
    expect(chooseChannel(pat("a"), all)).not.toBeNull();
    expect(chooseChannel(pat("a", { deceased: true }), all)).toBeNull();
  });

  it("planReminders überspringt 24-h-Erinnerung und Rückholung mit Grund „verstorben“", () => {
    const c: ReminderCandidates = {
      now: NOW,
      practice: { name: "Praxis Fußwohl", phone: null },
      settings: { r24: true, recall: true, braceCheck: false, recallAfterWeeks: 6 },
      patients: new Map([
        ["tot", pat("tot", { deceased: true })],
        ["lebt", pat("lebt")],
      ]),
      consents: new Map([
        ["tot", all],
        ["lebt", all],
      ]),
      appointments: [{ id: "t1", patientId: "tot", startsAt: new Date(NOW.getTime() + 24 * 3600_000), status: "planned" }],
      lastVisit: new Map([
        ["tot", new Date("2026-01-01T10:00:00Z")],
        ["lebt", new Date("2026-01-01T10:00:00Z")],
      ]),
      visitIntervalWeeks: new Map(),
      hasUpcoming: new Set(),
      lastRecallAt: new Map(),
      lastBraceCheckAt: new Map(),
      braceEpisodes: [],
    };
    const r = planReminders(c);
    expect(r.planned.map((p) => [p.kind, p.patientId])).toEqual([["recall", "lebt"]]);
    expect(r.skipped).toEqual([
      { kind: "reminder_24h", patientId: "tot", reason: "verstorben" },
      { kind: "recall", patientId: "tot", reason: "verstorben" },
    ]);
  });
});
