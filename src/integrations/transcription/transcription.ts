/**
 * Transkription (PLAN 6.10): Sprachbericht → Text.
 *
 * Gerüst für einen OpenAI-kompatiblen Whisper-Endpunkt (`POST {TRANSCRIPTION_BASE_URL}/audio/transcriptions`,
 * multipart: file, model, language). NUR EU-Anbieter mit AVV und Zero Data Retention
 * (z. B. Azure OpenAI EU, selbst gehostetes Whisper) – Audio enthält Gesundheitsdaten!
 * Doku: https://platform.openai.com/docs/api-reference/audio/createTranscription
 * TODO: Gegen den gewählten EU-Anbieter testen; Freigabe analog LLM (TRANSCRIPTION_DATA_PROCESSING_APPROVED).
 */
import { IntegrationNotConfiguredError } from "../errors";
import { requestJson } from "../http";
import type { FetchLike, TranscriptionPort } from "../types";

export interface TranscriptionOptions {
  baseUrl?: string | null;
  apiKey?: string | null;
  model?: string | null;
  dataProcessingApproved?: boolean;
  fetch?: FetchLike;
}

export class WhisperCompatibleTranscription implements TranscriptionPort {
  readonly provider = "transcription" as const;
  readonly isMock = false;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly fetchFn: FetchLike;

  constructor(private readonly opts: TranscriptionOptions = {}) {
    const baseUrl = opts.baseUrl ?? process.env.TRANSCRIPTION_BASE_URL;
    const apiKey = opts.apiKey ?? process.env.TRANSCRIPTION_API_KEY;
    const model = opts.model ?? process.env.TRANSCRIPTION_MODEL ?? "whisper-1";
    if (!baseUrl || !apiKey) {
      throw new IntegrationNotConfiguredError("transcription", "TRANSCRIPTION_BASE_URL und TRANSCRIPTION_API_KEY fehlen");
    }
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
    this.model = model;
    this.fetchFn = opts.fetch ?? ((u, i) => fetch(u, i));
  }

  async transcribe(audio: Uint8Array, o: { mime?: string; language?: string; filename?: string } = {}) {
    if (!this.opts.dataProcessingApproved && process.env.TRANSCRIPTION_DATA_PROCESSING_APPROVED !== "true") {
      throw new IntegrationNotConfiguredError("transcription", "Anbieter nicht freigegeben (EU, AVV, Zero Data Retention bestätigen)");
    }
    const form = new FormData();
    form.append("file", new Blob([audio as BlobPart], { type: o.mime ?? "audio/webm" }), o.filename ?? "bericht.webm");
    form.append("model", this.model);
    form.append("language", o.language ?? "de");
    const res = await requestJson<{ text?: string; duration?: number }>({
      provider: "transcription",
      fetch: this.fetchFn,
      baseUrl: this.baseUrl,
      method: "POST",
      path: "/audio/transcriptions",
      headers: { Authorization: `Bearer ${this.apiKey}` },
      rawBody: form,
    });
    return { text: (res?.text ?? "").trim(), durationSec: res?.duration ?? null };
  }
}

/** Mock: liefert einen festen Beispieltext (abhängig von der Audiolänge, deterministisch). */
export class TranscriptionMock implements TranscriptionPort {
  readonly provider = "transcription" as const;
  readonly isMock = true;
  async transcribe(audio: Uint8Array) {
    return {
      text:
        "Befund: Nagel D1 links leicht eingewachsen, Hornhaut an der Ferse. " +
        "Behandlung: Nägel gekürzt, Hornhaut abgetragen. Material: Spange Größe M gesetzt, Charge A-12. " +
        "Reaktion: gut vertragen, beschwerdefrei. Empfehlung: Kontrolle in 4 Wochen.",
      durationSec: Math.round(audio.byteLength / 16000),
    };
  }
}
