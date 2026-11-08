/**
 * Google Business Profile – Bewertungen lesen und beantworten (PLAN 6.5, P2).
 *
 * Gerüst: Die API muss bei Google beantragt werden (Freischaltung), Auth via OAuth 2.0.
 * Doku: https://developers.google.com/my-business/content/review-data
 * - GET    https://mybusiness.googleapis.com/v4/accounts/{accountId}/locations/{locationId}/reviews
 * - PUT    …/reviews/{reviewId}/reply   { comment }
 * TODO: OAuth-Flow (Refresh-Token verschlüsselt speichern), Paging, Rating-Enum (ONE…FIVE) mappen.
 */
import { IntegrationNotConfiguredError } from "../errors";
import { mockId } from "../mock-util";
import type { Review, ReviewsPort } from "../types";

const DOCS = "https://developers.google.com/my-business/content/review-data";

export interface GoogleBusinessOptions {
  accessToken?: string | null;
  accountId?: string | null;
  locationId?: string | null;
}

export const STAR_RATING: Record<string, number> = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };

export class GoogleBusinessAdapter implements ReviewsPort {
  readonly provider = "google_business" as const;
  readonly isMock = false;

  constructor(opts: GoogleBusinessOptions) {
    if (!opts.accessToken || !opts.accountId || !opts.locationId) {
      throw new IntegrationNotConfiguredError("google_business", "OAuth-Token, accountId und locationId fehlen", DOCS);
    }
  }

  async listReviews(): Promise<{ reviews: Review[]; nextPageToken?: string | null }> {
    // TODO: echte Anfrage implementieren, sobald API-Zugang freigeschaltet ist
    throw new IntegrationNotConfiguredError("google_business", "API-Anbindung noch nicht implementiert", DOCS);
  }

  async replyToReview(): Promise<void> {
    throw new IntegrationNotConfiguredError("google_business", "API-Anbindung noch nicht implementiert", DOCS);
  }
}

export class GoogleBusinessMock implements ReviewsPort {
  readonly provider = "google_business" as const;
  readonly isMock = true;
  private readonly reviews: Review[] = [
    { externalId: mockId("review", "1"), author: "Erika B.", rating: 5, text: "Sehr einfühlsame Behandlung, gerne wieder!", reply: null, createdAt: "2026-01-10T09:00:00.000Z" },
    { externalId: mockId("review", "2"), author: "Max M.", rating: 3, text: "Gute Behandlung, aber lange Wartezeit.", reply: null, createdAt: "2026-02-03T15:30:00.000Z" },
  ];

  async listReviews() {
    return { reviews: this.reviews.map((r) => ({ ...r })), nextPageToken: null };
  }

  async replyToReview(externalId: string, text: string) {
    const r = this.reviews.find((x) => x.externalId === externalId);
    if (!r) throw new Error("Bewertung nicht gefunden.");
    r.reply = text;
  }
}
