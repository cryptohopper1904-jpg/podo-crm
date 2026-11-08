"use server";

import { requestMeta } from "@/lib/auth/session";
import { parseAnamnesis } from "@/lib/anamnesis";
import { isWellFormedToken } from "@/lib/patient-link";
import { createRateLimiter } from "@/lib/rate-limit";
import { ONLINE_CONSENTS, submitOnlineAnamnesis, type OnlineConsent } from "@/server/anamnesis";

export type OnlineAnamnesisState = { error?: string; done?: boolean } | undefined;

// Drosselung je IP (Prozessspeicher mit Eviction; für mehrere Instanzen: Redis)
const limiter = createRateLimiter({ windowMs: 3600_000, max: 10, maxKeys: 5000 });

const INVALID = "Dieser Link ist ungültig, abgelaufen oder wurde bereits verwendet. Bitte wenden Sie sich an die Praxis.";

export async function submitOnlineAnamnesisAction(_: OnlineAnamnesisState, form: FormData): Promise<OnlineAnamnesisState> {
  const { ip } = await requestMeta();
  if (limiter.limited(ip ?? "unbekannt")) return { error: "Zu viele Versuche. Bitte später erneut versuchen oder die Praxis anrufen." };
  if (String(form.get("website") ?? "") !== "") return { error: INVALID }; // Honeypot
  const token = form.get("token");
  if (!isWellFormedToken(token)) return { error: INVALID };
  if (form.get("privacy") !== "on") return { error: "Bitte bestätigen Sie, dass Sie die Datenschutzhinweise gelesen haben." };
  const parsed = parseAnamnesis(Object.fromEntries(form), "online");
  if (!parsed.ok) return { error: parsed.error };
  const granted = ONLINE_CONSENTS.filter((c): c is OnlineConsent => form.get(`consent_${c}`) === "on");
  const res = await submitOnlineAnamnesis(token, parsed.data, granted);
  if (!res.ok) return { error: INVALID };
  // Keine Daten zurückgeben – nur Bestätigung
  return { done: true };
}
