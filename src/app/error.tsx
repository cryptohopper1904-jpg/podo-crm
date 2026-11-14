"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect } from "react";
import { errorBtnPrimary, errorBtnSecondary, errorContext, ErrorScreen } from "@/components/error-screen";

/** Fehlercode (digest) aus Server-Fehlern – passt zum Eintrag im Server-Log, ohne Details preiszugeben */
function digestOf(error: unknown): string | null {
  if (error && typeof error === "object" && "digest" in error && typeof error.digest === "string") return error.digest;
  return null;
}

/**
 * Fehlerseite für unerwartete Fehler unterhalb des Root-Layouts (deutsch, mit Logo, hell/dunkel über die Tokens).
 * Zeigt nie die Fehlermeldung selbst (könnte Daten enthalten), nur den Fehlercode. „Erneut versuchen“ lädt den
 * Abschnitt neu (retry, Next 16). Patient:innen-Seiten in Sie-Form ohne Weg in die Praxis-App.
 */
export default function ErrorPage({ error, retry }: { error: unknown; retry: () => void }) {
  const ctx = errorContext(usePathname());
  const digest = digestOf(error);
  useEffect(() => {
    console.error(error);
  }, [error]);
  const again = (
    <button type="button" onClick={() => retry()} className={errorBtnPrimary}>
      Erneut versuchen
    </button>
  );
  const code = digest ? <> Fehlercode: <code className="font-mono text-text">{digest}</code></> : null;
  if (ctx === "patient") {
    return (
      <ErrorScreen code="Fehler" title="Das hat leider nicht geklappt" actions={again} hint={<>Bitte versuchen Sie es in einigen Minuten erneut oder wenden Sie sich direkt an Ihre Praxis.{code}</>}>
        <title>Fehler</title>
        <p>Beim Laden dieser Seite ist ein Fehler aufgetreten. Ihre Eingaben wurden möglicherweise nicht übertragen.</p>
      </ErrorScreen>
    );
  }
  return (
    <ErrorScreen
      code="Fehler"
      title="Da ist etwas schiefgelaufen"
      actions={
        <>
          {again}
          <Link href={ctx === "app" ? "/heute" : "/"} className={errorBtnSecondary}>
            {ctx === "app" ? "Zur Tagesübersicht" : "Zur Startseite"}
          </Link>
        </>
      }
      hint={<>Tritt der Fehler wiederholt auf, wende dich bitte an den Support und nenne den Fehlercode.{code}</>}
    >
      <title>Fehler · PodoHero</title>
      <p>Diese Seite konnte nicht geladen werden. Meist hilft es, es gleich noch einmal zu versuchen.</p>
    </ErrorScreen>
  );
}
