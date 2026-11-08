/**
 * Minimaler MIME-Parser (RFC 5322/2045–2047) für KIM-Nachrichten, wie sie das KIM-Clientmodul
 * nach der Entschlüsselung per POP3 ausliefert. Liefert nur, was der Posteingang braucht:
 * Kopfzeilen (Betreff, Absender, Datum, Message-ID), text/plain-Inhalt und Namen/Größen der Anhänge.
 * Anhänge selbst werden NICHT gespeichert (Datenminimierung) – nur ihre Metadaten.
 *
 * Bewusst defensiv: unbekannte Kodierungen/Zeichensätze führen nie zu einer Ausnahme,
 * Verschachtelungstiefe und Anzahl der Teile sind begrenzt.
 */
import type { KimAttachmentInfo } from "../types";

export interface ParsedMail {
  messageId: string | null;
  from: string | null;
  to: string | null;
  subject: string | null;
  date: Date | null;
  inReplyTo: string | null;
  kimService: string | null;
  text: string;
  attachments: KimAttachmentInfo[];
  headers: Map<string, string>;
}

const MAX_DEPTH = 8;
const MAX_PARTS = 100;
const MAX_TEXT = 100_000;

/** Bytes (als latin1-String: 1 Zeichen = 1 Byte) in einen Zeichensatz dekodieren. */
function decodeCharset(bin: string, charset: string | undefined): string {
  const cs = (charset ?? "utf-8").trim().toLowerCase().replace(/^"|"$/g, "");
  const bytes = Buffer.from(bin, "latin1");
  try {
    if (cs === "us-ascii" || cs === "ascii") return bytes.toString("utf8");
    return new TextDecoder(cs, { fatal: false }).decode(bytes);
  } catch {
    // unbekannter Zeichensatz → als UTF-8 versuchen
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  }
}

function decodeQuotedPrintable(s: string, header = false): string {
  let src = header ? s.replace(/_/g, " ") : s.replace(/=\r?\n/g, "");
  src = src.replace(/=([0-9A-Fa-f]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
  return src;
}

function decodeBase64(s: string): string {
  return Buffer.from(s.replace(/[^A-Za-z0-9+/=]/g, ""), "base64").toString("latin1");
}

/** RFC 2047: =?charset?B|Q?…?= in Kopfzeilen dekodieren (benachbarte Wörter ohne Leerraum). */
export function decodeEncodedWords(value: string): string {
  const joined = value.replace(/(=\?[^?]+\?[BbQq]\?[^?]*\?=)\s+(?==\?)/g, "$1");
  return joined.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_, cs: string, enc: string, data: string) => {
    const charset = cs.split("*")[0]; // RFC 2231 Sprachzusatz ignorieren
    const bin = enc.toUpperCase() === "B" ? decodeBase64(data) : decodeQuotedPrintable(data, true);
    return decodeCharset(bin, charset);
  });
}

/** Kopf und Rumpf trennen; Kopfzeilen entfalten. Rohtext ist latin1 (Byte-treu). */
function splitHeaderBody(raw: string): { headers: Map<string, string>; body: string } {
  const lead = raw.match(/^\r?\n/);
  if (lead) return { headers: new Map(), body: raw.slice(lead[0].length) };
  const m = raw.match(/\r?\n\r?\n/);
  const headPart = m ? raw.slice(0, m.index) : raw;
  const body = m ? raw.slice((m.index ?? 0) + m[0].length) : "";
  const headers = new Map<string, string>();
  const unfolded = headPart.replace(/\r?\n[ \t]+/g, " ");
  for (const line of unfolded.split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i <= 0) continue;
    const name = line.slice(0, i).trim().toLowerCase();
    const value = line.slice(i + 1).trim();
    // erster Wert gewinnt (doppelte Kopfzeilen sind verdächtig, nicht überschreiben)
    if (!headers.has(name)) headers.set(name, value);
  }
  return { headers, body };
}

/** Content-Type/Disposition: Hauptwert + Parameter (inkl. RFC 2231 name*=utf-8''…, name*0=…). */
export function parseHeaderParams(value: string | undefined): { value: string; params: Record<string, string> } {
  if (!value) return { value: "", params: {} };
  const parts: string[] = [];
  let cur = "";
  let quoted = false;
  for (const ch of value) {
    if (ch === '"') quoted = !quoted;
    if (ch === ";" && !quoted) {
      parts.push(cur);
      cur = "";
    } else cur += ch;
  }
  parts.push(cur);
  const params: Record<string, string> = {};
  const continued: Record<string, { i: number; v: string; ext: boolean }[]> = {};
  for (const p of parts.slice(1)) {
    const eq = p.indexOf("=");
    if (eq < 0) continue;
    const key = p.slice(0, eq).trim().toLowerCase();
    let v = p.slice(eq + 1).trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1).replace(/\\(.)/g, "$1");
    const cont = key.match(/^([^*]+)\*(\d+)(\*)?$/);
    if (cont) {
      (continued[cont[1]] ??= []).push({ i: Number(cont[2]), v, ext: !!cont[3] });
      continue;
    }
    if (key.endsWith("*")) {
      params[key.slice(0, -1)] = decode2231(v);
      continue;
    }
    params[key] = v;
  }
  for (const [k, list] of Object.entries(continued)) {
    list.sort((a, b) => a.i - b.i);
    const ext = list[0]?.ext;
    const joined = list.map((x) => x.v).join("");
    params[k] = ext ? decode2231(joined) : joined;
  }
  return { value: parts[0].trim().toLowerCase(), params };
}

