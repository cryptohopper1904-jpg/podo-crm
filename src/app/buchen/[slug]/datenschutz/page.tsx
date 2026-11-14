import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PrivacyContent } from "@/app/p/[slug]/_site/legal-content";
import { loadBookingLegal } from "../_legal/load";
import { BookingLegalShell } from "../_legal/shell";

export async function generateMetadata(props: PageProps<"/buchen/[slug]/datenschutz">): Promise<Metadata> {
  const legal = await loadBookingLegal((await props.params).slug);
  if (!legal) notFound();
  return { title: { absolute: `Datenschutz · ${legal.name}` }, robots: { index: false, follow: false } };
}

/** Datenschutz der Praxis zur Online-Buchung (gleicher Inhalt wie /p/<slug>/datenschutz, ohne Website-Pflicht) */
export default async function BookingLegalPage(props: PageProps<"/buchen/[slug]/datenschutz">) {
  const legal = await loadBookingLegal((await props.params).slug);
  if (!legal) notFound();
  return (
    <BookingLegalShell legal={legal}>
      <PrivacyContent site={legal} />
    </BookingLegalShell>
  );
}
