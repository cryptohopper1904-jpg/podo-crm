/**
 * Anbieterneutraler Kern des KI-Telefonagenten (ohne Datenbank, ohne Anbieterformat).
 *
 * Regeln (PLAN 4.6, 3.1 AI Act, 11 Risiken):
 *  - Werkzeug-Ergebnisse enthalten NIE Patientendaten (keine Namen, keine bestehenden Termine, keine
 *    Bestätigung, ob jemand Patient:in ist) – nur freie Zeiten und Praxis-Infos.
 *  - Buchungen landen unbestätigt und ohne Aktenzuordnung im Kalender, die Praxis bestätigt im Posteingang
 *    (gleiche Regel wie die Online-Buchung: Name + Telefonnummer reichen nie, um eine Akte zu verändern).
 *  - Absagen ändern nichts automatisch – nur ein Absagewunsch im Posteingang.
 *  - Keine medizinische Beratung: steht im Assistenten-Prompt (vapi-assistant.json) und wird hier nicht beantwortet.
 */
import { z } from "zod";
import type { VoiceTool, VoiceToolCall, VoiceToolResult } from "../types";

export const VOICE_TOOLS: readonly VoiceTool[] = ["freie_termine", "termin_buchen", "termin_absagen", "rueckruf", "praxis_info"];
export const isVoiceTool = (v: string): v is VoiceTool => (VOICE_TOOLS as readonly string[]).includes(v);

/** Ergebnis eines Anrufs (voice_calls.outcome). Höherer Rang überschreibt niedrigeren. */
export type VoiceOutcome = "booked" | "rescheduled" | "cancelled" | "callback" | "handover" | "info" | "failed";
const OUTCOME_RANK: Record<VoiceOutcome, number> = { failed: 0, info: 1, handover: 2, callback: 3, cancelled: 4, rescheduled: 5, booked: 6 };
export function strongerOutcome(a: string | null | undefined, b: VoiceOutcome | null | undefined): VoiceOutcome | null {
  const ra = a && a in OUTCOME_RANK ? OUTCOME_RANK[a as VoiceOutcome] : -1;
  const rb = b ? OUTCOME_RANK[b] : -1;
  if (rb > ra) return b ?? null;
  return ra >= 0 ? (a as VoiceOutcome) : null;
}

export const OUTCOME_LABEL: Record<string, string> = {
  booked: "Terminwunsch gebucht",
  rescheduled: "verschoben",
  cancelled: "Absagewunsch",
  callback: "Rückrufbitte",
  handover: "weitergeleitet",
  info: "Auskunft",
  failed: "fehlgeschlagen",
};

/** Ausgang aus dem Endegrund des Anbieters, falls kein Werkzeug einen stärkeren Ausgang gesetzt hat. */
export function outcomeFromEndedReason(reason: string | null | undefined): VoiceOutcome {
  const r = (reason ?? "").toLowerCase();
  if (r.includes("forward") || r.includes("transfer")) return "handover";
  if (r.includes("error") || r.includes("failed") || r.includes("fault")) return "failed";
  return "info";
}

// ───────────────────────── Hilfsfunktionen ─────────────────────────

/** Telefonnummer gekürzt speichern/anzeigen: „+49 151 ••• 23“. */
export function maskPhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/[^\d+]/g, "");
  const plain = digits.replace(/\D/g, "");
  if (plain.length < 6) return "•••";
  const tail = plain.slice(-2);
  if (digits.startsWith("+49")) return `+49 ${plain.slice(2, 5)} ••• ${tail}`;
  if (digits.startsWith("+")) return `+${plain.slice(0, 2)} ${plain.slice(2, 4)} ••• ${tail}`;
  return `${plain.slice(0, 4)} ••• ${tail}`;
}

/** „Erika Mustermann“ → „Erika M.“ (Kalendertitel ohne vollen Namen). */
export function shortName(firstName: string, lastName: string): string {
  const f = firstName.trim().replace(/\s+/g, " ");
  const l = lastName.trim();
  return l ? `${f} ${l.slice(0, 1).toUpperCase()}.` : f;
}

