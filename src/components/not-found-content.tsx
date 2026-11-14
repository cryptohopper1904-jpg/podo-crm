import Link from "next/link";
import { errorBtnPrimary, errorBtnSecondary, ErrorScreen, type errorContext } from "./error-screen";
import { HistoryBack } from "./history-back";

/**
 * Inhalt der 404-Seiten (src/app/not-found.tsx und die Segment-Seiten unter /buchen und /p): je nach Bereich
 * Patient:innen (Sie-Form, kein Weg in die Praxis-App), öffentliche Website oder Praxis-App (du, Tagesübersicht).
 */
export function NotFoundContent({ ctx }: { ctx: ReturnType<typeof errorContext> }) {
  if (ctx === "patient") {
    return (
      <ErrorScreen
        code="Fehler 404"
        title="Seite nicht gefunden"
        actions={<HistoryBack className={errorBtnSecondary} />}
        hint="Termine können Sie jederzeit auch telefonisch mit Ihrer Praxis vereinbaren."
      >
        <p>Dieser Link ist ungültig oder nicht mehr aktuell. Bitte prüfen Sie die Adresse oder wenden Sie sich direkt an Ihre Praxis.</p>
      </ErrorScreen>
    );
  }
  if (ctx === "public") {
    return (
      <ErrorScreen
        code="Fehler 404"
        title="Seite nicht gefunden"
        actions={
          <>
            <Link href="/" className={errorBtnPrimary}>Zur Startseite</Link>
            <Link href="/login" className={errorBtnSecondary}>Zur Anmeldung</Link>
          </>
        }
      >
        <p>Diese Seite gibt es nicht (mehr). Vielleicht hat sich die Adresse geändert oder der Link ist unvollständig.</p>
      </ErrorScreen>
    );
  }
  return (
    <ErrorScreen
      code="Fehler 404"
      title="Seite nicht gefunden"
      actions={
        <>
          <Link href="/heute" className={errorBtnPrimary}>Zur Tagesübersicht</Link>
          <HistoryBack className={errorBtnSecondary} />
        </>
      }
      hint="Kommst du über einen Link aus PodoHero hierher? Dann melde dich gern beim Support und schick die Adresse mit."
    >
      <p>Diese Seite gibt es nicht (mehr) – vielleicht wurde der Eintrag gelöscht, oder die Adresse ist unvollständig.</p>
    </ErrorScreen>
  );
}
