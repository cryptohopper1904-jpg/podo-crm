/**
 * Vorlagen der Vertriebs-Sequenz: reiner Text mit Platzhaltern {{praxis}}, {{ansprechpartner}}, {{anrede}}, {{ort}}, {{absender}},
 * {{code}}, {{link}} (Aktionscode der Kampagne bzw. des Leads; ohne gültigen Code wird der Lead nicht angeschrieben).
 * - Ersetzung in EINEM Durchgang: Werte, die selbst „{{…}}“ enthalten, werden nicht erneut ersetzt.
 * - Werte sind einzeilig (Steuerzeichen/Zeilenumbrüche entfernt) und gekürzt; der Betreff nie mit Zeilenumbruch
 *   (keine Kopfzeilen-Injektion). HTML gibt es nicht – die Mail ist text/plain, die Vorschau rendert React (escaped).
 * - Leerer Wert vor Satzzeichen: das Leerzeichen davor entfällt („Guten Tag {{ansprechpartner}},“ → „Guten Tag,“).
 * - Jede Mail bekommt automatisch Absender-Impressum und Abmeldelink (nicht aus der Vorlage entfernbar).
 */
import { PLACEHOLDERS, PROMO_PLACEHOLDERS, type Placeholder, type Template } from "./constants";

export type TemplateValues = Record<Placeholder, string>;

const TOKEN_RE = /( ?)\{\{\s*([a-zA-Z_]+)\s*\}\}(?=([,.;:!?])?)/g;

/** Einzeiliger, harmloser Wert: keine Steuerzeichen/Zeilenumbrüche, Mehrfach-Leerzeichen zusammengefasst. */
export function cleanValue(v: string | null | undefined, max = 120): string {
  return (v ?? "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

export type PromoValues = { code: string; link: string };

export function placeholderValues(lead: { name: string; contactPerson?: string | null; city?: string | null }, senderName: string, promo?: PromoValues | null): TemplateValues {
  const contact = cleanValue(lead.contactPerson);
  return {
    praxis: cleanValue(lead.name),
    ansprechpartner: contact,
    anrede: contact ? `Guten Tag ${contact}` : "Guten Tag",
    // ohne Ort leer – „in {{ort}}“ entfällt dann ganz (renderText)
    ort: cleanValue(lead.city),
    absender: cleanValue(senderName),
    code: cleanValue(promo?.code, 40),
    link: cleanValue(promo?.link, 300),
  };
}

/** Nutzt die Vorlage {{code}} oder {{link}}? Dann braucht der Lead einen gültigen Aktionscode. */
export function templateUsesPromo(t: Template): boolean {
  const re = new RegExp(`\\{\\{\\s*(${PROMO_PLACEHOLDERS.join("|")})\\s*\\}\\}`, "i");
  return re.test(t.subject) || re.test(t.body);
}

const isPlaceholder = (k: string): k is Placeholder => (PLACEHOLDERS as readonly string[]).includes(k);

/** Ersetzt bekannte Platzhalter in einem Durchgang; unbekannte bleiben sichtbar stehen (Vorschau zeigt den Fehler). */
export function renderText(text: string, values: TemplateValues): string {
  // Ohne Ort: Präposition davor mit entfernen („… für die Podologie in {{ort}}“ → „… für die Podologie“)
  const t = values.ort ? text : text.replace(/(^|[ \t]+)(in|aus|bei|um)[ \t]+\{\{\s*ort\s*\}\}/gi, "");
  return t.replace(TOKEN_RE, (whole, space: string, key: string, punct: string | undefined) => {
    const k = key.toLowerCase();
    if (!isPlaceholder(k)) return whole;
    const v = values[k];
    if (!v) return punct ? "" : space;
    return space + v;
  });
}

/** Unbekannte Platzhalter in einer Vorlage (für die Prüfung beim Speichern). */
export function unknownPlaceholders(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\{\{\s*([^}]*?)\s*\}\}/g)) if (!isPlaceholder(m[1].toLowerCase())) out.add(m[1]);
  return [...out];
}

