import "server-only";
import { and, asc, desc, eq, inArray, isNull, like, sql } from "drizzle-orm";
import { z } from "zod";
import { db, withOrg, type Tx } from "@/db";
import { deviceEvents, devices, materials, organizations, patients, sterileBatches, tasks, treatmentRecords, users } from "@/db/schema";
import type { AuthContext } from "@/lib/auth/session";
import { audit } from "@/lib/audit";
import { berlinDateIso, dateDe } from "@/lib/format";
import {
  BATCH_REASON_TEXT,
  BATCH_RELEASE_ROLES,
  DEADLINE_BY_EVENT,
  DEADLINE_FIELDS,
  DEADLINE_WARN_DAYS,
  DEVICE_EVENT_KINDS,
  DEVICE_KINDS,
  batchUsability,
  checklistTaskTitle,
  deadlineStatus,
  deadlineTaskTitle,
  needsReorder,
  normalizeBatchCode,
  readChecklist,
  suggestBatchCode,
  type BatchCheck,
  type HygieneChecklist,
} from "@/lib/hygiene-rules";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Datum ungültig");
const optText = (max: number) =>
  z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? null : v), z.string().trim().max(max).nullable().optional());
const optDate = z.preprocess((v) => (v === "" || v === undefined ? null : v), isoDate.nullable());
const optUuid = z.preprocess((v) => (v === "" || v === undefined ? null : v), z.string().uuid().nullable());

export const BATCH_CODE_RE = /^[A-Z0-9][A-Z0-9._-]{1,59}$/;
/** SQL-Ausdruck: Chargennummer normalisiert (wie normalizeBatchCode) */
const normCol = (col: unknown) => sql`upper(regexp_replace(${col}, '\\s', '', 'g'))`;

/** Fehlendes Recht in der Serverschicht (Defense in Depth – zusätzlich zu requireAuth in Seiten/Actions). */
export class ForbiddenError extends Error {
  constructor(what: string) {
    super(`Kein Zugriff: ${what}`);
    this.name = "ForbiddenError";
  }
}
const need = (ok: boolean, what: string) => {
  if (!ok) throw new ForbiddenError(what);
};
const canReadHygiene = (a: AuthContext) => a.can("medical.read");
const canWriteHygiene = (a: AuthContext) => a.can("medical.write");
const canReadMaterials = (a: AuthContext) => a.can("medical.read") || a.can("patients.write");
const canWriteMaterials = (a: AuthContext) => a.can("medical.write") || a.can("patients.write");

/** PostgreSQL unique_violation (23505), auch wenn Drizzle den Fehler einpackt. */
function isUniqueViolation(e: unknown): boolean {
  for (let cur = e as { code?: string; cause?: unknown } | undefined, i = 0; cur && i < 5; cur = cur.cause as typeof cur, i++) {
    if (cur.code === "23505") return true;
  }
  return false;
}

// ───────────────────────── Sterilgut-Chargen ─────────────────────────

/**
 * Prüft, ob eine Sterilgut-Charge verwendet werden darf (für den Doku-Speichervorgang).
 * Läuft in der Transaktion des Aufrufers (RLS-Kontext muss gesetzt sein, z. B. via withOrg).
 */
export async function checkBatchUsable(tx: Tx, org: string, code: string, onDateIso = berlinDateIso()): Promise<BatchCheck> {
  const n = normalizeBatchCode(code);
  if (!n) return { ok: false, reason: "unknown" };
  const [b] = await tx
    .select({ result: sterileBatches.result, expiresAt: sterileBatches.expiresAt })
    .from(sterileBatches)
    .where(and(eq(sterileBatches.organizationId, org), sql`${normCol(sterileBatches.code)} = ${n}`))
    .limit(1);
  return batchUsability(b, onDateIso);
}

