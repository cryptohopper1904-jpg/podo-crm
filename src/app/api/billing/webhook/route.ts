import { NextResponse, type NextRequest } from "next/server";
import { getBillingPort } from "@/integrations/stripe";
import { WebhookSignatureError } from "@/integrations/stripe/types";
import { processBillingEvent } from "@/server/billing";

/**
 * Stripe-Webhook (öffentlich, siehe PUBLIC in src/proxy.ts) – FAIL CLOSED:
 *  1. Größe begrenzen (512 KB)
 *  2. Signatur `Stripe-Signature` mit STRIPE_WEBHOOK_SECRET prüfen (HMAC-SHA256, 5 min Toleranz)
 *  3. idempotent speichern + verarbeiten (billing_events), synchron: bei Fehler 500 → Stripe wiederholt
 * Antworten generisch (kein Orakel).
 */
const MAX_BODY = 512 * 1024;

export const dynamic = "force-dynamic";

async function readCapped(req: NextRequest): Promise<string | null> {
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY) return null;
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function POST(req: NextRequest) {
  const raw = await readCapped(req);
  if (raw === null) return NextResponse.json({ error: "Zu groß" }, { status: 413 });
  const port = getBillingPort();
  let event;
  try {
    event = port.verifyWebhook(raw, req.headers.get("stripe-signature"));
  } catch (e) {
    if (e instanceof WebhookSignatureError) return NextResponse.json({ error: "Nicht autorisiert" }, { status: 400 });
    throw e;
  }
  try {
    await processBillingEvent(event);
    return NextResponse.json({ received: true });
  } catch (e) {
    console.error("[billing] Verarbeitung fehlgeschlagen", event.id, event.type, e instanceof Error ? e.message : e);
    return NextResponse.json({ error: "Verarbeitung fehlgeschlagen" }, { status: 500 });
  }
}
