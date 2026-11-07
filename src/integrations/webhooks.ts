/**
 * Reine Funktionen für Webhook-Eingänge. Die Route-Handler (src/app/api/webhooks/…) übernehmen
 * Signaturprüfung, Idempotenz (webhook_events.external_id) und Persistenz.
 */
import { handleLexofficeWebhook } from "./lexoffice/lexoffice";
import { parseSevenSmsWebhook, parseWhatsAppWebhook } from "./messaging/messaging";
import { handleSumupWebhook } from "./sumup/sumup";
import type { InboundMessage, VoiceCallEvent } from "./types";
import { parseGenericVoiceEvent } from "./voice/voice-agent";

export { handleLexofficeWebhook, handleSumupWebhook };

export function handleWhatsAppWebhook(payload: unknown): InboundMessage[] {
  return parseWhatsAppWebhook(payload);
}

export function handleSmsWebhook(payload: unknown): InboundMessage[] {
  return parseSevenSmsWebhook(payload);
}

export function handleVoiceAgentWebhook(payload: unknown): VoiceCallEvent {
  return parseGenericVoiceEvent(payload);
}