/** Status für den Client-Hinweis im Doku-Formular (GET /api/hygiene/batch/[code]). */
export async function batchStatus(org: string, code: string) {
  return withOrg(org, async (tx) => {
    const n = normalizeBatchCode(code);
    const [b] = await tx
      .select({ code: sterileBatches.code, result: sterileBatches.result, expiresAt: sterileBatches.expiresAt, processedAt: sterileBatches.processedAt })
      .from(sterileBatches)
      .where(and(eq(sterileBatches.organizationId, org), sql`${normCol(sterileBatches.code)} = ${n}`))
      .limit(1);
    const check = batchUsability(b, berlinDateIso());
    return {
      code: b?.code ?? n,
      ok: check.ok,
      reason: check.reason,
      message: check.reason
        ? BATCH_REASON_TEXT[check.reason]
        : `Charge freigegeben${b?.expiresAt ? `, verwendbar bis ${dateDe(b.expiresAt)}` : ""}.`,
      result: b?.result ?? null,
      expiresAt: b?.expiresAt ?? null,
    };
  });
}

export async function listBatches(auth: AuthContext, limit = 50) {
  need(canReadHygiene(auth), "Chargen ansehen");
  const org = auth.organization.id;
  return withOrg(org, (tx) =>
    tx
      .select({ b: sterileBatches, device: devices.name, releasedByName: users.name })
      .from(sterileBatches)
      .leftJoin(devices, eq(devices.id, sterileBatches.deviceId))
      .leftJoin(users, eq(users.id, sterileBatches.releasedBy))
      .where(eq(sterileBatches.organizationId, org))
      .orderBy(desc(sterileBatches.processedAt))
      .limit(limit),
  );
}

export async function suggestCodeForToday(org: string, todayIso = berlinDateIso()) {
  const prefix = `ST-${todayIso.replaceAll("-", "")}-`;
  const rows = await withOrg(org, (tx) =>
    tx
      .select({ code: sterileBatches.code })
      .from(sterileBatches)
      .where(and(eq(sterileBatches.organizationId, org), like(sterileBatches.code, `${prefix}%`))),
  );
  return suggestBatchCode(todayIso, rows.map((r) => r.code));
}

export const batchInput = z.object({
  code: z
    .string()
    .transform(normalizeBatchCode)
    .refine((v) => BATCH_CODE_RE.test(v), "Chargennummer: 2–60 Zeichen, nur Buchstaben, Ziffern, Punkt, Binde- und Unterstrich."),
  deviceId: optUuid,
  cycleNo: optText(40),
  indicatorOk: z.boolean(),
  expiresAt: optDate,
  note: optText(500),
});
export type BatchInput = z.infer<typeof batchInput>;

export async function createBatch(auth: AuthContext, input: BatchInput): Promise<{ error?: string; id?: string }> {
  need(canWriteHygiene(auth), "Chargen anlegen");
  const org = auth.organization.id;
  // immer normalisiert speichern – der Unique-Index (organization_id, code) greift dann auch für „st-…“ vs. „ST-…“
  const code = normalizeBatchCode(input.code);
  if (!BATCH_CODE_RE.test(code)) return { error: "Chargennummer ungültig." };
  try {
    return await withOrg(org, async (tx) => {
      let deviceName: string | null = null;
      if (input.deviceId) {
        const [d] = await tx.select().from(devices).where(and(eq(devices.organizationId, org), eq(devices.id, input.deviceId)));
        if (!d) return { error: "Gerät nicht gefunden." };
        deviceName = d.name;
      }
      const [row] = await tx
        .insert(sterileBatches)
        .values({
          organizationId: org,
          code,
          deviceId: input.deviceId,
          sterilizer: deviceName,
          cycleNo: input.cycleNo ?? null,
          indicatorOk: input.indicatorOk,
          expiresAt: input.expiresAt,
          note: input.note ?? null,
        })
        .returning({ id: sterileBatches.id });
      await audit({ organizationId: org, userId: auth.user.id, action: "sterile_batch.create", entity: "sterile_batch", entityId: row.id, meta: { code } });
      return { id: row.id };
    });
  } catch (e) {
    // Unique-Index sterile_batches_org_code – atomar statt Vorab-SELECT
    if (isUniqueViolation(e)) return { error: `Chargennummer ${code} ist bereits vergeben.` };
    throw e;
  }
}

export const canReleaseBatch = (auth: AuthContext) =>
  auth.can("medical.write") && (BATCH_RELEASE_ROLES as readonly string[]).includes(auth.role);

/**
 * Freigabe oder Sperre – einmalig. Zusätzlich verhindert der DB-Trigger
 * (podo_sterile_batch_guard) jede spätere Änderung.
 */