const BERLIN = "Europe/Berlin";
const dayFmt = new Intl.DateTimeFormat("de-DE", { timeZone: BERLIN, weekday: "long", day: "2-digit", month: "2-digit", year: "numeric" });
const timeFmt = new Intl.DateTimeFormat("de-DE", { timeZone: BERLIN, hour: "2-digit", minute: "2-digit" });
/** „Dienstag, 10.11.2026 um 09:00 Uhr“ */
export const slotLabel = (d: Date) => `${dayFmt.format(d)} um ${timeFmt.format(d)} Uhr`;

/**
 * Hinweis auf die Aufzeichnung in der ersten Ansage des Assistenten (siehe firstMessageMitAufzeichnung in
 * vapi-assistant.json). Ohne diese Ansage wird nie ein Transkript gespeichert.
 */
const RECORDING_NOTICE = /(wird|werden)\s+(\S+\s+){0,4}(aufgezeichnet|transkribiert|mitgeschrieben)/i;
export function recordingAnnounced(transcript: string | null | undefined): boolean {
  if (!transcript) return false;
  // erste Äußerung des Assistenten („AI:“/„Assistant:“/„bot:“) bzw. der Gesprächsanfang
  const lines = transcript.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const first = lines.find((l) => /^(ai|assistant|bot|agent)\s*:/i.test(l)) ?? lines[0] ?? "";
  return RECORDING_NOTICE.test(first.slice(0, 600));
}

export type VoiceSettings = {
  /** Transkripte speichern (nur wirksam, wenn die Ansage auf die Aufzeichnung hinweist) */
  storeTranscripts: boolean;
  /** Leistungen, die telefonisch gebucht werden dürfen (leer = wie Online-Buchung bzw. alle Behandlungen) */
  serviceCodes: string[];
};

export function readVoiceSettings(settings: Record<string, unknown> | null | undefined): VoiceSettings {
  const v = (settings?.voice ?? {}) as { storeTranscripts?: unknown; serviceCodes?: unknown };
  return {
    storeTranscripts: v.storeTranscripts === true,
    serviceCodes: Array.isArray(v.serviceCodes) ? v.serviceCodes.filter((c): c is string => typeof c === "string").slice(0, 50) : [],
  };
}

export function shouldStoreTranscript(settings: VoiceSettings, transcript: string | null | undefined): boolean {
  return settings.storeTranscripts && recordingAnnounced(transcript);
}

// ───────────────────────── Werkzeuge ─────────────────────────

const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const phone = z.string().trim().regex(/^[+\d][\d\s()/-]{5,29}$/);
const name = z.string().trim().min(1).max(80);
const code = z.string().trim().min(1).max(20);

export const toolArgs = {
  freie_termine: z.object({ von: isoDay, bis: isoDay.optional(), leistung: code }),
  termin_buchen: z.object({ vorname: name, nachname: name, telefon: phone.optional(), leistung: code, termin: z.string().datetime({ offset: true }) }),
  termin_absagen: z.object({ telefon: phone.optional(), datum: isoDay, name: name.optional() }),
  rueckruf: z.object({ name, telefon: phone.optional(), anliegen: z.string().trim().min(1).max(300), dringend: z.boolean().optional() }),
  praxis_info: z.object({}).passthrough(),
} satisfies Record<VoiceTool, z.ZodType>;

export type BookableService = { code: string; name: string; durationMin: number };

/** Datenzugriff – in Produktion src/server/voice.ts, in Tests ein Fake. */
export interface VoiceToolDeps {
  now(): Date;
  /** Rufnummer des Anrufers laut Anbieter (Fallback für `telefon`) */
  caller: string | null;
  services(): Promise<BookableService[]>;
  /** Freie Startzeiten (sortiert), höchstens `limit` */
  findSlots(input: { fromIso: string; toIso: string; durationMin: number; limit: number }): Promise<Date[]>;
  /** Unbestätigten Termin ohne Aktenbezug + Posteingangsnachricht anlegen. */
  book(input: { firstName: string; lastName: string; phone: string; service: BookableService; startsAt: Date }): Promise<
    { status: "booked"; appointmentId: string } | { status: "duplicate"; appointmentId: string; startsAt: Date } | { status: "taken" }
  >;
  /** Nachricht in den Posteingang (keine Aktenzuordnung) */
  inbox(input: { subject: string; body: string; from: string | null }): Promise<void>;
  practiceInfo(): Promise<{ name: string; address: string | null; phone: string | null; openingText: string }>;
  /** Ausgang des Anrufs vormerken (voice_calls) */
  noteOutcome(outcome: VoiceOutcome, appointmentId?: string | null): Promise<void>;
}

