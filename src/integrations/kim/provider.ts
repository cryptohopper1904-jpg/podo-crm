import type { ProviderId } from "../types";

/**
 * Unter welchem `integration_provider` die KIM-Verbindung in `integration_connections` liegt.
 *
 * Das Enum enthält (noch) keinen Wert „kim“ (Schema-Wunsch in docs/SCHEMA_REQUESTS.md).
 * Bis dahin wird der bisher ungenutzte TI-/GKV-Platzhalter „gkv_billing“ verwendet.
 * Nach der Migration NUR diese Konstante auf "kim" umstellen und bestehende Zeilen per
 * `UPDATE integration_connections SET provider = 'kim' WHERE provider = 'gkv_billing'` umziehen.
 */
export const KIM_CONNECTION_PROVIDER = "gkv_billing" satisfies ProviderId;
export type KimConnectionProvider = typeof KIM_CONNECTION_PROVIDER;
