import { count } from "drizzle-orm";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { db } from "@/db";
import { users } from "@/db/schema";
import { requestMeta } from "@/lib/auth/session";
import { PLANS } from "@/lib/plans";
import { normalizePromoCode, trialDaysLabel } from "@/lib/promo-codes";
import { clientKey } from "@/lib/rate-limit";
import { lookupPromoCode, promoLookupLimiter } from "@/server/promo-codes";
import { SetupForm } from "./setup-form";

export const metadata = { title: "Praxis einrichten" };

export default async function SetupPage({ searchParams }: PageProps<"/einrichtung">) {
  await connection(); // immer zur Laufzeit prüfen, nie beim Build vorberechnen
  const [{ n }] = await db.select({ n: count() }).from(users);
  if (n > 0 && process.env.ALLOW_SIGNUP !== "true") redirect("/login");
  const saas = n > 0 && process.env.ALLOW_SIGNUP === "true";
  // Aktionscode aus dem Link: Banner nur für gültige Codes; ungültige werden still ignoriert (kein Hinweis), Abrufe gedrosselt
  const sp = await searchParams;
  const raw = typeof sp.code === "string" ? normalizePromoCode(sp.code) : null;
  const offer = saas && raw && !promoLookupLimiter.limited(clientKey(await requestMeta())) ? await lookupPromoCode(raw) : null;
  return (
    <>
      <h1 className="font-display text-2xl font-semibold">{n === 0 ? "Praxis einrichten" : "Neue Praxis registrieren"}</h1>
      {offer ? (
        <p role="status" className="mt-3 rounded-xl bg-primary-soft px-4 py-3 text-sm font-semibold text-primary-soft-text">
          {trialDaysLabel(offer.trialDays)} kostenlos testen mit Code {offer.code}
          {offer.grantPlan ? ` (Umfang Tarif „${PLANS[offer.grantPlan].label}“)` : " – alle Funktionen"}. Keine Zahlungsdaten nötig, endet automatisch.
        </p>
      ) : null}
      <p className="mt-1 text-sm text-muted">
        In zwei Minuten startklar. Leistungskatalog und Schnittstellen (Testmodus) werden automatisch angelegt.
      </p>
      <SetupForm
        needsToken={n === 0 && !!process.env.SETUP_TOKEN}
        saas={saas}
        code={offer?.code ?? ""}
        trialText={offer ? `${trialDaysLabel(offer.trialDays)} kostenlos testen` : null}
      />
    </>
  );
}