export async function decideBatch(
  auth: AuthContext,
  id: string,
  decision: "released" | "rejected",
  opts: { indicatorConfirmed: boolean; note?: string | null },
): Promise<{ error?: string }> {
  need(canWriteHygiene(auth), "Chargen freigeben/sperren");
  if (!canReleaseBatch(auth)) return { error: "Nur Inhaber:in oder Podolog:in dürfen Chargen freigeben/sperren." };
  const org = auth.organization.id;
  if (decision === "released" && !opts.indicatorConfirmed) return { error: "Freigabe nur mit bestätigtem Indikator/Prozessprotokoll." };
  if (decision === "rejected" && !opts.note?.trim()) return { error: "Bitte einen Grund für die Sperre angeben." };
  try {
    return await withOrg(org, async (tx) => {
      const [b] = await tx.select().from(sterileBatches).where(and(eq(sterileBatches.organizationId, org), eq(sterileBatches.id, id)));
      if (!b) return { error: "Charge nicht gefunden." };
      if (b.result !== "pending") return { error: "Über diese Charge wurde bereits entschieden – das ist endgültig." };
      const note = opts.note?.trim() ? [b.note, `${decision === "rejected" ? "Sperrgrund" : "Freigabe"}: ${opts.note.trim()}`].filter(Boolean).join("\n").slice(0, 1000) : b.note;
      const updated = await tx
        .update(sterileBatches)
        .set({
          result: decision,
          releasedBy: auth.user.id,
          releasedAt: new Date(),
          indicatorOk: decision === "released" ? true : b.indicatorOk,
          note,
        })
        .where(and(eq(sterileBatches.organizationId, org), eq(sterileBatches.id, id), eq(sterileBatches.result, "pending")))
        .returning({ id: sterileBatches.id });
      if (updated.length === 0) return { error: "Über diese Charge wurde bereits entschieden." };
      await audit({ organizationId: org, userId: auth.user.id, action: `sterile_batch.${decision}`, entity: "sterile_batch", entityId: id, meta: { code: b.code } });
      return {};
    });
  } catch (e) {
    if (e instanceof Error && /endgültig|unveränderbar/.test(e.message)) return { error: "Über diese Charge wurde bereits entschieden – das ist endgültig." };
    throw e;
  }
}

export async function getBatchByCode(auth: AuthContext, code: string) {
  need(canReadHygiene(auth), "Chargen ansehen");
  const org = auth.organization.id;
  const n = normalizeBatchCode(code);
  return withOrg(org, async (tx) => {
    const [row] = await tx
      .select({ b: sterileBatches, device: devices.name, releasedByName: users.name })
      .from(sterileBatches)
      .leftJoin(devices, eq(devices.id, sterileBatches.deviceId))
      .leftJoin(users, eq(users.id, sterileBatches.releasedBy))
      .where(and(eq(sterileBatches.organizationId, org), sql`${normCol(sterileBatches.code)} = ${n}`))
      .limit(1);
    return row ?? null;
  });
}

/**
 * Rückverfolgung Charge → Patient:innen (Rückruf bei Sterilisationsfehler).
 * Gesundheitsdaten: nur mit medical.read, Zugriff wird protokolliert.
 */
export async function traceBatch(auth: AuthContext, code: string) {
  need(auth.can("medical.read"), "Rückverfolgung (Gesundheitsdaten)");
  const org = auth.organization.id;
  const n = normalizeBatchCode(code);
  const rows = await withOrg(org, (tx) =>
    tx
      .select({
        recordId: treatmentRecords.id,
        treatedAt: treatmentRecords.treatedAt,
        servicesText: treatmentRecords.servicesText,
        patientId: patients.id,
        number: patients.number,
        firstName: patients.firstName,
        lastName: patients.lastName,
        phoneMobile: patients.phoneMobile,
        phoneLandline: patients.phoneLandline,
        author: users.name,
      })
      .from(treatmentRecords)
      .innerJoin(patients, eq(patients.id, treatmentRecords.patientId))
      .leftJoin(users, eq(users.id, treatmentRecords.authorId))
      .where(and(eq(treatmentRecords.organizationId, org), sql`${normCol(treatmentRecords.sterileBatchCode)} = ${n}`))
      .orderBy(desc(treatmentRecords.treatedAt)),
  );
  await audit({
    organizationId: org,
    userId: auth.user.id,
    action: "sterile_batch.trace",
    entity: "sterile_batch",
    entityId: n,
    meta: { records: rows.length, patients: new Set(rows.map((r) => r.patientId)).size },
  });
  return rows;
}

