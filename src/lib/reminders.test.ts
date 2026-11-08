import { describe, expect, it } from "vitest";
import {
  chooseChannel,
  grantedConsents,
  parseReminderSettings,
  planReminders,
  reminder24hText,
  type ReminderCandidates,
  type ReminderPatient,
} from "./reminders";

const NOW = new Date("2026-11-08T10:00:00Z");
const practice = { name: "Praxis Fußwohl", phone: "030 1234567" };
const all = { r24: true, recall: true, braceCheck: true, recallAfterWeeks: 6 };

function base(patch: Partial<ReminderCandidates> = {}): ReminderCandidates {
  return {
    now: NOW,
    practice,
    settings: all,
    patients: new Map(),
    consents: new Map(),
    appointments: [],
    lastVisit: new Map(),
    visitIntervalWeeks: new Map(),
    hasUpcoming: new Set(),
    lastRecallAt: new Map(),
    lastBraceCheckAt: new Map(),
    braceEpisodes: [],
    ...patch,
  };
}

const pat = (id: string, p: Partial<ReminderPatient> = {}): ReminderPatient => ({
  id,
  firstName: "Erika",
  email: "erika@example.org",
  phoneMobile: "+49 170 1234567",
  preferredChannel: "none",
  ...p,
});

describe("Einwilligungen und Kanalwahl", () => {
  it("nimmt den jeweils neuesten Eintrag je Einwilligung", () => {
    const s = grantedConsents([
      { type: "sms_reminders", granted: true, recordedAt: "2026-01-01" },
      { type: "sms_reminders", granted: false, recordedAt: "2026-06-01" },
      { type: "email_reminders", granted: true, recordedAt: "2026-02-01" },
    ]);
    expect([...s]).toEqual(["email_reminders"]);
  });

  it("bevorzugt den Wunschkanal, aber nur mit Einwilligung", () => {
    const p = pat("a", { preferredChannel: "whatsapp" });
    expect(chooseChannel(p, new Set(["whatsapp", "email_reminders"]))).toEqual({ channel: "whatsapp", to: "+49 170 1234567" });
    expect(chooseChannel(p, new Set(["email_reminders"]))).toEqual({ channel: "email", to: "erika@example.org" });
    expect(chooseChannel(p, new Set(["marketing"]))).toBeNull();
    expect(chooseChannel(pat("b", { email: null }), new Set(["email_reminders"]))).toBeNull();
    expect(chooseChannel(pat("c", { noReminders: true }), new Set(["sms_reminders"]))).toBeNull();
  });

  it("Einstellungen sind standardmäßig aus und werden begrenzt", () => {
    expect(parseReminderSettings(undefined)).toEqual({ r24: false, recall: false, braceCheck: false, recallAfterWeeks: 6 });
    expect(parseReminderSettings({ r24: true, recallAfterWeeks: 999 }).recallAfterWeeks).toBe(6);
  });
});

describe("24-h-Erinnerung", () => {
  const appt = (id: string, hours: number, status = "planned") => ({ id, patientId: "p1", startsAt: new Date(NOW.getTime() + hours * 3600_000), status });

  it("plant nur Termine im Fenster 20–28 h mit Status geplant/bestätigt und Einwilligung", () => {
    const plan = planReminders(
      base({
        patients: new Map([["p1", pat("p1")]]),
        consents: new Map([["p1", new Set(["sms_reminders"])]]),
        appointments: [appt("a-in", 24), appt("a-early", 10), appt("a-late", 30), appt("a-cancel", 24, "cancelled"), appt("a-conf", 21, "confirmed")],
      }),
    );
    expect(plan.planned.map((p) => p.dedupeKey).sort()).toEqual(["r24:a-conf", "r24:a-in"]);
    expect(plan.planned[0].channel).toBe("sms");
  });

  it("überspringt Personen ohne Einwilligung", () => {
    const plan = planReminders(base({ patients: new Map([["p1", pat("p1")]]), appointments: [appt("a", 24)] }));
    expect(plan.planned).toHaveLength(0);
    expect(plan.skipped[0]).toMatchObject({ kind: "reminder_24h", reason: "keine Einwilligung/Adresse" });
  });

  it("Text enthält Praxis, Datum, Uhrzeit, Telefon – aber keine Leistung", () => {
    const t = reminder24hText(practice, new Date("2026-11-09T09:30:00Z"));
    expect(t.body).toBe("Erinnerung: Ihr Termin bei Praxis Fußwohl am 09.11.2026 um 10:30 Uhr. Absage bitte bis 24 h vorher unter 030 1234567.");
  });
});

