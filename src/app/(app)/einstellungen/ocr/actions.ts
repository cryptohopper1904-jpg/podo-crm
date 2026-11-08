"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireAuth } from "@/lib/auth/session";
import { saveOcrSettings } from "@/server/ocr";

type State = { error?: string; ok?: string } | undefined;

const schema = z.object({
  enabled: z.boolean(),
  mode: z.enum(["mock", "live"]),
  baseUrl: z.string().trim().max(300).optional(),
  model: z.string().trim().max(120).regex(/^[\w.:/@-]*$/, "Modellname enthält ungültige Zeichen.").optional(),
  imageStyle: z.enum(["openai", "string"]),
  apiKey: z.string().trim().max(500).optional(),
  clearKey: z.boolean(),
  perHour: z.coerce.number().int().min(1, "Mindestens 1 Auslesung je Stunde.").max(500, "Höchstens 500 je Stunde."),
});

export async function saveOcrSettingsAction(_: State, form: FormData): Promise<State> {
  const auth = await requireAuth("settings.manage");
  const str = (k: string) => {
    const v = form.get(k);
    return typeof v === "string" && v.trim() ? v : undefined;
  };
  const parsed = schema.safeParse({
    enabled: form.get("enabled") === "on",
    mode: form.get("mode"),
    baseUrl: str("baseUrl"),
    model: str("model"),
    imageStyle: form.get("imageStyle"),
    apiKey: str("apiKey"),
    clearKey: form.get("clearKey") === "on",
    perHour: form.get("perHour"),
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Eingaben prüfen." };
  const res = await saveOcrSettings(auth, {
    ...parsed.data,
    confirm: { avv: form.get("confirmAvv") === "on", subprocessor: form.get("confirmSubprocessor") === "on", dataLeavesPractice: form.get("confirmDataLeaves") === "on" },
  });
  revalidatePath("/einstellungen/ocr");
  return res;
}
