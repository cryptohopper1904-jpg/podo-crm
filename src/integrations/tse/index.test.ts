import { describe, expect, it } from "vitest";
import { FiscalMock, FiskalyAdapter, fiscalIsTestMode, fiscalLiveBlockedReason, getFiscalPort, TSE_LIVE_RELEASE_ENV } from "./index";

describe("TSE-Auswahl: Riegel vor dem Echtbetrieb (Forderungsauflösung noch nicht umgesetzt)", () => {
  const live = { TSE_PROVIDER: "fiskaly" };
  it("ohne Konfiguration: Mock, Testmodus, kein Sperrhinweis", () => {
    expect(getFiscalPort({})).toBeInstanceOf(FiscalMock);
    expect(fiscalIsTestMode({})).toBe(true);
    expect(fiscalLiveBlockedReason({})).toBeNull();
  });
  it("fiskaly konfiguriert, aber nicht freigegeben: weiter Mock/Testmodus mit verständlicher Meldung", () => {
    expect(getFiscalPort(live)).toBeInstanceOf(FiscalMock);
    expect(fiscalIsTestMode(live)).toBe(true);
    expect(fiscalLiveBlockedReason(live)).toMatch(/Forderungsauflösung.*Steuerberatung/);
    expect(fiscalLiveBlockedReason({ ...live, [TSE_LIVE_RELEASE_ENV]: "ja" })).not.toBeNull();
  });
  it("mit ausdrücklicher Freigabe: fiskaly", () => {
    const env = { ...live, [TSE_LIVE_RELEASE_ENV]: "1", FISKALY_API_KEY: "test", FISKALY_API_SECRET: "test", FISKALY_TSS_ID: "t", FISKALY_CLIENT_ID: "c" };
    expect(getFiscalPort(env)).toBeInstanceOf(FiskalyAdapter);
    expect(fiscalIsTestMode(env)).toBe(false);
    expect(fiscalLiveBlockedReason(env)).toBeNull();
  });
  it("INTEGRATIONS_MODE=mock schlägt alles", () => {
    expect(getFiscalPort({ ...live, [TSE_LIVE_RELEASE_ENV]: "1", INTEGRATIONS_MODE: "mock" })).toBeInstanceOf(FiscalMock);
  });
});
