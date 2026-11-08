import { createHash } from "node:crypto";

/**
 * Hash-Kette für die Behandlungsdokumentation: Jeder Eintrag enthält den Hash des vorherigen
 * Eintrags desselben Patienten. Zusammen mit den append-only-Triggern wird jede nachträgliche
 * Manipulation erkennbar. (Für einen Nachweis auch gegenüber DB-Admins: Hashes regelmäßig
 * extern signieren/WORM-speichern – siehe docs/PLAN.md 14.4.)
 */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(",")}}`;
}

export function chainHash(prevHash: string | null, content: Record<string, unknown>): string {
  return createHash("sha256").update(`${prevHash ?? "GENESIS"}|${canonical(content)}`).digest("hex");
}

export function verifyChain(entries: { prevHash: string | null; hash: string; content: Record<string, unknown> }[]): number {
  // Gibt den Index des ersten ungültigen Eintrags zurück, -1 wenn alles stimmt
  let prev: string | null = null;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.prevHash !== prev || chainHash(prev, e.content) !== e.hash) return i;
    prev = e.hash;
  }
  return -1;
}

export type TreatmentContentInput = {
  patientId: string;
  authorId: string;
  treatedAt: string;
  findings: string | null;
  servicesText: string | null;
  material: string | null;
  sterileBatchCode: string | null;
  reaction: string | null;
  recommendation: string | null;
  footPoints: unknown[];
  structured: Record<string, unknown>;
  appointmentId: string | null;
  missingPhotoReason: string | null;
  aiAssisted: boolean;
  countersignRequired: boolean;
  prescriptionId?: string | null;
};

/**
 * Inhalt eines Behandlungseintrags, der in die Hash-Kette eingeht.
 * `prescriptionId` wird nur aufgenommen, wenn gesetzt – so bleiben die Hashes älterer Einträge
 * (vor der Verordnungs-Verknüpfung) unverändert reproduzierbar.
 */
export function treatmentContent(input: TreatmentContentInput): Record<string, unknown> {
  const { prescriptionId, ...rest } = input;
  return prescriptionId ? { ...rest, prescriptionId } : rest;
}
