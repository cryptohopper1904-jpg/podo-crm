/**
 * Gemeinsame Angaben der installierbaren Web-App (Manifest, Metadaten, Asset-Skript). Keine Server-Importe.
 * Farben entsprechen den Design-Tokens in src/app/globals.css (--bg/--surface hell bzw. dunkel).
 */
import type { Metadata } from "next";
import { startupImages } from "./startup-images";

export const APP_NAME = "PodoHero";

/**
 * Markenhinweis unter den Installationsanleitungen (src/components/pwa/install-guide.tsx). Nennt genau die Marken, die
 * auf der Seite vorkommen: Anleitung = iPhone, iPad, Mac, Safari, Android, Chrome, (Microsoft) Edge, Windows, Samsung
 * Internet; „App Store“ steht im Seitentext; `googlePlay` nur dort, wo Google Play erwähnt wird (öffentliche Seite /app).
 * Bei neuen Nennungen in Anleitung oder Seitentext hier ergänzen.
 */
export function trademarkNotice({ googlePlay = false }: { googlePlay?: boolean } = {}): string {
  return (
    "iPhone, iPad, Mac, Safari und App Store sind Marken der Apple Inc.; " +
    (googlePlay ? "Android, Chrome und Google Play sind Marken der Google LLC; " : "Android und Chrome sind Marken der Google LLC; ") +
    "Microsoft Edge und Windows sind Marken der Microsoft Corporation; " +
    "Samsung Internet ist eine Marke der Samsung Electronics Co., Ltd. " +
    "PodoHero steht in keiner Verbindung zu diesen Unternehmen."
  );
}

export const PWA_COLORS = {
  /** Seitenhintergrund (--bg) – Startbildschirm Android/iOS */
  backgroundLight: "#f4f9f8",
  backgroundDark: "#0d1b1e",
  /** Kopfzeile (--surface) – Statusleiste/Titelleiste der installierten App */
  themeLight: "#ffffff",
  themeDark: "#13262a",
  /** Logo-Farben (public/icons/icon.svg) */
  logoLight: { primary: "#0b7f73", accent: "#f2715a" },
  logoDark: { primary: "#34d1bc", accent: "#ff8a73" },
} as const;

/** Icon-Dateien in public/ (vom Manifest und den Metadaten referenziert; erzeugt von scripts/generate-pwa-assets.ts) */
export const PWA_ICONS = {
  svg: "/icons/icon.svg",
  any192: "/icons/icon-192.png",
  any512: "/icons/icon-512.png",
  maskable192: "/icons/icon-maskable-192.png",
  maskable512: "/icons/icon-maskable-512.png",
  apple: "/icons/apple-touch-icon.png",
  favicon16: "/icons/favicon-16.png",
  favicon32: "/icons/favicon-32.png",
  favicon48: "/icons/favicon-48.png",
  /** einfarbige Kürzel-Icons (Android-Verknüpfungen) */
  shortcutToday: "/icons/shortcut-heute.png",
  shortcutCalendar: "/icons/shortcut-kalender.png",
  shortcutNew: "/icons/shortcut-neu.png",
  shortcutSearch: "/icons/shortcut-suche.png",
} as const;

/** Bildschirmfotos für den Installationsdialog (Demo-Praxis, keine echten Patientendaten) */
export const PWA_SCREENSHOTS = {
  narrow: { src: "/screenshots/app-kalender-narrow.png", sizes: "780x1688" },
  wide: { src: "/screenshots/app-kalender-wide.png", sizes: "1280x800" },
} as const;

/**
 * Apple-Web-App-Metadaten. „default“: Inhalt beginnt unter der Statusleiste, iOS färbt sie (ab iOS 15) nach
 * theme-color hell bzw. dunkel ein – „black-translucent“ hätte immer weiße Schrift, die auf der hellen Kopfzeile
 * unlesbar wäre. Startbilder nur auf den App-Seiten (Login, Praxis), nicht auf jeder Website-Seite.
 */
export function appleWebApp(withStartupImages: boolean): NonNullable<Metadata["appleWebApp"]> {
  return {
    capable: true,
    title: APP_NAME,
    statusBarStyle: "default",
    ...(withStartupImages ? { startupImage: startupImages().map((s) => ({ url: s.url, media: s.media })) } : {}),
  };
}

/**
 * Metadaten der App-Layouts ((auth), (app)): Apple-Angaben mit Startbildern. Next.js schreibt für `capable` nur noch
 * „mobile-web-app-capable“; ältere iOS-Versionen werten für Vollbild und Startbilder aber nur
 * „apple-mobile-web-app-capable“ aus – deshalb zusätzlich gesetzt.
 */
export function appLayoutMetadata(): Pick<Metadata, "appleWebApp" | "other"> {
  return { appleWebApp: appleWebApp(true), other: { "apple-mobile-web-app-capable": "yes" } };
}

/**
 * Für Seiten, die Patient:innen bzw. Besucher:innen einer Praxis-Website sehen (/p, /portal, /buchen, /anamnese):
 * kein Verweis auf das Manifest der Praxis-App und keine Apple-Web-App-Angaben – dort soll niemand „PodoHero“
 * (Start auf /heute, Login) auf den Home-Bildschirm legen. Ein eigenes Portal-Manifest gibt es bewusst nicht.
 */
export const NOT_INSTALLABLE: Pick<Metadata, "manifest" | "appleWebApp"> = { manifest: null, appleWebApp: null };
