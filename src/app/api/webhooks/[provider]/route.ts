import { after, NextResponse, type NextRequest } from "next/server";
import { verifyHmacSignature } from "@/integrations/sumup/sumup";
import type { NormalizedWebhookEvent } from "@/integrations/types";
import {
  handleLexofficeWebhook,
  handleSmsWebhook,
  handleSumupWebhook,
  handleVoiceAgentWebhook,
  handleWhatsAppWebhook,
} from "@/integrations/webhooks";
import { decryptSecret } from "@/lib/secrets";
import { loadConnection, logSync } from "@/server/integrations";
import { bodyHash, finishWebhookEvent, isUuid, processSumupEvent, storeInboundMessages, storeWebhookEvent } from "@/server/webhooks";

/**
 * Webhook-Eingang: /api/webhooks/{provider}?org={organizationId}
 * 1. Signatur prüfen (falls Geheimnis hinterlegt), 2. idempotent in webhook_events speichern,
 * 3. sofort 200 antworten, 4. Verarbeitung nach der Antwort (after()).
 */
const PROVIDERS = ["sumup", "lexoffice", "whatsapp", "sms", "voice_agent"] as const;
type WebhookProvider = (typeof PROVIDERS)[number];

function secretOf(conn: Awaited<ReturnType<typeof loadConnection>>, org: string): Record<string, string> {
  if (!conn?.secretEnc) return {};
  try {
    return JSON.parse(decryptSecret(conn.secretEnc, org));
  } catch {
    return {};
  }
}

/** WhatsApp-Verifizierung (hub.challenge) */
export async function GET(req: NextRequest, ctx: RouteContext<"/api/webhooks/[provider]">) {
  const { provider } = await ctx.params;
  const org = req.nextUrl.searchParams.get("org");
  if (provider !== "whatsapp" || !isUuid(org)) return new NextResponse("Not found", { status: 404 });
  const conn = await loadConnection(org, "whatsapp");
  const token = (conn?.config as Record<string, unknown> | undefined)?.verifyToken;
  const sp = req.nextUrl.searchParams;
  if (sp.get("hub.mode") === "subscribe" && typeof token === "string" && token && sp.get("hub.verify_token") === token) {
    return new NextResponse(sp.get("hub.challenge") ?? "", { status: 200 });
  }
  return new NextResponse("Forbidden", { status: 403 });
}

export async function POST(req: NextRequest, ctx: RouteContext<"/api/webhooks/[provider]">) {
  const { provider: raw } = await ctx.params;
  const org = req.nextUrl.searchParams.get("org");
  if (!PROVIDERS.includes(raw as WebhookProvider) || !isUuid(org)) return NextResponse.json({ error: "Unbekannt" }, { status: 404 });
  const provider = raw as WebhookProvider;
  const rawBody = await req.text();
  if (rawBody.length > 512_000) return NextResponse.json({ error: "Zu groß" }, { status: 413 });
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Kein JSON" }, { status: 400 });
  }
  const headers = Object.fromEntries(req.headers.entries());
  const conn = await loadConnection(org, provider);
  const secret = secretOf(conn, org);

  // Signaturprüfung, sofern ein Geheimnis hinterlegt ist (Payloads sind ohnehin nicht autoritativ)
  if (provider === "sumup" && secret.webhookSecret) {
    const sig = headers[String((conn?.config as Record<string, unknown> | undefined)?.signatureHeader ?? "x-payload-signature").toLowerCase()];
    if (!verifyHmacSignature(rawBody, sig, secret.webhookSecret)) return NextResponse.json({ error: "Signatur ungültig" }, { status: 401 });
  }
  if (provider === "whatsapp" && secret.appSecret) {
    if (!verifyHmacSignature(rawBody, headers["x-hub-signature-256"], secret.appSecret)) return NextResponse.json({ error: "Signatur ungültig" }, { status: 401 });
  }

  let normalized: NormalizedWebhookEvent | null = null;
  let externalId = bodyHash(rawBody);
  if (provider === "sumup") {
    normalized = handleSumupWebhook(payload, headers);
    externalId = normalized.externalId;
  } else if (provider === "lexoffice") {
    normalized = handleLexofficeWebhook(payload);
    externalId = normalized.externalId;
  }

  let eventId: string | null;
  try {
    eventId = await storeWebhookEvent(provider, org, externalId, payload);
  } catch {
    return NextResponse.json({ error: "Unbekannte Praxis" }, { status: 404 });
  }
  if (!eventId) return NextResponse.json({ ok: true, duplicate: true });

  after(async () => {
    try {
      let note = "";
      if (provider === "sumup" && normalized) note = await processSumupEvent(org, normalized);
      else if (provider === "whatsapp") await storeInboundMessages(org, handleWhatsAppWebhook(payload));
      else if (provider === "sms") await storeInboundMessages(org, handleSmsWebhook(payload));
      else if (provider === "voice_agent") note = handleVoiceAgentWebhook(payload).type;
      else if (provider === "lexoffice") {
        // TODO: Zahlungsstatus per getPaymentStatus nachladen und Rechnung abgleichen
        await logSync(org, "lexoffice", { direction: "in", ok: true, message: `Ereignis ${normalized?.type}` });
      }
      await finishWebhookEvent(eventId, undefined);
      if (note) console.info(`[webhook ${provider}] ${note}`);
    } catch (e) {
      await finishWebhookEvent(eventId, e instanceof Error ? e.message : String(e));
      await logSync(org, provider, { direction: "in", ok: false, message: e instanceof Error ? e.message : String(e) }).catch(() => undefined);
    }
  });
  return NextResponse.json({ ok: true });
}
