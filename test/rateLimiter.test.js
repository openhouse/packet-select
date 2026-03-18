import { test } from "node:test";
import { strict as assert } from "node:assert";
import { RollingWindowScheduler, computeBackoffDelayMs } from "../src/rateLimiter.js";

test("RollingWindowScheduler tracks token and request budgets", async () => {
  const scheduler = new RollingWindowScheduler({ tpmLimit: 100, rpmLimit: 2, windowMs: 40 });
  await scheduler.reserve({ tokens: 40 });
  await scheduler.reserve({ tokens: 40 });
  const started = Date.now();
  await scheduler.reserve({ tokens: 40 });
  assert.ok(Date.now() - started >= 20);
});

test("RollingWindowScheduler refunds reservations for deterministic failures", async () => {
  const scheduler = new RollingWindowScheduler({ tpmLimit: 100, rpmLimit: 2, utilization: 0.8, windowMs: 1000 });
  const reservation = await scheduler.reserve({ tokens: 60 });
  reservation.release();
  const next = await scheduler.reserve({ tokens: 60 });
  assert.ok(next);
});

test("computeBackoffDelayMs respects retry-after when present", () => {
  assert.equal(computeBackoffDelayMs({ attempt: 3, retryAfterMs: 2500 }), 2500);
});
