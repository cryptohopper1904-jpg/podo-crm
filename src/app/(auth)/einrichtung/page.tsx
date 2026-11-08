import { count } from "drizzle-orm";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { db } from "@/db";
import { users } from "@/db/schema";
import { SetupForm } from "./setup-form";

export const metadata = { title: "Praxis einrichten" };

export default async function SetupPage() {
  await connection(); // immer zur Laufzeit prüfen, nie beim Build vorberechnen
  const [{ n }] = await db.select({ n: count() }).from(users);
  if (n > 0 && process.env.ALLOW_SIGNUP !== "true") redirect("/login");
  return (
    <>
      <h1 className="font-display text-2xl font-semibold">{n === 0 ? "Praxis einrichten" : "Neue Praxis registrieren"}</h1>
      <p className="mt-1 text-sm text-muted">
        In zwei Minuten startklar. Leistungskatalog und Schnittstellen (Testmodus) werden automatisch angelegt.
      </p>
      <SetupForm needsToken={n === 0 && !!process.env.SETUP_TOKEN} saas={n > 0 && process.env.ALLOW_SIGNUP === "true"} />
    </>
  );
}
