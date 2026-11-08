"use server";

import { randomBytes } from "node:crypto";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { RetellVoiceAgent, VoiceAgentMock } from "@/integrations/voice/voice-agent";
import type { VoiceAgentPort } from "@/integrations/types";
import { requireAuth } from "@/lib/auth/session";
import { processVoiceEvent, saveVoiceSettings, saveVoiceSetup, setVoiceLive, simulationAllowed, VoiceSetupError } from "@/server/voice";

export type VoiceState = { error?: string; ok?: string; result?: string; callId?: string } | undefined;

export async function saveVoiceSettingsAction(_: VoiceState, form: FormData): Promise<VoiceState> {
  const auth = await requireAuth("settings.manage");
  await saveVoiceSettings(auth, { storeTranscripts: form.get("storeTranscripts") === "on" });
  revalidatePath("/telefon");
  return { ok: "Gespeichert." };
}

/** Assistent Schritt 1+2: Anbieter + Geheimnis (wird verschlüsselt gespeichert und nie zurückgegeben). */
export async function saveVoiceSetupAction(_: VoiceState, form: FormData): Promise<VoiceState> {
  const auth = await requireAuth("integrations.manage");
  try {
    await saveVoiceSetup(auth, { vendor: String(form.get("vendor") ?? ""), secret: String(form.get("secret") ?? "") });
  } catch (e) {
    if (e instanceof VoiceSetupError) return { error: e.message };
    throw e;
  }
  revalidatePath("/telefon");
  return { ok: "Gespeichert. Nächster Schritt: Server-Adresse und Vorlage beim Anbieter eintragen." };
}

/** Assistent Schritt 5: live schalten bzw. zurück in den Testmodus. */
export async function setVoiceLiveAction(_: VoiceState, form: FormData): Promise<VoiceState> {
  const auth = await requireAuth("integrations.manage");
  const live = form.get("live") === "on";
  try {
    await setVoiceLive(auth, live);
  } catch (e) {
    if (e instanceof VoiceSetupError) return { error: e.message };
    throw e;
  }
  revalidatePath("/telefon");
  return { ok: live ? "Der KI-Telefonassistent ist live." : "Zurück im Testmodus – echte Anrufe werden abgelehnt (außer in der Entwicklung)." };
}

const simSchema = z.object({
  vendor: z.enum(["vapi", "retell"]).default("vapi"),
  kind: z.enum(["tool", "end"]),
  callId: z.string().regex(/^sim-[a-z0-9]{8,32}$/),
  caller: z.string().trim().max(30).optional(),
  tool: z.string().max(40).optional(),
  args: z.string().max(4000).optional(),
  summary: z.string().trim().max(500).optional(),
});

/**
 * „Testanruf simulieren“: baut eine Payload im Format des gewählten Anbieters (Vapi oder Retell) und
 * schickt sie durch denselben Code-Pfad wie /api/voice/{vendor} (Parser → processVoiceEvent → Werkzeuge
 * inkl. Minutenkontingent → Datenbank). Nur die Signaturprüfung entfällt.
 */
export async function simulateCallAction(_: VoiceState, form: FormData): Promise<VoiceState> {
  const auth = await requireAuth("messages.write");
  const org = auth.organization.id;
  if (!(await simulationAllowed(org))) return { error: "Simulation ist nur in der Entwicklung oder im Testmodus möglich." };
  const d = simSchema.safeParse(Object.fromEntries(form));
  if (!d.success) return { error: "Ungültige Eingabe." };
  const { callId, caller, vendor } = d.data;
  const call = { id: callId, customer: { number: caller || null } };
  const retellCall = { call_id: callId, from_number: caller || null };
  let payload: unknown;
  let args: unknown = {};
  if (d.data.kind === "tool") {
    try {
      args = d.data.args ? JSON.parse(d.data.args) : {};
    } catch {
      return { error: "Argumente sind kein gültiges JSON." };
    }
  }
  const transcript = "AI: Sie sprechen mit dem KI-Assistenten der Praxis. Dieses Gespräch wird aufgezeichnet.\nUser: Testanruf.";
  if (vendor === "retell") {
    const end = Date.now();
    payload =
      d.data.kind === "tool"
        ? { name: d.data.tool ?? "", args, call: retellCall }
        : { event: "call_analyzed", call: { ...retellCall, start_timestamp: end - 95_000, end_timestamp: end, duration_ms: 95_000, disconnection_reason: "user_hangup", transcript, call_analysis: { call_summary: d.data.summary || "Simulierter Anruf (Testdaten)." } } };
  } else if (d.data.kind === "tool") {
    const toolCallId = `simtc-${randomBytes(6).toString("hex")}`;
    payload = { message: { type: "tool-calls", call, toolCallList: [{ id: toolCallId, type: "function", function: { name: d.data.tool ?? "", arguments: args } }] } };
  } else {
    payload = {
      message: {
        type: "end-of-call-report",
        call,
        endedReason: "customer-ended-call",
        durationSeconds: 95,
        startedAt: new Date(Date.now() - 95_000).toISOString(),
        endedAt: new Date().toISOString(),
        analysis: { summary: d.data.summary || "Simulierter Anruf (Testdaten)." },
        artifact: { transcript },
      },
    };
  }
  const port: VoiceAgentPort = vendor === "retell" ? new RetellVoiceAgent() : new VoiceAgentMock();
  const results = await processVoiceEvent(org, port.vendor, port.parseEvent(payload));
  revalidatePath("/telefon");
  if (results) return { ok: "Werkzeug ausgeführt.", result: JSON.stringify(port.formatToolResults(results), null, 2), callId };
  return { ok: "Gespräch beendet und protokolliert.", callId: `sim-${randomBytes(6).toString("hex")}` };
}
