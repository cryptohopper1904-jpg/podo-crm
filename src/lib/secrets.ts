import { decrypt, encrypt } from "./crypto";

/** Verschlüsselt Geheimnisse (TOTP-Secrets, API-Keys) für die Ablage in der Datenbank. */
export const encryptSecret = (plain: string, aad?: string) => encrypt(plain, { aad });
export const decryptSecret = (payload: string, aad?: string) => decrypt(payload, { aad });
