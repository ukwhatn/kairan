import { describe, expect, test } from "bun:test";
import { SignalHub } from "./waiters.ts";

describe("SignalHub", () => {
  test("notify wakes all waiters on the key with true", async () => {
    const hub = new SignalHub();
    const a = hub.wait("k", 1000);
    const b = hub.wait("k", 1000);
    hub.notify("k");
    expect(await a).toBe(true);
    expect(await b).toBe(true);
    expect(hub.waiterCount("k")).toBe(0);
  });

  test("timeout resolves false and cleans up", async () => {
    const hub = new SignalHub();
    expect(await hub.wait("k", 5)).toBe(false);
    expect(hub.waiterCount("k")).toBe(0);
  });

  test("notify on a different key does not wake", async () => {
    const hub = new SignalHub();
    const waiting = hub.wait("a", 20);
    hub.notify("b");
    expect(await waiting).toBe(false);
  });

  test("abort resolves false immediately", async () => {
    const hub = new SignalHub();
    const controller = new AbortController();
    const waiting = hub.wait("k", 10_000, controller.signal);
    controller.abort();
    expect(await waiting).toBe(false);
    expect(hub.waiterCount("k")).toBe(0);
  });

  test("onWaitersChanged reports transitions to and from zero", async () => {
    const hub = new SignalHub();
    const seen: Array<[string, number]> = [];
    hub.onWaitersChanged = (key, count) => seen.push([key, count]);
    const waiting = hub.wait("k", 1000);
    hub.notify("k");
    await waiting;
    expect(seen).toEqual([
      ["k", 1],
      ["k", 0],
    ]);
  });
});
