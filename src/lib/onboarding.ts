/** Onboarding-Assistent (/willkommen): Schritte und Fortschritt (organizations.onboarding). */
export const ONBOARDING_STEPS = [
  { key: "practice", slug: "praxis", label: "Praxisdaten" },
  { key: "services", slug: "leistungen", label: "Leistungen" },
  { key: "team", slug: "team", label: "Team einladen" },
  { key: "import", slug: "import", label: "Daten importieren" },
  { key: "integrations", slug: "schnittstellen", label: "Schnittstellen" },
  { key: "done", slug: "fertig", label: "Fertig" },
] as const;

export type OnboardingKey = (typeof ONBOARDING_STEPS)[number]["key"];
export type OnboardingProgress = Partial<Record<OnboardingKey, boolean>>;

export const isOnboardingKey = (v: unknown): v is OnboardingKey => ONBOARDING_STEPS.some((s) => s.key === v);

export function stepBySlug(slug: unknown) {
  return ONBOARDING_STEPS.find((s) => s.slug === slug) ?? null;
}

export function nextStep(key: OnboardingKey) {
  const i = ONBOARDING_STEPS.findIndex((s) => s.key === key);
  return ONBOARDING_STEPS[Math.min(i + 1, ONBOARDING_STEPS.length - 1)];
}

/** Erster noch offener Schritt (ohne „Fertig“), sonst „Fertig“ */
export function currentStep(p: OnboardingProgress) {
  return ONBOARDING_STEPS.find((s) => s.key !== "done" && !p[s.key]) ?? ONBOARDING_STEPS[ONBOARDING_STEPS.length - 1];
}

export function onboardingPercent(p: OnboardingProgress): number {
  const steps = ONBOARDING_STEPS.filter((s) => s.key !== "done");
  return Math.round((steps.filter((s) => p[s.key]).length / steps.length) * 100);
}
