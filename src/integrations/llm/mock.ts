import type { LlmPort, NewsItemInput, StructuredReport } from "../types";

/**
 * Mock-LLM: regelbasiert und deterministisch. Ordnet Sätze anhand von Schlüsselwörtern den
 * Doku-Feldern zu – reicht für Entwicklung, Demos und Tests ohne Datenabfluss.
 */
const RULES: [keyof StructuredReport, RegExp][] = [
  ["material", /\b(material|charge|spange|tamponade|salbe|verband|fräser|instrument)/i],
  ["reaction", /\b(reaktion|vertragen|schmerz|blutung|rötung|beschwerdefrei)/i],
  ["recommendation", /\b(empfehl|nächste[rn]? termin|wiedervorstellung|kontrolle|in \d+ wochen)/i],
  ["services", /\b(behandlung|gekürzt|abgetragen|entfernt|geschliffen|gesetzt|durchgeführt|komplexbehandlung)/i],
  ["findings", /\b(befund|nagel|hornhaut|clavus|rhagade|mykose|eingewachsen|druckstelle|haut)/i],
];

export class LlmMock implements LlmPort {
  readonly provider = "llm" as const;
  readonly isMock = true;

  async structureReport(transcript: string): Promise<StructuredReport> {
    const out: StructuredReport = { findings: "", services: "", material: "", reaction: "", recommendation: "" };
    const sentences = transcript
      .split(/(?<=[.!?])\s+|\n+/)
      .map((s) => s.trim())
      .filter(Boolean);
    for (const s of sentences) {
      const key = RULES.find(([, re]) => re.test(s))?.[0] ?? "findings";
      out[key] = out[key] ? `${out[key]} ${s}` : s;
    }
    return out;
  }

  async suggestReply(message: string, context: { practiceName?: string } = {}): Promise<string> {
    const practice = context.practiceName ?? "Ihre Podologie-Praxis";
    const topic = /termin|absag|verschieb/i.test(message)
      ? "Gern kümmern wir uns um Ihren Termin und melden uns mit einem Vorschlag."
      : "Wir haben Ihre Nachricht erhalten und melden uns zeitnah.";
    return `Guten Tag,\n\nvielen Dank für Ihre Nachricht. ${topic}\n\nFreundliche Grüße\n${practice}`;
  }

  async summarizeNews(items: NewsItemInput[]) {
    return items.map((i) => ({ url: i.url, summary: (i.text ?? i.title).replace(/\s+/g, " ").slice(0, 200) }));
  }
}
