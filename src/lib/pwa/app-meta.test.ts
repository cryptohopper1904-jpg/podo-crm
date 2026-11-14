import { describe, expect, it } from "vitest";
import { trademarkNotice } from "./app-meta";

describe("trademarkNotice (Markenhinweis unter der Installationsanleitung)", () => {
  it("ohne Google Play (Einstellungen → App): alle Marken der Anleitung, Google Play nicht", () => {
    expect(trademarkNotice()).toBe(
      "iPhone, iPad, Mac, Safari und App Store sind Marken der Apple Inc.; Android und Chrome sind Marken der Google LLC; Microsoft Edge und Windows sind Marken der Microsoft Corporation; Samsung Internet ist eine Marke der Samsung Electronics Co., Ltd.; Firefox ist eine Marke der Mozilla Foundation. PodoHero steht in keiner Verbindung zu diesen Unternehmen.",
    );
  });

  it("mit Google Play (öffentliche Seite /app)", () => {
    const t = trademarkNotice({ googlePlay: true });
    expect(t).toContain("Android, Chrome und Google Play sind Marken der Google LLC;");
    expect(t).toContain("Firefox ist eine Marke der Mozilla Foundation.");
    expect(t.endsWith("PodoHero steht in keiner Verbindung zu diesen Unternehmen.")).toBe(true);
  });
});
