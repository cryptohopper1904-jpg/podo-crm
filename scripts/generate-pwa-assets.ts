/**
 * Einmaliges Skript: erzeugt aus public/icons/icon.svg alle PNG-Icons, die Favicons (src/app/favicon.ico) und die
 * iOS-Startbildschirme (public/splash/). Die Ergebnisse werden eingecheckt; erneut ausführen nur, wenn sich das
 * Logo, die Farben (src/lib/pwa/app-meta.ts) oder die Geräteliste (src/lib/pwa/startup-images.ts) ändern.
 *
 *   pnpm exec tsx scripts/generate-pwa-assets.ts
 *
 * sharp ist keine direkte Abhängigkeit – es kommt mit Next.js (Bildoptimierung) und wird von dort geladen.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CalendarDays, CalendarPlus, Home, Search, type LucideIcon } from "lucide-react";
import { PWA_COLORS, PWA_ICONS } from "../src/lib/pwa/app-meta";
import { startupImages } from "../src/lib/pwa/startup-images";

/** benötigter Ausschnitt der sharp-API (Typen sind nicht installiert) */
type SharpImage = { png(o: Record<string, unknown>): SharpImage; toFile(file: string): Promise<unknown> };
const sharp = createRequire(require.resolve("next/package.json"))("sharp") as (input: Buffer, o?: { density?: number }) => SharpImage;

const root = path.resolve(__dirname, "..");
const pub = (p: string) => path.join(root, "public", p.replace(/^\//, ""));

/** Logo ohne <style>/Media-Query, mit festen Farben (librsvg kennt prefers-color-scheme nicht) */
function logoSvg(colors: { primary: string; accent: string }): string {
  const src = readFileSync(pub(PWA_ICONS.svg), "utf8");
  const inner = src
    .replace(/<svg[^>]*>/, "")
    .replace(/<\/svg>\s*$/, "")
    .replace(/<style>[\s\S]*?<\/style>/, "")
    .replace(/class="p"/g, `fill="${colors.primary}"`)
    .replace(/class="a"/g, `fill="${colors.accent}"`)
    .replace(/class="f"/g, `fill="#000" fill-opacity=".14"`);
  return inner;
}

/** Quadratisches Bild: Logo mittig mit Anteil `scale` an der Kantenlänge, optional mit Hintergrund */
function squareSvg(size: number, scale: number, bg: string | null, colors = PWA_COLORS.logoLight): string {
  const logo = size * scale;
  const off = (size - logo) / 2;
  // viewBox des Logos: -2 -1 104 104
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${
    bg ? `<rect width="100%" height="100%" fill="${bg}"/>` : ""
  }<svg x="${off}" y="${off}" width="${logo}" height="${logo}" viewBox="-2 -1 104 104">${logoSvg(colors)}</svg></svg>`;
}

async function png(svg: string, file: string, opts: { palette?: boolean } = {}) {
  mkdirSync(path.dirname(file), { recursive: true });
  const img = sharp(Buffer.from(svg), { density: 72 });
  await (opts.palette ? img.png({ palette: true, quality: 90, compressionLevel: 9 }) : img.png({ compressionLevel: 9 })).toFile(file);
  console.log("✓", path.relative(root, file));
}

/** ICO-Datei mit eingebetteten PNGs (von allen aktuellen Browsern unterstützt) */
function ico(pngs: { size: number; data: Buffer }[]): Buffer {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  const dir = Buffer.alloc(16 * pngs.length);
  let offset = 6 + dir.length;
  pngs.forEach((p, i) => {
    const o = i * 16;
    dir.writeUInt8(p.size >= 256 ? 0 : p.size, o);
    dir.writeUInt8(p.size >= 256 ? 0 : p.size, o + 1);
    dir.writeUInt8(0, o + 2);
    dir.writeUInt8(0, o + 3);
    dir.writeUInt16LE(1, o + 4);
    dir.writeUInt16LE(32, o + 6);
    dir.writeUInt32LE(p.data.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += p.data.length;
  });
  return Buffer.concat([header, dir, ...pngs.map((p) => p.data)]);
}

/** Verknüpfungs-Icon (Android-Langdruck-Menü): weißes Symbol auf Petrol-Kreis */
function shortcutSvg(Icon: LucideIcon): string {
  const glyph = renderToStaticMarkup(createElement(Icon, { size: 52, color: "#ffffff", strokeWidth: 2.2, x: 22, y: 22 }));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96"><circle cx="48" cy="48" r="48" fill="${PWA_COLORS.logoLight.primary}"/>${glyph}</svg>`;
}

async function main() {
  const L = PWA_COLORS.logoLight;
  // „any“: transparenter Hintergrund, wenig Rand
  await png(squareSvg(192, 0.92, null), pub(PWA_ICONS.any192));
  await png(squareSvg(512, 0.92, null), pub(PWA_ICONS.any512));
  // „maskable“: voller Hintergrund, Logo innerhalb der Safe-Zone (Kreis mit 80 % Durchmesser → Quadrat ≤ 56 %)
  await png(squareSvg(192, 0.56, PWA_COLORS.backgroundLight), pub(PWA_ICONS.maskable192));
  await png(squareSvg(512, 0.56, PWA_COLORS.backgroundLight), pub(PWA_ICONS.maskable512));
  // iOS füllt Transparenz schwarz → deckender Hintergrund; iOS rundet die Ecken selbst
  await png(squareSvg(180, 0.72, PWA_COLORS.themeLight), pub(PWA_ICONS.apple));
  // Favicons
  const fav: { size: number; data: Buffer }[] = [];
  for (const [size, file] of [[16, PWA_ICONS.favicon16], [32, PWA_ICONS.favicon32], [48, PWA_ICONS.favicon48]] as const) {
    await png(squareSvg(size, 1, null), pub(file));
    fav.push({ size, data: readFileSync(pub(file)) });
  }
  writeFileSync(path.join(root, "src/app/favicon.ico"), ico(fav));
  console.log("✓ src/app/favicon.ico");
  // Verknüpfungen
  const shortcuts: [LucideIcon, string][] = [
    [Home, PWA_ICONS.shortcutToday],
    [CalendarDays, PWA_ICONS.shortcutCalendar],
    [CalendarPlus, PWA_ICONS.shortcutNew],
    [Search, PWA_ICONS.shortcutSearch],
  ];
  for (const [Icon, file] of shortcuts) await png(shortcutSvg(Icon), pub(file));
  // iOS-Startbildschirme: Logo mittig auf dem Seitenhintergrund
  for (const s of startupImages()) {
    const { width: w, height: h } = s.px;
    const dark = s.theme === "dark";
    const logo = Math.round(Math.min(w, h) * 0.22);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="100%" height="100%" fill="${
      dark ? PWA_COLORS.backgroundDark : PWA_COLORS.backgroundLight
    }"/><svg x="${(w - logo) / 2}" y="${(h - logo) / 2}" width="${logo}" height="${logo}" viewBox="-2 -1 104 104">${logoSvg(dark ? PWA_COLORS.logoDark : L)}</svg></svg>`;
    await png(svg, pub(s.url), { palette: true });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
