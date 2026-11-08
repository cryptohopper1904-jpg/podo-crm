/**
 * Minimaler POP3-Client (RFC 1939) über TLS (POP3S, Port 995) – für das KIM-Clientmodul.
 * Unterstützt: USER/PASS, STAT, UIDL, RETR, DELE (nur auf ausdrücklichen Wunsch), QUIT.
 *
 * Der Transport ist injizierbar (`connect` liefert einen Duplex-Stream) – in Tests ein
 * In-Memory-Server, im Betrieb eine TLS-Verbindung (siehe ./net.ts).
 * Grenzen: Antwortzeilen ≤ 8 KB, Nachrichten ≤ maxMessageBytes, Zeitlimit je Befehl.
 */
import type { Duplex } from "node:stream";

export class Pop3Error extends Error {
  /**
   * `serverReply`: reguläre „-ERR“-Antwort des Servers – die Verbindung ist danach weiter benutzbar.
   * Alle anderen Fehler (Zeitlimit, Abbruch, Größen-/Zeilenlimit) lassen den Stream in unbekanntem
   * Zustand zurück → die Verbindung wird sofort geschlossen.
   */
  constructor(message: string, readonly response?: string, readonly serverReply = false) {
    super(message);
    this.name = "Pop3Error";
  }
}

export type ConnectFn = () => Promise<Duplex>;

export interface Pop3Options {
  connect: ConnectFn;
  user: string;
  password: string;
  /** Zeitlimit je Befehl in ms (Standard 20 s) */
  timeoutMs?: number;
  /** Höchstgröße einer Nachricht (Standard 25 MB) */
  maxMessageBytes?: number;
}

const MAX_LINE = 8 * 1024;

/** Liest CRLF-getrennte Zeilen bzw. Mehrzeilen-Antworten aus einem Stream. */
class LineReader {
  private buf = Buffer.alloc(0);
  private waiters: (() => void)[] = [];
  private ended = false;
  private error: Error | null = null;

  constructor(private readonly stream: Duplex) {
    stream.on("data", (chunk: Buffer) => {
      this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : Buffer.from(chunk);
      this.wake();
    });
    stream.on("end", () => {
      this.ended = true;
      this.wake();
    });
    stream.on("close", () => {
      this.ended = true;
      this.wake();
    });
    stream.on("error", (e: Error) => {
      this.error = e;
      this.wake();
    });
  }

  private wake() {
    const w = this.waiters;
    this.waiters = [];
    for (const f of w) f();
  }