// ───────────────────────── Geräte & Gerätebuch ─────────────────────────

export const deviceInput = z.object({
  name: z.string().trim().min(2, "Name fehlt").max(120),
  kind: z.enum(DEVICE_KINDS),
  manufacturer: optText(120),
  serialNumber: optText(80),
  location: optText(120),
  nextMaintenanceAt: optDate,
  nextValidationAt: optDate,
  nextElectricalCheckAt: optDate,
  active: z.boolean(),
  notes: optText(1000),
});
export type DeviceInput = z.infer<typeof deviceInput>;

export async function listDevices(auth: AuthContext, opts: { activeOnly?: boolean } = {}) {
  need(canReadHygiene(auth), "Geräte ansehen");
  const org = auth.organization.id;
  return withOrg(org, (tx) =>
    tx
      .select()
      .from(devices)
      .where(and(eq(devices.organizationId, org), opts.activeOnly ? eq(devices.active, true) : undefined))
      .orderBy(desc(devices.active), asc(devices.name)),
  );
}

export async function getDevice(auth: AuthContext, id: string) {
  need(canReadHygiene(auth), "Gerätebuch ansehen");
  const org = auth.organization.id;
  return withOrg(org, async (tx) => {
    const [device] = await tx.select().from(devices).where(and(eq(devices.organizationId, org), eq(devices.id, id)));
    if (!device) return null;
    const events = await tx
      .select({ e: deviceEvents, author: users.name })
      .from(deviceEvents)
      .leftJoin(users, eq(users.id, deviceEvents.authorId))
      .where(and(eq(deviceEvents.organizationId, org), eq(deviceEvents.deviceId, id)))
      .orderBy(desc(deviceEvents.occurredAt), desc(deviceEvents.createdAt));
    const batches = await tx
      .select({ id: sterileBatches.id, code: sterileBatches.code, result: sterileBatches.result, processedAt: sterileBatches.processedAt })
      .from(sterileBatches)
      .where(and(eq(sterileBatches.organizationId, org), eq(sterileBatches.deviceId, id)))
      .orderBy(desc(sterileBatches.processedAt))
      .limit(10);
    return { device, events, batches };
  });
}

export async function saveDevice(auth: AuthContext, id: string | null, input: DeviceInput): Promise<{ error?: string; id?: string }> {
  need(canWriteHygiene(auth), "Geräte bearbeiten");
  const org = auth.organization.id;
  return withOrg(org, async (tx) => {
    if (id) {
      const r = await tx.update(devices).set(input).where(and(eq(devices.organizationId, org), eq(devices.id, id))).returning({ id: devices.id });
      if (!r.length) return { error: "Gerät nicht gefunden." };
      await audit({ organizationId: org, userId: auth.user.id, action: "device.update", entity: "device", entityId: id });
      return { id };
    }
    const [r] = await tx.insert(devices).values({ ...input, organizationId: org }).returning({ id: devices.id });
    await audit({ organizationId: org, userId: auth.user.id, action: "device.create", entity: "device", entityId: r.id });
    return { id: r.id };
  });
}

export const deviceEventInput = z.object({
  deviceId: z.string().uuid(),
  kind: z.enum(DEVICE_EVENT_KINDS),
  occurredAt: isoDate,
  performedBy: optText(120),
  note: optText(2000),
  /** optional: neue Frist (Wartung/Validierung/Prüfung) gleich mitsetzen */
  nextDueAt: optDate,
});
export type DeviceEventInput = z.infer<typeof deviceEventInput>;

