import "server-only";
import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { db, withOrg } from "@/db";
import { anamneses, appointments, auditLog, consents, messages, organizations, patientLinks, patients, users } from "@/db/schema";
import { audit } from "@/lib/audit";
import type { AuthContext } from "@/lib/auth/session";
import { isDeceased } from "@/lib/patient-deceased";
import { mergeRiskFlagsAdditive, riskFlagsFromAnamnesis, type AnamnesisData } from "@/lib/anamnesis";
import { assertCan } from "./authz";
import { generateLinkToken, hashLinkToken, isWellFormedToken, linkExpiry, linkState } from "@/lib/patient-link";

export async function listAnamneses(auth: AuthContext, patientId: string) {
  assertCan(auth, "patients.read");
  const org = auth.organization.id;
  const medical = auth.can("medical.read");
  const res = await withOrg(org, async (tx) => {
    // Ohne medizinisches Leserecht keine Risikomerkmale (Art. 9 DSGVO) – nur nicht-klinische Spalten
    const [row] = await tx
      .select({ id: patients.id, salutation: patients.salutation, title: patients.title, firstName: patients.firstName, lastName: patients.lastName, riskFlags: patients.riskFlags })
      .from(patients)
      .where(and(eq(patients.organizationId, org), eq(patients.id, patientId)));
    if (!row) return null;
    const p = medical ? row : { ...row, riskFlags: {} };
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
  if (res) await audit({ organizationId: org, userId: auth.user.id, action: medical ? "anamnesis.read" : "anamnesis.read_meta", entity: "patient", entityId: patientId });
  return res;
}

/**
 * Kopf- und Ausgangsdaten für den Anamnesebogen in der Praxis (iPad) bzw. die Druckfassung:
 * Patient (Name, Nummer, Geburtsdatum), optional der Termin (nur derselben Person), letzte Anamnese.
 * `mode`: "fill" (Bogen ausfüllen, medical.write) · "print" (Druck, medical.read).
 */
export async function anamnesisSheet(auth: AuthContext, patientId: string, opts: { mode: "fill" | "print"; appointmentId?: string | null }) {
  assertCan(auth, opts.mode === "fill" ? "medical.write" : "medical.read");
  const org = auth.organization.id;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuid.test(patientId)) return null;
  const res = await withOrg(org, async (tx) => {
    const [p] = await tx
      .select({ id: patients.id, number: patients.number, salutation: patients.salutation, title: patients.title, firstName: patients.firstName, lastName: patients.lastName, birthDate: patients.birthDate, riskFlags: patients.riskFlags })
      .from(patients)
      .where(and(eq(patients.organizationId, org), eq(patients.id, patientId)));
    if (!p) return null;
    const [appt] =
      opts.appointmentId && uuid.test(opts.appointmentId)
        ? await tx
            .select({ id: appointments.id, startsAt: appointments.startsAt })
            .from(appointments)
            .where(and(eq(appointments.organizationId, org), eq(appointments.id, opts.appointmentId), eq(appointments.patientId, patientId)))
        : [];
    const [latest] = await tx
      .select({ id: anamneses.id, createdAt: anamneses.createdAt, data: anamneses.data, author: users.name })
      .from(anamneses)
      .leftJoin(users, eq(users.id, anamneses.authorId))
      .where(and(eq(anamneses.organizationId, org), eq(anamneses.patientId, patientId)))
      .orderBy(desc(anamneses.createdAt))
      .limit(1);
    return {
      patient: p,
      appointment: appt ?? null,
      latest: latest ? { ...latest, data: latest.data as AnamnesisData, source: (latest.data as { source?: string }).source ?? "practice" } : null,
    };
  });
  if (res) await audit({ organizationId: org, userId: auth.user.id, action: opts.mode === "fill" ? "anamnesis.sheet_open" : "anamnesis.print", entity: "patient", entityId: patientId, meta: { appointmentId: res.appointment?.id ?? null } });
  return res;
}

export async function saveAnamnesis(auth: AuthContext, patientId: string, data: AnamnesisData, opts: { updateRiskFlags: boolean }) {
  assertCan(auth, "medical.write");
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
  assertCan(auth, "patients.write");
  const org = auth.organization.id;
  const { token, tokenHash } = generateLinkToken();
  const expiresAt = linkExpiry();
  let ok: boolean | "deceased" = false;
  try {
    ok = await withOrg(org, async (tx): Promise<boolean | "deceased"> => {
    // FOR UPDATE: ein paralleles „verstorben markieren“ (sperrt dieselbe Zeile) wartet bzw. wird hier gesehen
    const [p] = await tx.select({ id: patients.id, extra: patients.extra }).from(patients).where(and(eq(patients.organizationId, org), eq(patients.id, patientId))).for("update");
    if (!p) return false;
    // verstorben: keine neuen Patienten-Links
    if (isDeceased(p.extra)) return "deceased" as const;
    // Parallele Erzeugung serialisieren; zusätzlich sichert der partielle Unique-Index patient_links_one_active ab
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`plink:${org}:${patientId}:anamnesis`}))`);
    // ältere, noch offene Links desselben Zwecks werden widerrufen (nur ein gültiger Link je Patient)
    await tx
      .update(patientLinks)
      .set({ revokedAt: new Date() })
      .where(and(eq(patientLinks.organizationId, org), eq(patientLinks.patientId, patientId), eq(patientLinks.purpose, "anamnesis"), isNull(patientLinks.usedAt), isNull(patientLinks.revokedAt)));
    await tx.insert(patientLinks).values({ organizationId: org, patientId, purpose: "anamnesis", tokenHash, expiresAt, createdBy: auth.user.id });
    return true;
    });
  } catch (e) {
    // 23505 = unique_violation (patient_links_one_active): gleichzeitige Erzeugung → kein zweiter gültiger Link
    if (isUniqueViolation(e)) return { error: "Gerade wurde parallel ein Link erzeugt. Bitte erneut versuchen." } as const;
    throw e;
  }
  if (ok === "deceased") return { error: "Die Patient:in ist als verstorben markiert – kein neuer Link möglich." } as const;
  if (!ok) return { error: "Patient nicht gefunden." } as const;
  await audit({ organizationId: org, userId: auth.user.id, action: "patient_link.create", entity: "patient", entityId: patientId, meta: { purpose: "anamnesis" } });
  return { token, expiresAt };
}

export async function revokeAnamnesisLink(auth: AuthContext, patientId: string, linkId: string) {
  assertCan(auth, "patients.write");
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
    const [p] = await tx
      .select({ firstName: patients.firstName, extra: patients.extra })
      .from(patients)
      .where(and(eq(patients.organizationId, link.organizationId), eq(patients.id, link.patientId), isNull(patients.archivedAt)));
    if (!org || !p || isDeceased(p.extra)) return null;
    return { practiceName: org.name, practicePhone: org.phone, firstName: p.firstName };
  });
}

/** Version des Einwilligungstextes im Online-Bogen (wird je Einwilligung gespeichert) */
export const ONLINE_CONSENT_VERSION = "online-2026-11";

class LinkRejected extends Error {}

export const ONLINE_CONSENTS = ["photo_documentation", "email_reminders", "sms_reminders", "whatsapp"] as const;
export type OnlineConsent = (typeof ONLINE_CONSENTS)[number];

/**
 * Löst den Einmal-Link ein und speichert Anamnese + Einwilligungen + Posteingangs-Hinweis.
 * Alles in EINER Transaktion: Das atomare UPDATE … WHERE used_at IS NULL … RETURNING verhindert eine
 * Doppelnutzung (auch parallel); schlägt das Speichern fehl, bleibt der Link unbenutzt.
 */
export async function submitOnlineAnamnesis(token: string, data: AnamnesisData, granted: OnlineConsent[], meta: { ip?: string | null } = {}): Promise<{ ok: true } | { ok: false }> {
  if (!isWellFormedToken(token)) return { ok: false };
  const tokenHash = hashLinkToken(token);
  const result = await swallowRejected(db.transaction(async (tx) => {
    const [link] = await tx
      .update(patientLinks)
      .set({ usedAt: sql`now()` })
      .where(and(eq(patientLinks.tokenHash, tokenHash), eq(patientLinks.purpose, "anamnesis"), isNull(patientLinks.usedAt), isNull(patientLinks.revokedAt), gt(patientLinks.expiresAt, sql`now()`)))
      .returning({ id: patientLinks.id, organizationId: patientLinks.organizationId, patientId: patientLinks.patientId });
    if (!link) return null;
    // ab hier wie withOrg: Mandant aus dem gefundenen Link (RLS greift)
    await tx.execute(sql`select set_config('app.org_id', ${link.organizationId}, true)`);
    const org = link.organizationId;
    const [p] = await tx
      .select({ number: patients.number, archivedAt: patients.archivedAt, riskFlags: patients.riskFlags, extra: patients.extra })
      .from(patients)
      .where(and(eq(patients.organizationId, org), eq(patients.id, link.patientId)));
    // archivierte Akte: nichts speichern, Link NICHT verbrauchen (Rollback)
    if (!p || p.archivedAt || isDeceased(p.extra)) throw new LinkRejected();
    const [a] = await tx.insert(anamneses).values({ organizationId: org, patientId: link.patientId, data: { ...data, source: "online" }, authorId: null }).returning({ id: anamneses.id });
    // Jede Online-Einwilligung mit dem tatsächlichen Wert speichern (nicht angehakt = Widerruf/keine Einwilligung)
    const consentRows = [
      { type: "privacy_notice" as const, granted: true },
      ...ONLINE_CONSENTS.map((type) => ({ type, granted: granted.includes(type) })),
    ].map((c) => ({ ...c, organizationId: org, patientId: link.patientId, via: "online-anamnese", version: ONLINE_CONSENT_VERSION, recordedBy: null }));
    await tx.insert(consents).values(consentRows);
    // Sicherheitsrelevante Risiken (Diabetes, Blutverdünner …) sofort sichtbar machen – nur ergänzend,
    // Online-Angaben entfernen nie bestehende Merkmale (Bestätigung durch die Praxis-Version)
    await tx.update(patients).set({ riskFlags: mergeRiskFlagsAdditive(p.riskFlags, riskFlagsFromAnamnesis(data)), updatedAt: new Date() }).where(and(eq(patients.organizationId, org), eq(patients.id, link.patientId)));
    await tx.insert(messages).values({
      organizationId: org,
      patientId: link.patientId,
      channel: "none",
      direction: "inbound",
      subject: "Anamnesebogen eingegangen",
      // bewusst ohne Gesundheitsdaten (Posteingang sieht auch der Empfang)
      body: `Der Online-Anamnesebogen von Patient #${p.number} ist eingegangen. Bitte in der Akte unter „Anamnese“ prüfen und in einer Praxis-Version bestätigen.`,
      threadKey: `anamnesis:${a.id}`,
    });
    // Audit in derselben Transaktion: Daten, Token-Verbrauch und Nachweis gelingen nur gemeinsam
    await tx.insert(auditLog).values({
      organizationId: org,
      userId: null,
      action: "anamnesis.online.submit",
      entity: "patient",
      entityId: link.patientId,
      ip: meta.ip ?? null,
      meta: { anamnesisId: a.id, linkId: link.id, consentVersion: ONLINE_CONSENT_VERSION, consents: Object.fromEntries(consentRows.map((c) => [c.type, c.granted])) },
    });
    return true;
  }));
  return result ? { ok: true } : { ok: false };
}

async function swallowRejected<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch (e) {
    if (e instanceof LinkRejected) return null;
    throw e;
  }
}

function isUniqueViolation(e: unknown): boolean {
  for (let cur: unknown = e, i = 0; cur && i < 5; i++) {
    if (typeof cur === "object" && (cur as { code?: string }).code === "23505") return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}
