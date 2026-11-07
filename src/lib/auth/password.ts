import { hash, verify } from "@node-rs/argon2";

// OWASP-Empfehlung für Argon2id
const OPTIONS = { memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

export function hashPassword(password: string): Promise<string> {
  return hash(password, OPTIONS);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

/** Mindestanforderung: 12 Zeichen. Länge schlägt Sonderzeichen-Regeln. */
export function passwordProblem(password: string): string | null {
  if (password.length < 12) return "Das Passwort muss mindestens 12 Zeichen lang sein.";
  if (password.length > 200) return "Das Passwort ist zu lang.";
  return null;
}
