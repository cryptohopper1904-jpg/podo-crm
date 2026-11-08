import { StripeMock } from "./mock";
import { priceIdsFromEnv, StripeAdapter } from "./stripe";
import type { BillingPort } from "./types";

/**
 * Live, sobald STRIPE_SECRET_KEY gesetzt ist (und BILLING_MODE nicht „mock“). Sonst Mock –
 * in Produktion ohne Webhook-Secret (Webhooks werden dann abgelehnt, fail closed).
 */
export function getBillingPort(env: Record<string, string | undefined> = process.env): BillingPort {
  if (env.STRIPE_SECRET_KEY && env.BILLING_MODE !== "mock") {
    return new StripeAdapter({ secretKey: env.STRIPE_SECRET_KEY, webhookSecret: env.STRIPE_WEBHOOK_SECRET, prices: priceIdsFromEnv(env) });
  }
  const prod = env.NODE_ENV === "production";
  return new StripeMock(env.STRIPE_WEBHOOK_SECRET ?? (prod ? null : undefined));
}

export * from "./types";
