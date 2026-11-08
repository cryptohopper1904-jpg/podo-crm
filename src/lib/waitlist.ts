/**
 * Warteliste & Nachrücker – reine Regeln (ohne DB, testbar).
 *
 * waitlist.wishes ist Freitext (keine eigene Spalte für Präferenzen). Neue Einträge speichern die Wünsche
 * strukturiert als JSON (`{"v":1,…}`); ältere/handschriftliche Einträge werden heuristisch gelesen
 * („Di/Do vormittags“, „nachmittags“, Leistungsname). Leere Wünsche = jeder Termin passt.
 *
 * Angebot: Wird ein Termin frei, bekommen passende Personen (älteste Einträge zuerst, höchstens
 * MAX_OFFERS_PER_SLOT) einen persönlichen Einmal-Link (patient_links, Zweck „waitlist_offer“) – nur mit
 * Erinnerungs-Einwilligung für den Kanal. Wer zuerst annimmt, bekommt den Termin (Sperre); alle
 * anderen sehen „leider schon vergeben“.
 */
import { berlinDateIso, dateDe, TZ, timeDe } from "./format";
import { isoWeekday } from "./availability";

export const OFFER_PURPOSE = "waitlist_offer";
export const OFFER_KIND = "waitlist_offer";
export const MAX_OFFERS_PER_SLOT = 5;
export const OFFER_TTL_HOURS = 24;
/** Angebote nur, wenn bis zum Termin noch genug Zeit ist (Annahme + Anfahrt). */
export const OFFER_MIN_LEAD_HOURS = 3;

export const DAYPARTS = ["morning", "afternoon", "evening"] as const;
export type Daypart = (typeof DAYPARTS)[number];
export const DAYPART_LABEL: Record<Daypart, string> = { morning: "vormittags", afternoon: "nachmittags", evening: "abends" };

export type WaitlistWishes = { serviceIds: string[]; weekdays: number[]; dayparts: Daypart[]; note: string | null };

const uniq = <T,>(a: T[]) => [...new Set(a)];

export function serializeWishes(w: Partial<WaitlistWishes>): string {
  return JSON.stringify({
    v: 1,
    serviceIds: uniq(w.serviceIds ?? []).slice(0, 20),
    weekdays: uniq((w.weekdays ?? []).filter((d) => Number.isInteger(d) && d >= 1 && d <= 7)).sort(),
    dayparts: uniq((w.dayparts ?? []).filter((d) => (DAYPARTS as readonly string[]).includes(d))),
    note: w.note?.trim() ? w.note.trim().slice(0, 500) : null,
  });
}

const WEEKDAY_WORDS: [RegExp, number][] = [
  [/\bmo(ntag|ntags)?\b/, 1],
  [/\bdi(enstag|enstags)?\b/, 2],
  [/\bmi(ttwoch|ttwochs)?\b/, 3],
  [/\bdo(nnerstag|nnerstags)?\b/, 4],
  [/\bfr(eitag|eitags)?\b/, 5],
  [/\bsa(mstag|mstags)?\b/, 6],
  [/\bsonntags?\b/, 7], // „so“ allein ist ein häufiges Füllwort
];

/** Liest gespeicherte Wünsche: JSON (neu) oder Freitext (Heuristik). `services` dient dem Namensabgleich im Freitext. */
export function parseWishes(text: string | null | undefined, services: { id: string; name: string; code?: string }[] = []): WaitlistWishes {
  const empty: WaitlistWishes = { serviceIds: [], weekdays: [], dayparts: [], note: null };
  const t = (text ?? "").trim();
  if (!t) return empty;
  if (t.startsWith("{")) {
    try {
      const j = JSON.parse(t) as Record<string, unknown>;
      return {
        serviceIds: Array.isArray(j.serviceIds) ? j.serviceIds.filter((x): x is string => typeof x === "string") : [],
        weekdays: Array.isArray(j.weekdays) ? j.weekdays.filter((x): x is number => Number.isInteger(x) && (x as number) >= 1 && (x as number) <= 7) : [],
        dayparts: Array.isArray(j.dayparts) ? j.dayparts.filter((x): x is Daypart => (DAYPARTS as readonly string[]).includes(x as string)) : [],
        note: typeof j.note === "string" ? j.note : null,
      };
    } catch {
      /* Freitext */
    }
  }
  const low = t.toLowerCase().replace(/[.,;/+&]/g, " ");
  const weekdays = WEEKDAY_WORDS.filter(([re]) => re.test(low)).map(([, d]) => d);
  // „werktags“ = Mo–Fr
  if (/\bwerktags?\b/.test(low)) weekdays.push(1, 2, 3, 4, 5);
  const dayparts: Daypart[] = [];
  if (/vormittag|morgens|früh\b/.test(low)) dayparts.push("morning");
  if (/nachmittag|(?<!vor)mittags?\b/.test(low)) dayparts.push("afternoon");
  if (/abend/.test(low)) dayparts.push("evening");
  const serviceIds = services
    .filter((s) => s.name.length >= 4 && (t.toLowerCase().includes(s.name.toLowerCase()) || (s.code && new RegExp(`\\b${s.code.toLowerCase()}\\b`).test(low))))
    .map((s) => s.id);
  return { serviceIds, weekdays: uniq(weekdays).sort(), dayparts: uniq(dayparts), note: t };
}

