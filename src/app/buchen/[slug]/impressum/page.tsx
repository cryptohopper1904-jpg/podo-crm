import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ImprintContent } from "@/app/p/[slug]/_site/legal-content";
import { loadBookingLegal } from "../_legal/load";
import { BookingLegalShell } from "../_legal/shell";

export async function generateMetadata(props: PageProps<"/buchen/[slug]/impressum">): Promise<Metadata> {
  const legal = await loadBookingLegal((await props.params).slug);
  if (!legal) notFound();
  return { title: { absolute: `Impressum · ${legal.name}` }, robots: { index: false, follow: false } };
}

/** Impressum der Praxis zur Online-Buchung (gleicher Inhalt wie /p/<slug>/impressum, ohne Website-Pflicht) */
export default async function BookingLegalPage(props: PageProps<"/buchen/[slug]/impressum">) {
  const legal = await loadBookingLegal((await props.params).slug);
  if (!legal) notFound();
  return (
    <BookingLegalShell legal={legal}>
      <ImprintContent site={legal} />
    </BookingLegalShell>
  );
}