describe("Rückholung und Spangen-Kontrolle", () => {
  const consents = new Map([["p1", new Set(["email_reminders"])]]);
  const patients = new Map([["p1", pat("p1")]]);
  const weeksAgo = (w: number) => new Date(NOW.getTime() - w * 7 * 86400_000);

  it("Rückholung bei überfällig (Intervall + 2 Wochen), Dedupe-Schlüssel je Monat", () => {
    const plan = planReminders(base({ settings: { ...all, braceCheck: false }, patients, consents, lastVisit: new Map([["p1", weeksAgo(9)]]) }));
    expect(plan.planned).toHaveLength(1);
    expect(plan.planned[0]).toMatchObject({ kind: "recall", dedupeKey: "recall:p1:2026-11", channel: "email" });
    expect(plan.planned[0].body).not.toMatch(/Spange|Nagel|Behandlung/);
  });

  it("keine Rückholung, wenn nicht überfällig, Termin geplant oder in den letzten 30 Tagen schon erinnert", () => {
    const c = { settings: { ...all, braceCheck: false }, patients, consents };
    expect(planReminders(base({ ...c, lastVisit: new Map([["p1", weeksAgo(7)]]) })).planned).toHaveLength(0);
    expect(planReminders(base({ ...c, lastVisit: new Map([["p1", weeksAgo(12)]]), hasUpcoming: new Set(["p1"]) })).planned).toHaveLength(0);
    expect(planReminders(base({ ...c, lastVisit: new Map([["p1", weeksAgo(12)]]), lastRecallAt: new Map([["p1", weeksAgo(2)]]) })).planned).toHaveLength(0);
    // individuelles Intervall hat Vorrang
    expect(planReminders(base({ ...c, lastVisit: new Map([["p1", weeksAgo(9)]]), visitIntervalWeeks: new Map([["p1", 12]]) })).planned).toHaveLength(0);
  });

  it("Spangen-Kontrolle bei aktiver Episode und letzter Doku vor > 4 Wochen", () => {
    const ep = (lastRecordAt: Date | null) => [{ id: "e1", patientId: "p1", startedAt: "2026-08-01", lastRecordAt }];
    const c = { settings: { ...all, recall: false }, patients, consents };
    expect(planReminders(base({ ...c, braceEpisodes: ep(weeksAgo(5)) })).planned[0]).toMatchObject({ kind: "brace_check", dedupeKey: "brace:p1:2026-11" });
    expect(planReminders(base({ ...c, braceEpisodes: ep(weeksAgo(3)) })).planned).toHaveLength(0);
    expect(planReminders(base({ ...c, braceEpisodes: ep(weeksAgo(5)), lastBraceCheckAt: new Map([["p1", weeksAgo(1)]]) })).planned).toHaveLength(0);
  });

  it("höchstens eine neutrale Nachricht je Person und Lauf", () => {
    const plan = planReminders(
      base({ patients, consents, lastVisit: new Map([["p1", weeksAgo(10)]]), braceEpisodes: [{ id: "e1", patientId: "p1", startedAt: "2026-08-01", lastRecordAt: weeksAgo(10) }] }),
    );
    expect(plan.planned.map((p) => p.kind)).toEqual(["recall"]);
  });
});