/** Gerätebuch-Eintrag anhängen (append-only, per DB-Trigger geschützt). */
export async function addDeviceEvent(auth: AuthContext, input: DeviceEventInput): Promise<{ error?: string }> {
  need(canWriteHygiene(auth), "Gerätebuch schreiben");
  const org = auth.organization.id;
  if (input.occurredAt > berlinDateIso()) return { error: "Das Datum liegt in der Zukunft." };
  const field = DEADLINE_BY_EVENT[input.kind];
  if (field && input.nextDueAt && input.nextDueAt <= input.occurredAt) return { error: "Die neue Frist muss nach dem Datum des Eintrags liegen." };
  return withOrg(org, async (tx) => {
    const [d] = await tx.select().from(devices).where(and(eq(devices.organizationId, org), eq(devices.id, input.deviceId)));
    if (!d) return { error: "Gerät nicht gefunden." };
    await tx.insert(deviceEvents).values({
      organizationId: org,
      deviceId: d.id,
      kind: input.kind,
      occurredAt: input.occurredAt,
      performedBy: input.performedBy ?? null,
      note: input.note ?? null,
      authorId: auth.user.id,
    });
    if (field && input.nextDueAt) {
      await tx.update(devices).set({ [field]: input.nextDueAt }).where(and(eq(devices.organizationId, org), eq(devices.id, d.id)));
    }
    await audit({ organizationId: org, userId: auth.user.id, action: "device_event.create", entity: "device", entityId: d.id, meta: { kind: input.kind } });
    return {};
  });
}

// ───────────────────────── Fristen → Aufgaben ─────────────────────────

/**
 * Legt für Gerätefristen in den nächsten 30 Tagen (oder überfällig) Aufgaben (kind 'hygiene') an.
 * Dubletten: gleicher Titel + gleiches Fälligkeitsdatum wird nicht erneut angelegt (auch nicht,
 * wenn bereits erledigt). Offene Fristen-Aufgaben, deren Frist verschoben wurde, werden aktualisiert
 * bzw. – wenn die Frist nicht mehr ansteht – automatisch als erledigt markiert.
 */
