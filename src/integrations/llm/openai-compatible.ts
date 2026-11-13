/**
 * LLM-Adapter für OpenAI-kompatible Chat-Endpunkte (`POST {LLM_BASE_URL}/chat/completions`).
 * Konfiguration über env: LLM_BASE_URL, LLM_API_KEY, LLM_MODEL (oder Verbindungs-Config).
 *
 * ╔══════════════════════════════════════════════════════════════════════════════════════╗
 * ║ ACHTUNG – GESUNDHEITSDATEN (Art. 9 DSGVO, § 203 StGB):                               ║
 * ║ Echte Patientendaten dürfen NUR an einen Anbieter gehen, der                         ║
 * ║   1. Daten ausschließlich in der EU verarbeitet (EU-Endpunkt, z. B. Azure OpenAI EU,  ║
 * ║      Mistral, Claude über AWS Bedrock Frankfurt),                                    ║
 * ║   2. einen Auftragsverarbeitungsvertrag (AVV, Art. 28 DSGVO) unterschrieben hat,      ║
 * ║   3. Zero Data Retention zusichert und NICHT auf Kundendaten trainiert.               ║
 * ║ Zusätzlich ist die Einwilligung „ai_processing“ der Patient:in zu prüfen.             ║
 * ║ Vor jedem Versand wird `redact()` angewendet (Namen, Telefon, E-Mail, Datum …).       ║
 * ║ Das ist nur Datenminimierung – kein Ersatz für die Punkte 1–3.                        ║
 * ╚══════════════════════════════════════════════════════════════════════════════════════╝
 */
import { IntegrationNotConfiguredError } from "../errors";
import { requestJson } from "../http";
import type { FetchLike, LlmPort, NewsItemInput, StructuredReport } from "../types";
import { redact, restore } from "./redact";

export interface LlmOptions {
  baseUrl?: string | null;
  apiKey?: string | null;
  model?: string | null;
  /** Bestätigung, dass Anbieter EU + AVV + ZDR erfüllt (Pflicht für echte Daten). */
  dataProcessingApproved?: boolean;
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  temperature?: number;
}

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

const REPORT_KEYS: (keyof StructuredReport)[] = ["findings", "services", "material", "reaction", "recommendation"];

/** Extrahiert ein JSON-Objekt aus einer Modellantwort (auch wenn es in ```json … ``` steckt). */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf("{");
  const startArr = candidate.indexOf("[");
  const s = startArr >= 0 && (start < 0 || startArr < start) ? startArr : start;
  const end = Math.max(candidate.lastIndexOf("}"), candidate.lastIndexOf("]"));
  if (s < 0 || end < s) throw new Error("LLM-Antwort enthält kein JSON.");
  return JSON.parse(candidate.slice(s, end + 1));
}

export function normalizeReport(value: unknown): StructuredReport {
  const v = (value ?? {}) as Record<string, unknown>;
  const out = {} as StructuredReport;
  for (const k of REPORT_KEYS) {
    const x = v[k];
    out[k] = Array.isArray(x) ? x.map(String).join("\n") : typeof x === "string" ? x.trim() : x == null ? "" : String(x);
  }
  return out;
}

export class OpenAiCompatibleLlm implements LlmPort {
  readonly provider = "llm" as const;
  readonly isMock = false;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly fetchFn: FetchLike;

  constructor(private readonly opts: LlmOptions = {}) {
    const baseUrl = opts.baseUrl ?? process.env.LLM_BASE_URL;
    const apiKey = opts.apiKey ?? process.env.LLM_API_KEY;
    const model = opts.model ?? process.env.LLM_MODEL;
    if (!baseUrl || !apiKey || !model) {
      throw new IntegrationNotConfiguredError("llm", "LLM_BASE_URL, LLM_API_KEY und LLM_MODEL müssen gesetzt sein");
    }
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
    this.model = model;
    this.fetchFn = opts.fetch ?? ((u, i) => fetch(u, i));
  }

  /**
   * `publicDataOnly`: nur öffentliche Geschäftsdaten (Praxisname + Funktions-E-Mails aus OSM/Impressum),
   * keine Patientendaten – dann ist die Freigabe LLM_DATA_PROCESSING_APPROVED nicht nötig.
   */
  private async chat(messages: ChatMessage[], json: boolean, opts: { publicDataOnly?: boolean; maxRetries?: number } = {}): Promise<string> {
    if (!opts.publicDataOnly && !this.opts.dataProcessingApproved && process.env.LLM_DATA_PROCESSING_APPROVED !== "true") {
      throw new IntegrationNotConfiguredError(
        "llm",
        "Anbieter nicht freigegeben (EU-Verarbeitung, AVV und Zero Data Retention bestätigen: LLM_DATA_PROCESSING_APPROVED=true)",
      );
    }
    const res = await requestJson<{ choices?: { message?: { content?: string } }[] }>({
      provider: "llm",
      fetch: this.fetchFn,
      baseUrl: this.baseUrl,
      method: "POST",
      path: "/chat/completions",
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: {
        model: this.model,
        messages,
        temperature: this.opts.temperature ?? 0.2,
        // kostenlose Modelle (z. B. über OpenRouter) kennen response_format oft nicht → dort nur per Prompt
        ...(json && !opts.publicDataOnly ? { response_format: { type: "json_object" } } : {}),
      },
      sleep: this.opts.sleep,
      maxRetries: opts.maxRetries,
    });
    const content = res?.choices?.[0]?.message?.content;
    if (typeof content !== "string") throw new Error("LLM-Antwort ohne Inhalt.");
    return content;
  }