function decode2231(v: string): string {
  const m = v.match(/^([^']*)'[^']*'(.*)$/);
  const charset = m ? m[1] : "utf-8";
  const data = (m ? m[2] : v).replace(/%([0-9A-Fa-f]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
  return decodeCharset(data, charset || "utf-8");
}

function decodeTransfer(body: string, encoding: string | undefined): string {
  const enc = (encoding ?? "7bit").trim().toLowerCase();
  if (enc === "base64") return decodeBase64(body);
  if (enc === "quoted-printable") return decodeQuotedPrintable(body);
  return body;
}

function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

interface Walk {
  plain: string[];
  html: string[];
  attachments: KimAttachmentInfo[];
  parts: number;
}

function walk(headers: Map<string, string>, body: string, depth: number, acc: Walk) {
  if (++acc.parts > MAX_PARTS || depth > MAX_DEPTH) return;
  const ct = parseHeaderParams(headers.get("content-type") ?? "text/plain; charset=us-ascii");
  const cd = parseHeaderParams(headers.get("content-disposition"));
  const type = ct.value || "text/plain";

  if (type.startsWith("multipart/")) {
    const boundary = ct.params.boundary;
    if (!boundary) return;
    const esc = boundary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Epilog nach dem Schluss-Trenner abschneiden; das Zeilenende vor einem Trenner gehört zum Trenner
    let inner = `\r\n${body}`;
    const close = inner.search(new RegExp(`\\r?\\n--${esc}--`));
    if (close >= 0) inner = inner.slice(0, close);
    const sections = inner.split(new RegExp(`\\r?\\n--${esc}[ \\t]*\\r?\\n`));
    // sections[0] = Präambel
    for (let i = 1; i < sections.length; i++) {
      const sec = sections[i];
      if (!sec.trim()) continue;
      const p = splitHeaderBody(sec);
      walk(p.headers, p.body, depth + 1, acc);
    }
    return;
  }

  if (type === "message/rfc822") {
    // eingebettete Nachricht: als Anhang zählen, Inhalt nicht weiter auswerten
    acc.attachments.push({ filename: "weitergeleitete-nachricht.eml", contentType: type, size: body.length });
    return;
  }

  const filename = cd.params.filename ?? ct.params.name;
  const isAttachment = cd.value === "attachment" || (!!filename && !type.startsWith("text/")) || (!!filename && cd.value !== "inline");
  const data = decodeTransfer(body, headers.get("content-transfer-encoding"));
  if (isAttachment) {
    acc.attachments.push({
      filename: sanitizeFilename(decodeEncodedWords(filename ?? "anhang")),
      contentType: type.slice(0, 100),
      size: Buffer.byteLength(data, "latin1"),
    });
    return;
  }
  if (type === "text/plain") acc.plain.push(decodeCharset(data, ct.params.charset));
  else if (type === "text/html") acc.html.push(htmlToText(decodeCharset(data, ct.params.charset)));
  else acc.attachments.push({ filename: sanitizeFilename(`anhang.${type.split("/")[1] ?? "bin"}`), contentType: type.slice(0, 100), size: Buffer.byteLength(data, "latin1") });
}

export function sanitizeFilename(name: string): string {
  const base = name.replace(/[\\/]/g, "_").replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return (base || "anhang").slice(0, 150);
}

const angle = (v: string | undefined | null) => {
  if (!v) return null;
  const m = v.match(/<([^>]+)>/);
  return (m ? m[1] : v).trim().slice(0, 300) || null;
};

/** Parst eine Rohmail (Buffer oder latin1-String). */
export function parseMime(raw: Buffer | string): ParsedMail {
  const bin = typeof raw === "string" ? Buffer.from(raw, "utf8").toString("latin1") : raw.toString("latin1");
  const { headers, body } = splitHeaderBody(bin);
  const acc: Walk = { plain: [], html: [], attachments: [], parts: 0 };
  walk(headers, body, 0, acc);
  const h = (k: string) => {
    const v = headers.get(k);
    // Kopfzeilen sind eigentlich ASCII; 8-Bit-Werte (häufig UTF-8) tolerant dekodieren
    return v === undefined ? null : decodeEncodedWords(decodeCharset(v, "utf-8")).replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  };
  const dateRaw = h("date");
  const date = dateRaw ? new Date(dateRaw) : null;
  let text = (acc.plain.length ? acc.plain : acc.html).join("\n\n").replace(/\r\n/g, "\n").trim();
  if (text.length > MAX_TEXT) text = `${text.slice(0, MAX_TEXT)}\n[… gekürzt]`;
  return {
    messageId: angle(h("message-id")),
    from: h("from"),
    to: h("to"),
    subject: h("subject"),
    date: date && !Number.isNaN(date.getTime()) ? date : null,
    inReplyTo: angle(h("in-reply-to")),
    kimService: h("x-kim-dienstkennung"),
    text,
    attachments: acc.attachments,
    headers,
  };
}

/** Reine Adresse aus „Name <adresse>“. */
export function addressOf(v: string | null | undefined): string | null {
  if (!v) return null;
  const m = v.match(/<([^>]+)>/);
  const a = (m ? m[1] : v).trim();
  return a || null;
}
