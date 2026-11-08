/**
 * Endgültige Löschung gekündigter Praxen (Mandanten) – nur für den Betreiber, ausgeführt über
 * scripts/purge-organizations.ts mit der EIGENTÜMER-Rolle der Datenbank (DATABASE_MIGRATION_URL).
 *
 * Warum Eigentümer: Behandlungsdoku, Einwilligungen, Audit-Log, ausgestellte Rechnungen usw. sind per
 * Trigger unveränderbar (append-only). `SET session_replication_role = replica` dürfte nur ein Superuser.
 * Der Tabelleneigentümer darf aber `ALTER TABLE … DISABLE TRIGGER`. Das geschieht hier INNERHALB EINER
 * Transaktion:
 *   1. Sperre (ACCESS EXCLUSIVE) auf die betroffenen Tabellen – andere Sitzungen warten, sehen also nie
 *      einen Zustand ohne Trigger; ALTER TABLE ist transaktional.
 *   2. Nutzer-Trigger (nur die aktiven) abschalten; beim Audit-Log zusätzlich FORCE RLS aussetzen,
 *      weil es dort bewusst keine DELETE-Policy gibt.
 *   3. `app.org_id` = zu löschende Praxis setzen: Row-Level-Security begrenzt jedes DELETE zusätzlich
 *      zum WHERE auf diese Praxis (zweite Sicherung gegen Fehlgriffe).
 *   4. Zeilen aller Tabellen mit organization_id in FK-sicherer Reihenfolge löschen (Kind vor Eltern,
 *      aus pg_constraint berechnet – neue Tabellen werden automatisch erfasst).
 *   5. Benutzer löschen, die nur Mitglied dieser Praxis waren (keine Plattform-Admins).
 *   6. Praxis-Datensatz löschen, Trigger/RLS exakt wiederherstellen, Plattform-Protokollzeile schreiben, COMMIT.
 *   7. Danach das Speicherverzeichnis <STORAGE_DIR>/<org-id>/ löschen.
 * Schlägt etwas fehl, wird alles zurückgerollt (auch die Trigger-Änderungen).
 *
 * Bewusst behalten: billing_events (Abo-Abrechnung des Betreibers, eigene Aufbewahrungspflicht; die
 * Verknüpfung zur Praxis wird per FK auf NULL gesetzt).
 */
import { rm } from "node:fs/promises";
import path from "node:path";
import type { PoolClient } from "pg";
import { purgeCutoff } from "../lib/org-deletion";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IDENT = /^[a-z_][a-z0-9_]*$/;
/** Tabellen mit organization_id, die nicht zeilenweise gelöscht werden */
export const KEEP_TABLES = new Set(["organizations", "billing_events"]);

const q = (ident: string) => {
  if (!IDENT.test(ident)) throw new Error(`Unerwarteter Tabellen-/Triggername: ${ident}`);
  return `"${ident}"`;
};

export type DueOrganization = { id: string; slug: string; deletionRequestedAt: Date };

export type PurgeReport = {
  organizationId: string;
  slug: string;
  executed: boolean;
  /** Anzahl (zu) löschender Zeilen je Tabelle */
  rows: Record<string, number>;
  users: number;
  usersKept: number;
  storageDir: string | null;
};

export async function findDueOrganizations(client: PoolClient, now: Date = new Date()): Promise<DueOrganization[]> {
  const r = await client.query(
    "select id, slug, deletion_requested_at from organizations where deletion_requested_at is not null and deletion_requested_at < $1 order by deletion_requested_at",
    [purgeCutoff(now)],
  );
  return r.rows.map((x) => ({ id: x.id, slug: x.slug, deletionRequestedAt: x.deletion_requested_at }));
}

/** Bricht ab, wenn die Verbindung nicht Eigentümer aller Mandanten-Tabellen ist (z. B. App-Rolle). */
export async function assertTableOwner(client: PoolClient): Promise<void> {
  const r = await client.query(`
    select c.relname from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute a on a.attrelid = c.oid and a.attname = 'organization_id' and not a.attisdropped
     where n.nspname = 'public' and c.relkind in ('r','p') and pg_get_userbyid(c.relowner) <> current_user`);
  if (r.rowCount) {
    throw new Error(
      `Die Verbindung ist nicht Eigentümer von ${r.rows.map((x) => x.relname).join(", ")}. Bitte DATABASE_MIGRATION_URL (Eigentümer-Rolle) verwenden.`,
    );
  }
}

