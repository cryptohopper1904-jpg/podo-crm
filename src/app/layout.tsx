import type { Metadata, Viewport } from "next";
import "./globals.css";
import { appleWebApp, PWA_COLORS, PWA_ICONS } from "@/lib/pwa/app-meta";

export const metadata: Metadata = {
  title: { default: "PodoHero", template: "%s · PodoHero" },
  description: "Praxis- und Patientensystem für Podologie",
  applicationName: "PodoHero",
  icons: {
    icon: [
      { url: PWA_ICONS.svg, type: "image/svg+xml" },
      { url: PWA_ICONS.favicon32, sizes: "32x32", type: "image/png" },
      { url: PWA_ICONS.favicon16, sizes: "16x16", type: "image/png" },
    ],
    apple: { url: PWA_ICONS.apple, sizes: "180x180" },
  },
  // Startbilder nur in den App-Layouts ((auth), (app)) – siehe src/lib/pwa/app-meta.ts
  appleWebApp: appleWebApp(false),
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  // Farbe der Kopfzeile (--surface): Statusleiste der installierten App bzw. Browserleiste. Der Hell/Dunkel-Umschalter
  // überschreibt sie zur Laufzeit (themeScript), wenn die Wahl von der Systemeinstellung abweicht.
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: PWA_COLORS.themeLight },
    { media: "(prefers-color-scheme: dark)", color: PWA_COLORS.themeDark },
  ],
};

/** Setzt das Theme vor dem ersten Paint (kein Aufblitzen). Gespeichert in localStorage, sonst Systemeinstellung. */
// Übergabe-Modus: Seiten aus dem Browser-Zwischenspeicher („Zurück“, bfcache) immer neu laden – der Server prüft dann die Sperre
// theme-color: eigenes <meta> vorn im <head> (die erste passende gewinnt) folgt dem gewählten Theme (Statusleiste der App).
// beforeinstallprompt: früh merken, falls es vor dem Hydrieren kommt (src/components/pwa/install-store.ts).
const themeScript = `addEventListener('pageshow',function(e){if(e.persisted)location.reload()});addEventListener('beforeinstallprompt',function(e){e.preventDefault();window.__podoBip=e});(function(){var r=document.documentElement;try{var t=localStorage.getItem('podo-theme');if(t!=='light'&&t!=='dark'){t=matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'}r.dataset.theme=t}catch(e){r.dataset.theme='light'}try{var m=document.createElement('meta');m.name='theme-color';var s=function(){m.content=r.dataset.theme==='dark'?'${PWA_COLORS.themeDark}':'${PWA_COLORS.themeLight}'};s();document.head.insertBefore(m,document.head.firstChild);new MutationObserver(s).observe(r,{attributes:true,attributeFilter:['data-theme']})}catch(e){}})()`;

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="de" suppressHydrationWarning className="h-full antialiased">
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="min-h-full">{children}</body>
    </html>
  );
}
