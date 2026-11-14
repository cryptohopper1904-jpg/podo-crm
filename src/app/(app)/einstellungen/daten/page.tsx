import Link from "next/link";
import { eq } from "drizzle-orm";
import { Download } from "lucide-react";
import { db } from "@/db";
import { organizations } from "@/db/schema";
import { Badge, Card, CardTitle } from "@/components/ui";
import { requireAuth } from "@/lib/auth/session";
import { dateDe } from "@/lib/format";
import { DELETION_GRACE_DAYS, deletionDueAt, isWithinGrace } from "@/lib/org-deletion";
import { DeletionCancel, DeletionRequest } from "./deletion-panel";

export const metadata = { title: "Daten & Kündigung" };

function RetentionNotice() {
  return (
    <div className="rounded-xl bg-warn-soft p-4 text-sm text-warn-soft-text">
      <p className="font-semibold">Deine Aufbewahrungspflichten bleiben bestehen</p>
      <ul className="mt-2 list-disc pl-5">
        <li>Behandlungsdokumentation: <strong>10 Jahre</strong> nach Abschluss der Behandlung (§ 630f Abs. 3 BGB)</li>
        <li>Rechnungen und Buchungsbelege: <strong>8 Jahre</strong>, Bücher und Jahresabschlüsse: <strong>10 Jahre</strong> (§ 147 AO, § 14b UStG)</li>
      </ul>
      <p className="mt-2">
        Diese Pflichten treffen die Praxis. Erstelle deshalb <strong>vor</strong> der Kündigung einen vollständigen Export und bewahre ihn sicher
        auf. Wir löschen alle Daten {DELETION_GRACE_DAYS} Tage nach dem Antrag endgültig und behalten keine Kopie für dich.
      </p>
    </div>
  );
}

export default async function DataSettings() {
  const auth = await requireAuth("settings.manage");
  if (auth.role !== "owner" || auth.support) {
    return (
      <Card>
        <CardTitle>Daten & Kündigung</CardTitle>
        <p className="text-sm text-muted">Vollständiger Export und Kündigung sind nur für Inhaber:innen der Praxis möglich.</p>
      </Card>
    );
  }
  const [org] = await db.select({ name: organizations.name, at: organizations.deletionRequestedAt }).from(organizations).where(eq(organizations.id, auth.organization.id));
  const requestedAt = org?.at ?? null;

  return (
    <div className="flex flex-col gap-6">
      {requestedAt ? (
        <Card className="border-danger/50">
          <CardTitle>Löschung beantragt <Badge tone="accent">Karenzzeit</Badge></CardTitle>
          <p className="text-[15px]">
            Beantragt am <strong>{dateDe(requestedAt)}</strong>. Die Praxis wird frühestens am <strong>{dateDe(deletionDueAt(requestedAt))}</strong> mit allen
            Daten, Fotos und Zugängen endgültig gelöscht. Bis dahin kannst du weiterarbeiten und exportieren.
          </p>
          <div className="mt-4">
            {isWithinGrace(requestedAt) ? (
              <DeletionCancel />
            ) : (
              <p className="text-sm text-muted">Die Karenzzeit ist abgelaufen; die Löschung erfolgt im nächsten Löschlauf.</p>
            )}
          </div>
        </Card>
      ) : null}

      <Card>
        <CardTitle>Vollständiger Datenexport</CardTitle>
        <p className="text-[15px] text-muted">
          ZIP-Datei mit allen Daten deiner Praxis: jede Tabelle als JSON, alle Fotos und Dokumente entschlüsselt (Ordner je Patientennummer) und eine
          Erläuterung (README.txt). Zugangsdaten, Passwörter und 2FA-Geheimnisse sind nicht enthalten. Der Export wird im Zugriffsprotokoll vermerkt.
        </p>
        <p className="mt-2 text-sm text-muted">Enthält Gesundheitsdaten – nur auf einem verschlüsselten, geschützten Gerät speichern. Höchstens ein Export alle 10 Minuten.</p>
        <a
          href="/api/export/praxis"
          download
          className="mt-4 inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-primary px-4 text-[15px] font-semibold text-on-primary hover:bg-primary-hover"
        >
          <Download size={18} aria-hidden /> Export herunterladen (ZIP)
        </a>
      </Card>

      {!requestedAt ? (
        <Card>
          <CardTitle>Praxis kündigen & löschen</CardTitle>
          <p className="mb-4 text-[15px] text-muted">
            Mit der Kündigung beantragst du die vollständige Löschung deiner Praxis: alle Patient:innen, Doku, Fotos, Rechnungen, Termine und Zugänge.
            Nach {DELETION_GRACE_DAYS} Tagen Karenzzeit wird endgültig gelöscht; bis dahin kannst du den Antrag zurücknehmen. Ein laufendes Abo
            verwaltest du unter <Link href="/einstellungen/abo" className="font-semibold text-primary underline">Abo</Link>.
          </p>
          <RetentionNotice />
          <div className="mt-5">
            <DeletionRequest practiceName={org?.name ?? auth.organization.name} />
          </div>
        </Card>
      ) : (
        <RetentionNotice />
      )}
    </div>
  );
}