export function daypartOf(d: Date): Daypart {
  const [h] = timeDe(d).split(":").map(Number);
  return h < 12 ? "morning" : h < 17 ? "afternoon" : "evening";
}

export type FreedSlot = { startsAt: Date; endsAt: Date; serviceIds: string[] };

/** Passt der freie Termin zu den Wünschen? Leere Kategorie = egal. */
export function wishesMatch(w: WaitlistWishes, slot: FreedSlot): boolean {
  if (w.weekdays.length && !w.weekdays.includes(isoWeekday(berlinDateIso(slot.startsAt)))) return false;
  if (w.dayparts.length && !w.dayparts.includes(daypartOf(slot.startsAt))) return false;
  // Leistung: der freie Termin muss eine gewünschte Leistung enthalten (ohne Leistung am Termin: passt nicht bei Wunsch)
  if (w.serviceIds.length && !w.serviceIds.some((id) => slot.serviceIds.includes(id))) return false;
  return true;
}

export type WaitlistCandidate = { id: string; patientId: string; wishes: string | null; createdAt: Date };

/**
 * Wer bekommt ein Angebot? Passende, offene Einträge – älteste zuerst, je Person nur einmal,
 * ohne die Person des abgesagten Termins und ohne Personen mit bereits laufendem Angebot.
 */
export function matchWaitlist(
  entries: WaitlistCandidate[],
  slot: FreedSlot,
  opts: { services?: { id: string; name: string; code?: string }[]; excludePatientIds?: Iterable<string>; limit?: number } = {},
): WaitlistCandidate[] {
  const exclude = new Set(opts.excludePatientIds ?? []);
  const seen = new Set<string>();
  return [...entries]
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))
    .filter((e) => {
      if (exclude.has(e.patientId) || seen.has(e.patientId)) return false;
      if (!wishesMatch(parseWishes(e.wishes, opts.services), slot)) return false;
      seen.add(e.patientId);
      return true;
    })
    .slice(0, opts.limit ?? MAX_OFFERS_PER_SLOT);
}

/** Gültigkeit des Angebots: 24 h, aber spätestens OFFER_MIN_LEAD_HOURS vor Terminbeginn. null = zu kurzfristig. */
export function offerExpiry(slotStart: Date, now = new Date()): Date | null {
  const latest = slotStart.getTime() - OFFER_MIN_LEAD_HOURS * 3600_000;
  if (latest <= now.getTime() + 30 * 60_000) return null;
  return new Date(Math.min(now.getTime() + OFFER_TTL_HOURS * 3600_000, latest));
}

/** Nachricht ohne medizinische Inhalte (keine Leistung, kein Befund). */
export function offerText(practice: { name: string; phone: string | null }, firstName: string | null, startsAt: Date, url: string, expiresAt: Date) {
  const hello = firstName ? `Guten Tag ${firstName}, ` : "Guten Tag, ";
  const until = new Intl.DateTimeFormat("de-DE", { timeZone: TZ, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(expiresAt);
  return {
    subject: `Freier Termin – ${practice.name}`,
    body: `${hello}bei ${practice.name} ist ein Termin frei geworden: ${dateDe(startsAt)} um ${timeDe(startsAt)} Uhr. Sie stehen auf unserer Warteliste. Wer zuerst bestätigt, bekommt den Termin: ${url} (gültig bis ${until} Uhr).${practice.phone ? ` Fragen: ${practice.phone}` : ""}`,
  };
}

export const describeWishes = (w: WaitlistWishes, services: { id: string; name: string }[] = []) => {
  const parts: string[] = [];
  if (w.serviceIds.length) parts.push(services.filter((s) => w.serviceIds.includes(s.id)).map((s) => s.name).join(", ") || "bestimmte Leistung");
  if (w.weekdays.length) parts.push(w.weekdays.map((d) => ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"][d - 1]).join("/"));
  if (w.dayparts.length) parts.push(w.dayparts.map((d) => DAYPART_LABEL[d]).join("/"));
  return parts.length ? parts.join(" · ") : "jeder Termin";
};
