import Link from "next/link";
import { eq } from "drizzle-orm";
import { Download } from "lucide-react";
import { db } from "@/db";
import { organizations } from "@/db/schema";
import { Badge, Card, CardTitle } from "@/components/ui";
import { requireAuth } from "@/lib/auth/session";
import { dateDe } from "@/lib/format";
import { DELETION_GRACE_DAYS, deletionDueAt, isWithinGrace } from "@/lib/org-deletion";
import { CANCEL_FAILED_MESSAGE, cancelStateFromSettings, hasRunningSubscription } from "@/lib/subscription-cancel";
import { DeletionCancel, DeletionRequest } from "./deletion-panel";

export const metadata = { title: "Daten & Kündigung" };

function RetentionNotice() {
  return (
    <div className="rounded-xl bg-warn-soft p-4 text-sm text-warn-soft-text">
      <p className="font-semibold">Deine Aufbewahrungspflichten bleiben bestehen</p>
      <ul className="mt-2 list-disc pl-5">
        <li>Behandlungsdokumentation: <strong>10 Jahre</strong> nach Abschluss der Behandlung (§ 630f Abs. 3 BGB)</li>
        <li>
          Rechnungen, Quittungen, Zahlungsbelege und andere Buchungsbelege: <strong>8 Jahre</strong> ab Ende des Ausstellungsjahres (§ 147 AO, § 14b UStG)
        </li>
        <li>Bücher, Jahresabschlüsse und Kassenaufzeichnungen (Einzelaufzeichnungen, TSE-/DSFinV-K-Export): <strong>10 Jahre</strong> (§ 147 AO)</li>
        <li>
          Arbeitsanweisungen und Organisationsunterlagen (Verfahrensdokumentation, Einrichtungsprotokolle der Kasse, Kassenmeldung ans Finanzamt,
          Angaben zum TSE-Zertifikat): <strong>10 Jahre</strong> (§ 147 AO)
        </li>
      </ul>
      <p className="mt-2">
        Steuerliche Fristen enden frühestens zu diesem Zeitpunkt – solange die Unterlagen für eine noch offene Steuerfestsetzung von Bedeutung sind, laufen
        sie nicht ab (Ablaufhemmung, § 147 Abs. 3 S. 5 AO).
      </p>
      <p className="mt-2">
        Datenschutz: Archivierte Belege (Original-PDF) und die beim Ausstellen festgehaltenen Empfängerangaben bleiben auch nach dem Löschen der
        Kontaktdaten einer Person mindestens bis zum Fristende erhalten – sie werden nur noch für diese Aufbewahrungspflicht verarbeitet (Art. 17
        Abs. 3 lit. b DSGVO, § 147 AO). Die Löschung nach Fristablauf erfolgt derzeit nicht automatisch, sondern auf Antrag.
      </p>
      <p className="mt-2">
        Diese Pflichten treffen die Praxis. Erstelle deshalb <strong>vor</strong> der Kündigung einen vollständigen Export und bewahre ihn sicher
        auf. Wir löschen alle Daten frühestens {DELETION_GRACE_DAYS} Tage nach dem Antrag endgültig. Verschlüsselte Datensicherungen laufen
        spätestens 14 Tage danach aus. Eine Kopie für dich bewahren wir nicht auf.
      </p>
      <p className="mt-2">
        Der Komplett-Export enthält <strong>nicht</strong> den DSFinV-K-Export (Kasse → DSFinV-K-Export) und den TSE-Export (beim TSE-Anbieter):
        Erstelle beide für <strong>alle Zeiträume bis zur Kündigung</strong> separat und bewahre sie 10 Jahre auf – nach der Löschung lassen
        sie sich nicht mehr erzeugen.
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
  const [org] = await db
    .select({
      name: organizations.name,
      at: organizations.deletionRequestedAt,
      plan: organizations.plan,
      subscriptionStatus: organizations.subscriptionStatus,
      stripeSubscriptionId: organizations.stripeSubscriptionId,
      currentPeriodEnd: organizations.currentPeriodEnd,
      settings: organizations.settings,
    })
    .from(organizations)
    .where(eq(organizations.id, auth.organization.id));
  const requestedAt = org?.at ?? null;
  const running = !!org && hasRunningSubscription(org);
  const cancel = cancelStateFromSettings(org?.settings);
  const periodEnd = org?.currentPeriodEnd ? dateDe(org.currentPeriodEnd) : "Ende des Abrechnungszeitraums";
  const aboLink = <Link href="/einstellungen/abo" className="font-semibold underline">Abo</Link>;

  return (
    <div className="flex flex-col gap-6">
      {requestedAt ? (
        <Card className="border-danger/50">
          <CardTitle>Löschung beantragt <Badge tone="accent">Karenzzeit</Badge></CardTitle>
          <p className="text-[15px]">
            Beantragt am <strong>{dateDe(requestedAt)}</strong>. Die Praxis wird frühestens am <strong>{dateDe(deletionDueAt(requestedAt))}</strong> mit allen
            Daten, Fotos und Zugängen endgültig gelöscht. Bis dahin kannst du weiterarbeiten und exportieren.
          </p>
          {running && cancel.cancelAtPeriodEnd ? (
            <p className="mt-2 text-[15px]" data-testid="abo-kuendigung-status">
              Dein Abo ist zum <strong>{periodEnd}</strong> gekündigt; danach wird nichts mehr abgebucht.
              {cancel.reason !== "deletion_request" ? " Die Kündigung wurde separat ausgesprochen und bleibt auch bei einer Rücknahme des Löschantrags bestehen." : null}
            </p>
          ) : running ? (
            <p role="alert" className="mt-3 rounded-xl bg-warn-soft px-4 py-3 text-sm font-medium text-warn-soft-text" data-testid="abo-kuendigung-status">
              {CANCEL_FAILED_MESSAGE} Zum Kündigen: {aboLink}.
            </p>
          ) : null}
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
            Nach {DELETION_GRACE_DAYS} Tagen Karenzzeit wird endgültig gelöscht; bis dahin kannst du den Antrag zurücknehmen. Der Löschantrag gilt
            zugleich als Kündigung deines Abos zum Ende des laufenden Abrechnungszeitraums; danach wird nichts mehr abgebucht. Nimmst du den
            Löschantrag innerhalb der Karenzzeit zurück, gilt auch die Kündigung als zurückgenommen und dein Abo läuft weiter. Möchtest du nur das
            Abo kündigen und deine Daten behalten, nutze „Abo kündigen“ unter{" "}
            <Link href="/einstellungen/abo" className="font-semibold text-primary underline">Abo</Link>.
          </p>
          {running && cancel.cancelAtPeriodEnd ? (
            <p className="mb-4 text-sm text-muted">Hinweis: Dein Abo ist bereits zum {periodEnd} gekündigt. Diese Kündigung bleibt auch bestehen, wenn du einen Löschantrag zurücknimmst.</p>
          ) : null}
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
