import type { ComponentProps } from "react";
import { connection } from "next/server";
import { LinkButton } from "@/components/ui";
import { signupOpen, TRIAL_ON_REQUEST, TRIAL_REQUEST_LABEL, trialRequestHref } from "./site";

/** Registrierung offen? Zur Laufzeit (ALLOW_SIGNUP ist eine Server-Variable, beim Build nicht gesetzt). */
export async function trialOpen(): Promise<boolean> {
  await connection();
  return signupOpen();
}

type ButtonProps = Omit<ComponentProps<typeof LinkButton>, "href" | "children"> & { label?: string; href?: string };

/** „Kostenlos testen“ nur bei offener Registrierung, sonst „Testzugang anfragen“ (Rechtsprüfung R1). */
export async function TrialButton({ label = "Kostenlos testen", href = "/einrichtung", children, ...rest }: ButtonProps & { children?: React.ReactNode }) {
  if (await trialOpen())
    return (
      <LinkButton href={href} {...rest}>
        {label}
        {children}
      </LinkButton>
    );
  return (
    <LinkButton href={trialRequestHref()} {...rest}>
      {TRIAL_REQUEST_LABEL}
      {children}
    </LinkButton>
  );
}

/** Text zum Testangebot – bei gesperrter Registrierung der Hinweis „Testzugang auf Anfrage“. */
export async function TrialText({ open, closed = TRIAL_ON_REQUEST }: { open: React.ReactNode; closed?: React.ReactNode }) {
  return <>{(await trialOpen()) ? open : closed}</>;
}
