/**
 * Erklärvideo auf der Startseite (src/app/(public)/_content/explainer-video-player.tsx) – gegen den Produktions-Build:
 *  - vor dem Klick keine Anfrage auf .mp4/.vtt und kein <video> im DOM (Datenschutzerklärung: „lädt erst beim Klick“),
 *  - nach dem Klick <video> mit Untertitel-Spur (ohne default), 16:9 am Desktop, 9:16 unter 640 px, ohne Layout-Sprung,
 *  - Hinweistext unter dem Video wörtlich, VideoObject-JSON-LD, Dateien vom eigenen Server (Range-Anfragen, Cache),
 *  - Datenschutzerklärung enthält den Abschnitt „Erklärvideo auf der Startseite“.
 */
import { expect, test, type Page } from "@playwright/test";

const NOTE =
  "Lädt erst beim Klick auf Abspielen · direkt von unserem Server, ohne eingebundene Fremddienste und ohne Tracking · Untertitel verfügbar · Sprecherstimme KI-generiert · Demo-Daten, Abläufe gekürzt · Kassen-TSE in Vorbereitung";
const PLAY = "Erklärvideo abspielen (2:36, mit Untertiteln)";

/** Alle Anfragen auf Video-/Untertiteldateien mitschneiden (auch solche, die der Browser abbricht) */
function trackMedia(page: Page) {
  const media: string[] = [];
  page.on("request", (r) => {
    if (/\.(mp4|vtt)$/i.test(new URL(r.url()).pathname)) media.push(r.url());
  });
  return media;
}

/** Startseite laden und bis ans Seitenende scrollen (lazy Bilder, späte Anfragen) – danach darf kein Video geladen sein */
async function openHome(page: Page) {
  await page.goto("/");
  const button = page.getByRole("button", { name: PLAY });
  await button.scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForLoadState("networkidle");
  await button.scrollIntoViewIfNeeded();
  return button;
}

test("Desktop: Video lädt erst beim Klick, danach 16:9 mit Untertitel-Spur", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const media = trackMedia(page);
  const button = await openHome(page);

  await expect(button).toBeVisible();
  await expect(page.locator("video")).toHaveCount(0);
  expect(media).toEqual([]);
  await expect(page.getByText(NOTE, { exact: true })).toBeVisible();

  // VideoObject-JSON-LD mit den Pflichtangaben, Dateien vom eigenen Origin
  const ld = await page.locator('script[type="application/ld+json"]').allTextContents();
  const video = ld.map((t) => JSON.parse(t)).find((d) => d["@type"] === "VideoObject");
  expect(video).toMatchObject({ uploadDate: "2026-11-16T00:00:00+01:00", duration: "PT2M36S", inLanguage: "de" });
  expect(video.contentUrl).toMatch(/\/video\/podohero-erklaervideo-v2\.mp4$/);
  expect(video.thumbnailUrl[0]).toMatch(/\/video\/podohero-erklaervideo-poster-v2\.jpg$/);

  // Tastatur: Fokus auf den Knopf, Enter startet
  await button.focus();
  const before = await button.boundingBox();
  await page.keyboard.press("Enter");

  const player = page.locator("video");
  await expect(player).toHaveCount(1);
  await expect(player.locator("source")).toHaveAttribute("src", "/video/podohero-erklaervideo-v2.mp4");
  const track = player.locator("track");
  await expect(track).toHaveCount(1);
  await expect(track).toHaveAttribute("kind", "subtitles");
  await expect(track).toHaveAttribute("srclang", "de");
  await expect(track).toHaveAttribute("label", "Deutsch");
  await expect(track).not.toHaveAttribute("default");
  await expect(track).toHaveAttribute("src", "/video/podohero-erklaervideo-v2.de.vtt");
  await expect(player).toBeFocused();
  await expect(page.getByRole("button", { name: PLAY })).toHaveCount(0);

  // gleiche Box vor und nach dem Klick (kein Layout-Sprung)
  const after = await player.locator("xpath=..").boundingBox();
  expect(Math.round(after!.height)).toBe(Math.round(before!.height));
  expect(Math.round(after!.width)).toBe(Math.round(before!.width));

  // Der Browser fordert die Datei erst jetzt an (nur, wenn er H.264 abspielen kann – sonst überspringt er die Quelle)
  if (await page.evaluate(() => document.createElement("video").canPlayType("video/mp4") !== "")) {
    await expect.poll(() => media.some((u) => u.endsWith("/video/podohero-erklaervideo-v2.mp4"))).toBe(true);
  }
  expect(media.every((u) => new URL(u).origin === new URL(page.url()).origin)).toBe(true);
});

test("Smartphone: 9:16-Poster und 9:16-Video in derselben Box", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
  const page = await context.newPage();
  try {
    const media = trackMedia(page);
    const button = await openHome(page);
    await expect(page.locator("video")).toHaveCount(0);
    expect(media).toEqual([]);
    await expect(page.getByText(NOTE, { exact: true })).toBeVisible();

    const before = await button.boundingBox();
    expect(before!.height).toBeGreaterThan(before!.width); // Hochformat
    expect(before!.x + before!.width).toBeLessThanOrEqual(390); // kein Überlauf

    await button.tap();
    const player = page.locator("video");
    await expect(player.locator("source")).toHaveAttribute("src", "/video/podohero-erklaervideo-9x16-v2.mp4");
    await expect(player.locator("track")).toHaveAttribute("kind", "subtitles");
    const after = await player.locator("xpath=..").boundingBox();
    expect(Math.round(after!.height)).toBe(Math.round(before!.height));
    expect(Math.round(after!.width)).toBe(Math.round(before!.width));
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  } finally {
    await context.close();
  }
});

test("Videodateien: ohne Anmeldung, Teilabrufe (Range), lange cachebar", async ({ request }) => {
  const mp4 = await request.get("/video/podohero-erklaervideo-v2.mp4", { headers: { Range: "bytes=0-1023" }, maxRedirects: 0 });
  expect(mp4.status()).toBe(206);
  expect(mp4.headers()["content-type"]).toMatch(/^video\/mp4/);
  expect(mp4.headers()["cache-control"]).toMatch(/max-age=31536000/);
  expect((await mp4.body()).length).toBe(1024);
  const vtt = await request.get("/video/podohero-erklaervideo-v2.de.vtt", { maxRedirects: 0 });
  expect(vtt.status()).toBe(200);
  expect(vtt.headers()["content-type"]).toMatch(/^text\/vtt/);
  expect(await vtt.text()).toMatch(/^WEBVTT/);
  const tall = await request.head("/video/podohero-erklaervideo-9x16-v2.mp4", { maxRedirects: 0 });
  expect(tall.status()).toBe(200);
  expect(vtt.headers()["cache-control"]).toMatch(/immutable/);
  // Nicht vorhandene Datei: kein Jahres-Cache für die 404 (sonst bliebe eine zu früh abgerufene neue Fassung hängen)
  const missing = await request.get("/video/gibtsnicht-v9.mp4", { maxRedirects: 0 });
  expect(missing.status()).toBe(404);
  expect(missing.headers()["cache-control"] ?? "").not.toMatch(/immutable/);
});

test("Datenschutzerklärung: Abschnitt „Erklärvideo auf der Startseite“", async ({ page }) => {
  await page.goto("/datenschutz");
  await expect(page.getByRole("heading", { level: 3, name: "Erklärvideo auf der Startseite" })).toBeVisible();
  await expect(page.getByText("Videodatei und Untertitel ruft er erst ab, wenn Sie auf „Abspielen“ klicken.", { exact: false })).toBeVisible();
});
