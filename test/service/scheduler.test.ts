import { test, expect } from "bun:test";
import { createScheduler } from "../../src/service/scheduler.ts";
test("work arriving during a run is drained without concurrent indexing", async () => {
  let runs = 0,
    active = 0,
    max = 0;
  let unblock!: () => void;
  const blocked = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  const scheduler = createScheduler(async () => {
    runs++;
    active++;
    max = Math.max(max, active);
    if (runs === 1) await blocked;
    active--;
  }, 0);
  scheduler.schedule();
  await Bun.sleep(10);
  scheduler.schedule();
  await Bun.sleep(10);
  unblock();
  await scheduler.idle();
  expect(runs).toBe(2);
  expect(max).toBe(1);
  await scheduler.close();
});
test("scheduler recovers after rejection and close waits for active work", async () => {
  let runs = 0;
  const scheduler = createScheduler(
    async () => {
      runs++;
      if (runs === 1) throw new Error("expected");
    },
    0,
    () => {},
  );
  scheduler.schedule();
  await scheduler.idle();
  scheduler.schedule();
  await scheduler.idle();
  await scheduler.close();
  scheduler.schedule();
  expect(runs).toBe(2);
});