export const MAX_SLOTS = 3;
const MAX_RANGE_DAYS = 14;
/** Frühester buchbarer Termin (wie Online-Buchung) */
export const MIN_LEAD_MS = 2 * 3600_000;

const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T12:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);
const berlinToday = (now: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: BERLIN }).format(now);

function serviceList(svc: BookableService[]) {
  return svc.map((s) => `${s.code} (${s.name}, ${s.durationMin} Min.)`).join(", ");
}

async function resolveService(deps: VoiceToolDeps, raw: string): Promise<BookableService | string> {
  const svc = await deps.services();
  const found = svc.find((s) => s.code.toLowerCase() === raw.trim().toLowerCase());
  if (found) return found;
  return svc.length
    ? `Diese Leistung kann telefonisch nicht gebucht werden. Möglich sind: ${serviceList(svc)}.`
    : "Telefonisch können derzeit keine Termine gebucht werden. Bitte eine Rückrufbitte aufnehmen.";
}

const INVALID = "Die Angaben waren unvollständig oder ungültig. Bitte noch einmal nachfragen.";

async function run(tool: VoiceTool, rawArgs: Record<string, unknown>, deps: VoiceToolDeps): Promise<string> {
  switch (tool) {
    case "freie_termine": {
      const a = toolArgs.freie_termine.safeParse(rawArgs);
      if (!a.success) return `${INVALID} Benötigt: von (JJJJ-MM-TT), optional bis, leistung (Kürzel).`;
      const svc = await resolveService(deps, a.data.leistung);
      if (typeof svc === "string") return svc;
      const today = berlinToday(deps.now());
      const from = a.data.von < today ? today : a.data.von;
      let to = a.data.bis && a.data.bis >= from ? a.data.bis : from;
      if (to > addDays(from, MAX_RANGE_DAYS - 1)) to = addDays(from, MAX_RANGE_DAYS - 1);
      const slots = await deps.findSlots({ fromIso: from, toIso: to, durationMin: svc.durationMin, limit: MAX_SLOTS });
      await deps.noteOutcome("info");
      if (slots.length === 0) return `Im Zeitraum ${from} bis ${to} ist für ${svc.name} kein Termin frei. Bitte einen anderen Zeitraum anbieten oder eine Rückrufbitte aufnehmen.`;
      return [
        `Freie Termine für ${svc.name} (${svc.durationMin} Min.):`,
        ...slots.slice(0, MAX_SLOTS).map((s, i) => `${i + 1}. ${slotLabel(s)} – termin=${s.toISOString()}`),
        "Zum Buchen den gewählten Wert von termin unverändert an termin_buchen übergeben.",
      ].join("\n");
    }
    case "termin_buchen": {
      const a = toolArgs.termin_buchen.safeParse(rawArgs);
      if (!a.success) return `${INVALID} Benötigt: vorname, nachname, leistung, termin (aus freie_termine), telefon.`;
      const tel = a.data.telefon ?? deps.caller;
      if (!tel || !phone.safeParse(tel).success) return "Bitte eine Rückrufnummer erfragen und erneut buchen.";
      const svc = await resolveService(deps, a.data.leistung);
      if (typeof svc === "string") return svc;
      const startsAt = new Date(a.data.termin);
      if (!Number.isFinite(startsAt.getTime()) || startsAt.getTime() < deps.now().getTime() + MIN_LEAD_MS) {
        return "Dieser Zeitpunkt ist nicht mehr buchbar. Bitte mit freie_termine neue Zeiten abfragen.";
      }
      const r = await deps.book({ firstName: a.data.vorname, lastName: a.data.nachname, phone: tel.trim(), service: svc, startsAt });
      if (r.status === "taken") return "Dieser Termin ist leider nicht mehr frei. Bitte mit freie_termine neue Zeiten abfragen.";
      if (r.status === "duplicate") {
        return `In diesem Gespräch wurde bereits ein Terminwunsch für ${slotLabel(r.startsAt)} aufgenommen. Weitere Wünsche bitte als Rückrufbitte aufnehmen.`;
      }
      await deps.noteOutcome("booked", r.appointmentId);
      return `Terminwunsch für ${svc.name} am ${slotLabel(startsAt)} ist vorgemerkt. Wichtig für den Anrufer: Der Termin ist erst gültig, wenn die Praxis ihn bestätigt – die Praxis meldet sich unter der angegebenen Nummer.`;
    }
    case "termin_absagen": {
      const a = toolArgs.termin_absagen.safeParse(rawArgs);
      if (!a.success) return `${INVALID} Benötigt: datum (JJJJ-MM-TT) des Termins, telefon.`;
      const tel = a.data.telefon ?? deps.caller;
      await deps.inbox({
        subject: "Absagewunsch (KI-Telefon)",
        from: tel,
        body: [
          `Absagewunsch per KI-Telefon für den Termin am ${a.data.datum}.`,
          a.data.name ? `Name laut Anrufer: ${a.data.name}` : null,
          `Rückrufnummer: ${tel ?? "nicht übermittelt"}`,
          "Es wurde nichts automatisch geändert. Bitte Termin prüfen, Identität klären und ggf. absagen.",
        ].filter(Boolean).join("\n"),
      });
      await deps.noteOutcome("cancelled");
      // Kein Hinweis, ob es einen Termin gibt (kein Orakel für Dritte)
      return "Der Absagewunsch ist an die Praxis weitergegeben. Die Praxis kümmert sich darum und meldet sich bei Rückfragen. Bitte dem Anrufer sagen, dass der Termin erst nach Bestätigung durch die Praxis als abgesagt gilt.";
    }
    case "rueckruf": {
      const a = toolArgs.rueckruf.safeParse(rawArgs);
      if (!a.success) return `${INVALID} Benötigt: name, anliegen (kurz), telefon.`;
      const tel = a.data.telefon ?? deps.caller;
      if (!tel) return "Bitte eine Rückrufnummer erfragen.";
      await deps.inbox({
        subject: a.data.dringend ? "DRINGEND: Rückrufbitte (KI-Telefon)" : "Rückrufbitte (KI-Telefon)",
        from: tel,
        body: [`Rückrufbitte per KI-Telefon.`, `Name: ${a.data.name}`, `Telefon: ${tel}`, `Anliegen: ${a.data.anliegen}`].join("\n"),
      });
      await deps.noteOutcome("callback");
      return "Die Rückrufbitte ist an die Praxis weitergegeben.";
    }
    case "praxis_info": {
      const p = await deps.practiceInfo();
      const svc = await deps.services();
      await deps.noteOutcome("info");
      return [
        `Praxis: ${p.name}`,
        p.address ? `Adresse: ${p.address}` : null,
        p.phone ? `Telefon: ${p.phone}` : null,
        `Öffnungszeiten: ${p.openingText}`,
        svc.length ? `Telefonisch buchbare Leistungen: ${serviceList(svc)}` : "Telefonisch können derzeit keine Termine gebucht werden.",
      ].filter(Boolean).join("\n");
    }
  }
}

/** Führt die Werkzeug-Aufrufe nacheinander aus. Fehler werden nie als Details an den Anbieter gegeben. */
export async function runVoiceTools(calls: VoiceToolCall[], deps: VoiceToolDeps, onError?: (e: unknown, tool: string) => void): Promise<VoiceToolResult[]> {
  const out: VoiceToolResult[] = [];
  for (const c of calls) {
    if (!isVoiceTool(c.tool)) {
      out.push({ toolCallId: c.toolCallId, result: "Dieses Werkzeug gibt es nicht." });
      continue;
    }
    try {
      out.push({ toolCallId: c.toolCallId, result: await run(c.tool, c.args, deps) });
    } catch (e) {
      onError?.(e, c.tool);
      out.push({ toolCallId: c.toolCallId, result: "Technischer Fehler. Bitte eine Rückrufbitte aufnehmen oder auf die Öffnungszeiten verweisen." });
    }
  }
  return out;
}