  private wait(timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const waiter = () => {
        clearTimeout(t);
        resolve();
      };
      const t = setTimeout(() => {
        // abgelaufenen Waiter entfernen und Verbindung hart schließen
        this.waiters = this.waiters.filter((w) => w !== waiter);
        this.stream.destroy();
        reject(new Pop3Error("Zeitüberschreitung beim POP3-Server"));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  /** Eine Zeile ohne CRLF (latin1). */
  async line(timeoutMs: number): Promise<string> {
    for (;;) {
      const i = this.buf.indexOf("\n");
      if (i >= 0) {
        const line = this.buf.subarray(0, i).toString("latin1").replace(/\r$/, "");
        this.buf = this.buf.subarray(i + 1);
        return line;
      }
      if (this.buf.length > MAX_LINE) throw new Pop3Error("POP3-Antwortzeile zu lang");
      if (this.error) throw this.error;
      if (this.ended) throw new Pop3Error("Verbindung vom POP3-Server geschlossen");
      await this.wait(timeoutMs);
    }
  }

  /** Mehrzeilige Antwort bis „.“ – Dot-Stuffing wird entfernt. Ergebnis als Buffer (Byte-treu). */
  async multiline(timeoutMs: number, maxBytes: number): Promise<Buffer> {
    const parts: Buffer[] = [];
    let total = 0;
    for (;;) {
      const i = this.buf.indexOf("\n");
      if (i < 0) {
        if (this.buf.length > maxBytes) throw new Pop3Error("Nachricht zu groß");
        if (this.error) throw this.error;
        if (this.ended) throw new Pop3Error("Verbindung während der Übertragung geschlossen");
        await this.wait(timeoutMs);
        continue;
      }
      let line = this.buf.subarray(0, i);
      this.buf = this.buf.subarray(i + 1);
      if (line.length && line[line.length - 1] === 0x0d) line = line.subarray(0, line.length - 1);
      if (line.length === 1 && line[0] === 0x2e) return Buffer.concat(parts);
      if (line.length > 1 && line[0] === 0x2e) line = line.subarray(1);
      total += line.length + 2;
      if (total > maxBytes) throw new Pop3Error("Nachricht zu groß");
      parts.push(line, Buffer.from("\r\n"));
    }
  }
}

export class Pop3Client {
  private stream: Duplex | null = null;
  private reader: LineReader | null = null;
  private readonly timeoutMs: number;
  private readonly maxMessageBytes: number;

  constructor(private readonly opts: Pop3Options) {
    this.timeoutMs = opts.timeoutMs ?? 20_000;
    this.maxMessageBytes = opts.maxMessageBytes ?? 25 * 1024 * 1024;
  }

  private async status(): Promise<string> {
    const line = await this.reader!.line(this.timeoutMs);
    if (line.startsWith("+OK")) return line.slice(3).trim();
    // Fehlertext des Servers nicht weiterreichen (kann Benutzernamen enthalten) – nur kurz
    throw new Pop3Error("POP3-Server meldet einen Fehler", line.slice(0, 120), true);
  }

  /** Führt eine Operation aus; bei jedem Transportfehler (nicht bei „-ERR“) wird die Verbindung geschlossen. */
  private async guarded<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (!(e instanceof Pop3Error && e.serverReply)) this.close();
      throw e;
    }
  }

  private async command(cmd: string): Promise<string> {
    if (/[\r\n]/.test(cmd)) throw new Pop3Error("Ungültiges Zeichen im POP3-Befehl", undefined, true);
    if (!this.stream || !this.reader) throw new Pop3Error("Keine POP3-Verbindung");
    const stream = this.stream;
    return this.guarded(async () => {
      stream.write(`${cmd}\r\n`);
      return this.status();
    });
  }

  private multiline(maxBytes: number): Promise<Buffer> {
    if (!this.reader) return Promise.reject(new Pop3Error("Keine POP3-Verbindung"));
    const reader = this.reader;
    return this.guarded(() => reader.multiline(this.timeoutMs, maxBytes));
  }

  async connect(): Promise<void> {
    try {
      this.stream = await this.opts.connect();
      this.reader = new LineReader(this.stream);
      await this.status(); // Begrüßung
      await this.command(`USER ${this.opts.user}`);
      try {
        await this.command(`PASS ${this.opts.password}`);
      } catch (e) {
        throw new Pop3Error("POP3-Anmeldung fehlgeschlagen", e instanceof Pop3Error ? e.response : undefined);
      }
    } catch (e) {
      // jede Störung beim Verbindungsaufbau/Anmelden → Socket schließen
      this.close();
      throw e;
    }
  }

  async stat(): Promise<{ count: number; size: number }> {
    const r = await this.command("STAT");
    const [count, size] = r.split(/\s+/).map(Number);
    if (!Number.isInteger(count) || count < 0) throw new Pop3Error("Ungültige STAT-Antwort");
    return { count, size: Number.isFinite(size) ? size : 0 };
  }

  /** Eindeutige IDs je Nachrichtennummer (falls der Server UIDL unterstützt, sonst null). */
  async uidl(): Promise<Map<number, string> | null> {
    try {
      await this.command("UIDL");
    } catch {
      return null;
    }
    const raw = (await this.multiline(1024 * 1024)).toString("latin1");
    const map = new Map<number, string>();
    for (const line of raw.split(/\r\n/)) {
      const m = line.match(/^(\d+)\s+(\S+)$/);
      if (m) map.set(Number(m[1]), m[2]);
    }
    return map;
  }

  async retr(n: number): Promise<Buffer> {
    if (!Number.isInteger(n) || n < 1) throw new Pop3Error("Ungültige Nachrichtennummer");
    await this.command(`RETR ${n}`);
    return this.multiline(this.maxMessageBytes);
  }

  async dele(n: number): Promise<void> {
    if (!Number.isInteger(n) || n < 1) throw new Pop3Error("Ungültige Nachrichtennummer");
    await this.command(`DELE ${n}`);
  }

  /** QUIT – erst hier werden DELE-Markierungen auf dem Server wirksam. */
  async quit(): Promise<void> {
    if (!this.stream) return;
    try {
      await this.command("QUIT");
    } finally {
      this.close();
    }
  }

  close() {
    this.stream?.destroy();
    this.stream = null;
    this.reader = null;
  }

  /** nur für Tests: ist noch ein Stream offen? */
  get isOpen(): boolean {
    return this.stream !== null;
  }
}
