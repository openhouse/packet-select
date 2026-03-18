export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class RollingWindowScheduler {
  constructor({ tpmLimit = null, rpmLimit = null, utilization = 1, windowMs = 60000 }) {
    this.tpmLimit = tpmLimit;
    this.rpmLimit = rpmLimit;
    this.utilization = utilization;
    this.windowMs = windowMs;
    this.tokenEvents = [];
    this.requestEvents = [];
  }

  prune(now = Date.now()) {
    const cutoff = now - this.windowMs;
    this.tokenEvents = this.tokenEvents.filter((event) => event.time > cutoff);
    this.requestEvents = this.requestEvents.filter((event) => event.time > cutoff);
  }

  currentUsage(now = Date.now()) {
    this.prune(now);
    return {
      tokenUsed: this.tokenEvents.reduce((sum, event) => sum + event.tokens, 0),
      reqUsed: this.requestEvents.length,
    };
  }

  async reserve({ tokens = 0 }) {
    while (true) {
      const now = Date.now();
      const { tokenUsed, reqUsed } = this.currentUsage(now);
      const effectiveTpmLimit = this.tpmLimit ? this.tpmLimit * this.utilization : null;
      const effectiveRpmLimit = this.rpmLimit ? this.rpmLimit * this.utilization : null;
      const tokenOk = !effectiveTpmLimit || tokenUsed + tokens <= effectiveTpmLimit;
      const reqOk = !effectiveRpmLimit || reqUsed + 1 <= effectiveRpmLimit;
      if (tokenOk && reqOk) {
        const reservation = { time: now, tokens };
        const requestReservation = { time: now };
        this.tokenEvents.push(reservation);
        this.requestEvents.push(requestReservation);
        return {
          release: () => this.release({ reservation, requestReservation }),
        };
      }
      const waits = [];
      if (!tokenOk && this.tokenEvents.length) waits.push(this.windowMs - (now - this.tokenEvents[0].time));
      if (!reqOk && this.requestEvents.length) waits.push(this.windowMs - (now - this.requestEvents[0].time));
      await sleep(Math.max(50, Math.min(...waits)));
    }
  }

  release({ reservation, requestReservation }) {
    this.tokenEvents = this.tokenEvents.filter((event) => event !== reservation);
    this.requestEvents = this.requestEvents.filter((event) => event !== requestReservation);
  }
}

export function computeBackoffDelayMs({ attempt, retryAfterMs = null, baseMs = 1000, maxMs = 30000 }) {
  if (retryAfterMs) return retryAfterMs;
  const exp = Math.min(maxMs, baseMs * (2 ** (attempt - 1)));
  const jitter = Math.floor(Math.random() * Math.max(250, exp * 0.25));
  return exp + jitter;
}
