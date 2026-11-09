import { describe, expect, it } from "vitest";
import { appointmentEditLock, durationMinutes } from "./appointment-edit";

describe("Termin verschieben: welche Termine sind änderbar?", () => {
  it("manuell, Telefon, Online, Portal … sind änderbar", () => {
    for (const source of ["manual", "phone", "online", "portal", "whatsapp", "email", "voice_agent"]) {
      expect(appointmentEditLock({ source, status: "planned" })).toBeNull();
    }
    expect(appointmentEditLock({ source: "manual", status: "done" })).toBeNull();
  });

  it("Doctolib und Kalender-Abo nur in der Quelle – mit kurzem Hinweis warum", () => {
    expect(appointmentEditLock({ source: "doctolib", status: "planned" })).toMatchObject({ reason: "doctolib", message: expect.stringMatching(/in Doctolib.*Abgleich/) });
    expect(appointmentEditLock({ source: "extern", status: "confirmed" })).toMatchObject({ reason: "extern", message: expect.stringMatching(/Kalender-Abo.*Abgleich/) });
    // Termin aus dem Abo, auch wenn die Quelle anders lautet (Verknüpfung über calendar_feed_events)
    expect(appointmentEditLock({ source: "manual", status: "planned" }, true)).toMatchObject({ reason: "extern" });
  });

  it("abgesagte Termine werden nicht verschoben", () => {
    expect(appointmentEditLock({ source: "manual", status: "cancelled" })).toMatchObject({ reason: "cancelled" });
  });

  it("Dauer in Minuten", () => {
    expect(durationMinutes(new Date("2026-11-09T09:00:00Z"), new Date("2026-11-09T09:45:00Z"))).toBe(45);
    expect(durationMinutes(new Date("2026-11-09T09:00:00Z"), new Date("2026-11-09T09:00:00Z"))).toBe(5);
  });
});
