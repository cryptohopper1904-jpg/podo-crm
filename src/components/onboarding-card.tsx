import Link from "next/link";
import { eq } from "drizzle-orm";
import { Card, CardTitle, LinkButton } from "@/components/ui";
import { db } from "@/db";
import { organizations } from "@/db/schema";
import type { AuthContext } from "@/lib/auth/session";
import { currentStep, ONBOARDING_STEPS, onboardingPercent, type OnboardingProgress } from "@/lib/onboarding";

/** Kompakte Checkliste auf /heute, bis das Onboarding abgeschlossen ist (nur Inhaber:in). */
export async function OnboardingCard({ auth }: { auth: AuthContext }) {
  if (auth.role !== "owner" || auth.support) return null;
  const [o] = await db.select({ onboarding: organizations.onboarding }).from(organizations).where(eq(organizations.id, auth.organization.id));
  const p = (o?.onboarding ?? {}) as OnboardingProgress;
  if (p.done) return null;
  const next = currentStep(p);
  return (
    <Card className="mb-6">
      <CardTitle action={<span className="text-sm font-semibold text-muted">{onboardingPercent(p)} %</span>}>Praxis einrichten</CardTitle>
      <ul className="mb-4 grid gap-1.5 text-sm sm:grid-cols-2 lg:grid-cols-5">
        {ONBOARDING_STEPS.filter((s) => s.key !== "done").map((s) => (
          <li key={s.key}>
            <Link href={`/willkommen?schritt=${s.slug}`} className={p[s.key] ? "text-muted line-through" : "font-semibold"}>
              <span aria-hidden>{p[s.key] ? "✓ " : "○ "}</span>{s.label}
            </Link>
          </li>
        ))}
      </ul>
      <LinkButton href={`/willkommen?schritt=${next.slug}`}>Weiter: {next.label}</LinkButton>
    </Card>
  );
}
