import { describe, expect, it } from "vitest";
import { computeAvailability, subtractRanges } from "./availability";
import {
  blockInput,
  blocksFor,
  describeBlock,
  describeBlockConflicts,
  describeRepeat,
  expandBlocks,
  occurrenceUtc,
  occursOn,
  overlappingBlocks,
  type BlockRule,
} from "./calendar-blocks";

const rule = (r: Partial<BlockRule>): BlockRule => ({
  id: "b1",
  userId: "u1",
  kind: "pause",
  title: null,
  startsOn: "2026-03-23",
  endsOn: null,
  allDay: false,
  startTime: "12:00",
  endTime: "12:30",
  repeat: "none",
  weekdays: [],
  intervalWeeks: 1,
  exceptions: [],
  ...r,
});

describe("Sperrzeiten – Expansion", () => {
  it("einmalig: genau ein Vorkommen am Datum", () => {
    const occ = expandBlocks([rule({})], "2026-03-01", "2026-03-31");
    expect(occ).toEqual([
      { blockId: "b1", userId: "u1", dateIso: "2026-03-23", startMin: 720, endMin: 750, allDay: false, kind: "pause", label: "Pause", series: false },
    ]);
    expect(expandBlocks([rule({})], "2026-03-24", "2026-03-31")).toEqual([]);
  });

  it("täglich (Mo–Fr): Wochenende ausgelassen, Enddatum inklusive", () => {
    const occ = expandBlocks([rule({ repeat: "daily", startsOn: "2026-03-26", endsOn: "2026-04-01" })], "2026-03-01", "2026-04-30");
    expect(occ.map((o) => o.dateIso)).toEqual(["2026-03-26", "2026-03-27", "2026-03-30", "2026-03-31", "2026-04-01"]);
    expect(occ.every((o) => o.series)).toBe(true);
  });

  it("wöchentlich an gewählten Wochentagen, alle 2 Wochen ab der Woche des Beginns", () => {
    // Beginn Mi 2026-03-25 → Woche ab Mo 23.03.; Mo und Mi; alle 2 Wochen
    const r = rule({ repeat: "weekly", weekdays: [1, 3], intervalWeeks: 2, startsOn: "2026-03-25" });
    const occ = expandBlocks([r], "2026-03-23", "2026-04-22");
    expect(occ.map((o) => o.dateIso)).toEqual(["2026-03-25", "2026-04-06", "2026-04-08", "2026-04-20", "2026-04-22"]);
    expect(occursOn(r, "2026-03-23")).toBe(false); // vor Beginn
    expect(occursOn(r, "2026-03-30")).toBe(false); // Zwischenwoche
  });

  it("Ausnahmen (einzelne Vorkommen gelöscht)", () => {
    const r = rule({ repeat: "weekly", weekdays: [5], exceptions: ["2026-04-03"] });
    expect(expandBlocks([r], "2026-03-23", "2026-04-17").map((o) => o.dateIso)).toEqual(["2026-03-27", "2026-04-10", "2026-04-17"]);
  });

  it("Personenfilter: ganze Praxis gilt immer, fremde Personen nicht", () => {
    const rules = [rule({ id: "p", userId: null, kind: "reinigung" }), rule({ id: "a", userId: "u1" }), rule({ id: "b", userId: "u2" })];
    expect(expandBlocks(rules, "2026-03-23", "2026-03-23", ["u1"]).map((o) => o.blockId).sort()).toEqual(["a", "p"]);
    expect(expandBlocks(rules, "2026-03-23", "2026-03-23", []).map((o) => o.blockId)).toEqual(["p"]);
    const all = expandBlocks(rules, "2026-03-23", "2026-03-23");
    expect(blocksFor(all, "u2", "2026-03-23").map((o) => o.blockId).sort()).toEqual(["b", "p"]);
    expect(blocksFor(all, null, "2026-03-23").map((o) => o.blockId)).toEqual(["p"]);
  });

  it("Sommerzeit: gleiche Wanduhrzeit, UTC verschiebt sich um eine Stunde (29.03.2026 / 25.10.2026)", () => {
    const r = rule({ repeat: "daily", startsOn: "2026-03-26" });
    const occ = expandBlocks([r], "2026-03-26", "2026-03-31");
    // Fr 27.03. (MEZ, UTC+1) und Mo 30.03. (MESZ, UTC+2)
    const fri = occ.find((o) => o.dateIso === "2026-03-27")!;
    const mon = occ.find((o) => o.dateIso === "2026-03-30")!;
    expect(occurrenceUtc(fri).start.toISOString()).toBe("2026-03-27T11:00:00.000Z");
    expect(occurrenceUtc(mon).start.toISOString()).toBe("2026-03-30T10:00:00.000Z");
    expect(occurrenceUtc(mon).end.toISOString()).toBe("2026-03-30T10:30:00.000Z");
    // Rückstellung im Oktober
    const oct = expandBlocks([rule({ repeat: "daily", startsOn: "2026-10-23" })], "2026-10-23", "2026-10-26");
    expect(oct.map((o) => occurrenceUtc(o).start.toISOString())).toEqual(["2026-10-23T10:00:00.000Z", "2026-10-26T11:00:00.000Z"]);
    // ganztägig am Umstellungstag: 23 Stunden
    const day = occurrenceUtc({ dateIso: "2026-03-29", startMin: 0, endMin: 1440 });
    expect((day.end.getTime() - day.start.getTime()) / 3600_000).toBe(23);
  });

  it("Überschneidung mit Terminen (UTC) nur für die Person bzw. die ganze Praxis", () => {
    const occ = expandBlocks([rule({ repeat: "daily", startsOn: "2026-03-30" }), rule({ id: "x", userId: "u2", startsOn: "2026-03-30", startTime: "08:00", endTime: "09:00" })], "2026-03-30", "2026-03-30");
    const at = (iso: string, min: number) => [new Date(iso), new Date(new Date(iso).getTime() + min * 60_000)] as const;
    expect(overlappingBlocks(occ, "u1", ...at("2026-03-30T10:15:00Z", 30)).map((o) => o.blockId)).toEqual(["b1"]); // 12:15 MESZ
    expect(overlappingBlocks(occ, "u1", ...at("2026-03-30T10:30:00Z", 30))).toEqual([]); // 12:30 – direkt danach
    expect(overlappingBlocks(occ, "u1", ...at("2026-03-30T06:00:00Z", 30))).toEqual([]); // 08:00 – nur u2 gesperrt
    expect(overlappingBlocks(occ, "u2", ...at("2026-03-30T06:00:00Z", 30)).map((o) => o.blockId)).toEqual(["x"]);
  });

  it("Texte für Konflikt und Anzeige", () => {
    const [o] = expandBlocks([rule({ title: "Mittagspause" })], "2026-03-23", "2026-03-23");
    expect(describeBlock(o)).toBe("Mittagspause 12:00–12:30");
    expect(describeBlockConflicts([o, o])).toBe("Mittagspause 12:00–12:30 (23.03.)");
    const [w] = expandBlocks([rule({ kind: "wartung", allDay: true, startTime: null, endTime: null })], "2026-03-23", "2026-03-23");
    expect(describeBlock(w)).toBe("Wartung (ganztägig)");
    const [f] = expandBlocks([rule({ kind: "feierabend", startTime: "15:00", endTime: "24:00" })], "2026-03-23", "2026-03-23");
    expect(describeBlock(f)).toBe("Früher Feierabend 15:00–24:00");
    expect(describeRepeat({ repeat: "weekly", weekdays: [3, 1], intervalWeeks: 2, endsOn: "2026-12-31" })).toBe("alle 2 Wochen Mo, Mi · bis 31.12.2026");
  });

  it("Verfügbarkeit: Sperrzeiten werden von der Arbeitszeit abgezogen", () => {
    const hours = [{ weekday: 1, startTime: "08:00", endTime: "17:00" }];
    const occ = expandBlocks([rule({}), rule({ id: "p", userId: null, kind: "feierabend", startTime: "15:00", endTime: "24:00" })], "2026-03-23", "2026-03-23");
    const av = computeAvailability({ dateIso: "2026-03-23", hours, absences: [], blocks: blocksFor(occ, "u1", "2026-03-23") });
    expect(av).toMatchObject({ available: true, ranges: [{ start: "08:00", end: "12:00" }, { start: "12:30", end: "15:00" }], hoursRanges: [{ start: "08:00", end: "17:00" }] });
    const allDay = computeAvailability({ dateIso: "2026-03-23", hours, absences: [], blocks: [{ startMin: 0, endMin: 1440 }] });
    expect(allDay).toMatchObject({ available: false, reason: "block" });
    expect(subtractRanges([{ start: "08:00", end: "12:00" }], [{ startMin: 420, endMin: 510 }, { startMin: 600, endMin: 600 }])).toEqual([{ start: "08:30", end: "12:00" }]);
  });
});

