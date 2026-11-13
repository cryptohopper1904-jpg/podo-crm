/** Kalenderdatum JJJJ-MM-TT, das es wirklich gibt (kein 2026-02-30) und in einem sinnvollen Bereich liegt */
export function isValidIsoDate(s: string, opts: { minYear?: number; maxYear?: number } = {}): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  if (y < (opts.minYear ?? 2000) || y > (opts.maxYear ?? 2100)) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}
