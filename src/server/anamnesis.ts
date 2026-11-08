import "server-only";
import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { db, withOrg } from "@/db";
import { anamneses, consents, messages, organizations, patientLinks, patients, users } from "@/db/schema";
import { audit } from "@/lib/audit";
import type { AuthContext } from "@/lib/auth/session";
import { riskFlagsFromAnamnesis, type AnamnesisData } from "@/lib/anamnesis";
import { generateLinkToken, hashLinkToken, isWellFormedToken, linkExpiry, linkState } from "@/lib/patient-link";

export async function listAnamneses(auth: AuthContext, patientId: string) {
  const org = auth.organization.id;
  const medical = auth.can("medical.read");
  const res = await withOrg(org, async (tx) => {
    const [p] = await tx.select().from(patients).where(and(eq(patients.organizationId, org), eq(patients.id, patientId)));
    if (!p) return null;
    const rows = await tx
      .select({ id: anamneses.id, createdAt: anamneses.createdAt, data: anamneses.data, author: users.name })
      .from(anamneses)
      .leftJoin(users, eq(users.id, anamneses.authorId))
      .where(and(eq(anamneses.organizationId, org), eq(anamneses.patientId, patientId)))
      .orderBy(desc(anamneses.createdAt));
    const links = await tx
      .select({ id: patientLinks.id, createdAt: patientLinks.createdAt, expiresAt: patientLinks.expiresAt, usedAt: patientLinks.usedAt, revokedAt: patientLinks.revokedAt })
      .from(patientLinks)
      .where(and(eq(patientLinks.organizationId, org), eq(patientLinks.patientId, patientId), eq(patientLinks.purpose, "anamnesis")))
      .orderBy(desc(patientLinks.createdAt))
      .limit(10);
    return {
      patient: p,
      // Ohne medizinisches Leserecht (Empfang) nur Metadaten der Versionen
      versions: rows.map((r) => ({ id: r.id, createdAt: r.createdAt, author: r.author, source: (r.data as { source?: string }).source ?? "practice", data: medical ? (r.data as AnamnesisData) : null })),
      links: links.map((l) => ({ ...l, state: linkState(l) })),
    };
  });
  if (res && medical) await audit({ organizationId: org, userId: auth.user.id, action: "anamnesis.read", entity: "patient", entityId: patientId });
  return res;
}

export async function saveAnamnesis(auth: AuthContext, patientId: string, data: AnamnesisData, opts: { updateRiskFlags: boolean }) {
  const org = auth.organization.id;
  const id = await withOrg(org, async (tx) => {
    const [p] = await tx.select({ id: patients.id, riskFlags: patients.riskFlags }).from(patients).where(and(eq(patients.organizationId, org), eq(patients.id, patientId)));
    if (!p) return null;
    const [row] = await tx.insert(anamneses).values({ organizationId: org, patientId, data, authorId: auth.user.id }).returning({ id: anamneses.id });
    if (opts.updateRiskFlags) {
      await tx.update(patients).set({ riskFlags: riskFlagsFromAnamnesis(data, p.riskFlags), updatedAt: new Date() }).where(and(eq(patients.organizationId, org), eq(patients.id, patientId)));
    }
    return row.id;
  });
  if (id) await audit({ organizationId: org, userId: auth.user.id, action: "anamnesis.create", entity: "patient", entityId: patientId, meta: { anamnesisId: id, riskFlagsUpdated: opts.updateRiskFlags } });
  return id;
}

/** Neuer Einmal-Link für die Online-Anamnese. Der Klartext-Token wird nur EINMAL zurückgegeben. */
export async function createAnamnesisLink(auth: AuthContext, patientId: string) {
  const org = auth.organization.id;
  const { token, tokenHash } = generateLinkToken();
  const expiresAt = linkExpiry();
  const ok = await withOrg(org, async (tx) => {
    const [p] = await tx.select({ id: patients.id }).from(patients).where(and(eq(patients.organizationId, org), eq(patients.id, patientId)));
    if (!p) return false;
    // ältere, noch offene Links desselben Zwecks werden widerrufen (nur ein gültiger Link je Patient)
    await tx
      .update(patientLinks)
      .set({ revokedAt: new Date() })
      .where(and(eq(patientLinks.organizationId, org), eq(patientLinks.patientId, patientId), eq(patientLinks.purpose, "anamnesis"), isNull(patientLinks.usedAt), isNull(patientLinks.revokedAt)));
    await tx.insert(patientLinks).values({ organizationId: org, patientId, purpose: "anamnesis", tokenHash, expiresAt, createdBy: auth.user.id });
    return true;
  });
  if (!ok) return null;
  await audit({ organizationId: org, userId: auth.user.id, action: "patient_link.create", entity: "patient", entityId: patientId, meta: { purpose: "anamnesis" } });
  return { token, expiresAt };
}

