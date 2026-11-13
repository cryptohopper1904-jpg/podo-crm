/**
 * iOS-Startbildschirme (apple-touch-startup-image) für gängige iPhones/iPads, hoch und quer, hell und dunkel.
 * iOS zeigt sie nur, wenn Bildgröße und Media-Query exakt zum Gerät passen; sonst erscheint kurz eine leere Fläche.
 * Die Dateien erzeugt `pnpm exec tsx scripts/generate-pwa-assets.ts` (public/splash/…), der Test
 * src/lib/pwa/pwa-assets.test.ts prüft, dass jede hier referenzierte Datei existiert.
 * Keine Server-Importe (auch in Metadaten und Skripten nutzbar).
 */

/** CSS-Pixel im Hochformat und Pixeldichte */
export type AppleDevice = { name: string; width: number; height: number; dpr: 2 | 3 };

export const APPLE_DEVICES: AppleDevice[] = [
  { name: "iPhone 16 Pro Max", width: 440, height: 956, dpr: 3 },
  { name: "iPhone 14 Pro Max / 15 Plus / 15 Pro Max / 16 Plus", width: 430, height: 932, dpr: 3 },
  { name: "iPhone 16 Pro", width: 402, height: 874, dpr: 3 },
  { name: "iPhone 14 Pro / 15 / 15 Pro / 16", width: 393, height: 852, dpr: 3 },
  { name: "iPhone 12 / 13 / 14 / 16e", width: 390, height: 844, dpr: 3 },
  { name: "iPhone X / XS / 11 Pro / 12 mini / 13 mini", width: 375, height: 812, dpr: 3 },
  { name: "iPhone XR / 11", width: 414, height: 896, dpr: 2 },
  { name: "iPhone 8 / SE", width: 375, height: 667, dpr: 2 },
  { name: "iPad Pro 13 (M4)", width: 1032, height: 1376, dpr: 2 },
  { name: "iPad Pro 12,9", width: 1024, height: 1366, dpr: 2 },
  { name: "iPad Pro 11 (M4)", width: 834, height: 1210, dpr: 2 },
  { name: "iPad Pro 11 / iPad Air 11", width: 834, height: 1194, dpr: 2 },
  { name: "iPad Air 10,9 / iPad 10", width: 820, height: 1180, dpr: 2 },
  { name: "iPad 10,2", width: 810, height: 1080, dpr: 2 },
  { name: "iPad mini 6/7", width: 744, height: 1133, dpr: 2 },
  { name: "iPad 9,7 / iPad mini 5", width: 768, height: 1024, dpr: 2 },
];

export type StartupImage = {
  url: string;
  media: string;
  /** Bildgröße in Gerätepixeln */
  px: { width: number; height: number };
  theme: "light" | "dark";
};

/** Alle Startbilder (je Gerät hoch/quer × hell/dunkel) */
export function startupImages(devices: AppleDevice[] = APPLE_DEVICES): StartupImage[] {
  const out: StartupImage[] = [];
  for (const d of devices) {
    for (const orientation of ["portrait", "landscape"] as const) {
      for (const theme of ["light", "dark"] as const) {
        const w = (orientation === "portrait" ? d.width : d.height) * d.dpr;
        const h = (orientation === "portrait" ? d.height : d.width) * d.dpr;
        out.push({
          url: `/splash/apple-splash-${w}x${h}${theme === "dark" ? "-dark" : ""}.png`,
          // device-width/-height sind bei iOS immer die Hochformat-Maße; die Ausrichtung entscheidet orientation
          media:
            `screen and (device-width: ${d.width}px) and (device-height: ${d.height}px) and (-webkit-device-pixel-ratio: ${d.dpr}) ` +
            `and (orientation: ${orientation}) and (prefers-color-scheme: ${theme})`,
          px: { width: w, height: h },
          theme,
        });
      }
    }
  }
  return out;
}