type TableMeta = { name: string; triggers: string[]; forceRls: boolean; hasDeletePolicy: boolean };

async function loadTables(client: PoolClient): Promise<{ order: string[]; meta: Map<string, TableMeta> }> {
  const tables = await client.query(`
    select c.oid, c.relname, c.relforcerowsecurity as force_rls,
           exists (select 1 from pg_policy p where p.polrelid = c.oid and p.polcmd in ('*','d')) as has_delete_policy
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute a on a.attrelid = c.oid and a.attname = 'organization_id' and not a.attisdropped
     where n.nspname = 'public' and c.relkind in ('r','p')`);
  const meta = new Map<string, TableMeta>();
  for (const t of tables.rows) {
    if (KEEP_TABLES.has(t.relname)) continue;
    meta.set(t.relname, { name: t.relname, triggers: [], forceRls: t.force_rls, hasDeletePolicy: t.has_delete_policy });
  }
  const trg = await client.query(`
    select c.relname, t.tgname from pg_trigger t join pg_class c on c.oid = t.tgrelid
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and not t.tgisinternal and t.tgenabled <> 'D'`);
  for (const t of trg.rows) meta.get(t.relname)?.triggers.push(t.tgname);

  const fks = await client.query(`
    select cc.relname as child, pc.relname as parent from pg_constraint k
      join pg_class cc on cc.oid = k.conrelid join pg_class pc on pc.oid = k.confrelid
      join pg_namespace n on n.oid = cc.relnamespace
     where k.contype = 'f' and n.nspname = 'public'`);
  // Kahn: eine Tabelle darf gelöscht werden, wenn keine (noch nicht gelöschte) Tabelle auf sie verweist
  const referencedBy = new Map<string, Set<string>>();
  for (const name of meta.keys()) referencedBy.set(name, new Set());
  for (const { child, parent } of fks.rows) {
    if (child !== parent && meta.has(child) && meta.has(parent)) referencedBy.get(parent)!.add(child);
  }
  const order: string[] = [];
  const remaining = new Set(meta.keys());
  while (remaining.size) {
    const ready = [...remaining].filter((t) => [...referencedBy.get(t)!].every((c) => !remaining.has(c))).sort();
    if (!ready.length) throw new Error(`Zyklische Fremdschlüssel zwischen: ${[...remaining].join(", ")}`);
    for (const t of ready) {
      order.push(t);
      remaining.delete(t);
    }
  }
  return { order, meta };
}

async function exclusiveUsers(client: PoolClient, orgId: string): Promise<string[]> {
  const r = await client.query(
    `select distinct m.user_id from memberships m join users u on u.id = m.user_id
      where m.organization_id = $1 and not u.is_platform_admin
        and not exists (select 1 from memberships m2 where m2.user_id = m.user_id and m2.organization_id <> $1)`,
    [orgId],
  );
  return r.rows.map((x) => x.user_id);
}

/**
 * Löscht eine Praxis endgültig (execute) oder zeigt nur, was gelöscht würde (Probelauf, Standard).
 * Verweigert Praxen ohne Löschantrag oder innerhalb der Karenzzeit.
 */
export async function purgeOrganization(
  client: PoolClient,
  orgId: string,
  opts: { execute: boolean; storageRoot?: string | null; now?: Date; log?: (line: string) => void },
): Promise<PurgeReport> {
  if (!UUID.test(orgId)) throw new Error("Ungültige Praxis-ID");
  const log = opts.log ?? (() => {});
  for (let attempt = 1; ; attempt++) {
    try {
      return await purgeOnce(client, orgId, opts, log);
    } catch (e) {
      const code = (e as { code?: string }).code;
      // Deadlock / Sperr-Timeout: andere Sitzungen hielten Sperren – kurz warten und neu versuchen
      if ((code === "40P01" || code === "55P03") && attempt < 3) {
        log(`Sperrkonflikt (${code}), Versuch ${attempt + 1} …`);
        await new Promise((r) => setTimeout(r, 500 * attempt));
        continue;
      }
      throw e;
    }
  }
}