export function validateTemplate(t: Template): string | null {
  if (!t.subject.trim()) return "Betreff fehlt.";
  if (t.subject.length > 200) return "Betreff ist zu lang (max. 200 Zeichen).";
  if (/[\r\n]/.test(t.subject)) return "Der Betreff darf keinen Zeilenumbruch enthalten.";
  if (!t.body.trim()) return "Text fehlt.";
  if (t.body.length > 5000) return "Text ist zu lang (max. 5000 Zeichen).";
  const unknown = [...unknownPlaceholders(t.subject), ...unknownPlaceholders(t.body)];
  if (unknown.length) return `Unbekannte Platzhalter: ${unknown.map((u) => `{{${u}}}`).join(", ")}`;
  return null;
}

export type ComposeInput = {
  template: Template;
  lead: { name: string; contactPerson?: string | null; city?: string | null };
  senderName: string;
  impressum: string;
  unsubscribeUrl: string;
  /** Aktionscode/-link für {{code}}/{{link}} */
  promo?: PromoValues | null;
  /** Datenschutzhinweis (Art. 14 DSGVO), z. B. https://…/datenschutz#vertrieb */
  privacyUrl: string;
  /** Quelle der Kontaktdaten dieses Leads (sales_leads.source) – sonst allgemeine Aufzählung */
  source?: string | null;
  /** mailto-Abmeldung (Antwortadresse), zusätzlich zum Link */
  unsubscribeMailto?: string | null;
};

const GENERIC_SOURCE = "öffentlich zugänglichen Quellen (Praxis-Website/Impressum, OpenStreetMap) bzw. aus Ihrer Anfrage oder einem persönlichen Kontakt (z. B. Messe)";

/** Quelle als Text für die Fußzeile (Art. 14 Abs. 2 lit. f DSGVO): konkrete Quelle des Leads, sonst allgemein */
export function sourceText(source: string | null | undefined): string {
  const s = cleanValue(source, 120);
  if (!s || /^(manuell|csv-import)$/i.test(s)) return GENERIC_SOURCE;
  if (/^osm$/i.test(s)) return "OpenStreetMap (öffentlich zugängliche Geschäftsangaben)";
  if (/^osm\+impressum$/i.test(s)) return "OpenStreetMap und dem Impressum Ihrer Praxis-Website (öffentlich zugängliche Geschäftsangaben)";
  return s;
}

/** Fußzeile mit Absenderangaben, Datenschutzhinweis (Art. 14 DSGVO) und Abmeldung – wird an jede Mail angehängt. */
export function footer(impressum: string, unsubscribeUrl: string, privacyUrl: string, source?: string | null): string {
  const imp = impressum
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.trimEnd())
    .join("\n")
    .trim();
  return [
    "-- ",
    imp,
    "",
    `Ihre geschäftlichen Kontaktdaten stammen aus: ${sourceText(source)}. Eine erteilte Einwilligung können Sie jederzeit widerrufen (Art. 7 Abs. 3 DSGVO). Zweck, Rechtsgrundlage, Speicherdauer und Ihre Rechte, insbesondere Ihr Widerspruchsrecht nach Art. 21 DSGVO:`,
    privacyUrl,
    "",
    "Sie möchten keine weiteren E-Mails von uns erhalten? Mit einem Klick abmelden:",
    unsubscribeUrl,
    "Oder antworten Sie einfach mit „Abmelden“.",
  ].join("\n");
}

export function composeMail(input: ComposeInput): { subject: string; text: string; headers: Record<string, string> } {
  const values = placeholderValues(input.lead, input.senderName, input.promo);
  const subject = cleanValue(renderText(input.template.subject, values), 200);
  const body = renderText(input.template.body.replace(/\r\n?/g, "\n"), values).trim();
  const text = `${body}\n\n${footer(input.impressum, input.unsubscribeUrl, input.privacyUrl, input.source)}\n`;
  const unsub = [`<${input.unsubscribeUrl}>`];
  if (input.unsubscribeMailto) unsub.push(`<mailto:${input.unsubscribeMailto}?subject=Abmelden>`);
  return {
    subject,
    text,
    headers: { "List-Unsubscribe": unsub.join(", "), "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
  };
}
