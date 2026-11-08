import type { ProviderId } from "../types";

/** KIM-Verbindung in `integration_connections` (eigener Enum-Wert seit Migration 0013). */
export const KIM_CONNECTION_PROVIDER = "kim" satisfies ProviderId;
export type KimConnectionProvider = typeof KIM_CONNECTION_PROVIDER;
