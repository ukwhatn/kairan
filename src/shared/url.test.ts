import { describe, expect, test } from "bun:test";
import { daemonBaseUrl, localBaseUrls } from "./url.ts";

describe("daemonBaseUrl", () => {
  test("ipv4 and hostname pass through", () => {
    expect(daemonBaseUrl("127.0.0.1", 5766)).toBe("http://127.0.0.1:5766");
    expect(daemonBaseUrl("localhost", 8080)).toBe("http://localhost:8080");
  });

  test("ipv6 loopback is bracketed so the URL parses", () => {
    expect(daemonBaseUrl("::1", 5766)).toBe("http://[::1]:5766");
    expect(() => new URL(daemonBaseUrl("::1", 5766))).not.toThrow();
  });
});

describe("localBaseUrls", () => {
  test("covers all loopback spellings with trailing slash", () => {
    expect(localBaseUrls(5766)).toEqual([
      "http://127.0.0.1:5766/",
      "http://localhost:5766/",
      "http://[::1]:5766/",
    ]);
  });
});
