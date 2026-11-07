/** Formatierung für Deutschland. Zeitzone der Praxis: Europe/Berlin. */
export const TZ = "Europe/Berlin";

const eur = new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR" });
export const money = (cents: number | null | undefined) => eur.format((cents ?? 0) / 100);

/** "65,00" / "65" / "65.5" → 6500 Cent. Gibt null bei ungültiger Eingabe zurück. */
export function parseMoney(input: string | number | null | undefined): number | null {
  if (input === null || input === undefined || input === "") return null;
  if (typeof input === "number") return Math.round(input * 100);
  const s = input.replace(/\s|€/g, "").replace(/\.(?=\d{3}(\D|$))/g, "").replace(",", ".");
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

export const dateDe = (d: Date | string | null | undefined) =>
  d ? new Intl.DateTimeFormat("de-DE", { timeZone: TZ, day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date(d)) : "–";

export const timeDe = (d: Date | string) =>
  new Intl.DateTimeFormat("de-DE", { timeZone: TZ, hour: "2-digit", minute: "2-digit" }).format(new Date(d));

export const dateTimeDe = (d: Date | string) => `${dateDe(d)}, ${timeDe(d)}`;

export const weekdayLong = (d: Date | string) =>
  new Intl.DateTimeFormat("de-DE", { timeZone: TZ, weekday: "long", day: "numeric", month: "long" }).format(new Date(d));

/** YYYY-MM-DD des Tages in Berlin */
export function berlinDateIso(d: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  return parts;
}

/** Wandelt "YYYY-MM-DD" + "HH:MM" (Berliner Ortszeit) in ein Date (UTC) um – inkl. Sommerzeit. */
export function berlinToUtc(dateIso: string, time: string): Date {
  const [y, m, d] = dateIso.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const offset = tzOffsetMinutes(new Date(guess));
  const result = new Date(guess - offset * 60_000);
  // Bei Umstellungstagen einmal nachkorrigieren
  const offset2 = tzOffsetMinutes(result);
  return offset2 === offset ? result : new Date(guess - offset2 * 60_000);
}

function tzOffsetMinutes(d: Date): number {
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(d);
  const get = (t: string) => Number(p.find((x) => x.type === t)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"));
  return Math.round((asUtc - d.getTime()) / 60_000);
}

export function ageYears(birthDate: string | null | undefined, at = new Date()): number | null {
  if (!birthDate) return null;
  const b = new Date(birthDate);
  let a = at.getFullYear() - b.getFullYear();
  if (at.getMonth() < b.getMonth() || (at.getMonth() === b.getMonth() && at.getDate() < b.getDate())) a--;
  return a;
}

export function fullName(p: { salutation?: string | null; title?: string | null; firstName?: string | null; lastName: string }) {
  return [p.title, p.firstName, p.lastName].filter(Boolean).join(" ");
}
