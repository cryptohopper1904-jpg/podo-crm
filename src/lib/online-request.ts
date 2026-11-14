/**
 * Online-Terminanfragen (/buchen): Kennzeichen, Texte und die Fassung, die ein KI-Antwortvorschlag zu sehen bekommt.
 * Rein (ohne DB), damit Seite, Server und Tests dieselben Regeln nutzen.
 */
import type { MessageMeta } from "@/db/schema";

/** Betreff der Posteingangs-Nachricht einer Online-Anfrage (src/app/buchen/[slug]/actions.ts) */
export const ONLINE_REQUEST_SUBJECT = "Neue Online-Buchung (unbestätigt)";
/** Kennzeichen echter /buchen-Anfragen: appointments.external_id und messages.thread_key = „online-request:<Termin-ID>“ */
export const ONLINE_REQUEST_PREFIX = "online-request:";

export const onlineRequestKey = (appointmentId: string) => `${ONLINE_REQUEST_PREFIX}${appointmentId}`;

/** Termin-ID aus dem Kennzeichen „online-request:<uuid>“, sonst null */
export function onlineRequestAppointmentId(threadKey: string | null | undefined): string | null {
  if (!threadKey?.startsWith(ONLINE_REQUEST_PREFIX)) return null;
  const id = threadKey.slice(ONLINE_REQUEST_PREFIX.length);
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ? id.toLowerCase() : null;
}

/** Ersatz für die freie Notiz der anfragenden Person – sie geht nie an einen KI-Dienst */
export const NOTE_REMOVED = "[Notiz entfernt]";
/** Ersatz für den Leistungsnamen (kann gesundheitsbezogen sein, z. B. „Nagelkorrekturspange“) */
export const SERVICE_REMOVED = "[Leistung]";

/** Steuerzeichen/Zeilenumbrüche aus Namen entfernen (der Name steht in einer eigenen Zeile der Nachricht) */
export const singleLine = (s: string) => s.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();

/** Vor- und Nachname der Anfrage: strukturiert (messages.meta), bei älteren Nachrichten aus der „Name:“-Zeile */
export function onlineRequestNames(body: string, meta: MessageMeta | null | undefined): string[] {
  const r = meta?.onlineRequest;
  let first = r?.firstName?.trim() ?? "";
  let last = r?.lastName?.trim() ?? "";
  if (!first && !last) {
    // ältere Anfragen ohne meta: zweite Zeile „Name: Vorname Nachname“ (von uns erzeugt, vor der freien Notiz)
    const line = body.split(/\r?\n/)[1] ?? "";
    const m = /^Name: (.+)$/.exec(line);
    if (m) {
      const parts = m[1].trim().split(/\s+/);
      first = parts.slice(0, -1).join(" ");
      last = parts.at(-1) ?? "";
    }
  }
  const full = [first, last].filter(Boolean).join(" ");
  return [...new Set([full, last, first, ...full.split(/\s+/)].filter((n) => n.length >= 2))];
}

/**
 * Text einer Online-Anfrage für einen KI-Antwortvorschlag – NEU aufgebaut statt gefiltert, damit keine freien
 * Angaben durchrutschen: nur Termin-Datum/-Uhrzeit, der Name (wird danach durch redact() zum Platzhalter) und ein
 * fester Hinweis. Leistungsname → „[Leistung]“, Telefon/E-Mail entfallen, die freie Notiz → „[Notiz entfernt]“.
 */
export function onlineRequestLlmText(body: string, names: string[]): string {
  const lines = body.split(/\r?\n/);
  const when = /\bam (\d{4}-\d{2}-\d{2}) um (\d{2}:\d{2}) Uhr\.$/.exec(lines[0] ?? "");
  const hasNote = lines.some((l) => l.startsWith("Notiz: "));
  return [
    when ? `Online-Terminanfrage: ${SERVICE_REMOVED} am ${when[1]} um ${when[2]} Uhr.` : `Online-Terminanfrage: ${SERVICE_REMOVED}.`,
    names[0] ? `Name: ${names[0]}` : null,
    hasNote ? NOTE_REMOVED : null,
    "Die Anfrage ist noch unbestätigt; die Praxis meldet sich zur Bestätigung.",
  ]
    .filter(Boolean)
    .join("\n");
}
