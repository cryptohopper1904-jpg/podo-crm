/**
 * KI-Antwortvorschläge (Posteingang, Bewertungen) sind im Nur-Lesen-Modus gesperrt (AVV § 10 Nr. 2: nach Vertragsende nur
 * Speicherung, Anzeige, Export und Löschung – keine Übermittlung an einen KI-Dienst).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { effectiveCan } from "@/lib/auth/access";

const src = (f: string) => readFileSync(path.join(process.cwd(), f), "utf8");

describe("KI-Vorschläge im Nur-Lesen-Modus", () => {
  it("messages.write ist bei schreibenden Anfragen im Nur-Lesen-Modus nicht erlaubt", () => {
    expect(effectiveCan({ role: "owner", readOnly: true, mutating: true, support: null }, "messages.write")).toBe(false);
    expect(effectiveCan({ role: "owner", readOnly: false, mutating: true, support: null }, "messages.write")).toBe(true);
  });

  for (const [file, fn] of [
    ["src/app/(app)/posteingang/actions.ts", "suggestReplyAction"],
    ["src/app/(app)/bewertungen/actions.ts", "suggestReviewReplyAction"],
  ] as const) {
    it(`${fn} prüft messages.write ohne allowReadOnly`, () => {
      const body = src(file).split(`export async function ${fn}(`)[1]?.split("\nexport ")[0] ?? "";
      expect(body).toMatch(/requireAuth\("messages\.write"\)/);
      expect(body).not.toMatch(/allowReadOnly/);
    });
  }
});
