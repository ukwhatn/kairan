import { describe, expect, test } from "bun:test";
import { loadConfig } from "./config.ts";

const HOME = "/home/testuser";

describe("loadConfig", () => {
  test("returns defaults when no file and no env", () => {
    const config = loadConfig({ env: {}, home: HOME, readConfigFile: () => null });
    expect(config).toEqual({
      port: 5766,
      host: "127.0.0.1",
      dataDir: "/home/testuser/.kairan",
      autoOpen: "session-first",
      reopenWhenNoTab: true,
      notifications: true,
      notifyOn: "all",
      openCommand: "open",
      followDefault: true,
      shutdownGraceMs: 5000,
    });
  });

  test("config file overrides defaults", () => {
    const config = loadConfig({
      env: {},
      home: HOME,
      readConfigFile: () => JSON.stringify({ port: 8080, notifications: false }),
    });
    expect(config.port).toBe(8080);
    expect(config.notifications).toBe(false);
    expect(config.host).toBe("127.0.0.1");
  });

  test("env overrides config file", () => {
    const config = loadConfig({
      env: { KAIRAN_PORT: "9999", KAIRAN_AUTO_OPEN: "never" },
      home: HOME,
      readConfigFile: () => JSON.stringify({ port: 8080, autoOpen: "always" }),
    });
    expect(config.port).toBe(9999);
    expect(config.autoOpen).toBe("never");
  });

  test("boolean env vars accept true/false/1/0", () => {
    const load = (value: string) =>
      loadConfig({
        env: { KAIRAN_NOTIFICATIONS: value },
        home: HOME,
        readConfigFile: () => null,
      }).notifications;
    expect(load("true")).toBe(true);
    expect(load("1")).toBe(true);
    expect(load("false")).toBe(false);
    expect(load("0")).toBe(false);
  });

  test("tilde in config file dataDir expands to home", () => {
    const config = loadConfig({
      env: {},
      home: HOME,
      readConfigFile: () => JSON.stringify({ dataDir: "~/custom-kairan" }),
    });
    expect(config.dataDir).toBe("/home/testuser/custom-kairan");
  });

  test("invalid port in env throws", () => {
    expect(() =>
      loadConfig({ env: { KAIRAN_PORT: "abc" }, home: HOME, readConfigFile: () => null }),
    ).toThrow();
    expect(() =>
      loadConfig({ env: { KAIRAN_PORT: "0" }, home: HOME, readConfigFile: () => null }),
    ).toThrow();
  });

  test("invalid JSON in config file throws with file path hint", () => {
    expect(() => loadConfig({ env: {}, home: HOME, readConfigFile: () => "{not json" })).toThrow(
      /config/i,
    );
  });

  test("unknown enum value in config file throws", () => {
    expect(() =>
      loadConfig({
        env: {},
        home: HOME,
        readConfigFile: () => JSON.stringify({ autoOpen: "sometimes" }),
      }),
    ).toThrow();
  });
});
