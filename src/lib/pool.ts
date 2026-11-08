/** Begrenzte Parallelität und harte Zeitlimits für Hintergrundläufe (z. B. Cron über alle Praxen). */

export class TimeoutError extends Error {
  constructor(message = "Zeitüberschreitung") {
    super(message);
    this.name = "TimeoutError";
  }
}

/** Verwirft das Ergebnis nach `ms` mit TimeoutError (die Operation selbst wird nicht abgebrochen). */
export function withTimeout<T>(p: Promise<T>, ms: number, message?: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(message)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Verarbeitet `items` mit höchstens `limit` gleichzeitigen Aufgaben. Fehler einzelner Aufgaben brechen
 * die anderen nicht ab (Ergebnis wie Promise.allSettled, Reihenfolge wie `items`).
 */
export async function mapPool<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      try {
        results[i] = { status: "fulfilled", value: await fn(items[i], i) };
      } catch (reason) {
        results[i] = { status: "rejected", reason };
      }
    }
  };
  const n = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
  await Promise.all(Array.from({ length: n }, worker));
  return results;
}
