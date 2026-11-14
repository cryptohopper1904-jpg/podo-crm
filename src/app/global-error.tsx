"use client";

import "./globals.css";
import { useEffect, useSyncExternalStore } from "react";
import { errorBtnPrimary, errorBtnSecondary, errorContext, ErrorScreen } from "@/components/error-screen";

/** Gewähltes Theme wie im Root-Layout (localStorage „podo-theme“, sonst Systemeinstellung) */
function readTheme(): "light" | "dark" {
  try {
    const t = localStorage.getItem("podo-theme");
    if (t === "light" || t === "dark") return t;
  } catch {
    /* kein Speicher */
  }
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}
const noop = () => () => {};

/**
 * Letzte Rettung, wenn das Root-Layout selbst fehlschlägt: eigenes Dokument (html/body), eigene Styles und das
 * gewählte Theme (das Theme-Skript des Layouts läuft hier nicht). Links als <a> (volles Neuladen statt Client-Router).
 */
export default function GlobalError({ error, retry }: { error: unknown; retry: () => void }) {
  const theme = useSyncExternalStore(noop, readTheme, () => "light" as const);
  const path = useSyncExternalStore(noop, () => location.pathname, () => "");
  const ctx = errorContext(path);
  const digest = error && typeof error === "object" && "digest" in error && typeof error.digest === "string" ? error.digest : null;
  useEffect(() => {
    console.error(error);
  }, [error]);
  const patient = ctx === "patient";
  return (
    <html lang="de" data-theme={theme} suppressHydrationWarning className="h-full antialiased">
      <body className="min-h-full">
        <title>{patient ? "Fehler" : "Fehler · PodoHero"}</title>
        <ErrorScreen
          code="Fehler"
          title={patient ? "Das hat leider nicht geklappt" : "Da ist etwas schiefgelaufen"}
          actions={
            <>
              <button type="button" onClick={() => retry()} className={errorBtnPrimary}>
                Erneut versuchen
              </button>
              {patient ? null : (
                <a href={ctx === "app" ? "/heute" : "/"} className={errorBtnSecondary}>
                  {ctx === "app" ? "Zur Tagesübersicht" : "Zur Startseite"}
                </a>
              )}
            </>
          }
          hint={
            <>
              {patient
                ? "Bitte versuchen Sie es in einigen Minuten erneut oder wenden Sie sich direkt an Ihre Praxis."
                : "Tritt der Fehler wiederholt auf, wende dich bitte an den Support und nenne den Fehlercode."}
              {digest ? <> Fehlercode: <code className="font-mono text-text">{digest}</code></> : null}
            </>
          }
        >
          <p>{patient ? "Beim Laden dieser Seite ist ein Fehler aufgetreten." : "Die App konnte nicht geladen werden. Meist hilft es, es gleich noch einmal zu versuchen."}</p>
        </ErrorScreen>
      </body>
    </html>
  );
}
