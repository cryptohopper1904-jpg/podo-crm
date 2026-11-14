import "server-only";
import { and, eq } from "drizzle-orm";
import { withOrg } from "@/db";
import { patients, type messages } from "@/db/schema";
import { aiReplyChannel } from "@/lib/ai-replies";
import { onlineRequestLlmText, onlineRequestMessageAppointmentId, onlineRequestNames } from "@/lib/online-request";
import { matchPatientByAddress } from "@/server/messages";

type Message = typeof messages.$inferSelect;

/**
 * Was ein KI-Antwortvorschlag von einer Nachricht sehen darf (AppSec M-1, Recht H-88-4). Danach entfernt redact()
 * Namen (knownNames), Telefonnummern, E-Mail-Adressen und Datumsangaben, bevor etwas den Server verlässt.
 * - nur eingehende Nachrichten auf Kanälen mit Antwortmöglichkeit (E-Mail, SMS, WhatsApp) – keine internen
 *   Hinweise (Warteliste, Belege …) und keine Telefonnotizen des KI-Telefons (Name ohne Akte)
 * - nie KIM (Recht/AppSec L-2): Arztbriefe enthalten Gesundheitsdaten und Namen Dritter
 * - Online-Anfrage (/buchen: thread_key „online-request:“, ohne external_id, fester Betreff – AppSec I-4): Text wird
 *   neu aufgebaut – Name aus messages.meta,
 *   Leistung → „[Leistung]“, freie Notiz → „[Notiz entfernt]“, Telefon/E-Mail entfallen
 * - sonst: Namen der zugeordneten Person; ohne Zuordnung die Namen der eindeutig zur Absenderadresse passenden Akte
 *   (nur zum Schwärzen, es wird nichts zugeordnet). Freie Namen im Text erkennt redact() nicht zuverlässig.
 */
export async function replySuggestionInput(organizationId: string, m: Message): Promise<{ error: string } | { text: string; knownNames: string[] }> {
  if (m.channel === "kim") {
    return { error: "Für KIM-Nachrichten gibt es keine KI-Antwortvorschläge – Arztbriefe gehen nie an einen KI-Dienst." };
  }
  if (m.direction !== "inbound" || !aiReplyChannel(m.channel)) {
    return { error: "Für diese Nachricht gibt es keine KI-Antwortvorschläge (nur für E-Mail, SMS und WhatsApp)." };
  }
  const names: string[] = [];
  const onlineRequest = onlineRequestMessageAppointmentId(m) !== null;
  const patientId = m.patientId ?? (onlineRequest ? null : await matchPatientByAddress(organizationId, m.fromAddress));
  if (patientId) {
    const [p] = await withOrg(organizationId, (tx) =>
      tx.select({ firstName: patients.firstName, lastName: patients.lastName }).from(patients).where(and(eq(patients.organizationId, organizationId), eq(patients.id, patientId))),
    );
    if (p) names.push([p.firstName, p.lastName].filter(Boolean).join(" "), p.lastName, p.firstName ?? "");
  }
  if (onlineRequest) {
    const requestNames = onlineRequestNames(m.body, m.meta);
    return { text: onlineRequestLlmText(m.body, requestNames), knownNames: unique([...requestNames, ...names]) };
  }
  return { text: m.body, knownNames: unique(names) };
}

const unique = (names: string[]) => [...new Set(names.map((n) => n.trim()).filter((n) => n.length >= 2))];
