"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { withOrg } from "@/db";
import { appointments, braceEpisodes, media, patients, recordAddenda, treatmentRecords, type FootPoint } from "@/db/schema";
import { audit } from "@/lib/audit";
import { requireAuth } from "@/lib/auth/session";
import { chainHash } from "@/lib/records";
import { BRACE_RULES_VERSION, checkBracePhotos, type BraceAction } from "@/lib/rules/brace";

export type DokuFormState = { error?: string } | undefined;

const text = z.string().trim().max(5000).optional().transform((v) => (v ? v : null));

const schema = z.object({
  patientId: z.string().uuid(),
  appointmentId: z.string().uuid().optional(),
  findings: text,
  servicesText: text,
  material: text,
  reaction: text,
  recommendation: text,
  sterileBatchCode: z.string().trim().max(80).optional().transform((v) => v || null),
  missingPhotoReason: text,
  braceAction: z.enum(["none", "set", "check", "complication", "remove"]).default("none"),
  braceEpisodeId: z.string().uuid().optional(),
  braceSide: z.enum(["left", "right"]).optional(),
  braceToe: z.coerce.number().int().min(1).max(5).optional(),
  braceStage: z.string().optional(),
  braceType: z.string().trim().max(200).optional(),
  braceChange: z.string().trim().max(500).optional(),
  aiAssisted: z.string().optional(),
  confirm: z.literal("on", { message: "Bitte die Prüfung bestätigen." }),
});

