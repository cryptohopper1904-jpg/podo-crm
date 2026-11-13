import "server-only";
import { and, eq, gte, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import { withOrg, type Tx } from "@/db";
import { calendarBlocks, memberships, users } from "@/db/schema";
import { audit } from "@/lib/audit";
import { assertCan, ForbiddenError } from "@/lib/auth/assert";
import { CALENDAR_ROLES } from "@/lib/auth/permissions";
import type { AuthContext } from "@/lib/auth/session";
import { blockInput, expandBlocks, occursOn, overlappingBlocks, type BlockInput, type BlockOccurrence, type BlockRule } from "@/lib/calendar-blocks";
import { addDaysIso, berlinParts } from "@/lib/calendar-grid";

/**
 * Kalender-Sperrzeiten (Pause, Schulung, früher Feierabend, Wartung, Reinigung …) – Laden, Expandieren und Pflege.
 * Rechte: eigene Sperrzeiten mit appointments.write; für andere Personen oder die ganze Praxis zusätzlich
 * users.manage (wie Dienstplan/Abwesenheiten in src/server/staff.ts). Support-Modus: nur lesen.
 */

const RULE_COLUMNS = {
  id: calendarBlocks.id,
  userId: calendarBlocks.userId,
  kind: calendarBlocks.kind,
  title: calendarBlocks.title,
  startsOn: calendarBlocks.startsOn,
  endsOn: calendarBlocks.endsOn,
  allDay: calendarBlocks.allDay,
  startTime: calendarBlocks.startTime,
  endTime: calendarBlocks.endTime,
  repeat: calendarBlocks.repeat,
  weekdays: calendarBlocks.weekdays,
  intervalWeeks: calendarBlocks.intervalWeeks,
  exceptions: calendarBlocks.exceptions,
};

/**
 * Regeln, die den Zeitraum berühren können: für die Personen `userIds` (null = alle Personen) und immer die der
 * ganzen Praxis. Muss in einer Transaktion mit gesetztem Mandanten laufen (withOrg).
 */
export async function loadBlockRules(tx: Tx, org: string, userIds: readonly string[] | null, fromIso: string, toIso: string): Promise<BlockRule[]> {
  // keine Personen → nur Regeln der ganzen Praxis
  const who = userIds === null ? undefined : userIds.length ? or(isNull(calendarBlocks.userId), inArray(calendarBlocks.userId, [...userIds])) : isNull(calendarBlocks.userId);
  const rows = await tx
    .select(RULE_COLUMNS)
    .from(calendarBlocks)
    .where(
      and(
        eq(calendarBlocks.organizationId, org),
        lte(calendarBlocks.startsOn, toIso),
        or(isNull(calendarBlocks.endsOn), gte(calendarBlocks.endsOn, fromIso)),
        who,
      ),
    );
  return rows.map((r) => ({ ...r, weekdays: r.weekdays ?? [], exceptions: r.exceptions ?? [] }));
}

/** Expandierte Vorkommen (zentrale Funktion für Verfügbarkeit, Buchung, Telefon, Konflikte und Kalender). */
export async function loadBlockOccurrences(tx: Tx, org: string, userIds: readonly string[] | null, fromIso: string, toIso: string): Promise<BlockOccurrence[]> {
  const rules = await loadBlockRules(tx, org, userIds, fromIso, toIso);
  return expandBlocks(rules, fromIso, toIso, userIds ?? undefined);
}

/**
 * Sperrzeiten der Behandler:in (und der ganzen Praxis), die sich mit einem der Zeiträume überschneiden –
 * für die Konfliktprüfung bei Terminanlage und Verschieben (gleiche Transaktion/Buchungssperre).
 */
export async function blockClashesInTx(tx: Tx, org: string, therapistId: string, intervals: readonly { start: Date; end: Date }[]): Promise<BlockOccurrence[]> {
  if (!intervals.length) return [];
  const days = intervals.flatMap((i) => [berlinParts(i.start).dateIso, berlinParts(i.end).dateIso]).sort();
  const occ = await loadBlockOccurrences(tx, org, [therapistId], addDaysIso(days[0], -1), days[days.length - 1]);
  const hits: BlockOccurrence[] = [];
  for (const i of intervals) for (const o of overlappingBlocks(occ, therapistId, i.start, i.end)) if (!hits.includes(o)) hits.push(o);
  return hits.sort((a, b) => a.dateIso.localeCompare(b.dateIso) || a.startMin - b.startMin);
}

// ───────────── Rechte ─────────────

/** Darf die angemeldete Person Sperrzeiten für `targetUserId` (null = ganze Praxis) anlegen/ändern/löschen? */
export function canManageBlocksFor(auth: Pick<AuthContext, "support" | "can" | "user">, targetUserId: string | null): boolean {
  if (auth.support) return false;
  if (!auth.can("appointments.write")) return false;
  if (targetUserId !== null && targetUserId === auth.user.id) return true;
  return auth.can("users.manage");
}

/** Darf überhaupt Sperrzeiten anlegen (eigene oder für andere)? */
export const canCreateBlocks = (auth: Pick<AuthContext, "support" | "can" | "user" | "role">) =>
  !auth.support && auth.can("appointments.write") && (auth.can("users.manage") || (CALENDAR_ROLES as readonly string[]).includes(auth.role));

function assertWritable(auth: AuthContext) {
  if (auth.support) throw new ForbiddenError("appointments.write");
  assertCan(auth, "appointments.write");
}

const NO_RIGHT = "Sperrzeiten für andere Personen oder die ganze Praxis darf nur ändern, wer das Team verwalten darf.";

async function isCalendarMemberTx(tx: Tx, org: string, userId: string): Promise<boolean> {
  const [m] = await tx
    .select({ id: memberships.userId })
    .from(memberships)
    .where(and(eq(memberships.organizationId, org), eq(memberships.userId, userId), eq(memberships.active, true), inArray(memberships.role, [...CALENDAR_ROLES])));
  return !!m;
}

// ───────────── Lesen ─────────────

export type BlockDetail = BlockRule & { note: string | null; personName: string | null; createdBy: string | null };

/** Eine Sperrzeit (Regel) der Praxis; null = nicht gefunden. */
export async function getBlock(auth: AuthContext, id: string): Promise<BlockDetail | null> {
  assertCan(auth, "appointments.read");
  if (!z.uuid().safeParse(id).success) return null;
  const org = auth.organization.id;
  const [row] = await withOrg(org, (tx) =>
    tx
      .select({ ...RULE_COLUMNS, note: calendarBlocks.note, createdBy: calendarBlocks.createdBy, personName: users.name })
      .from(calendarBlocks)
      .leftJoin(users, eq(users.id, calendarBlocks.userId))
      .where(and(eq(calendarBlocks.organizationId, org), eq(calendarBlocks.id, id)))
      .limit(1),
  );
  return row ? { ...row, weekdays: row.weekdays ?? [], exceptions: row.exceptions ?? [] } : null;
}

// ───────────── Schreiben ─────────────

export type BlockResult = { ok: true; id: string } | { ok: false; error: string };

const values = (org: string, d: BlockInput) => ({
  organizationId: org,
  userId: d.userId,
  kind: d.kind,
  title: d.title,
  startsOn: d.startsOn,
  endsOn: d.endsOn,
  allDay: d.allDay,
  startTime: d.startTime,
  endTime: d.endTime,
  repeat: d.repeat,
  weekdays: d.weekdays,
  intervalWeeks: d.intervalWeeks,
  note: d.note,
});

const auditMeta = (d: Pick<BlockInput, "userId" | "kind" | "repeat">, extra: Record<string, unknown> = {}) => ({
  target: d.userId ? "person" : "praxis",
  kind: d.kind,
  repeat: d.repeat,
  ...extra,
});

/** Sperrzeit anlegen. */
export async function createBlock(auth: AuthContext, raw: unknown): Promise<BlockResult> {
  assertWritable(auth);
  const parsed = blockInput.safeParse(raw);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Eingaben prüfen." };
  const d = parsed.data;
  if (!canManageBlocksFor(auth, d.userId)) return { ok: false, error: NO_RIGHT };
  const org = auth.organization.id;
  const res = await withOrg(org, async (tx): Promise<BlockResult> => {
    if (d.userId && !(await isCalendarMemberTx(tx, org, d.userId))) return { ok: false, error: "Bitte eine Behandler:in (Inhaber:in oder Podolog:in) wählen." };
    const [row] = await tx
      .insert(calendarBlocks)
      .values({ ...values(org, d), createdBy: auth.user.id })
      .returning({ id: calendarBlocks.id });
    return { ok: true, id: row.id };
  });
  if (res.ok) await audit({ organizationId: org, userId: auth.user.id, action: "calendar_block.create", entity: "calendar_block", entityId: res.id, meta: auditMeta(d) });
  return res;
}

export type BlockScope = "series" | "occurrence";

async function lockedRule(tx: Tx, org: string, id: string) {
  const [row] = await tx
    .select(RULE_COLUMNS)
    .from(calendarBlocks)
    .where(and(eq(calendarBlocks.organizationId, org), eq(calendarBlocks.id, id)))
    .for("update");
  return row ? { ...row, weekdays: row.weekdays ?? [], exceptions: row.exceptions ?? [] } : null;
}

/**
 * Sperrzeit ändern. Bei Serien: `scope` „occurrence“ ändert nur das Vorkommen am `occurrenceDate`
 * (es wird aus der Serie ausgenommen und als einzelne Sperrzeit neu angelegt), „series“ die ganze Serie.
 */
export async function updateBlock(auth: AuthContext, id: string, raw: unknown, scope: BlockScope = "series", occurrenceDate?: string | null): Promise<BlockResult> {
  assertWritable(auth);
  if (!z.uuid().safeParse(id).success) return { ok: false, error: "Sperrzeit nicht gefunden." };
  const parsed = blockInput.safeParse(raw);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Eingaben prüfen." };
  const d = parsed.data;
  const org = auth.organization.id;
  const res = await withOrg(org, async (tx): Promise<BlockResult & { single?: boolean }> => {
    const old = await lockedRule(tx, org, id);
    if (!old) return { ok: false, error: "Sperrzeit nicht gefunden." };
    if (!canManageBlocksFor(auth, old.userId) || !canManageBlocksFor(auth, d.userId)) return { ok: false, error: NO_RIGHT };
    if (d.userId && d.userId !== old.userId && !(await isCalendarMemberTx(tx, org, d.userId))) return { ok: false, error: "Bitte eine Behandler:in (Inhaber:in oder Podolog:in) wählen." };
    if (scope === "occurrence" && old.repeat !== "none") {
      if (!occurrenceDate || !occursOn(old, occurrenceDate)) return { ok: false, error: "Dieses Vorkommen gibt es in der Serie nicht (mehr)." };
      await tx
        .update(calendarBlocks)
        .set({ exceptions: sql`array_append(${calendarBlocks.exceptions}, ${occurrenceDate}::date)`, updatedAt: new Date() })
        .where(and(eq(calendarBlocks.organizationId, org), eq(calendarBlocks.id, id)));
      const [row] = await tx
        .insert(calendarBlocks)
        .values({ ...values(org, { ...d, repeat: "none", endsOn: null, weekdays: [], intervalWeeks: 1 }), createdBy: auth.user.id })
        .returning({ id: calendarBlocks.id });
      return { ok: true, id: row.id, single: true };
    }
    // Ausnahmen bleiben nur, solange sie noch zur (geänderten) Serie passen
    const exceptions = d.repeat === "none" ? [] : old.exceptions.filter((x) => x >= d.startsOn && (!d.endsOn || x <= d.endsOn));
    await tx
      .update(calendarBlocks)
      .set({ ...values(org, d), exceptions, updatedAt: new Date() })
      .where(and(eq(calendarBlocks.organizationId, org), eq(calendarBlocks.id, id)));
    return { ok: true, id };
  });
  if (res.ok)
    await audit({
      organizationId: org,
      userId: auth.user.id,
      action: "calendar_block.update",
      entity: "calendar_block",
      entityId: id,
      meta: auditMeta(d, { scope: res.single ? "occurrence" : "series", ...(res.single ? { newId: res.id, date: occurrenceDate } : {}) }),
    });
  return res.ok ? { ok: true, id: res.id } : res;
}

/**
 * Sperrzeit löschen: einzelne Sperrzeit bzw. ganze Serie („series“) oder nur ein Vorkommen einer Serie
 * („occurrence“ – wird als Ausnahme vermerkt).
 */
export async function deleteBlock(auth: AuthContext, id: string, scope: BlockScope = "series", occurrenceDate?: string | null): Promise<{ ok: true } | { ok: false; error: string }> {
  assertWritable(auth);
  if (!z.uuid().safeParse(id).success) return { ok: false, error: "Sperrzeit nicht gefunden." };
  const org = auth.organization.id;
  const res = await withOrg(org, async (tx): Promise<{ ok: true; meta: Record<string, unknown> } | { ok: false; error: string }> => {
    const old = await lockedRule(tx, org, id);
    if (!old) return { ok: false, error: "Sperrzeit nicht gefunden." };
    if (!canManageBlocksFor(auth, old.userId)) return { ok: false, error: NO_RIGHT };
    const meta = auditMeta(old as Pick<BlockInput, "userId" | "kind" | "repeat">);
    if (scope === "occurrence" && old.repeat !== "none") {
      if (!occurrenceDate || !occursOn(old, occurrenceDate)) return { ok: false, error: "Dieses Vorkommen gibt es in der Serie nicht (mehr)." };
      await tx
        .update(calendarBlocks)
        .set({ exceptions: sql`array_append(${calendarBlocks.exceptions}, ${occurrenceDate}::date)`, updatedAt: new Date() })
        .where(and(eq(calendarBlocks.organizationId, org), eq(calendarBlocks.id, id)));
      return { ok: true, meta: { ...meta, scope: "occurrence", date: occurrenceDate } };
    }
    await tx.delete(calendarBlocks).where(and(eq(calendarBlocks.organizationId, org), eq(calendarBlocks.id, id)));
    return { ok: true, meta: { ...meta, scope: "series" } };
  });
  if (!res.ok) return res;
  await audit({ organizationId: org, userId: auth.user.id, action: "calendar_block.delete", entity: "calendar_block", entityId: id, meta: res.meta });
  return { ok: true };
}
