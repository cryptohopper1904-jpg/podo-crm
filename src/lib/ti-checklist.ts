/**
 * TI-Vorbereitung der Praxis (Telematikinfrastruktur): Checkliste, gespeichert in organizations.settings.ti.
 * Nur Selbstauskunft der Praxis – PodoCRM prüft nichts davon gegen die TI und ist kein zertifiziertes TI-Produkt.
 */
import { z } from "zod";

export const TI_ITEM_STATES = ["open", "requested", "done"] as const;
export type TiItemState = (typeof TI_ITEM_STATES)[number];
export const TI_STATE_LABEL: Record<TiItemState, string> = { open: "offen", requested: "beantragt / in Arbeit", done: "erledigt" };

export const TI_ITEMS = [
  {
    key: "smcb",
    label: "SMC-B (Praxisausweis) beantragt",
    hint: "Institutionskarte der Praxis. Für Heilmittelerbringer über das eGBR (elektronisches Gesundheitsberuferegister); Voraussetzung ist die Kassenzulassung.",
  },
  {
    key: "ehba",
    label: "eHBA (elektronischer Heilberufsausweis)",
    hint: "Persönlicher Ausweis für die qualifizierte elektronische Signatur – ebenfalls über das eGBR. Nicht für jede Anwendung zwingend; beim Anbieter klären.",
  },
  {
    key: "access",
    label: "TI-Zugang: Konnektor oder TI-Gateway (Anbieter gewählt)",
    hint: "Konnektor vor Ort (mit Kartenterminal) oder TI-Gateway als Dienst eines zugelassenen Anbieters. Kartenterminal für SMC-B/eHBA wird in beiden Fällen benötigt.",
  },
  {
    key: "kim",
    label: "KIM-Adresse eingerichtet",
    hint: "KIM-Vertrag bei einem zugelassenen KIM-Anbieter, Clientmodul bzw. KIM über das TI-Gateway. Zugangsdaten unter Einstellungen → Schnittstellen → KIM eintragen.",
  },
  {
    key: "financing",
    label: "TI-Pauschale / Finanzierungsvereinbarung geprüft",
    hint: "Die Kosten werden über eine monatliche TI-Pauschale der Krankenkassen erstattet (Finanzierungsvereinbarung für Heilmittelerbringer) – Höhe und Antragsweg beim Verband bzw. GKV-Spitzenverband prüfen.",
  },
] as const;

export type TiItemKey = (typeof TI_ITEMS)[number]["key"];

const itemSchema = z.object({ state: z.enum(TI_ITEM_STATES).catch("open"), note: z.string().max(200).catch("") });
export const tiSettingsSchema = z.object({
  items: z.record(z.string(), itemSchema).catch({}),
  /** Name des TI-Anbieters (Konnektor/Gateway) – Freitext */
  provider: z.string().max(120).catch(""),
  updatedAt: z.string().max(40).optional().catch(undefined),
});
export type TiSettings = z.infer<typeof tiSettingsSchema>;

export function parseTiSettings(raw: unknown): TiSettings {
  const s = tiSettingsSchema.safeParse(raw ?? {});
  const base: TiSettings = s.success ? s.data : { items: {}, provider: "" };
  const items: TiSettings["items"] = {};
  for (const i of TI_ITEMS) items[i.key] = base.items[i.key] ?? { state: "open", note: "" };
  return { ...base, items };
}

export function tiProgress(s: TiSettings): { done: number; total: number } {
  return { done: TI_ITEMS.filter((i) => s.items[i.key]?.state === "done").length, total: TI_ITEMS.length };
}
