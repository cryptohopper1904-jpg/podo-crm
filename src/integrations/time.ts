/** Zeitzonen-Hilfen für Europe/Berlin ohne externe Bibliothek. */

const TZ = "Europe/Berlin";

/** Offset von Europe/Berlin zum Zeitpunkt `utc` in Minuten (60 oder 120). */
export function berlinOffsetMinutes(utc: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(utc);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"));
  return Math.round((asUtc - Math.floor(utc.getTime() / 60000) * 60000) / 60000);
}

function fmtOffset(min: number): string {
  const sign = min >= 0 ? "+" : "-";
  const a = Math.abs(min);
  return `${sign}${String(Math.floor(a / 60)).padStart(2, "0")}:${String(a % 60).padStart(2, "0")}`;
}

/** Lokale Berliner Wandzeit → ISO-String mit Offset, z. B. 2026-11-09T10:30:00+01:00 */
export function berlinLocalToIso(y: number, m: number, d: number, hh = 0, mm = 0): string {
  // erste Schätzung mit +1 h, dann mit tatsächlichem Offset korrigieren (DST)
  let guess = new Date(Date.UTC(y, m - 1, d, hh, mm) - 60 * 60000);
  const off = berlinOffsetMinutes(guess);
  guess = new Date(Date.UTC(y, m - 1, d, hh, mm) - off * 60000);
  const off2 = berlinOffsetMinutes(guess);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${y}-${pad(m)}-${pad(d)}T${pad(hh)}:${pad(mm)}:00${fmtOffset(off2)}`;
}

/** YYYY-MM-DD → lexoffice-Format `YYYY-MM-DDT00:00:00.000+01:00` */
export function dateToLexofficeTimestamp(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return berlinLocalToIso(y, m, d).replace(/:00([+-])/, ":00.000$1");
}
