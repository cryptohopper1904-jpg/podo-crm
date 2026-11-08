/**
 * Stripe-Webhook-Signatur (https://docs.stripe.com/webhooks#verify-manually):
 * Header `Stripe-Signature: t=<unix>,v1=<hex>[,v1=…][,v0=…]`, signiert wird `${t}.${rawBody}`
 * mit HMAC-SHA256 und dem Endpoint-Secret (whsec_…). Toleranz gegen Replay: 5 Minuten.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { WebhookSignatureError, type StripeEvent } from "./types";

export const SIGNATURE_TOLERANCE_SEC = 300;

export function signStripePayload(rawBody: string, secret: string, timestampSec: number): string {
  const sig = createHmac("sha256", secret).update(`${timestampSec}.${rawBody}`, "utf8").digest("hex");
  return `t=${timestampSec},v1=${sig}`;
}

export function parseSignatureHeader(header: string): { t: number | null; v1: string[] } {
  let t: number | null = null;
  const v1: string[] = [];
  for (const part of header.split(",")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === "t" && /^\d{1,12}$/.test(v)) t = Number(v);
    else if (k === "v1" && /^[0-9a-f]{64}$/i.test(v)) v1.push(v.toLowerCase());
  }
  return { t, v1 };
}

/** Wirft WebhookSignatureError bei fehlender/falscher/abgelaufener Signatur. */
export function verifyStripeSignature(
  rawBody: string,
  header: string | null | undefined,
  secret: string | null | undefined,
  opts: { now?: Date; toleranceSec?: number } = {},
): void {
  if (!secret) throw new WebhookSignatureError("Kein Webhook-Secret konfiguriert.");
  if (!header) throw new WebhookSignatureError("Signatur fehlt.");
  const { t, v1 } = parseSignatureHeader(header);
  if (t === null || v1.length === 0) throw new WebhookSignatureError("Signatur unvollständig.");
  const nowSec = Math.floor((opts.now ?? new Date()).getTime() / 1000);
  const tolerance = opts.toleranceSec ?? SIGNATURE_TOLERANCE_SEC;
  if (Math.abs(nowSec - t) > tolerance) throw new WebhookSignatureError("Signatur abgelaufen (Zeitstempel außerhalb der Toleranz).");
  const expected = Buffer.from(createHmac("sha256", secret).update(`${t}.${rawBody}`, "utf8").digest("hex"), "hex");
  const ok = v1.some((s) => {
    const got = Buffer.from(s, "hex");
    return got.length === expected.length && timingSafeEqual(got, expected);
  });
  if (!ok) throw new WebhookSignatureError("Signatur ungültig.");
}

/** Signatur prüfen und Event-Grundstruktur validieren. */
export function parseVerifiedEvent(rawBody: string, header: string | null | undefined, secret: string | null | undefined, now?: Date): StripeEvent {
  verifyStripeSignature(rawBody, header, secret, { now });
  let ev: unknown;
  try {
    ev = JSON.parse(rawBody);
  } catch {
    throw new WebhookSignatureError("Kein gültiges JSON.");
  }
  const e = ev as Partial<StripeEvent>;
  if (
    !e ||
    typeof e.id !== "string" ||
    typeof e.type !== "string" ||
    typeof e.created !== "number" ||
    !e.data ||
    typeof e.data.object !== "object" ||
    e.data.object === null
  ) {
    throw new WebhookSignatureError("Unerwartetes Event-Format.");
  }
  return e as StripeEvent;
}