describe("Sperrzeiten – Eingabe prüfen", () => {
  const base = { userId: null, kind: "pause", title: "", startsOn: "2026-03-23", endsOn: "", allDay: false, startTime: "12:00", endTime: "12:30", repeat: "none", weekdays: [], intervalWeeks: 1, note: "" };
  it("gültig; leere Felder → null; einmalig ohne Enddatum", () => {
    const r = blockInput.safeParse({ ...base, endsOn: "2026-04-01" });
    expect(r.success && r.data).toMatchObject({ title: null, note: null, endsOn: null, weekdays: [] });
  });
  it("Fehler: Ende vor Beginn, fehlende Wochentage, Enddatum vor Beginn, ungültige Art/Datum", () => {
    expect(blockInput.safeParse({ ...base, endTime: "11:00" }).success).toBe(false);
    expect(blockInput.safeParse({ ...base, repeat: "weekly" }).success).toBe(false);
    expect(blockInput.safeParse({ ...base, repeat: "daily", endsOn: "2026-03-01" }).success).toBe(false);
    expect(blockInput.safeParse({ ...base, kind: "urlaub" }).success).toBe(false);
    expect(blockInput.safeParse({ ...base, startsOn: "2026-02-30" }).success).toBe(false);
    expect(blockInput.safeParse({ ...base, startTime: "" }).success).toBe(false);
  });
  it("ganztägig ignoriert Zeiten; Wochentage sortiert/eindeutig", () => {
    const r = blockInput.safeParse({ ...base, allDay: true, startTime: "", endTime: "", repeat: "weekly", weekdays: [5, 1, 5], intervalWeeks: 3 });
    expect(r.success && r.data).toMatchObject({ startTime: null, endTime: null, weekdays: [1, 5], intervalWeeks: 3 });
    expect(blockInput.safeParse({ ...base, endTime: "24:00" }).success).toBe(true);
  });
});
