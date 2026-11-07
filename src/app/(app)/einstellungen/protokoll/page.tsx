import { desc, eq } from "drizzle-orm";
import { Table } from "@/components/ui";
import { db } from "@/db";
import { auditLog, users } from "@/db/schema";
import { requireAuth } from "@/lib/auth/session";
import { dateTimeDe } from "@/lib/format";

export const metadata = { title: "Zugriffsprotokoll" };

export default async function AuditPage() {
  const auth = await requireAuth("audit.read");
  const rows = await db
    .select({ l: auditLog, name: users.name })
    .from(auditLog)
    .leftJoin(users, eq(users.id, auditLog.userId))
    .where(eq(auditLog.organizationId, auth.organization.id))
    .orderBy(desc(auditLog.at))
    .limit(300);
  return (
    <>
      <p className="mb-4 text-sm text-muted">Jeder Zugriff auf Kundenakten, Fotos und Doku wird protokolliert (unveränderbar). Die letzten 300 Einträge:</p>
      <Table>
        <thead><tr><th>Zeit</th><th>Person</th><th>Aktion</th><th>Objekt</th><th>IP</th></tr></thead>
        <tbody>
          {rows.map(({ l, name }) => (
            <tr key={l.id}>
              <td className="whitespace-nowrap text-sm tabular-nums">{dateTimeDe(l.at)}</td>
              <td className="text-sm">{name ?? "System"}</td>
              <td className="font-mono text-sm">{l.action}</td>
              <td className="font-mono text-xs text-muted">{l.entity ? `${l.entity}:${l.entityId?.slice(0, 8)}` : "–"}</td>
              <td className="text-xs text-muted">{l.ip ?? "–"}</td>
            </tr>
          ))}
        </tbody>
      </Table>
    </>
  );
}
