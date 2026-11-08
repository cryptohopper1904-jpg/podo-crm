/**
 * Kleine HTTP-Hilfen für Adapter: Rate-Limiter (Token-Abstand), Retry bei 429/5xx, JSON.
 * Bewusst ohne Abhängigkeiten.
 */
import { IntegrationHttpError } from "./errors";
import type { FetchLike, ProviderId } from "./types";

const sleepReal = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Serialisiert Aufrufe mit Mindestabstand (z. B. lexoffice: ~2 Anfragen/s → 500 ms).
 * Pro Prozess; bei mehreren Instanzen zusätzlich auf 429 reagieren (siehe requestJson).
 */
export class RateLimiter {
  private nextSlot = 0;
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly minIntervalMs: number,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = sleepReal,
  ) {}

  schedule<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(async () => {
      const wait = this.nextSlot - this.now();
      if (wait > 0) await this.sleep(wait);
      this.nextSlot = Math.max(this.now(), this.nextSlot) + this.minIntervalMs;
    });
    this.chain = run.catch(() => undefined);
    return run.then(fn);
  }
}

export interface RequestOptions {
  provider: ProviderId;
  fetch: FetchLike;
  baseUrl: string;
  method?: string;
  path: string;
  headers?: Record<string, string>;
  body?: unknown;
  /** roher Body (z. B. FormData) statt JSON */
  rawBody?: BodyInit;
  limiter?: RateLimiter;
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** Führt eine Anfrage aus; wiederholt bei 429 (Retry-After beachtet) und 502/503/504 mit Backoff. */
export async function requestJson<T = unknown>(opts: RequestOptions): Promise<T> {
  const method = opts.method ?? "GET";
  const maxRetries = opts.maxRetries ?? 3;
  const sleep = opts.sleep ?? sleepReal;
  const headers: Record<string, string> = { Accept: "application/json", ...opts.headers };
  let body: BodyInit | undefined = opts.rawBody;
  if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.body);
  }
  const url = opts.baseUrl.replace(/\/$/, "") + opts.path;

  for (let attempt = 0; ; attempt++) {
    const exec = () => opts.fetch(url, { method, headers, body });
    const res = opts.limiter ? await opts.limiter.schedule(exec) : await exec();
    if (res.ok) {
      if (res.status === 204) return undefined as T;
      const text = await res.text();
      return (text ? JSON.parse(text) : undefined) as T;
    }
    const retryable = res.status === 429 || res.status === 502 || res.status === 503 || res.status === 504;
    if (retryable && attempt < maxRetries) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** attempt;
      await sleep(Math.min(delay, 10_000));
      continue;
    }
    const text = await res.text().catch(() => "");
    throw new IntegrationHttpError(opts.provider, res.status, text, method, opts.path);
  }
}