export async function revokeAnamnesisLink(auth: AuthContext, patientId: string, linkId: string) {
  const org = auth.organization.id;
  await withOrg(org, (tx) =>
    tx.update(patientLinks).set({ revokedAt: new Date() }).where(and(eq(patientLinks.organizationId, org), eq(patientLinks.id, linkId), eq(patientLinks.patientId, patientId), isNull(patientLinks.revokedAt), isNull(patientLinks.usedAt))),
  );
  await audit({ organizationId: org, userId: auth.user.id, action: "patient_link.revoke", entity: "patient", entityId: patientId });
}

// ───────────────────────── Öffentlich (ohne Login) ─────────────────────────

/** Für die öffentliche Seite: nur Vorname und Praxisname, und nur bei gültigem Link. */
export async function publicLinkInfo(token: string) {
  if (!isWellFormedToken(token)) return null;
  // patient_links hat bewusst keine RLS: Suche ausschließlich über den Token-Hash
  const [link] = await db
    .select({ organizationId: patientLinks.organizationId, patientId: patientLinks.patientId, usedAt: patientLinks.usedAt, revokedAt: patientLinks.revokedAt, expiresAt: patientLinks.expiresAt })
    .from(patientLinks)
    .where(and(eq(patientLinks.tokenHash, hashLinkToken(token)), eq(patientLinks.purpose, "anamnesis")));
  if (!link || linkState(link) !== "valid") return null;
  return withOrg(link.organizationId, async (tx) => {
    const [org] = await tx.select({ name: organizations.name, phone: organizations.phone }).from(organizations).where(eq(organizations.id, link.organizationId));
    const [p] = await tx.select({ firstName: patients.firstName }).from(patients).where(and(eq(patients.organizationId, link.organizationId), eq(patients.id, link.patientId)));
    if (!org || !p) return null;
    return { practiceName: org.name, practicePhone: org.phone, firstName: p.firstName };
  });
}

export const ONLINE_CONSENTS = ["photo_documentation", "email_reminders", "sms_reminders", "whatsapp"] as const;
export type OnlineConsent = (typeof ONLINE_CONSENTS)[number];

/**
 * Löst den Einmal-Link ein und speichert Anamnese + Einwilligungen + Posteingangs-Hinweis.
 * Alles in EINER Transaktion: Das atomare UPDATE … WHERE used_at IS NULL … RETURNING verhindert eine
 * Doppelnutzung (auch parallel); schlägt das Speichern fehl, bleibt der Link unbenutzt.
 */
export async function submitOnlineAnamnesis(token: string, data: AnamnesisData, granted: OnlineConsent[]): Promise<{ ok: true } | { ok: false }> {
  if (!isWellFormedToken(token)) return { ok: false };
  const tokenHash = hashLinkToken(token);
  const result = await db.transaction(async (tx) => {
    const [link] = await tx
      .update(patientLinks)
      .set({ usedAt: sql`now()` })
      .where(and(eq(patientLinks.tokenHash, tokenHash), eq(patientLinks.purpose, "anamnesis"), isNull(patientLinks.usedAt), isNull(patientLinks.revokedAt), gt(patientLinks.expiresAt, sql`now()`)))
      .returning({ id: patientLinks.id, organizationId: patientLinks.organizationId, patientId: patientLinks.patientId });
    if (!link) return null;
    // ab hier wie withOrg: Mandant aus dem gefundenen Link (RLS greift)
    await tx.execute(sql`select set_config('app.org_id', ${link.organizationId}, true)`);
    const org = link.organizationId;
    const [p] = await tx.select({ number: patients.number }).from(patients).where(and(eq(patients.organizationId, org), eq(patients.id, link.patientId)));
    if (!p) throw new Error("Patient zum Link fehlt");
    const [a] = await tx.insert(anamneses).values({ organizationId: org, patientId: link.patientId, data: { ...data, source: "online" }, authorId: null }).returning({ id: anamneses.id });
    const consentRows = [
      { type: "privacy_notice" as const, granted: true },
      ...granted.map((type) => ({ type, granted: true })),
    ].map((c) => ({ ...c, organizationId: org, patientId: link.patientId, via: "online-anamnese", recordedBy: null }));
    await tx.insert(consents).values(consentRows);
    await tx.insert(messages).values({
      organizationId: org,
      patientId: link.patientId,
      channel: "none",
      direction: "inbound",
      subject: "Anamnesebogen eingegangen",
      // bewusst ohne Gesundheitsdaten (Posteingang sieht auch der Empfang)
      body: `Der Online-Anamnesebogen von Kunde #${p.number} ist eingegangen. Bitte in der Akte unter „Anamnese“ prüfen und in einer Praxis-Version bestätigen.`,
      threadKey: `anamnesis:${a.id}`,
    });
    return { org, patientId: link.patientId, anamnesisId: a.id, linkId: link.id, consents: consentRows.map((c) => c.type) };
  });
  if (!result) return { ok: false };
  await audit({ organizationId: result.org, userId: null, action: "anamnesis.online.submit", entity: "patient", entityId: result.patientId, meta: { anamnesisId: result.anamnesisId, linkId: result.linkId, consents: result.consents } });
  return { ok: true };
}
