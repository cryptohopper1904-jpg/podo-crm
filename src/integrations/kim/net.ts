/**
 * TLS-Verbindungsaufbau zum KIM-Clientmodul / TI-Gateway mit SSRF-Schutz:
 * Host wird aufgelöst, ALLE Adressen müssen öffentlich sein (net-guard), verbunden wird dann
 * genau mit der geprüften IP (kein DNS-Rebinding zwischen Prüfung und Verbindung).
 * Zertifikatsprüfung bleibt immer an (servername = konfigurierter Host).
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { connect as tlsConnect } from "node:tls";
import type { Duplex } from "node:stream";
import { isPrivateIp, resolvePublicAddress, UnsafeTargetError, type Resolver } from "../net-guard";

const defaultResolver: Resolver = (host) => lookup(host, { all: true, verbatim: true });

export interface TlsTarget {
  host: string;
  port: number;
  timeoutMs?: number;
  resolve?: Resolver;
}

/** Erlaubte Ports: POP3S 995, SMTPS 465 und die beim KIM-Clientmodul üblichen frei gewählten Ports ≥ 1024. */
export function assertKimPort(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new UnsafeTargetError("Ungültiger Port.");
  if (port !== 995 && port !== 465 && port < 1024) throw new UnsafeTargetError("Port nicht erlaubt (995, 465 oder ≥ 1024).");
}

/** Geprüfte öffentliche IP für den Host (IP-Literale werden ebenfalls gegen private Bereiche geprüft). */
export async function resolvePublic(host: string, resolve: Resolver = defaultResolver): Promise<string> {
  const ip = await resolvePublicAddress(host, resolve);
  // doppelte Absicherung: auch das Ergebnis selbst nochmals prüfen
  if (isPrivateIp(ip)) throw new UnsafeTargetError("Private oder lokale Adresse nicht erlaubt.");
  return ip;
}

export function tlsConnector(target: TlsTarget): () => Promise<Duplex> {
  return async () => {
    assertKimPort(target.port);
    const ip = await resolvePublic(target.host, target.resolve);
    return new Promise<Duplex>((resolve, reject) => {
      const socket = tlsConnect({
        host: ip,
        port: target.port,
        servername: isIP(target.host.replace(/^\[|\]$/g, "")) ? undefined : target.host,
        rejectUnauthorized: true,
        minVersion: "TLSv1.2",
        timeout: target.timeoutMs ?? 20_000,
      });
      const fail = (e: Error) => {
        socket.destroy();
        reject(e);
      };
      socket.once("secureConnect", () => {
        socket.off("error", fail);
        resolve(socket);
      });
      socket.once("error", fail);
      socket.once("timeout", () => fail(new Error("TLS-Verbindung: Zeitüberschreitung")));
    });
  };
}
