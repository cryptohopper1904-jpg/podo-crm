import { randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { unsubscribeToken, unsubscribeUrl, verifyUnsubscribeToken } from "./unsubscribe-token";

const key = randomBytes(32);

describe("Abmelde-Token", () => {
  it("signieren und prüfen", () => {
    const id = randomUUID();
    const t = unsubscribeToken(id, key);
    expect(verifyUnsubscribeToken(t, key)).toBe(id);
    expect(t).not.toContain(id);
    expect(t).toMatch(/^[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{22}$/);
  });

  it("manipuliert, fremder Schlüssel oder Unsinn → null", () => {
    const id = randomUUID();
    const t = unsubscribeToken(id, key);
    const [a, b] = t.split(".");
    const other = unsubscribeToken(randomUUID(), key).split(".")[0];
    expect(verifyUnsubscribeToken(`${other}.${b}`, key)).toBeNull();
    expect(verifyUnsubscribeToken(`${a}.${b.slice(0, -1)}${b.at(-1) === "A" ? "B" : "A"}`, key)).toBeNull();
    expect(verifyUnsubscribeToken(t, randomBytes(32))).toBeNull();
    for (const bad of ["", "x", `${a}`, `${a}.${b}.x`, "../../etc", `${id}.${b}`]) expect(verifyUnsubscribeToken(bad, key)).toBeNull();
  });

  it("URL ohne Kontaktdaten", () => {
    const id = randomUUID();
    expect(unsubscribeUrl(id, "https://podo.example/", key)).toBe(`https://podo.example/abmelden/${unsubscribeToken(id, key)}`);
    expect(() => unsubscribeToken("keine-uuid", key)).toThrow();
  });
});
