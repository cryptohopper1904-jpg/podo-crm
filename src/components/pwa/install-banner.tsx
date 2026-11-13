"use client";

/**
 * Einmaliger, wegklickbarer Hinweis „Als App installieren“ in der Praxis-App – nur auf Touch-Geräten (Handy/Tablet),
 * nur wenn die Installation dort möglich ist (iOS oder ein Installationsangebot des Browsers) und nicht, wenn PodoHero
 * bereits als installierte App läuft. Im Übergabe-Modus wird das App-Layout gar nicht gezeigt (Sperrbildschirm).
 * Die Wahl „Nicht mehr anzeigen“ gilt pro Gerät (localStorage).
 */
import Link from "next/link";
import { useState, useSyncExternalStore } from "react";
import { Download, Smartphone, X } from "lucide-react";
import { detectPlatform } from "@/lib/pwa/platform";
import { promptInstall, useInstallPrompt, useStandalone } from "./install-store";

export const INSTALL_HINT_KEY = "podo-install-hint";

const noop = () => () => {};

function readDismissed(): boolean {
  try {
    return localStorage.getItem(INSTALL_HINT_KEY) === "dismissed";
  } catch {
    return false;
  }
}

export function InstallBanner() {
  const standalone = useStandalone();
  const bip = useInstallPrompt();
  const [closed, setClosed] = useState(false);
  const env = useSyncExternalStore(
    noop,
    () => `${matchMedia("(pointer: coarse)").matches ? 1 : 0}|${detectPlatform(navigator.userAgent, navigator.maxTouchPoints)}|${readDismissed() ? 1 : 0}`,
    () => null,
  );
  if (!env || standalone !== false || closed) return null;
  const [touch, platform, dismissed] = env.split("|");
  if (touch !== "1" || dismissed === "1") return null;
  if (platform !== "ios" && !bip) return null;

  const dismiss = () => {
    try {
      localStorage.setItem(INSTALL_HINT_KEY, "dismissed");
    } catch {
      // privates Fenster: nur für diese Seite ausblenden
    }
    setClosed(true);
  };

  return (
    <div role="region" aria-label="App installieren" className="no-print flex items-center gap-3 border-b border-border bg-info-soft py-2 pr-[max(1rem,env(safe-area-inset-right))] pl-[max(1rem,env(safe-area-inset-left))] text-info-soft-text lg:px-8">
      <Smartphone size={20} aria-hidden className="shrink-0" />
      <p className="min-w-0 flex-1 text-sm font-medium">
        PodoHero als App auf dem Home-Bildschirm – ohne Browserleiste.
      </p>
      {platform === "ios" ? (
        <Link href="/einstellungen/app" onClick={dismiss} className="inline-flex h-11 shrink-0 items-center rounded-xl bg-surface px-3 text-sm font-semibold text-text">
          So geht’s
        </Link>
      ) : (
        <button
          type="button"
          onClick={async () => {
            const r = await promptInstall();
            if (r === "accepted") dismiss();
          }}
          className="inline-flex h-11 shrink-0 cursor-pointer items-center gap-1.5 rounded-xl bg-primary px-3 text-sm font-semibold text-on-primary"
        >
          <Download size={17} aria-hidden /> Installieren
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
