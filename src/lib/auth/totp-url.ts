/** Client-sicher (ohne node:crypto): otpauth-URL für Authenticator-Apps. */
export function otpauthUrl(secret: string, account: string, issuer = "PodoCRM"): string {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&period=30&digits=6`;
}
