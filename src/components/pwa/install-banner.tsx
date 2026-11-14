"use client";

/**
 * Wegklickbarer Hinweis „Als App installieren“ in der Praxis-App – nur auf Touch-Geräten (Handy/Tablet), nur wenn die
 * Installation dort möglich ist (iOS oder ein Installationsangebot des Browsers) und nicht, wenn PodoHero bereits als
 * installierte App läuft. Im Übergabe-Modus wird das App-Layout gar nicht gezeigt (Sperrbildschirm).
 * Platz sparen (kleine Handys): nur auf der Startseite „Heute“, einzeilig, und von selbst nur in den ersten
 * MAX_SESSIONS Browser-Sitzungen. „Nicht mehr anzeigen“ gilt pro Gerät (localStorage); die Anleitung bleibt unter
 * Einstellungen → App erreichbar.
 */
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Download, Smartphone, X } from "lucide-react";
import { detectPlatform } from "@/lib/pwa/platform";
import { promptInstall, useInstallPrompt, useStandalone } from "./install-store";

export const INSTALL_HINT_KEY = "podo-install-hint";
/** Anzahl Browser-Sitzungen, in denen der Hinweis schon erschien (localStorage) */
const SHOWN_KEY = "podo-install-hint-sessions";
/** in dieser Browser-Sitzung schon gezählt (sessionStorage) */
const SESSION_KEY = "podo-install-hint-session";
const MAX_SESSIONS = 3;

const noop = () => () => {};

function read(store: () => Storage, key: string): string | null {
  try {
    return store().getItem(key);
  } catch {
    return null;
  }
}

export function InstallBanner() {
  const path = usePathname();
  const standalone = useStandalone();
  const bip = useInstallPrompt();
  const [closed, setClosed] = useState(false);
  const env = useSyncExternalStore(
    noop,
    () =>
      [
        matchMedia("(pointer: coarse)").matches ? 1 : 0,
        detectPlatform(navigator.userAgent, navigator.maxTouchPoints),
        read(() => localStorage, INSTALL_HINT_KEY) === "dismissed" ? 1 : 0,
        Number(read(() => localStorage, SHOWN_KEY)) || 0,
        read(() => sessionStorage, SESSION_KEY) ? 1 : 0,
      ].join("|"),
    () => null,
  );
  const [touch, platform, dismissed, sessions, counted] = env?.split("|") ?? [];
  const show =
    !!env && path === "/heute" && standalone === false && !closed && touch === "1" && dismissed !== "1" && (counted === "1" || Number(sessions) < MAX_SESSIONS) && (platform === "ios" || !!bip);

  // erste Anzeige in dieser Browser-Sitzung zählen (ändert die Anzeige jetzt nicht – counted gilt ab dem nächsten Lesen)
  useEffect(() => {
    if (!show || counted === "1") return;
    try {
      sessionStorage.setItem(SESSION_KEY, "1");
      localStorage.setItem(SHOWN_KEY, String(Number(sessions) + 1));
    } catch {
      // privates Fenster: nicht zählen
    }
  }, [show, counted, sessions]);

  if (!show) return null;

  const dismiss = () => {
    try {
      localStorage.setItem(INSTALL_HINT_KEY, "dismissed");
    } catch {
      // privates Fenster: nur für diese Seite ausblenden
    }
    setClosed(true);
  };

  return (
    <div role="region" aria-label="App installieren" className="no-print flex items-center gap-2 border-b border-border bg-info-soft py-1 pr-[max(0.5rem,env(safe-area-inset-right))] pl-[max(1rem,env(safe-area-inset-left))] text-info-soft-text lg:px-8">
      <Smartphone size={18} aria-hidden className="shrink-0" />
      <p className="min-w-0 flex-1 truncate text-sm font-medium" title="PodoHero als App auf dem Home-Bildschirm – ohne Browserleiste">
        Als App installieren
      </p>
      {platform === "ios" ? (
        <Link href="/einstellungen/app" onClick={dismiss} className="inline-flex h-9 shrink-0 items-center rounded-lg bg-surface px-3 text-sm font-semibold text-text">
          So geht’s
        </Link>
      ) : (
        <button
          type="button"
          onClick={async () => {
            const r = await promptInstall();
            if (r === "accepted") dismiss();
          }}
          className="inline-flex h-9 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg bg-primary px-3 text-sm font-semibold text-on-primary"
        >
          <Download size={16} aria-hidden /> Installieren
        </button>
      )}
      <button
        type="button"
        onClick={dismiss}
        aria-label="Hinweis schließen"
        title="Nicht mehr anzeigen"
        className="inline-flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-xl hover:bg-surface/60"
      >
        <X size={18} aria-hidden />
      </button>
    </div>
  );
}
