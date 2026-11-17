import { describe, expect, it } from "vitest";
import { priceSnapshot } from "./prescription";

/** PR #111 „GKV-Grundlagen“, Review-Runde 4 (Nachprüfung Code, Integrationstest mit #110) – docs/GKV.md */
describe("Review-Runde 4 PR #111", () => {
  const old = { birthDate: "1950-01-01", exemptions: [] };

  it("V-1: 78610 × 4 mit zwei Einträgen am selben Tag → höchstens 2 an dem Tag, Rest nicht verteilbar", () => {
    const snap = priceSnapshot({ positions: [{ position: "78610", label: "Spange", units: 4 }], treatmentDates: ["2026-11-02", "2026-11-02"], ...old, computedOn: "2026-11-03" });
    expect(snap.lines).toEqual([expect.objectContaining({ date: "2026-11-02", position: "78610", units: 2 })]);
    expect(snap.remedyCents).toBe(2 * 5720);
    expect(snap.notes.join(" ")).toMatch(/2 Einheiten 78610 nicht verteilbar \(1 Behandlungstag\)/);
    expect(snap.notes.join(" ")).not.toMatch(/angenommen/); // zwei Einträge belegen die zwei Einheiten
    // mit weiterem Tag: Rest wird verteilt
    const more = priceSnapshot({ positions: [{ position: "78610", label: "Spange", units: 4 }], treatmentDates: ["2026-11-02", "2026-11-02", "2026-11-09"], ...old, computedOn: "2026-11-10" });
    expect(more.lines.map((l) => [l.date, l.units])).toEqual([["2026-11-02", 2], ["2026-11-09", 2]]);
    expect(more.notes).toContain("2 × 78610 am 09.11.2026 angenommen – bitte mit Doku abgleichen.");
    expect(more.notes.join(" ")).not.toMatch(/nicht verteilbar/);
  });

  it("V-1: 78010 × 3 mit drei Einträgen an einem Tag → 1 Einheit, Hinweis mit der tatsächlichen Zahl", () => {
    const snap = priceSnapshot({ positions: [{ position: "78010", label: "klein", units: 3 }], treatmentDates: ["2026-11-02", "2026-11-02", "2026-11-02"], ...old, computedOn: "2026-11-03" });
    expect(snap.lines).toEqual([expect.objectContaining({ date: "2026-11-02", units: 1 })]);
    expect(snap.notes).toContain("3 Behandlungseinträge am 02.11.2026 – nur 1 Einheit 78010 abrechenbar, bitte prüfen.");
    expect(snap.notes.join(" ")).toMatch(/2 Einheiten 78010 nicht verteilbar \(1 Behandlungstag\)/);
  });

  it("V-1: vorzeitig beendet → auch 78610 nur 1 je Kalendertag", () => {
    const snap = priceSnapshot({ positions: [{ position: "78610", label: "Spange", units: 4 }], treatmentDates: ["2026-11-02", "2026-11-02"], ...old, computedOn: "2026-11-03", endedEarly: true });
    expect(snap.lines.map((l) => l.units)).toEqual([1]);
    expect(snap.notes).toContain("2 Behandlungseinträge am 02.11.2026 – nur 1 Einheit 78610 abrechenbar, bitte prüfen.");
  });

  it("Befund 1/2: Befreiung einer anderen Kasse einmal je Befreiung (gültig von–bis), IK normalisiert verglichen", () => {
    const positions = [{ position: "78020", label: "groß", units: 3 }];
    const exemptions = [{ validFrom: "2026-01-01", validTo: "2026-12-31", insurerIk: "108310400" }];
    const snap = priceSnapshot({ positions, treatmentDates: ["2026-11-02", "2026-11-30", "2026-12-28"], ...old, exemptions, computedOn: "2026-12-29", insurerIk: "109911114" });
    const hits = snap.notes.filter((n) => n.includes("von einer anderen Krankenkasse"));
    expect(hits).toEqual(["Befreiung (gültig 01.01.2026–31.12.2026) ist von einer anderen Krankenkasse (IK 108310400) als auf der Verordnung (IK 109911114) – bitte prüfen."]);
    // gleiche Kasse, nur anders geschrieben → kein Hinweis
    const same = priceSnapshot({ positions, treatmentDates: ["2026-11-02"], ...old, exemptions: [{ validFrom: "2026-01-01", validTo: "2026-12-31", insurerIk: "10 123 4567" }], computedOn: "2026-11-03", insurerIk: "101234567" });
    expect(same.notes.join(" ")).not.toMatch(/anderen Krankenkasse/);
  });
});

/** Nachtrag aus der Prüfung zu #111: Hinweis bei mehr Einträgen als der Tageshöchstmenge – auch bei 78610 (2 je Tag) */
describe("Tageshöchstmenge: Hinweis bei mehr Einträgen als erlaubt", () => {
  const old = { birthDate: "1950-01-01", exemptions: [] };

  it("78610 mit drei Einträgen am selben Tag → Hinweis „nur 2 Einheiten“", () => {
    const snap = priceSnapshot({ positions: [{ position: "78610", label: "Spange", units: 4 }], treatmentDates: ["2026-11-02", "2026-11-02", "2026-11-02"], ...old, computedOn: "2026-11-03" });
    expect(snap.lines).toEqual([expect.objectContaining({ date: "2026-11-02", position: "78610", units: 2 })]);
    expect(snap.notes).toContain("3 Behandlungseinträge am 02.11.2026 – nur 2 Einheiten 78610 abrechenbar, bitte prüfen.");
  });

  it("78610 mit zwei Einträgen am selben Tag → kein Hinweis (zweimal je Tag erlaubt)", () => {
    const snap = priceSnapshot({ positions: [{ position: "78610", label: "Spange", units: 2 }], treatmentDates: ["2026-11-02", "2026-11-02"], ...old, computedOn: "2026-11-03" });
    expect(snap.lines).toEqual([expect.objectContaining({ date: "2026-11-02", units: 2 })]);
    expect(snap.notes.join(" ")).not.toMatch(/Behandlungseinträge am/);
  });
});