async function purgeOnce(
  client: PoolClient,
  orgId: string,
  opts: { execute: boolean; storageRoot?: string | null; now?: Date },
  log: (line: string) => void,
): Promise<PurgeReport> {
  await client.query("begin");
  try {
    await client.query("set local lock_timeout = '15s'");
    const org = (await client.query("select id, slug, deletion_requested_at from organizations where id = $1 for update", [orgId])).rows[0];
    if (!org) throw new Error(`Praxis ${orgId} nicht gefunden`);
    if (!org.deletion_requested_at) throw new Error(`Praxis ${org.slug}: keine Löschung beantragt`);
    if (org.deletion_requested_at >= purgeCutoff(opts.now)) throw new Error(`Praxis ${org.slug}: Karenzzeit läuft noch`);

    const { order, meta } = await loadTables(client);
    // RLS als zweite Sicherung: nur Zeilen dieser Praxis sind sichtbar/löschbar
    await client.query("select set_config('app.org_id', $1, true)", [orgId]);
    const userIds = await exclusiveUsers(client, orgId);
    const rows: Record<string, number> = {};
    const storageDir = opts.storageRoot ? path.join(opts.storageRoot, orgId) : null;

    if (!opts.execute) {
      // Probelauf: zählen. Tabellen mit FORCE RLS ohne DELETE-Policy (Audit-Log) sind ohnehin per SELECT-Policy lesbar.
      for (const t of order) rows[t] = Number((await client.query(`select count(*)::int as n from ${q(t)} where organization_id = $1`, [orgId])).rows[0].n);
      await client.query("rollback");
      return { organizationId: orgId, slug: org.slug, executed: false, rows, users: userIds.length, usersKept: 0, storageDir };
    }

    const altered = order.map((t) => meta.get(t)!).filter((m) => m.triggers.length || (m.forceRls && !m.hasDeletePolicy));
    if (altered.length) await client.query(`lock table ${altered.map((m) => q(m.name)).join(", ")} in access exclusive mode`);
    for (const m of altered) {
      for (const tg of m.triggers) await client.query(`alter table ${q(m.name)} disable trigger ${q(tg)}`);
      if (m.forceRls && !m.hasDeletePolicy) await client.query(`alter table ${q(m.name)} no force row level security`);
    }

    for (const t of order) rows[t] = (await client.query(`delete from ${q(t)} where organization_id = $1`, [orgId])).rowCount ?? 0;

    let usersDeleted = 0;
    let usersKept = 0;
    for (const uid of userIds) {
      await client.query("savepoint purge_user");
      try {
        // Anmelde-Ereignisse ohne Praxisbezug dieses Benutzers (Datensparsamkeit)
        await client.query("delete from audit_log where organization_id is null and user_id = $1", [uid]);
        await client.query("delete from users where id = $1", [uid]);
        await client.query("release savepoint purge_user");
        usersDeleted++;
      } catch {
        // noch anderswo referenziert → Benutzer bleibt (ohne Mitgliedschaft) bestehen
        await client.query("rollback to savepoint purge_user");
        usersKept++;
      }
    }

    await client.query("delete from organizations where id = $1", [orgId]);

    for (const m of altered) {
      for (const tg of m.triggers) await client.query(`alter table ${q(m.name)} enable trigger ${q(tg)}`);
      if (m.forceRls && !m.hasDeletePolicy) await client.query(`alter table ${q(m.name)} force row level security`);
    }

    // Plattform-Protokoll (ohne Praxisbezug, ohne Inhalte): nur ID und Zählwerte
    await client.query("select set_config('app.org_id', '', true)");
    await client.query(
      "insert into audit_log (organization_id, user_id, action, entity, entity_id, meta) values (null, null, 'platform.org_purged', 'organization', $1, $2)",
      [orgId, JSON.stringify({ rows, usersDeleted, usersKept })],
    );
    await client.query("commit");

    if (storageDir) {
      const root = path.resolve(opts.storageRoot!);
      const target = path.resolve(storageDir);
      if (path.dirname(target) !== root) throw new Error("Speicherpfad außerhalb des Ablageverzeichnisses");
      await rm(target, { recursive: true, force: true });
    }
    const total = Object.values(rows).reduce((a, b) => a + b, 0);
    log(`[platform] ${new Date().toISOString()} org.purged id=${orgId} rows=${total} users=${usersDeleted} kept_users=${usersKept} storage=${storageDir ? "removed" : "skipped"}`);
    return { organizationId: orgId, slug: org.slug, executed: true, rows, users: usersDeleted, usersKept, storageDir };
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  }
}
