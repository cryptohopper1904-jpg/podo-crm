import { Card, Empty } from "@/components/ui";
import { requestMeta } from "@/lib/auth/session";
import { dateDe, timeDe, weekdayLong } from "@/lib/format";
import { clientKey } from "@/lib/rate-limit";
import { portalFailLimiter, portalLimiter } from "@/server/portal-core";
import { loadOffer } from "@/server/waitlist";
import { PortalShell } from "../../shell";
import { AcceptOfferForm, OfferAcceptedNotice } from "./accept-form";

export const metadata = { title: "Freier Termin", robots: { index: false, follow: false }, referrer: "no-referrer" as const };
export const dynamic = "force-dynamic";

/**
 * Wartelisten-Angebot (persönlicher Einmal-Link). Das Öffnen nimmt nichts an – erst der Knopf
 * (POST, Server Action). Wer zuerst bestätigt, bekommt den Termin; danach „leider schon vergeben“.
 */
export default async function OfferPage(props: PageProps<"/portal/angebot/[token]">) {
  const { token } = await props.params;
  const key = clientKey(await requestMeta());
  if (portalFailLimiter.exceeded(key) || portalLimiter.limited(`offer-view:${key}`)) {
    return (
      <PortalShell>
        <Empty title="Zu viele Aufrufe">Bitte versuchen Sie es in einigen Minuten erneut.</Empty>
      </PortalShell>
    );
  }
  const offer = await loadOffer(token);
  if (offer.state === "invalid") portalFailLimiter.limited(key);
  const tel = offer.state !== "invalid" && offer.practice.phone ? ` Telefon: ${offer.practice.phone}` : "";
  return (
    <PortalShell>
      {offer.state === "valid" ? (
        <Card>
          <p className="text-sm text-muted">{offer.practice.name}</p>
          <h1 className="font-display text-2xl font-semibold">Ein Termin ist frei geworden</h1>
          <p className="mt-2">
            {offer.firstName ? `Guten Tag ${offer.firstName}, ` : ""}Sie stehen auf unserer Warteliste. Frei ist:
          </p>
          <p className="my-4 text-xl font-semibold">{weekdayLong(offer.startsAt)}, {timeDe(offer.startsAt)} Uhr</p>
          <p className="mb-4 text-sm text-muted">Das Angebot ging an mehrere Personen – wer zuerst bestätigt, bekommt den Termin.</p>
          <AcceptOfferForm token={token} label={`${dateDe(offer.startsAt)}, ${timeDe(offer.startsAt)} Uhr`} />
        </Card>
      ) : offer.state === "taken" ? (
        <Empty title="Leider schon vergeben">Jemand anderes war schneller. Sie bleiben auf der Warteliste und wir melden uns beim nächsten freien Termin.{tel}</Empty>
      ) : offer.state === "accepted" ? (
        <OfferAcceptedNotice>
          <Empty title="Termin bereits angenommen">{offer.startsAt ? `Ihr Termin: ${dateDe(offer.startsAt)}, ${timeDe(offer.startsAt)} Uhr.` : ""}{tel}</Empty>
        </OfferAcceptedNotice>
      ) : offer.state === "expired" ? (
        <Empty title="Angebot abgelaufen">Dieses Angebot gilt nicht mehr.{tel}</Empty>
      ) : (
        <Empty title="Link ungültig">Der Link ist ungültig. Bitte wenden Sie sich an Ihre Praxis.</Empty>
      )}
    </PortalShell>
  );
}
