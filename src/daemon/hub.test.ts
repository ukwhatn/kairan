import { describe, expect, test } from "bun:test";
import type { KairanEvent } from "../shared/types.ts";
import { Hub } from "./hub.ts";

const event: KairanEvent = { type: "session:archived", sessionId: "abc" };

describe("attach tracking", () => {
  test("attach increments count, returned detach decrements", () => {
    const hub = new Hub();
    const detach = hub.attach("s1");
    expect(hub.attachCount("s1")).toBe(1);
    detach();
    expect(hub.attachCount("s1")).toBe(0);
  });

  test("onSessionDetached fires only when the last attach for a session is released", () => {
    const hub = new Hub();
    const detached: string[] = [];
    hub.onSessionDetached = (sessionId) => detached.push(sessionId);
    const a = hub.attach("s1");
    const b = hub.attach("s1");
    a();
    expect(detached).toEqual([]);
    b();
    expect(detached).toEqual(["s1"]);
  });

  test("double-calling the same detach does not double-decrement", () => {
    const hub = new Hub();
    const detached: string[] = [];
    hub.onSessionDetached = (sessionId) => detached.push(sessionId);
    const a = hub.attach("s1");
    const b = hub.attach("s1");
    a();
    a();
    expect(hub.attachCount("s1")).toBe(1);
    expect(detached).toEqual([]);
    b();
    expect(detached).toEqual(["s1"]);
  });
});

describe("browser tracking and broadcast", () => {
  test("broadcast reaches all browser listeners regardless of session", () => {
    const hub = new Hub();
    const received: KairanEvent[][] = [[], []];
    hub.addBrowser("s1", (e) => received[0]?.push(e));
    hub.addBrowser(null, (e) => received[1]?.push(e));
    hub.broadcast(event);
    expect(received[0]).toEqual([event]);
    expect(received[1]).toEqual([event]);
  });

  test("browserCount counts per session and total", () => {
    const hub = new Hub();
    const removeA = hub.addBrowser("s1", () => {});
    hub.addBrowser("s2", () => {});
    expect(hub.browserCount("s1")).toBe(1);
    expect(hub.browserCount()).toBe(2);
    removeA();
    expect(hub.browserCount("s1")).toBe(0);
    expect(hub.browserCount()).toBe(1);
  });
});

describe("emptiness", () => {
  test("onEmpty fires when the last connection (attach or browser) is gone", () => {
    const hub = new Hub();
    let emptyCalls = 0;
    hub.onEmpty = () => emptyCalls++;
    const detach = hub.attach("s1");
    const removeBrowser = hub.addBrowser("s1", () => {});
    detach();
    expect(emptyCalls).toBe(0);
    removeBrowser();
    expect(emptyCalls).toBe(1);
    expect(hub.isEmpty()).toBe(true);
  });

  test("a hub with no connections at all reports empty but never fired onEmpty", () => {
    const hub = new Hub();
    let emptyCalls = 0;
    hub.onEmpty = () => emptyCalls++;
    expect(hub.isEmpty()).toBe(true);
    expect(emptyCalls).toBe(0);
  });
});
