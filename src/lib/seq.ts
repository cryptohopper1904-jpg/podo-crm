/**
 * Wie Promise.all, aber nacheinander. Innerhalb einer DB-Transaktion (eine Verbindung)
 * dürfen Abfragen nicht parallel laufen (pg warnt bzw. verbietet das ab pg@9).
 */
export async function sequential<T extends (() => Promise<unknown>)[]>(
  ...fns: T
): Promise<{ [K in keyof T]: Awaited<ReturnType<T[K]>> }> {
  const out: unknown[] = [];
  for (const fn of fns) out.push(await fn());
  return out as { [K in keyof T]: Awaited<ReturnType<T[K]>> };
}

export async function mapSequential<A, B>(items: A[], fn: (a: A) => Promise<B>): Promise<B[]> {
  const out: B[] = [];
  for (const i of items) out.push(await fn(i));
  return out;
}
