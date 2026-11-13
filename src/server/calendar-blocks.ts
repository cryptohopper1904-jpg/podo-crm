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
  // Regeln einmal laden; expandiert wird nur an den Berliner Tagen der Termine (keine Lücke zwischen Serienterminen,
  // damit auch Serien über mehr als MAX_EXPAND_DAYS geprüft werden und die Prüfung unter der Buchungssperre schnell bleibt)
  const perInterval = intervals.map((i) => {
    const first = berlinParts(i.start).dateIso;
    // Ende genau um Mitternacht gehört zum Vortag
    const last = berlinParts(new Date(i.end.getTime() - 1)).dateIso;
    const days: string[] = [];
    for (let d = first; d <= last && days.length < 3; d = addDaysIso(d, 1)) days.push(d);
    return { ...i, days };
  });
  const all = [...new Set(perInterval.flatMap((i) => i.days))].sort();
  const rules = await loadBlockRules(tx, org, [therapistId], all[0], all[all.length - 1]);
  if (!rules.length) return [];
  const byDay = new Map(all.map((d) => [d, expandBlocks(rules, d, d, [therapistId])]));
  const hits = new Map<string, BlockOccurrence>();
  for (const i of perInterval) {
    for (const d of i.days) for (const o of overlappingBlocks(byDay.get(d) ?? [], therapistId, i.start, i.end)) hits.set(`${o.blockId}|${o.dateIso}`, o);
  }
  return [...hits.values()].sort((a, b) => a.dateIso.localeCompare(b.dateIso) || a.startMin - b.startMin);
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

/** Vorheriger Stand für das Protokoll (wer/welche Wiederholung vorher) */
const auditOld = (old: Pick<BlockRule, "userId" | "repeat">) => ({ oldTarget: old.userId ? "person" : "praxis", oldUserId: old.userId, oldRepeat: old.repeat });

/** Höchstzahl aktiver Sperrzeit-Regeln je Praxis (Schutz vor Massenanlage) */
export const MAX_ACTIVE_BLOCKS = 500;
/** Höchstzahl einzeln gelöschter Vorkommen je Serie (wie CHECK calendar_blocks_valid_check) */
export const MAX_EXCEPTIONS = 500;

const TOO_MANY_BLOCKS = `Es gibt bereits ${MAX_ACTIVE_BLOCKS} aktive Sperrzeiten in dieser Praxis. Bitte nicht mehr benötigte löschen oder Serien zusammenfassen.`;
const TOO_MANY_EXCEPTIONS = "Diese Serie hat zu viele einzeln geänderte oder gelöschte Vorkommen. Bitte die Serie beenden (Enddatum) und neu anlegen.";

