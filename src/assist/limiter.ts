// Hält die eigenen Abfragen unter dem Limit der WarEra-API: 500 Anfragen je Minute und Schlüssel
// (Antwortkopf Ratelimit-Policy: 500;w=60). Gebündelte Aufrufe zählen als eine Anfrage; geprüft am
// 2026-11-27: ein Bündel mit 8 Prozeduren senkte Ratelimit-Remaining um 1.
//
// Browser dürfen die Ratelimit-Kopfzeilen nicht lesen (die API legt sie nicht über CORS offen), deshalb
// zählt die Seite selbst mit und lässt Luft für die anderen Abfragen, die gleichzeitig laufen
// (Live-Abfrage, Märkte, andere Tools mit demselben Schlüssel).

export class RateBudget {
  private stamps: number[] = [];

  constructor(
    private readonly max: number,
    private readonly windowMs = 60_000,
    private readonly now: () => number = () => Date.now(),
    private readonly wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  /** Wartet, bis im laufenden Fenster wieder eine Anfrage frei ist, und reserviert sie. */
  async take(): Promise<void> {
    for (;;) {
      const t = this.now();
      while (this.stamps.length && t - this.stamps[0] >= this.windowMs) this.stamps.shift();
      if (this.stamps.length < this.max) {
        this.stamps.push(t);
        return;
      }
      await this.wait(Math.max(1, this.stamps[0] + this.windowMs - t));
    }
  }
}