export async function syncHygieneTasks(org: string, todayIso = berlinDateIso()): Promise<{ created: number; updated: number; closed: number }> {
  return withOrg(org, async (tx) => {
    const devs = await tx.select().from(devices).where(and(eq(devices.organizationId, org), eq(devices.active, true)));
    const wanted = new Map<string, string>();
    for (const d of devs) {
      const label = d.serialNumber ? `${d.name} (SN ${d.serialNumber})` : d.name;
      for (const f of DEADLINE_FIELDS) {
        const due = d[f];
        const st = deadlineStatus(due, todayIso, DEADLINE_WARN_DAYS);
        if (due && (st.status === "overdue" || st.status === "soon")) wanted.set(deadlineTaskTitle(f, label), due);
      }
    }
    // parallele Seitenaufrufe nicht doppelt anlegen lassen
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`hygiene-sync:${org}`}))`);
    const existing = await tx
      .select()
      .from(tasks)
      .where(and(eq(tasks.organizationId, org), eq(tasks.kind, "hygiene"), like(tasks.title, "Frist %")));
    let created = 0, updated = 0;
    const toClose: string[] = [];
    const hasOpen = new Set<string>();
    for (const t of existing) {
      if (t.doneAt) continue;
      const due = wanted.get(t.title);
      if (!due || hasOpen.has(t.title)) {
        toClose.push(t.id); // Frist steht nicht mehr an (oder Dublette)
      } else if (t.dueAt !== due) {
        // Frist verschoben: schon (für dieses Datum) erledigt? → schließen, sonst Datum nachziehen
        if (existing.some((x) => x.title === t.title && x.dueAt === due && x.doneAt)) {
          toClose.push(t.id);
        } else {
          await tx.update(tasks).set({ dueAt: due }).where(and(eq(tasks.organizationId, org), eq(tasks.id, t.id)));
          hasOpen.add(t.title);
          updated++;
        }
      } else {
        hasOpen.add(t.title);
      }
    }
    if (toClose.length) {
      await tx.update(tasks).set({ doneAt: new Date() }).where(and(eq(tasks.organizationId, org), inArray(tasks.id, toClose)));
    }
    const values = [...wanted]
      .filter(([title, due]) => !hasOpen.has(title) && !existing.some((t) => t.title === title && t.dueAt === due))
      .map(([title, due]) => ({ organizationId: org, title, kind: "hygiene", dueAt: due }));
    if (values.length) {
      await tx.insert(tasks).values(values);
      created = values.length;
    }
    const closed = toClose.length;
    return { created, updated, closed };
  });
}

// ───────────────────────── Hygiene-Checkliste ─────────────────────────

async function orgSettings(org: string) {
  const [o] = await db.select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, org));
  return o?.settings ?? {};
}

export async function getChecklist(org: string): Promise<HygieneChecklist> {
  return readChecklist(await orgSettings(org));
}

export async function saveChecklist(auth: AuthContext, list: HygieneChecklist) {
  need(auth.can("settings.manage"), "Checkliste bearbeiten");
  const org = auth.organization.id;
  // atomar mergen, damit parallele Einstellungsänderungen nicht überschrieben werden
  await db
    .update(organizations)
    .set({ settings: sql`coalesce(${organizations.settings}, '{}'::jsonb) || jsonb_build_object('hygieneChecklist', ${JSON.stringify(list)}::jsonb)` })
    .where(eq(organizations.id, org));
  await audit({ organizationId: org, userId: auth.user.id, action: "settings.hygiene_checklist" });
}

export type ChecklistItemState = { interval: "daily" | "weekly"; item: string; title: string; doneAt: Date | null; doneBy: string | null; taskId: string | null };

export async function checklistState(org: string, todayIso = berlinDateIso()): Promise<ChecklistItemState[]> {
  const list = await getChecklist(org);
  const items = [
    ...list.daily.map((item) => ({ interval: "daily" as const, item, ...checklistTaskTitle("daily", item, todayIso) })),
    ...list.weekly.map((item) => ({ interval: "weekly" as const, item, ...checklistTaskTitle("weekly", item, todayIso) })),
  ];
  if (!items.length) return [];
  const done = await withOrg(org, (tx) =>
    tx
      .select({ id: tasks.id, title: tasks.title, doneAt: tasks.doneAt, by: users.name })
      .from(tasks)
      .leftJoin(users, eq(users.id, tasks.assigneeId))
      .where(and(eq(tasks.organizationId, org), eq(tasks.kind, "hygiene"), inArray(tasks.title, items.map((i) => i.title)))),
  );
  return items.map((i) => {
    const t = done.find((d) => d.title === i.title && d.doneAt);
    return { interval: i.interval, item: i.item, title: i.title, doneAt: t?.doneAt ?? null, doneBy: t?.by ?? null, taskId: t?.id ?? null };
  });
}

/** Checklisten-Punkt abhaken: erledigte Aufgabe (kind 'hygiene') mit Zeitstempel und Person. */
export async function completeChecklistItem(auth: AuthContext, interval: "daily" | "weekly", item: string): Promise<{ error?: string }> {
  need(canWriteHygiene(auth), "Checkliste abhaken");
  const org = auth.organization.id;
  const list = await getChecklist(org);
  if (!(interval === "daily" ? list.daily : list.weekly).includes(item)) return { error: "Punkt ist nicht (mehr) in der Checkliste." };
  const { title, period } = checklistTaskTitle(interval, item, berlinDateIso());
  return withOrg(org, async (tx) => {
    // gleiche Aufgabe nicht doppelt (paralleles Abhaken): pro Mandant serialisieren
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`hygiene-check:${org}`}))`);
    const [exists] = await tx
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(eq(tasks.organizationId, org), eq(tasks.kind, "hygiene"), eq(tasks.title, title)));
    if (exists) return {};
    await tx.insert(tasks).values({ organizationId: org, title, kind: "hygiene", dueAt: period, assigneeId: auth.user.id, doneAt: new Date() });
    return {};
  });
}

