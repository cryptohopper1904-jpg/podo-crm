/** Gesetzliche Feiertage in Deutschland je Bundesland (offline berechnet, ohne externe API). */
export const STATES = {
  BW: "Baden-Württemberg",
  BY: "Bayern",
  BE: "Berlin",
  BB: "Brandenburg",
  HB: "Bremen",
  HH: "Hamburg",
  HE: "Hessen",
  MV: "Mecklenburg-Vorpommern",
  NI: "Niedersachsen",
  NW: "Nordrhein-Westfalen",
  RP: "Rheinland-Pfalz",
  SL: "Saarland",
  SN: "Sachsen",
  ST: "Sachsen-Anhalt",
  SH: "Schleswig-Holstein",
  TH: "Thüringen",
} as const;
export type StateCode = keyof typeof STATES;

/** Ostersonntag nach dem Gauß/Meeus-Algorithmus. */
export function easterSunday(year: number): Date {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day));
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86400_000);

/** Buß- und Bettag: Mittwoch vor dem 23. November. */
function repentanceDay(year: number) {
  const nov23 = new Date(Date.UTC(year, 10, 23));
  const diff = (nov23.getUTCDay() + 7 - 3) % 7 || 7;
  return addDays(nov23, -diff);
}

export function holidays(year: number, state: StateCode): { date: string; name: string }[] {
  const e = easterSunday(year);
  const list: { date: Date; name: string; states?: StateCode[] }[] = [
    { date: new Date(Date.UTC(year, 0, 1)), name: "Neujahr" },
    { date: new Date(Date.UTC(year, 0, 6)), name: "Heilige Drei Könige", states: ["BW", "BY", "ST"] },
    { date: new Date(Date.UTC(year, 2, 8)), name: "Internationaler Frauentag", states: ["BE", "MV"] },
    { date: addDays(e, -2), name: "Karfreitag" },
    { date: e, name: "Ostersonntag", states: ["BB"] },
    { date: addDays(e, 1), name: "Ostermontag" },
    { date: new Date(Date.UTC(year, 4, 1)), name: "Tag der Arbeit" },
    { date: addDays(e, 39), name: "Christi Himmelfahrt" },
    { date: addDays(e, 49), name: "Pfingstsonntag", states: ["BB"] },
    { date: addDays(e, 50), name: "Pfingstmontag" },
    { date: addDays(e, 60), name: "Fronleichnam", states: ["BW", "BY", "HE", "NW", "RP", "SL"] },
    { date: new Date(Date.UTC(year, 7, 15)), name: "Mariä Himmelfahrt", states: ["SL"] },
    { date: new Date(Date.UTC(year, 8, 20)), name: "Weltkindertag", states: ["TH"] },
    { date: new Date(Date.UTC(year, 9, 3)), name: "Tag der Deutschen Einheit" },
    {
      date: new Date(Date.UTC(year, 9, 31)),
      name: "Reformationstag",
      states: ["BB", "HB", "HH", "MV", "NI", "SN", "ST", "SH", "TH"],
    },
    { date: new Date(Date.UTC(year, 10, 1)), name: "Allerheiligen", states: ["BW", "BY", "NW", "RP", "SL"] },
    { date: repentanceDay(year), name: "Buß- und Bettag", states: ["SN"] },
    { date: new Date(Date.UTC(year, 11, 25)), name: "1. Weihnachtstag" },
    { date: new Date(Date.UTC(year, 11, 26)), name: "2. Weihnachtstag" },
  ];
  return list
    .filter((h) => !h.states || h.states.includes(state))
    .map((h) => ({ date: iso(h.date), name: h.name }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

export function holidayOn(dateIso: string, state: StateCode): string | null {
  const year = Number(dateIso.slice(0, 4));
  return holidays(year, state).find((h) => h.date === dateIso)?.name ?? null;
}
