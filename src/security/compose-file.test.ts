import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * docker compose bricht bei doppelten Schlüsseln ab („mapping key … already defined“) – und damit jedes
 * Update auf dem Server. Zwei parallel entstandene Zweige können denselben Eintrag (z. B. eine
 * Umgebungsvariable) hinzufügen, ohne dass git einen Konflikt meldet. Dieser Test findet das vor dem Merge.
 */
function duplicateKeys(yaml: string): string[] {
  const dups: string[] = [];
  // Stapel von Ebenen: Einrückung + bereits gesehene Schlüssel
  const stack: { indent: number; keys: Set<string> }[] = [{ indent: -1, keys: new Set() }];
  yaml.split("\n").forEach((line, i) => {
    if (/^\s*(#|$)/.test(line)) return;
    const m = /^(\s*)(?:- )?([A-Za-z0-9_.-]+):(?:\s|$)/.exec(line);
    if (!m) return;
    const indent = m[1].length + (line.trimStart().startsWith("- ") ? 2 : 0);
    while (stack.length > 1 && stack[stack.length - 1].indent > indent) stack.pop();
    let top = stack[stack.length - 1];
    if (top.indent < indent) {
      top = { indent, keys: new Set() };
      stack.push(top);
    }
    if (line.trimStart().startsWith("- ")) top.keys = new Set(); // neues Listenelement
    if (top.keys.has(m[2])) dups.push(`Zeile ${i + 1}: ${m[2]}`);
    top.keys.add(m[2]);
  });
  return dups;
}

describe("deploy/docker-compose.yml", () => {
  it("enthält keine doppelten Schlüssel", () => {
    const file = readFileSync(path.join(__dirname, "../../deploy/docker-compose.yml"), "utf8");
    expect(duplicateKeys(file)).toEqual([]);
  });

  it("Prüfung erkennt doppelte Schlüssel", () => {
    expect(duplicateKeys("services:\n  app:\n    environment:\n      A:\n      B:\n      A:\n")).toEqual(["Zeile 6: A"]);
    expect(duplicateKeys("a:\n  x: 1\nb:\n  x: 2\n")).toEqual([]);
  });
});
