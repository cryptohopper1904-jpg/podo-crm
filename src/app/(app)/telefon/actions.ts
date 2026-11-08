"use server";

import { randomBytes } from "node:crypto";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { VoiceAgentMock } from "@/integrations/voice/voice-agent";
import { requireAuth } from "@/lib/auth/session";
import { processVoiceEvent, saveVoiceSettings, simulationAllowed } from "@/server/voice";

export type VoiceState = { error?: string; ok?: string; result?: string; callId?: string } | undefined;

export async function saveVoiceSettingsAction(_: VoiceState, form: FormData): Promise<VoiceState> {
  const auth = await requireAuth("settings.manage");
  await saveVoiceSettings(auth, { storeTranscripts: form.get("storeTranscripts") === "on" });
  revalidatePath("/telefon");
  return { ok: "Gespeichert." };
}

const simSchema = z.object({
  kind: z.enum(["tool", "end"]),
  callId: z.string().regex(/^sim-[a-z0-9]{8,32}$/),
  caller: z.string().trim().max(30).optional(),
  tool: z.string().max(40).optional(),
  args: z.string().max(4000).optional(),
  summary: z.string().trim().max(500).optional(),
});

/**
 * „Anruf simulieren“: baut eine Vapi-Payload und schickt sie durch denselben Code-Pfad wie
 * /api/voice/vapi (Parser → processVoiceEvent → Werkzeuge → Datenbank). Nur die Signaturprüfung entfällt.
 */
export async function simulateCallAction(_: VoiceState, form: FormData): Promise<VoiceState> {
  const auth = await requireAuth("messages.write");
  const org = auth.organization.id;
  if (!(await simulationAllowed(org))) return { error: "Simulation ist nur in der Entwicklung oder im Testmodus möglich." };
  const d = simSchema.safeParse(Object.fromEntries(form));
  if (!d.success) return { error: "Ungültige Eingabe." };
  const { callId, caller } = d.data;
  const call = { id: callId, customer: { number: caller || null } };
  let payload: unknown;
  if (d.data.kind === "tool") {
    let args: unknown = {};
    try {
      args = d.data.args ? JSON.parse(d.data.args) : {};
    } catch {
      return { error: "Argumente sind kein gültiges JSON." };
    }
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
        artifact: { transcript: "AI: Sie sprechen mit dem KI-Assistenten der Praxis. Dieses Gespräch wird aufgezeichnet.\nUser: Testanruf." },
      },
    };
  }
  const port = new VoiceAgentMock();
  const results = await processVoiceEvent(org, port.vendor, port.parseEvent(payload));
  revalidatePath("/telefon");
  if (results) return { ok: "Werkzeug ausgeführt.", result: JSON.stringify(port.formatToolResults(results), null, 2), callId };
  return { ok: "Gespräch beendet und protokolliert.", callId: `sim-${randomBytes(6).toString("hex")}` };
}