  async structureReport(transcript: string, opts: { knownNames?: string[] } = {}): Promise<StructuredReport> {
    // Behandlungsdaten sind hier nötig; Identifikatoren werden entfernt.
    const { text, map } = redact(transcript, { names: opts.knownNames, keepDates: false });
    const content = await this.chat(
      [
        {
          role: "system",
          content:
            "Du strukturierst diktierte Behandlungsberichte einer podologischen Praxis. Antworte ausschließlich als JSON-Objekt " +
            'mit den Schlüsseln "findings" (Befund), "services" (erbrachte Leistungen), "material" (verwendetes Material/Charge), ' +
            '"reaction" (Reaktion/Verträglichkeit), "recommendation" (Empfehlung/Nächster Termin). Erfinde nichts; ' +
            "fehlende Angaben als leere Zeichenkette. Platzhalter wie [NAME_1] unverändert lassen. Sprache: Deutsch.",
        },
        { role: "user", content: text },
      ],
      true,
    );
    const report = normalizeReport(extractJson(content));
    for (const k of REPORT_KEYS) report[k] = restore(report[k], map);
    return report;
  }

  async suggestReply(
    message: string,
    context: { practiceName?: string; tone?: "formal" | "friendly"; knownNames?: string[]; facts?: string[] } = {},
  ): Promise<string> {
    const { text, map } = redact(message, { names: context.knownNames });
    const facts = (context.facts ?? []).map((f) => redact(f, { names: context.knownNames, keepDates: true }).text);
    const content = await this.chat(
      [
        {
          role: "system",
          content:
            `Du formulierst Antwortentwürfe für ${context.practiceName ?? "eine podologische Praxis"}. ` +
            `Ton: ${context.tone === "friendly" ? "freundlich, per Sie" : "höflich-förmlich, per Sie"}. ` +
            "Keine medizinischen Diagnosen, keine Zusagen zu Terminen, die nicht in den Fakten stehen. " +
            "Platzhalter wie [NAME_1] unverändert lassen. Nur den Antworttext ausgeben." +
            (facts.length ? `\nFakten:\n- ${facts.join("\n- ")}` : ""),
        },
        { role: "user", content: text },
      ],
      false,
    );
    return restore(content.trim(), map);
  }

  /**
   * Praxissuche (Vertrieb): wählt aus bereits regelgeprüften Kandidaten die beste allgemeine Praxis-Adresse
   * und markiert Adressen, die nach einer Person aussehen. Gesendet werden NUR Praxisname und Kandidatenliste
   * (keine Seiteninhalte, keine Patientendaten). Praxisnamen von Einzelpraxen können den Namen der Inhaberin/des
   * Inhabers enthalten – deshalb nur mit ausdrücklicher Freigabe LEAD_SEARCH_LLM_APPROVED=true (src/server/lead-search.ts).
   * Die Antwort wird streng auf die Kandidaten beschränkt.
   */
  async choosePracticeEmail(practiceName: string, candidates: string[]): Promise<{ best: string | null; personal: string[] }> {
    const list = [...new Set(candidates.map((c) => c.trim().toLowerCase()))].slice(0, 20);
    if (!list.length) return { best: null, personal: [] };
    const content = await this.chat(
      [
        {
          role: "system",
          content:
            "Du hilfst, für eine Praxis (Podologie/medizinische Fußpflege) die allgemeine Kontaktadresse zu wählen. " +
            "Adressen, die nach einer Person aussehen (Vor- oder Nachname), dürfen NICHT gewählt werden. " +
            'Antworte ausschließlich als JSON {"best": "<adresse oder null>", "personal": ["<adressen, die nach einer Person aussehen>"]}. ' +
            "Wähle nur aus der Liste.",
        },
        { role: "user", content: JSON.stringify({ praxis: practiceName.slice(0, 200), kandidaten: list }) },
      ],
      true,
      // Praxissuche: keine Wiederholungen (Zeitbudget des Laufs)
      { publicDataOnly: true, maxRetries: 0 },
    );
    const parsed = extractJson(content) as { best?: unknown; personal?: unknown } | null;
    const personal = Array.isArray(parsed?.personal) ? parsed.personal.map((x) => String(x).trim().toLowerCase()).filter((x) => list.includes(x)) : [];
    const b = typeof parsed?.best === "string" ? parsed.best.trim().toLowerCase() : "";
    return { best: list.includes(b) && !personal.includes(b) ? b : null, personal };
  }

  async summarizeNews(items: NewsItemInput[]): Promise<{ url: string; summary: string }[]> {
    if (items.length === 0) return [];
    const content = await this.chat(
      [
        {
          role: "system",
          content:
            'Fasse jede Meldung für Podolog:innen in 2–3 Sätzen auf Deutsch zusammen. Antworte als JSON {"items":[{"url":"…","summary":"…"}]}.',
        },
        { role: "user", content: JSON.stringify(items.map((i) => ({ url: i.url, title: i.title, text: i.text?.slice(0, 4000) }))) },
      ],
      true,
    );
    const parsed = extractJson(content) as { items?: { url: string; summary: string }[] } | { url: string; summary: string }[];
    const list = Array.isArray(parsed) ? parsed : parsed.items ?? [];
    return list.filter((x) => x && typeof x.url === "string").map((x) => ({ url: x.url, summary: String(x.summary ?? "") }));
  }
}