/** Aktive Regeln (Serie ohne Ende bzw. Ende/Datum heute oder später) der Praxis zählen – unter Sperre je Praxis */
async function activeBlockCount(tx: Tx, org: string): Promise<number> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${"blocks:" + org}, 0))`);
  const today = berlinParts(new Date()).dateIso;
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(calendarBlocks)
    .where(
      and(
        eq(calendarBlocks.organizationId, org),
        or(
          and(eq(calendarBlocks.repeat, "none"), gte(calendarBlocks.startsOn, today)),
          and(sql`${calendarBlocks.repeat} <> 'none'`, or(isNull(calendarBlocks.endsOn), gte(calendarBlocks.endsOn, today))),
        ),
      ),
    );
  return row?.n ?? 0;
}

/** Sperrzeit anlegen. */
export async function createBlock(auth: AuthContext, raw: unknown): Promise<BlockResult> {
  assertWritable(auth);
  const parsed = blockInput.safeParse(raw);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Eingaben prüfen." };
  const d = parsed.data;
  if (!canManageBlocksFor(auth, d.userId)) return { ok: false, error: NO_RIGHT };
  const org = auth.organization.id;
  return withOrg(org, async (tx): Promise<BlockResult> => {
    if (d.userId && !(await isCalendarMemberTx(tx, org, d.userId))) return { ok: false, error: "Bitte eine Behandler:in (Inhaber:in oder Podolog:in) wählen." };
    if ((await activeBlockCount(tx, org)) >= MAX_ACTIVE_BLOCKS) return { ok: false, error: TOO_MANY_BLOCKS };
    const [row] = await tx
      .insert(calendarBlocks)
      .values({ ...values(org, d), createdBy: auth.user.id })
      .returning({ id: calendarBlocks.id });
    // Protokoll in derselben Transaktion: keine Sperrzeit ohne Audit-Eintrag
    await audit({ organizationId: org, userId: auth.user.id, action: "calendar_block.create", entity: "calendar_block", entityId: row.id, meta: auditMeta(d) }, tx);
    return { ok: true, id: row.id };
  });
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
 * (es wird aus der Serie ausgenommen und als einzelne Sperrzeit neu angelegt), „series“ die ganze Serie
 * (auch vergangene Vorkommen).
 */
export async function updateBlock(auth: AuthContext, id: string, raw: unknown, scope: BlockScope = "series", occurrenceDate?: string | null): Promise<BlockResult> {
  assertWritable(auth);
  if (!z.uuid().safeParse(id).success) return { ok: false, error: "Sperrzeit nicht gefunden." };
  const parsed = blockInput.safeParse(raw);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Eingaben prüfen." };
  const d = parsed.data;
  const org = auth.organization.id;
  return withOrg(org, async (tx): Promise<BlockResult> => {
    const old = await lockedRule(tx, org, id);
    if (!old) return { ok: false, error: "Sperrzeit nicht gefunden." };
    if (!canManageBlocksFor(auth, old.userId) || !canManageBlocksFor(auth, d.userId)) return { ok: false, error: NO_RIGHT };
    if (d.userId && d.userId !== old.userId && !(await isCalendarMemberTx(tx, org, d.userId))) return { ok: false, error: "Bitte eine Behandler:in (Inhaber:in oder Podolog:in) wählen." };
    const log = (meta: Record<string, unknown>) =>
      audit({ organizationId: org, userId: auth.user.id, action: "calendar_block.update", entity: "calendar_block", entityId: id, meta: { ...auditMeta(d), ...auditOld(old), ...meta } }, tx);
    if (scope === "occurrence" && old.repeat !== "none") {
      if (!occurrenceDate || !occursOn(old, occurrenceDate)) return { ok: false, error: "Dieses Vorkommen gibt es in der Serie nicht (mehr)." };
      if (old.exceptions.length >= MAX_EXCEPTIONS) return { ok: false, error: TOO_MANY_EXCEPTIONS };
      if ((await activeBlockCount(tx, org)) >= MAX_ACTIVE_BLOCKS) return { ok: false, error: TOO_MANY_BLOCKS };
      await tx
        .update(calendarBlocks)
        .set({ exceptions: sql`array_append(${calendarBlocks.exceptions}, ${occurrenceDate}::date)`, updatedAt: new Date() })
        .where(and(eq(calendarBlocks.organizationId, org), eq(calendarBlocks.id, id)));
      const [row] = await tx
        .insert(calendarBlocks)
        .values({ ...values(org, { ...d, repeat: "none", endsOn: null, weekdays: [], intervalWeeks: 1 }), createdBy: auth.user.id })
        .returning({ id: calendarBlocks.id });
      await log({ scope: "occurrence", newId: row.id, date: occurrenceDate });
      return { ok: true, id: row.id };
    }
    // Ausnahmen bleiben nur, solange sie noch zur (geänderten) Serie passen
    const exceptions = d.repeat === "none" ? [] : old.exceptions.filter((x) => x >= d.startsOn && (!d.endsOn || x <= d.endsOn));
    await tx
      .update(calendarBlocks)
      .set({ ...values(org, d), exceptions, updatedAt: new Date() })
      .where(and(eq(calendarBlocks.organizationId, org), eq(calendarBlocks.id, id)));
    await log({ scope: "series" });
    return { ok: true, id };
  });
}

/**
 * Sperrzeit löschen: einzelne Sperrzeit bzw. ganze Serie („series“) oder nur ein Vorkommen einer Serie
 * („occurrence“ – wird als Ausnahme vermerkt).
 */
export async function deleteBlock(auth: AuthContext, id: string, scope: BlockScope = "series", occurrenceDate?: string | null): Promise<{ ok: true } | { ok: false; error: string }> {
  assertWritable(auth);
  if (!z.uuid().safeParse(id).success) return { ok: false, error: "Sperrzeit nicht gefunden." };
  const org = auth.organization.id;
  return withOrg(org, async (tx): Promise<{ ok: true } | { ok: false; error: string }> => {
    const old = await lockedRule(tx, org, id);
    if (!old) return { ok: false, error: "Sperrzeit nicht gefunden." };
    if (!canManageBlocksFor(auth, old.userId)) return { ok: false, error: NO_RIGHT };
    const log = (meta: Record<string, unknown>) =>
      audit({ organizationId: org, userId: auth.user.id, action: "calendar_block.delete", entity: "calendar_block", entityId: id, meta: { ...auditMeta(old as Pick<BlockInput, "userId" | "kind" | "repeat">), ...auditOld(old), ...meta } }, tx);
    if (scope === "occurrence" && old.repeat !== "none") {
      if (!occurrenceDate || !occursOn(old, occurrenceDate)) return { ok: false, error: "Dieses Vorkommen gibt es in der Serie nicht (mehr)." };
      if (old.exceptions.length >= MAX_EXCEPTIONS) return { ok: false, error: TOO_MANY_EXCEPTIONS };
      await tx
        .update(calendarBlocks)
        .set({ exceptions: sql`array_append(${calendarBlocks.exceptions}, ${occurrenceDate}::date)`, updatedAt: new Date() })
        .where(and(eq(calendarBlocks.organizationId, org), eq(calendarBlocks.id, id)));
      await log({ scope: "occurrence", date: occurrenceDate });
      return { ok: true };
    }
    await tx.delete(calendarBlocks).where(and(eq(calendarBlocks.organizationId, org), eq(calendarBlocks.id, id)));
    await log({ scope: "series" });
    return { ok: true };
  });
}
