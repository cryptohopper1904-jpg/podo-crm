import { describe, expect, it } from "vitest";
import { CHANGELOG, type ChangelogEntry } from "@/content/changelog";
import { canSee, nextPrefs, selectLoginEntries, shouldOfferChangelog, visibleEntries, type ChangelogViewer } from "./changelog";

const e = (id: string, audience?: ChangelogEntry["audience"]): ChangelogEntry => ({ id, date: id.slice(0, 10), title: id, items: [{ tag: "neu", text: id }], audience });
const ENTRIES = [e("2026-10-01"), e("2026-11-01-p", "platform"), e("2026-11-01"), e("2026-10-15-o", "owner"), e("2026-09-01")];

const therapist: ChangelogViewer = { role: "therapist", isPlatformAdmin: false };
const owner: ChangelogViewer = { role: "owner", isPlatformAdmin: false };
const platformOnly: ChangelogViewer = { role: null, isPlatformAdmin: true };
const ids = (x: { entries: ChangelogEntry[] } | null) => x?.entries.map((y) => y.id);

describe("Neuigkeiten: Zielgruppe", () => {
  it("platform nur für Plattform-Admins, owner nur für Inhaber:innen", () => {
    expect(visibleEntries(ENTRIES, therapist).map((x) => x.id)).toEqual(["2026-11-01", "2026-10-01", "2026-09-01"]);
    expect(visibleEntries(ENTRIES, owner).map((x) => x.id)).toEqual(["2026-11-01", "2026-10-15-o", "2026-10-01", "2026-09-01"]);
    expect(visibleEntries(ENTRIES, platformOnly).map((x) => x.id)).toEqual(["2026-11-01-p", "2026-11-01", "2026-10-01", "2026-09-01"]);
    expect(canSee(e("x", "owner"), { role: "owner", isPlatformAdmin: true })).toBe(true);
  });
});

describe("Neuigkeiten: Auswahl beim Login", () => {
  it("noch nichts gesehen → neueste ungesehene (max. 3)", () => {
    expect(selectLoginEntries(ENTRIES, owner)).toEqual({ mode: "neu", entries: expect.any(Array) });
    expect(ids(selectLoginEntries(ENTRIES, owner))).toEqual(["2026-11-01", "2026-10-15-o", "2026-10-01"]);
    expect(ids(selectLoginEntries(ENTRIES, owner, {}, 1))).toEqual(["2026-11-01"]);
  });

  it("nur Einträge nach seenId", () => {
    const s = selectLoginEntries(ENTRIES, owner, { seenId: "2026-10-01" });
    expect(s?.mode).toBe("neu");
    expect(ids(s)).toEqual(["2026-11-01", "2026-10-15-o"]);
  });

  it("alles gesehen → trotzdem der neueste Eintrag (jedes Login)", () => {
    const s = selectLoginEntries(ENTRIES, therapist, { seenId: "2026-11-01" });
    expect(s).toEqual({ mode: "wiederholung", entries: [expect.objectContaining({ id: "2026-11-01" })] });
  });

  it("„bis zur nächsten Neuerung nicht mehr anzeigen“ → nichts, bis ein neuer Eintrag kommt", () => {
    expect(selectLoginEntries(ENTRIES, therapist, { seenId: "2026-11-01", mutedId: "2026-11-01" })).toBeNull();
    const later = [e("2026-12-01"), ...ENTRIES];
    expect(ids(selectLoginEntries(later, therapist, { seenId: "2026-11-01", mutedId: "2026-11-01" }))).toEqual(["2026-12-01"]);
  });

  it("Plattform-Eintrag zählt für andere nicht als neu", () => {
    expect(selectLoginEntries(ENTRIES, therapist, { seenId: "2026-11-01", mutedId: "2026-11-01" })).toBeNull();
    expect(ids(selectLoginEntries(ENTRIES, platformOnly, { seenId: "2026-11-01", mutedId: "2026-11-01" }))).toEqual(["2026-11-01-p"]);
  });

  it("keine Einträge → kein Popup", () => {
    expect(selectLoginEntries([], owner)).toBeNull();
    expect(selectLoginEntries([e("x", "platform")], owner)).toBeNull();
  });
});

describe("Neuigkeiten: Merken nach dem Schließen", () => {
  it("seenId/mutedId nur vorwärts und nur für sichtbare Einträge", () => {
    expect(nextPrefs({}, "2026-11-01", false, ENTRIES, therapist)).toEqual({ seenId: "2026-11-01" });
    expect(nextPrefs({}, "2026-11-01", true, ENTRIES, therapist)).toEqual({ seenId: "2026-11-01", mutedId: "2026-11-01" });
    expect(nextPrefs({ seenId: "2026-11-01" }, "2026-10-01", false, ENTRIES, therapist)).toEqual({ seenId: "2026-11-01" });
    expect(nextPrefs({}, "2026-11-01-p", false, ENTRIES, therapist)).toBeNull();
    expect(nextPrefs({}, "gibt-es-nicht", false, ENTRIES, owner)).toBeNull();
  });
});

describe("Neuigkeiten: Sitzungs-Flag", () => {
  it("nur einmal je Anmeldung, nicht vor 2FA, nicht im Support-Modus", () => {
    expect(shouldOfferChangelog({ verified: true, changelogShownAt: null, support: false })).toBe(true);
    expect(shouldOfferChangelog({ verified: true, changelogShownAt: new Date(), support: false })).toBe(false);
    expect(shouldOfferChangelog({ verified: false, changelogShownAt: null, support: false })).toBe(false);
    expect(shouldOfferChangelog({ verified: true, changelogShownAt: null, support: true })).toBe(false);
  });
});

describe("Neuigkeiten: Inhalte", () => {
  it("ids eindeutig, absteigend sortiert, Datum passt, Texte vorhanden", () => {
    const list = CHANGELOG.map((x) => x.id);
    expect(new Set(list).size).toBe(list.length);
    expect([...list].sort().reverse()).toEqual(list);
    for (const x of CHANGELOG) {
      expect(x.id.startsWith(x.date)).toBe(true);
      expect(x.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(x.items.length).toBeGreaterThan(0);
      for (const i of x.items) {
        expect(i.text.trim().length).toBeGreaterThan(10);
        if (i.href) expect(i.href.startsWith("/")).toBe(true);
      }
    }
  });
});
