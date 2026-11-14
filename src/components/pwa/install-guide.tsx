"use client";

/**
 * Installationshilfe der Web-App: Android/Chrome/Edge mit Knopf (beforeinstallprompt), iPhone/iPad Schritt für
 * Schritt über Safari → Teilen → „Zum Home-Bildschirm“ (iOS kennt keinen Installationsknopf für Websites).
 * Erkennt die laufende installierte App und zeigt dann nur eine kurze Bestätigung.
 */
import { useState, useSyncExternalStore, type ReactNode } from "react";
import { CircleCheck, Download, EllipsisVertical, MonitorDown, Share, SquarePlus } from "lucide-react";
import { cx } from "@/components/ui";
import { detectPlatform, isIosOtherBrowser, type InstallPlatform } from "@/lib/pwa/platform";
import { promptInstall, useInstallPrompt, useStandalone } from "./install-store";

const noop = () => () => {};
function usePlatform(): { platform: InstallPlatform; otherIosBrowser: boolean } | null {
  const key = useSyncExternalStore(
    noop,
    () => `${detectPlatform(navigator.userAgent, navigator.maxTouchPoints)}|${isIosOtherBrowser(navigator.userAgent) ? 1 : 0}`,
    () => null,
  );
  if (!key) return null;
  const [platform, other] = key.split("|");
  return { platform: platform as InstallPlatform, otherIosBrowser: other === "1" };
}

function Step({ n, children }: { n: number; children: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span aria-hidden className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary-soft text-sm font-bold text-primary-soft-text">{n}</span>
      <span className="min-w-0 pt-0.5 text-[15px]">{children}</span>
    </li>
  );
}

const Key = ({ children }: { children: ReactNode }) => (
  <span className="inline-flex max-w-full items-center gap-1 rounded-md border border-border bg-surface-2 px-1.5 py-0.5 align-middle text-sm font-semibold [overflow-wrap:anywhere] [&>svg]:shrink-0">{children}</span>
);

function IosSteps({ otherBrowser }: { otherBrowser: boolean }) {
  return (
    <ol className="flex flex-col gap-3" aria-label="Anleitung für iPhone und iPad">
      <Step n={1}>
        PodoHero in <strong>Safari</strong> öffnen und anmelden.
        {otherBrowser ? " (In Chrome oder Firefox auf dem iPhone geht es ab iOS 16.4 genauso über „Teilen“.)" : null}
      </Step>
      <Step n={2}>
        Auf <Key><Share size={15} aria-hidden /> Teilen</Key> tippen – auf dem iPhone unten in der Leiste (ggf. erst über{" "}
        <Key>···</Key>), auf dem iPad oben rechts neben der Adresse.
      </Step>
      <Step n={3}>
        In der Liste nach unten wischen und <Key><SquarePlus size={15} aria-hidden /> Zum Home-Bildschirm</Key> wählen.
      </Step>
      <Step n={4}>
        Falls angezeigt, <strong>„Als Web-App öffnen“</strong> eingeschaltet lassen, dann oben rechts auf <Key>Hinzufügen</Key> tippen.
      </Step>
      <Step n={5}>PodoHero ab jetzt über das neue Symbol auf dem Home-Bildschirm starten – ohne Browserleiste, wie eine App.</Step>
    </ol>
  );
}

function AndroidSteps({ canPrompt, onInstall, busy }: { canPrompt: boolean; onInstall: () => void; busy: boolean }) {
  return (
    <div className="flex flex-col gap-4">
      {canPrompt ? (
        <button
          type="button"
          onClick={onInstall}
          disabled={busy}
          className="inline-flex h-12 cursor-pointer items-center justify-center gap-2 self-start rounded-xl bg-primary px-5 text-[15px] font-semibold text-on-primary hover:bg-primary-hover disabled:opacity-50"
        >
          <Download size={19} aria-hidden /> App installieren
        </button>
      ) : null}
      <ol className="flex flex-col gap-3" aria-label="Anleitung für Android">
        <Step n={1}>PodoHero in <strong>Chrome</strong> (oder Edge, Samsung Internet) öffnen und anmelden.</Step>
        <Step n={2}>
          {canPrompt ? "Oben auf „App installieren“ tippen – oder rechts oben auf " : "Rechts oben auf "}
          <Key><EllipsisVertical size={15} aria-hidden /> Menü</Key> tippen.
        </Step>
        <Step n={3}>
          <Key>App installieren</Key> bzw. <Key>Zum Startbildschirm hinzufügen</Key> wählen und bestätigen.
        </Step>
        <Step n={4}>PodoHero startet danach über das Symbol auf dem Startbildschirm in einem eigenen Fenster.</Step>
      </ol>
    </div>
  );
}

