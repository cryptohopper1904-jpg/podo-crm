import { describe, expect, it } from "vitest";
import { detectPlatform, isIosOtherBrowser } from "./platform";

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const IPAD_DESKTOP_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
const PIXEL = "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36";
const CHROME_IOS = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0 Mobile/15E148 Safari/604.1";

describe("Installationshilfe: Plattform", () => {
  it("iPhone und iPad (auch iPadOS mit Desktop-Kennung) → iOS-Anleitung", () => {
    expect(detectPlatform(IPHONE, 5)).toBe("ios");
    expect(detectPlatform(IPAD_DESKTOP_UA, 5)).toBe("ios");
    expect(detectPlatform(IPAD_DESKTOP_UA, 0)).toBe("desktop"); // echter Mac
  });
  it("Android und Desktop", () => {
    expect(detectPlatform(PIXEL, 5)).toBe("android");
    expect(detectPlatform("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0")).toBe("desktop");
  });
  it("andere Browser auf iOS werden erkannt", () => {
    expect(isIosOtherBrowser(CHROME_IOS)).toBe(true);
    expect(isIosOtherBrowser(IPHONE)).toBe(false);
  });
});
