/**
 * Fertige Assistenten-Konfiguration zum Herunterladen (Einrichtungsassistent unter /telefon).
 *
 * Einzige Quelle für Prompt und Werkzeuge ist vapi-assistant.json; die Retell-Variante wird daraus
 * abgeleitet (Retell LLM: general_prompt, begin_message, general_tools vom Typ „custom“; Agent: webhook_url).
 * Der Retell-API-Schlüssel steht NIE in der Datei (Retell signiert mit dem Kontoschlüssel selbst).
 */
import template from "./vapi-assistant.json";

type Fn = { name: string; description: string; parameters: Record<string, unknown> };
type VapiTool = { type: string; function: Fn };

const cleanName = (name: string) => name.replace(/["\\<>{}]/g, "").trim().slice(0, 120) || "Ihre Praxis";

function fill(text: string, p: { serverUrl: string; secret?: string; practiceName: string }) {
  return text.replaceAll("<SERVER_URL>", p.serverUrl).replaceAll("<SERVER_SECRET>", p.secret ?? "").replaceAll("<PRAXISNAME>", cleanName(p.practiceName));
}

/** Vapi: Inhalt für Assistant → JSON (mit Server-URL-Secret – wie ein Passwort behandeln). */
export function vapiAssistantConfig(p: { serverUrl: string; secret: string; practiceName: string }): string {
  return fill(JSON.stringify(template.assistant, null, 2), p);
}

const systemPrompt = () => template.assistant.model.messages.find((m) => m.role === "system")?.content ?? "";

/** Retell: LLM + Agent als JSON (für die Retell-API bzw. zum Übertragen in das Dashboard). */
export function retellAgentConfig(p: { serverUrl: string; practiceName: string; recordingNotice?: boolean }) {
  const prompt = fill(systemPrompt(), p).replace(/\{\{\s*"now"[^}]*\}\}/g, "{{current_time_Europe/Berlin}}");
  const begin = fill(p.recordingNotice ? template.firstMessageMitAufzeichnung : template.assistant.firstMessage, p);
  const tools = (template.assistant.model.tools as VapiTool[]).map((t) => ({
    type: "custom",
    name: t.function.name,
    description: t.function.description,
    url: p.serverUrl,
    parameters: t.function.parameters,
    speak_during_execution: false,
    speak_after_execution: true,
    timeout_ms: 20000,
  }));
  return {
    anleitung: [
      "Vorlage für Retell AI. 1) Unter „LLM“ ein Retell-LLM mit den Werten aus \"llm\" anlegen (API: POST /create-retell-llm).",
      "2) Einen Agenten mit den Werten aus \"agent\" anlegen und das LLM auswählen (API: POST /create-agent). Stimme (voice_id) in Retell wählen.",
      "3) In PodoCRM → Telefon den API-Schlüssel des Retell-Kontos hinterlegen. Retell signiert jeden Aufruf (x-retell-signature); ohne gültige Signatur lehnt PodoCRM ab.",
      "Die erste Ansage muss den KI-Hinweis enthalten (EU AI Act Art. 50). Nicht entfernen.",
      "Transkripte werden nur gespeichert, wenn in PodoCRM „Transkripte speichern“ aktiv ist UND die erste Ansage auf die Aufzeichnung hinweist.",
      "AVV mit Retell und den gewählten Sprach-/Modellanbietern abschließen, EU-Verarbeitung wählen, wo möglich.",
    ],
    llm: {
      model: "gpt-4o",
      model_temperature: 0.2,
      general_prompt: prompt,
      begin_message: begin,
      general_tools: [...tools, { type: "end_call", name: "auflegen", description: "Gespräch höflich beenden, nachdem sich die anrufende Person verabschiedet hat." }],
    },
    agent: {
      agent_name: `Telefonassistent ${cleanName(p.practiceName)}`,
      language: "de-DE",
      voice_id: "<IN_RETELL_WAEHLEN>",
      webhook_url: p.serverUrl,
      end_call_after_silence_ms: 30000,
    },
  };
}
