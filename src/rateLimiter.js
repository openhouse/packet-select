export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class RollingWindowScheduler {
  constructor({ tpmLimit = null, rpmLimit = null, windowMs = 60000 }) {
    this.tpmLimit = tpmLimit;
    this.rpmLimit = rpmLimit;
    this.windowMs = windowMs;
    this.tokenEvents = [];
    this.requestEvents = [];
  }

  prune(now = Date.now()) {
    const cutoff = now - this.windowMs;
    this.tokenEvents = this.tokenEvents.filter((event) => event.time > cutoff);
    this.requestEvents = this.requestEvents.filter((event) => event > cutoff);
  }

  async reserve({ tokens = 0 }) {
    while (true) {
      const now = Date.now();
      this.prune(now);
      const tokenUsed = this.tokenEvents.reduce((sum, event) => sum + event.tokens, 0);
      const reqUsed = this.requestEvents.length;
      const tokenOk = !this.tpmLimit || tokenUsed + tokens <= this.tpmLimit;
      const reqOk = !this.rpmLimit || reqUsed + 1 <= this.rpmLimit;
      if (tokenOk && reqOk) {
        this.tokenEvents.push({ time: now, tokens });
        this.requestEvents.push(now);
        return;
      }
      const waits = [];
      if (!tokenOk && this.tokenEvents.length) waits.push(this.windowMs - (now - this.tokenEvents[0].time));
      if (!reqOk && this.requestEvents.length) waits.push(this.windowMs - (now - this.requestEvents[0]));
      await sleep(Math.max(50, Math.min(...waits)));
    }
  }
}

export function computeBackoffDelayMs({ attempt, retryAfterMs = null, baseMs = 1000, maxMs = 30000 }) {
  if (retryAfterMs) return retryAfterMs;
  const exp = Math.min(maxMs, baseMs * (2 ** (attempt - 1)));
  const jitter = Math.floor(Math.random() * Math.max(250, exp * 0.25));
  return exp + jitter;
}
