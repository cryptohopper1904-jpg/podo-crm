import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import manifest from "@/app/manifest";
import { appleWebApp, PWA_ICONS, PWA_SCREENSHOTS } from "./app-meta";
import { APPLE_DEVICES, startupImages } from "./startup-images";

const PUBLIC = path.resolve(__dirname, "../../../public");
const file = (url: string) => path.join(PUBLIC, url.split("?")[0].replace(/^\//, ""));

/** Breite × Höhe aus dem PNG-Kopf (IHDR) */
function pngSize(url: string): string {
  const b = readFileSync(file(url));
  expect(b.subarray(1, 4).toString("latin1"), url).toBe("PNG");
  return `${b.readUInt32BE(16)}x${b.readUInt32BE(20)}`;
}

describe("Web-App-Manifest", () => {
  const m = manifest();

  it("jede referenzierte Datei (Icons, Verknüpfungen, Bildschirmfotos) existiert mit der angegebenen Größe", () => {
    const refs = [
      ...(m.icons ?? []),
      ...(m.shortcuts ?? []).flatMap((s) => s.icons ?? []),
      ...(m.screenshots ?? []),
    ];
    expect(refs.length).toBeGreaterThan(8);
    for (const r of refs) {
      expect(existsSync(file(r.src)), r.src).toBe(true);
      if (r.type === "image/png" && r.sizes) expect(pngSize(r.src), r.src).toBe(r.sizes);
    }
  });

  it("installierbar: Name, Start, Standalone, 192/512-Icons und ein maskierbares Icon", () => {
    expect(m.name).toBe("PodoHero");
    expect(m.id).toBe("/heute");
    expect(m.start_url).toBe("/heute");
    expect(m.scope).toBe("/");
    expect(m.display).toBe("standalone");
    expect(m.lang).toBe("de");
    const png = (m.icons ?? []).filter((i) => i.type === "image/png");
    expect(png.some((i) => i.sizes === "192x192" && i.purpose === "any")).toBe(true);
    expect(png.some((i) => i.sizes === "512x512" && i.purpose === "any")).toBe(true);
    expect(png.some((i) => i.sizes === "512x512" && i.purpose === "maskable")).toBe(true);
  });

  it("Verknüpfungen zeigen auf Praxis-Seiten innerhalb des Scopes", () => {
    const urls = (m.shortcuts ?? []).map((s) => s.url);
    expect(urls).toEqual(["/heute", "/kalender", "/kalender/neu", "/kunden?suche=1"]);
    for (const u of urls) expect(u.startsWith(m.scope ?? "/")).toBe(true);
  });

  it("Bildschirmfotos: schmal + breit, Seitenverhältnis ≤ 2,3 (Chrome-Vorgabe)", () => {
    const shots = m.screenshots ?? [];
    expect(shots.map((s) => s.form_factor).sort()).toEqual(["narrow", "wide"]);
    for (const s of shots) {
      const [w, h] = (s.sizes ?? "").split("x").map(Number);
      expect(Math.max(w, h) / Math.min(w, h)).toBeLessThanOrEqual(2.3);
    }
    expect(PWA_SCREENSHOTS.narrow.src).toMatch(/^\/screenshots\//);
  });
});

describe("Icons und iOS-Startbildschirme", () => {
  it("alle Icon-Dateien aus PWA_ICONS existieren", () => {
    for (const url of Object.values(PWA_ICONS)) expect(existsSync(file(url)), url).toBe(true);
    expect(pngSize(PWA_ICONS.apple)).toBe("180x180");
    expect(existsSync(path.resolve(__dirname, "../../app/favicon.ico"))).toBe(true);
  });

  it("je Gerät hoch/quer × hell/dunkel ein Startbild in exakt passender Größe", () => {
    const imgs = startupImages();
    expect(imgs).toHaveLength(APPLE_DEVICES.length * 4);
    expect(new Set(imgs.map((i) => i.media)).size).toBe(imgs.length);
    for (const i of imgs) {
      expect(pngSize(i.url), i.url).toBe(`${i.px.width}x${i.px.height}`);
      expect(i.media).toContain(`prefers-color-scheme: ${i.theme}`);
    }
    const ipadLandscape = imgs.find((i) => i.media.includes("device-width: 834px") && i.media.includes("device-height: 1194px") && i.media.includes("landscape") && i.theme === "light");
    expect(ipadLandscape?.url).toBe("/splash/apple-splash-2388x1668.png");
  });

  it("Apple-Metadaten: Startbilder nur auf Wunsch, Statusleiste „default“ (lesbar in Hell und Dunkel)", () => {
    const withImages = appleWebApp(true);
    const plain = appleWebApp(false);
    expect(typeof withImages === "object" && withImages.startupImage).toHaveLength(startupImages().length);
    expect(typeof plain === "object" && "startupImage" in plain).toBe(false);
    expect(typeof plain === "object" && plain.statusBarStyle).toBe("default");
  });
});
