import { existsSync } from "node:fs";
import { chromium, defineConfig, devices } from "@playwright/test";

/**
 * End-to-End-Tests (Playwright) gegen einen laufenden Produktions-Build (`next start`).
 * Voraussetzung: migrierte + mit scripts/seed-demo.ts befüllte Datenbank (DATABASE_URL).
 *
 *   pnpm build && pnpm e2e            # startet `next start` auf E2E_PORT (Standard 3100)
 *   E2E_BASE_URL=http://localhost:3000 pnpm e2e   # gegen einen bereits laufenden Server
 *
 * Browser: CI installiert Chromium (`npx playwright install --with-deps chromium`). Fehlt der zur
 * Playwright-Version passende Browser (z. B. in vorkonfigurierten Umgebungen), wird – falls vorhanden –
 * /opt/pw-browsers/chromium bzw. E2E_CHROMIUM verwendet.
 */
const port = Number(process.env.E2E_PORT ?? 3100);
const baseURL = process.env.E2E_BASE_URL ?? `http://localhost:${port}`;

function fallbackChromium(): string | undefined {
  let bundled = "";
  try {
    bundled = chromium.executablePath();
  } catch {
    /* kein gebündelter Browser */
  }
  if (bundled && existsSync(bundled)) return undefined;
  const alt = process.env.E2E_CHROMIUM ?? "/opt/pw-browsers/chromium";
  return existsSync(alt) ? alt : undefined;
}

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL,
    locale: "de-DE",
    timezoneId: "Europe/Berlin",
    trace: "off",
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    launchOptions: { executablePath: fallbackChromium() },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], launchOptions: { executablePath: fallbackChromium() } } }],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: `pnpm exec next start -p ${port}`,
        url: `${baseURL}/api/health`,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
        stdout: "pipe",
        stderr: "pipe",
      },
});