export async function saveTreatmentAction(_: DokuFormState, form: FormData): Promise<DokuFormState> {
  const auth = await requireAuth("medical.write");
  const org = auth.organization.id;
  const parsed = schema.safeParse(Object.fromEntries([...form.entries()].filter(([, v]) => v !== "")));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Eingaben prüfen." };
  const d = parsed.data;
  let footPoints: FootPoint[] = [];
  let mediaIds: string[] = [];
  try {
    footPoints = z.array(z.object({ side: z.enum(["left", "right"]), point: z.string(), label: z.string().optional(), note: z.string().max(500).optional() })).parse(JSON.parse(String(form.get("footPoints") ?? "[]")));
    mediaIds = z.array(z.string().uuid()).parse(JSON.parse(String(form.get("mediaIds") ?? "[]")));
  } catch {
    return { error: "Fußschema oder Fotos konnten nicht gelesen werden." };
  }
  if (!d.findings && !d.servicesText && footPoints.length === 0) {
    return { error: "Bitte mindestens Befund oder durchgeführte Behandlung eintragen." };
  }

  const recordId = await withOrg(org, async (tx) => {
    const [p] = await tx.select({ id: patients.id }).from(patients).where(and(eq(patients.organizationId, org), eq(patients.id, d.patientId)));
    if (!p) throw new Error("Kunde nicht gefunden");
    // Hash-Kette je Patient serialisieren (parallele Einträge dürfen nicht verzweigen)
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"rec:" + d.patientId}))`);
    if (d.appointmentId) {
      const [a] = await tx.select({ id: appointments.id }).from(appointments).where(and(eq(appointments.organizationId, org), eq(appointments.id, d.appointmentId), eq(appointments.patientId, d.patientId)));
      if (!a) return { error: "Der Termin gehört nicht zu diesem Kunden." } as const;
    }
    if (d.braceEpisodeId) {
      const [b] = await tx.select({ id: braceEpisodes.id }).from(braceEpisodes).where(and(eq(braceEpisodes.organizationId, org), eq(braceEpisodes.id, d.braceEpisodeId), eq(braceEpisodes.patientId, d.patientId)));
      if (!b) return { error: "Die Spangen-Episode gehört nicht zu diesem Kunden." } as const;
    }
    const photos = mediaIds.length
      ? await tx.select({ id: media.id, purpose: media.purpose }).from(media).where(and(eq(media.organizationId, org), eq(media.patientId, d.patientId), inArray(media.id, mediaIds), isNull(media.recordId), eq(media.uploadedBy, auth.user.id)))
      : [];
    const brace = checkBracePhotos(d.braceAction as BraceAction, photos.map((x) => x.purpose), d.missingPhotoReason);
    if (!brace.ok) return { error: "Für diesen Spangen-Schritt fehlt das Pflichtfoto. Bitte aufnehmen oder begründen." } as const;
    if (d.braceAction === "check" && d.braceChange && d.braceChange.length < 10) {
      return { error: "Bei einem Spangenwechsel bitte neuen Typ UND Begründung angeben." } as const;
    }

    // Spangen-Episode pflegen
    let braceEpisodeId = d.braceEpisodeId ?? null;
    if (d.braceAction === "set") {
      if (!d.braceSide || !d.braceToe || !d.braceType) return { error: "Bitte Seite, Zehe und Spangentyp angeben." } as const;
      const [ep] = await tx
        .insert(braceEpisodes)
        .values({ organizationId: org, patientId: d.patientId, side: d.braceSide, toe: d.braceToe, stage: d.braceStage, braceType: d.braceType, startedAt: new Date().toISOString().slice(0, 10) })
        .returning({ id: braceEpisodes.id });
      braceEpisodeId = ep.id;
    } else if (braceEpisodeId && d.braceAction === "remove") {
      await tx.update(braceEpisodes).set({ status: "completed", endedAt: new Date().toISOString().slice(0, 10) }).where(and(eq(braceEpisodes.organizationId, org), eq(braceEpisodes.id, braceEpisodeId), eq(braceEpisodes.patientId, d.patientId)));
    } else if (braceEpisodeId && d.braceChange) {
      await tx.update(braceEpisodes).set({ braceType: d.braceChange }).where(and(eq(braceEpisodes.organizationId, org), eq(braceEpisodes.id, braceEpisodeId), eq(braceEpisodes.patientId, d.patientId)));
    }

    const [prev] = await tx
      .select({ hash: treatmentRecords.hash })
      .from(treatmentRecords)
      .where(and(eq(treatmentRecords.organizationId, org), eq(treatmentRecords.patientId, d.patientId)))
      .orderBy(desc(treatmentRecords.createdAt))
      .limit(1);
    const treatedAt = new Date();
    const structured = {
      braceAction: d.braceAction,
      braceChange: d.braceChange ?? null,
      braceRulesVersion: BRACE_RULES_VERSION,
      braceEpisodeId,
      mediaIds: photos.map((x) => x.id),
    };
    const content = {
      patientId: d.patientId,
      authorId: auth.user.id,
      treatedAt: treatedAt.toISOString(),
      findings: d.findings,
      servicesText: d.servicesText,
      material: d.material,
      sterileBatchCode: d.sterileBatchCode,
      reaction: d.reaction,
      recommendation: d.recommendation,
      footPoints,
      structured,
      appointmentId: d.appointmentId ?? null,
      missingPhotoReason: brace.missing ? d.missingPhotoReason : null,
      aiAssisted: d.aiAssisted === "1",
      countersignRequired: auth.role === "trainee",
    };
    const hash = chainHash(prev?.hash ?? null, content);
    const [rec] = await tx
      .insert(treatmentRecords)
      .values({
        organizationId: org,
        patientId: d.patientId,
        appointmentId: d.appointmentId ?? null,
        authorId: auth.user.id,
        treatedAt,
        findings: d.findings,
        servicesText: d.servicesText,
        material: d.material,
        sterileBatchCode: d.sterileBatchCode,
        reaction: d.reaction,
        recommendation: d.recommendation,
        footPoints,
        structured,
        missingPhotoReason: brace.missing ? d.missingPhotoReason : null,
        aiAssisted: d.aiAssisted === "1",
        countersignRequired: auth.role === "trainee",
        prevHash: prev?.hash ?? null,
        hash,
      })
      .returning({ id: treatmentRecords.id });
    if (photos.length) {
      await tx.update(media).set({ recordId: rec.id, braceEpisodeId }).where(and(eq(media.organizationId, org), inArray(media.id, photos.map((x) => x.id))));
    }
    if (d.appointmentId) {
      await tx.update(appointments).set({ status: "done", updatedAt: new Date() }).where(and(eq(appointments.organizationId, org), eq(appointments.id, d.appointmentId), eq(appointments.patientId, d.patientId)));
    }
    return { id: rec.id } as const;
  });
  if ("error" in recordId) return { error: recordId.error };
  await audit({ organizationId: org, userId: auth.user.id, action: "record.create", entity: "treatment_record", entityId: recordId.id, meta: { patientId: d.patientId } });
  revalidatePath(`/kunden/${d.patientId}`);
  redirect(`/kunden/${d.patientId}/doku/${recordId.id}?gespeichert=1`);
}

export async function addAddendumAction(form: FormData) {
  const auth = await requireAuth("medical.write");
  const org = auth.organization.id;
  const recordId = z.string().uuid().parse(form.get("recordId"));
  const patientId = z.string().uuid().parse(form.get("patientId"));
  const body = z.string().trim().min(3).max(5000).parse(form.get("text"));
  const kind = form.get("kind") === "countersign" ? "countersign" : "addendum";
  await withOrg(org, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"add:" + recordId}))`);
    const [rec] = await tx
      .select({ hash: treatmentRecords.hash, authorId: treatmentRecords.authorId, countersignRequired: treatmentRecords.countersignRequired })
      .from(treatmentRecords)
      .where(and(eq(treatmentRecords.organizationId, org), eq(treatmentRecords.id, recordId), eq(treatmentRecords.patientId, patientId)));
    if (!rec) throw new Error("Eintrag nicht gefunden");
    if (kind === "countersign") {
      // Gegenzeichnung nur durch Inhaber:in/Podolog:in, nicht durch die Autorin/den Autor selbst
      if (!(auth.role === "owner" || auth.role === "therapist")) throw new Error("Keine Berechtigung zur Gegenzeichnung.");
      if (rec.authorId === auth.user.id) throw new Error("Eigene Einträge können nicht gegengezeichnet werden.");
      if (!rec.countersignRequired) throw new Error("Dieser Eintrag braucht keine Gegenzeichnung.");
    }
    const [prev] = await tx.select({ hash: recordAddenda.hash }).from(recordAddenda).where(and(eq(recordAddenda.organizationId, org), eq(recordAddenda.recordId, recordId))).orderBy(desc(recordAddenda.createdAt)).limit(1);
    const prevHash = prev?.hash ?? rec.hash;
    const createdAt = new Date();
    // gehasht wird exakt der gespeicherte Zeitstempel → später reproduzierbar
    const content = { recordId, authorId: auth.user.id, kind, text: body, at: createdAt.toISOString() };
    await tx.insert(recordAddenda).values({ organizationId: org, recordId, authorId: auth.user.id, kind, text: body, createdAt, prevHash, hash: chainHash(prevHash, content) });
  });
  await audit({ organizationId: org, userId: auth.user.id, action: `record.${kind}`, entity: "treatment_record", entityId: recordId });
  revalidatePath(`/kunden/${patientId}/doku/${recordId}`);
}