function DesktopSteps({ canPrompt, onInstall, busy }: { canPrompt: boolean; onInstall: () => void; busy: boolean }) {
  return (
    <div className="flex flex-col gap-4">
      {canPrompt ? (
        <button
          type="button"
          onClick={onInstall}
          disabled={busy}
          className="inline-flex h-11 cursor-pointer items-center justify-center gap-2 self-start rounded-xl bg-primary px-4 text-[15px] font-semibold text-on-primary hover:bg-primary-hover disabled:opacity-50"
        >
          <MonitorDown size={18} aria-hidden /> App installieren
        </button>
      ) : null}
      <ol className="flex flex-col gap-3" aria-label="Anleitung für Computer">
        <Step n={1}>In <strong>Chrome</strong> oder <strong>Edge</strong> in der Adressleiste rechts auf das Installations-Symbol klicken.</Step>
        <Step n={2}>„Installieren“ bestätigen – PodoHero öffnet sich in einem eigenen Fenster und erscheint im Startmenü bzw. Dock.</Step>
        <Step n={3}>Safari auf dem Mac: Ablage → „Zum Dock hinzufügen“.</Step>
      </ol>
    </div>
  );
}

const TITLES: Record<InstallPlatform, string> = { ios: "iPhone & iPad", android: "Android", desktop: "Computer (Windows, Mac)" };

export function InstallGuide({ headingLevel = 2 }: { headingLevel?: 2 | 3 }) {
  const env = usePlatform();
  const standalone = useStandalone();
  const bip = useInstallPrompt();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<"accepted" | "dismissed" | null>(null);
  const H = headingLevel === 2 ? "h2" : "h3";

  if (standalone) {
    return (
      <p role="status" className="flex items-start gap-3 rounded-xl bg-primary-soft px-4 py-3 text-[15px] font-medium text-primary-soft-text">
        <CircleCheck size={20} aria-hidden className="mt-0.5 shrink-0" />
        PodoHero läuft bereits als installierte App auf diesem Gerät.
      </p>
    );
  }

  const install = async () => {
    setBusy(true);
    try {
      const r = await promptInstall();
      if (r !== "unavailable") setResult(r);
    } finally {
      setBusy(false);
    }
  };
  const order: InstallPlatform[] = env ? [env.platform, ...(["ios", "android", "desktop"] as const).filter((p) => p !== env.platform)] : ["ios", "android", "desktop"];
  const body = (p: InstallPlatform) =>
    p === "ios" ? (
      <IosSteps otherBrowser={!!env?.otherIosBrowser} />
    ) : p === "android" ? (
      <AndroidSteps canPrompt={!!bip && env?.platform === "android"} onInstall={install} busy={busy} />
    ) : (
      <DesktopSteps canPrompt={!!bip && env?.platform === "desktop"} onInstall={install} busy={busy} />
    );

  return (
    <div className="flex flex-col gap-4">
      {result === "accepted" ? (
        <p role="status" className="rounded-xl bg-primary-soft px-4 py-3 text-[15px] font-medium text-primary-soft-text">
          Wird installiert – PodoHero erscheint gleich auf dem Startbildschirm.
        </p>
      ) : null}
      {order.map((p, i) =>
        i === 0 && env ? (
          <section key={p} aria-labelledby={`install-${p}`} className="rounded-xl border border-primary/40 bg-surface p-4">
            <H id={`install-${p}`} className="mb-3 font-display text-lg font-semibold">
              {TITLES[p]} <span className="text-sm font-medium text-muted">(dieses Gerät)</span>
            </H>
            {body(p)}
          </section>
        ) : (
          <details key={p} className="group rounded-xl border border-border bg-surface">
            <summary className={cx("flex min-h-11 cursor-pointer list-none items-center px-4 font-semibold [&::-webkit-details-marker]:hidden")}>
              {TITLES[p]}
              <span aria-hidden className="ml-auto text-muted transition-transform group-open:rotate-90">›</span>
            </summary>
            <div className="px-4 pb-4">{body(p)}</div>
          </details>
        ),
      )}
    </div>
  );
}