/** Versehentliches Abhaken am selben Tag zurücknehmen (nur eigener Eintrag oder mit medical.write als Inhaber:in). */
export async function undoChecklistItem(auth: AuthContext, taskId: string): Promise<{ error?: string }> {
  need(canWriteHygiene(auth), "Checkliste abhaken");
  const org = auth.organization.id;
  return withOrg(org, async (tx) => {
    const [t] = await tx.select().from(tasks).where(and(eq(tasks.organizationId, org), eq(tasks.id, taskId), eq(tasks.kind, "hygiene")));
    if (!t || !t.doneAt || t.title.startsWith("Frist ")) return { error: "Eintrag nicht gefunden." };
    if (berlinDateIso(t.doneAt) !== berlinDateIso()) return { error: "Nur am selben Tag rücknehmbar." };
    if (t.assigneeId !== auth.user.id && auth.role !== "owner") return { error: "Nur die Person, die abgehakt hat, kann das zurücknehmen." };
    await tx.delete(tasks).where(and(eq(tasks.organizationId, org), eq(tasks.id, taskId)));
    await audit({ organizationId: org, userId: auth.user.id, action: "hygiene_check.undo", entity: "task", entityId: taskId, meta: { title: t.title } });
    return {};
  });
}

/** Offene Hygiene-Fristaufgaben (für die Übersicht). */
export async function openHygieneTasks(org: string) {
  return withOrg(org, (tx) =>
    tx
      .select()
      .from(tasks)
      .where(and(eq(tasks.organizationId, org), eq(tasks.kind, "hygiene"), isNull(tasks.doneAt)))
      .orderBy(asc(tasks.dueAt)),
  );
}

// ───────────────────────── Material ─────────────────────────

export const materialInput = z.object({
  name: z.string().trim().min(2, "Name fehlt").max(120),
  unit: z.string().trim().min(1).max(30).default("Stück"),
  stock: z.coerce.number().int("Bestand: ganze Zahl").min(0).max(1_000_000),
  minStock: z.coerce.number().int("Mindestbestand: ganze Zahl").min(0).max(1_000_000),
  supplier: optText(120),
  orderUrl: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? null : v),
    z.string().trim().max(500).url("Bestell-Link ungültig").refine((u) => /^https?:\/\//i.test(u), "Bestell-Link muss mit http(s):// beginnen").nullable(),
  ),
  active: z.boolean(),
});
export type MaterialInput = z.infer<typeof materialInput>;

export async function listMaterials(auth: AuthContext, opts: { activeOnly?: boolean } = {}) {
  need(canReadMaterials(auth), "Material ansehen");
  const org = auth.organization.id;
  return withOrg(org, (tx) =>
    tx
      .select()
      .from(materials)
      .where(and(eq(materials.organizationId, org), opts.activeOnly ? eq(materials.active, true) : undefined))
      .orderBy(desc(materials.active), asc(materials.name)),
  );
}

export async function reorderList(auth: AuthContext) {
  const all = await listMaterials(auth, { activeOnly: true });
  return all.filter(needsReorder);
}

export async function saveMaterial(auth: AuthContext, id: string | null, input: MaterialInput): Promise<{ error?: string }> {
  need(canWriteMaterials(auth), "Material bearbeiten");
  const org = auth.organization.id;
  return withOrg(org, async (tx) => {
    if (id) {
      const r = await tx.update(materials).set(input).where(and(eq(materials.organizationId, org), eq(materials.id, id))).returning({ id: materials.id });
      if (!r.length) return { error: "Material nicht gefunden." };
      await audit({ organizationId: org, userId: auth.user.id, action: "material.update", entity: "material", entityId: id, meta: { stock: input.stock, minStock: input.minStock } });
    } else {
      const [r] = await tx.insert(materials).values({ ...input, organizationId: org }).returning({ id: materials.id });
      await audit({ organizationId: org, userId: auth.user.id, action: "material.create", entity: "material", entityId: r.id });
    }
    return {};
  });
}

/** Bestand atomar ändern (nie unter 0), Änderung wird protokolliert. */
export async function adjustStock(auth: AuthContext, id: string, delta: number) {
  need(canWriteMaterials(auth), "Materialbestand ändern");
  const org = auth.organization.id;
  if (!Number.isInteger(delta) || delta === 0 || Math.abs(delta) > 10_000) return;
  const [row] = await withOrg(org, (tx) =>
    tx
      .update(materials)
      .set({ stock: sql`greatest(${materials.stock} + ${delta}, 0)` })
      .where(and(eq(materials.organizationId, org), eq(materials.id, id)))
      .returning({ stock: materials.stock }),
  );
  if (row) await audit({ organizationId: org, userId: auth.user.id, action: "material.stock", entity: "material", entityId: id, meta: { delta, stock: row.stock } });
}
