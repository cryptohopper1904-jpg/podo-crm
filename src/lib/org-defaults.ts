import type { Tx } from "@/db";
import { integrationConnections, services } from "@/db/schema";

/**
 * Startkatalog für eine neue Praxis. Preise sind Beispielwerte und müssen von der Praxis
 * angepasst werden. USt: 0 % nur bei Heilbehandlung mit therapeutischem Ziel (§ 4 Nr. 14 UStG) –
 * deshalb `requiresTherapeuticPurpose`, die Rechnung fragt den Nachweis ab.
 */
export const DEFAULT_SERVICES = [
  { code: "PK", name: "Podologische Komplexbehandlung", priceCents: 6500, vatRate: 0, durationMin: 40, category: "treatment" },
  { code: "HH", name: "Hornhautabtragung", priceCents: 3000, vatRate: 0, durationMin: 20, category: "treatment" },
  { code: "NB", name: "Nagelbearbeitung", priceCents: 3000, vatRate: 0, durationMin: 20, category: "treatment" },
  { code: "NS", name: "Nagelkorrekturspange setzen", priceCents: 6000, vatRate: 0, durationMin: 30, category: "brace" },
  { code: "NK", name: "Kontrolle/Nachregulierung Spange", priceCents: 2500, vatRate: 0, durationMin: 15, category: "brace" },
  { code: "ON", name: "Onyfix-Spange", priceCents: 6000, vatRate: 0, durationMin: 30, category: "brace" },
  { code: "OT", name: "Orthose (Silikon)", priceCents: 500, vatRate: 0, durationMin: 5, category: "treatment" },
  { code: "TA", name: "Tamponade", priceCents: 1000, vatRate: 0, durationMin: 10, category: "treatment" },
  { code: "FK", name: "Fußpflege kosmetisch", priceCents: 3500, vatRate: 19, durationMin: 30, category: "cosmetic", requiresTherapeuticPurpose: false },
  { code: "HB", name: "Hausbesuch-Pauschale", priceCents: 1500, vatRate: 0, durationMin: 0, category: "travel" },
  { code: "PR", name: "Pflegeprodukt (Verkauf)", priceCents: 1200, vatRate: 19, durationMin: 0, category: "product", requiresTherapeuticPurpose: false },
] as const;

const PROVIDERS = [
  "lexoffice",
  "sumup",
  "doctolib",
  "google_business",
  "email_imap",
  "whatsapp",
  "sms",
  "voice_agent",
  "transcription",
  "llm",
  "calendar_ics",
] as const;

export async function seedOrganizationDefaults(tx: Tx, organizationId: string) {
  await tx.insert(services).values(
    DEFAULT_SERVICES.map((s) => ({
      organizationId,
      code: s.code,
      name: s.name,
      priceCents: s.priceCents,
      vatRate: s.vatRate,
      durationMin: s.durationMin,
      category: s.category,
      requiresTherapeuticPurpose: "requiresTherapeuticPurpose" in s ? s.requiresTherapeuticPurpose : true,
    })),
  );
  await seedIntegrationDefaults(tx, organizationId);
}

/** Alle Schnittstellen starten im Mock-Modus, damit die Praxis alles gefahrlos ausprobieren kann. */
export async function seedIntegrationDefaults(tx: Tx, organizationId: string) {
  await tx
    .insert(integrationConnections)
    .values(PROVIDERS.map((provider) => ({ organizationId, provider, status: "mock" as const })));
}
