import { describe, expect, it } from "vitest";
import { assertPublicHost, assertPublicUrl, assertSafeUrlSyntax, guardedFetch, isPrivateIp, resolvePublicAddress, UnsafeTargetError } from "./net-guard";

const resolveTo = (...ips: string[]) => async () => ips.map((address) => ({ address }));

describe("net-guard (SSRF)", () => {
  it("erkennt private, lokale und Metadaten-Adressen", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "::", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:7f00:1"]) {
      expect(isPrivateIp(ip), ip).toBe(true);
    }
    for (const ip of ["8.8.8.8", "172.32.0.1", "1.1.1.1", "2a00:1450:4001::1"]) expect(isPrivateIp(ip), ip).toBe(false);
    // ausgeschriebene/ungekürzte IPv6-Formen, Zonen-IDs, gemappte und eingebettete IPv4
    for (const ip of ["0:0:0:0:0:0:0:1", "0000:0000:0000:0000:0000:0000:0000:0001", "[::1]", "fe80::1%eth0", "febf::1", "fc00::1", "FD12:3456::1", "::ffff:10.0.0.1", "0:0:0:0:0:ffff:a9fe:a9fe", "::ffff:169.254.169.254", "::127.0.0.1", "2002:7f00:1::", "64:ff9b::a00:1", "ff02::1"]) {
      expect(isPrivateIp(ip), ip).toBe(true);
    }
    for (const ip of ["::ffff:8.8.8.8", "2001:4860:4860::8888"]) expect(isPrivateIp(ip), ip).toBe(false);
  });

  it("prüft URL-Syntax", () => {
    expect(assertSafeUrlSyntax("https://api.mistral.ai/v1").hostname).toBe("api.mistral.ai");
    for (const bad of ["http://api.example.com", "https://localhost/v1", "https://127.0.0.1", "https://[::1]/", "https://169.254.169.254/latest", "https://user:pw@api.example.com", "https://api.example.com:8443", "ftp://x.de", "https://metadata.google.internal"]) {
      expect(() => assertSafeUrlSyntax(bad), bad).toThrow(UnsafeTargetError);
    }
  });

  it("lehnt Hosts ab, die auf private Adressen auflösen", async () => {
    await expect(assertPublicHost("evil.example.com", resolveTo("93.184.216.34", "10.0.0.5"))).rejects.toThrow(UnsafeTargetError);
    await expect(assertPublicHost("ok.example.com", resolveTo("93.184.216.34"))).resolves.toBeUndefined();
    await expect(assertPublicUrl("https://ok.example.com/v1", resolveTo("93.184.216.34"))).resolves.toBeInstanceOf(URL);
    await expect(assertPublicHost("x.example.com", async () => { throw new Error("NXDOMAIN"); })).rejects.toThrow(/aufgelöst/);
  });

  it("guardedFetch prüft vor jedem Request und verbietet Weiterleitungen", async () => {
    const calls: RequestInit[] = [];
    const f = guardedFetch(async (_u, i) => { calls.push(i ?? {}); return new Response("ok"); }, resolveTo("93.184.216.34"));
    await f("https://ok.example.com/a");
    expect(calls[0].redirect).toBe("error");
    const g = guardedFetch(async () => new Response("ok"), resolveTo("127.0.0.1"));
    await expect(g("https://rebind.example.com/a")).rejects.toThrow(UnsafeTargetError);
  });
});

describe("resolvePublicAddress (eine Auflösung, geprüfte IP)", () => {
  it("IP-Literale werden geprüft, Hostnamen genau einmal aufgelöst", async () => {
    for (const h of ["127.0.0.1", "::1", "[::1]", "169.254.169.254", "fe80::1", "fd00::1", "::ffff:127.0.0.1", "0:0:0:0:0:0:0:1"]) {
      await expect(resolvePublicAddress(h, async () => [{ address: "93.184.216.34" }]), h).rejects.toBeInstanceOf(UnsafeTargetError);
    }
    expect(await resolvePublicAddress("93.184.216.34")).toBe("93.184.216.34");
    let calls = 0;
    const resolver = async () => (calls++, [{ address: "93.184.216.34" }, { address: "2a00:1450:4001::1" }]);
    expect(await resolvePublicAddress("smtp.example.org", resolver)).toBe("93.184.216.34");
    expect(calls).toBe(1);
    await expect(resolvePublicAddress("smtp.example.org", async () => [{ address: "93.184.216.34" }, { address: "10.0.0.1" }])).rejects.toThrow(/private/);
  });
});
