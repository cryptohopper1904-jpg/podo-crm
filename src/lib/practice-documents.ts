/**
 * Angaben der Praxis für Belege (Rechnungen, Quittungen, Bögen) – organizations.settings.documents.
 * Reine Funktionen ohne Server-Importe (auch in Tests und im PDF nutzbar).
 *
 *   documents.qualification   Berufsbezeichnung/Qualifikation für die Fußzeile (Freitext)
 *   documents.whatsapp        Telefonnummer ist auch per WhatsApp erreichbar („auch WhatsApp“)
 *   documents.booking         Buchungsweg, der auf Rechnungen beworben wird (QR-Code + Kurz-URL)
 * Die Website stammt aus settings.websiteUrl (wie auf der Praxis-Website).
 */
import { parseOnlineBookingSettings } from "./portal-booking";
import { safeUrl } from "./website";

export const BOOKING_CHANNELS = ["podohero", "doctolib", "custom", "none"] as const;
export type BookingChannel = (typeof BOOKING_CHANNELS)[number];

export const BOOKING_CHANNEL_LABEL: Record<BookingChannel, string> = {
  podohero: "PodoHero-Online-Buchung (eigene Buchungsseite)",
  doctolib: "Doctolib",
  custom: "Andere (eigener Link)",
  none: "keiner",
};

export const LIMITS = { qualification: 200, bookingLabel: 60, url: 300 } as const;

/** Standard-Zahlungsziel neuer Rechnungen in Tagen (0 = sofort) */
export const DEFAULT_DUE_DAYS = 14;
export const MAX_DUE_DAYS = 120;

export type DocumentSettings = {
  dueDays: number;
  qualification: string | null;
  whatsapp: boolean;
  booking: { channel: BookingChannel; url: string | null; label: string | null };
};

const str = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

export function readDocumentSettings(settings: Record<string, unknown> | null | undefined): DocumentSettings {
  const raw = ((settings ?? {}).documents ?? {}) as Record<string, unknown>;
  const b = (raw.booking ?? {}) as Record<string, unknown>;
  const channel = BOOKING_CHANNELS.includes(b.channel as BookingChannel) ? (b.channel as BookingChannel) : "none";
  const due = typeof raw.dueDays === "number" && Number.isInteger(raw.dueDays) && raw.dueDays >= 0 && raw.dueDays <= MAX_DUE_DAYS ? raw.dueDays : DEFAULT_DUE_DAYS;
  return {
    dueDays: due,
    qualification: str(raw.qualification, LIMITS.qualification),
    whatsapp: raw.whatsapp === true,
    booking: { channel, url: safeUrl(b.url), label: str(b.label, LIMITS.bookingLabel) },
  };
}

/** Website der Praxis (settings.websiteUrl), nur http(s). */
export const practiceWebsite = (settings: Record<string, unknown> | null | undefined) => safeUrl((settings ?? {}).websiteUrl);

/** URL ohne Schema, „www.“ bleibt, ohne abschließenden Schrägstrich – für den Druck. */
export function shortUrl(url: string): string {
  return url.replace(/^https?:\/\//i, "").replace(/\/$/, "");
}

export type InvoiceBookingLink = { label: string; url: string; display: string };

/**
 * Buchungshinweis für Rechnungen: abhängig vom gewählten Weg.
 *  - podohero: eigene Buchungsseite /buchen/<slug> – nur wenn PUBLIC_URL gesetzt und Online-Buchung aktiv
 *  - doctolib / custom: hinterlegte http(s)-URL (custom mit eigener Beschriftung)
 *  - none oder unvollständig: kein Hinweis
 */
export function invoiceBookingLink(
  settings: Record<string, unknown> | null | undefined,
  ctx: { slug: string; publicUrl?: string | null },
): InvoiceBookingLink | null {
  const { booking } = readDocumentSettings(settings);
  const make = (url: string | null, label: string): InvoiceBookingLink | null => (url ? { label, url, display: shortUrl(url) } : null);
  switch (booking.channel) {
    case "podohero": {
      if (!parseOnlineBookingSettings(settings).enabled) return null;
      const base = safeUrl(ctx.publicUrl ?? "");
      if (!base || !/^[a-z0-9-]{1,80}$/.test(ctx.slug)) return null;
      return make(`${base.replace(/\/$/, "")}/buchen/${ctx.slug}`, booking.label ?? "Nächsten Termin online buchen:");
    }
    case "doctolib":
      return make(booking.url, booking.label ?? "Nächsten Termin online buchen (Doctolib):");
    case "custom":
      return make(booking.url, booking.label ?? "Nächsten Termin online buchen:");
    default:
      return null;
  }
}
