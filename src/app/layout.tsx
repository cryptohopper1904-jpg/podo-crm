import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "PodoHero", template: "%s · PodoHero" },
  description: "Praxis- und Kundensystem für Podologie",
  applicationName: "PodoHero",
  icons: {
    icon: { url: "/icons/icon.svg", type: "image/svg+xml" },
    apple: { url: "/icons/apple-touch-icon.png", sizes: "180x180" },
  },
  appleWebApp: { capable: true, title: "PodoHero", statusBarStyle: "default" },
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f4f9f8" },
    { media: "(prefers-color-scheme: dark)", color: "#0d1b1e" },
  ],
};

/** Setzt das Theme vor dem ersten Paint (kein Aufblitzen). Gespeichert in localStorage, sonst Systemeinstellung. */
const themeScript = `(function(){try{var t=localStorage.getItem('podo-theme');if(t!=='light'&&t!=='dark'){t=matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'}document.documentElement.dataset.theme=t}catch(e){document.documentElement.dataset.theme='light'}})()`;

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
