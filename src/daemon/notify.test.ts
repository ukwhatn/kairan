import { describe, expect, test } from "bun:test";
import type { KairanConfig } from "../config.ts";
import { createNotifier } from "./notify.ts";

function testConfig(overrides: Partial<KairanConfig> = {}): KairanConfig {
  return {
    port: 5766,
    host: "127.0.0.1",
    dataDir: "/tmp/unused",
    autoOpen: "session-first",
    reopenWhenNoTab: true,
    notifications: true,
    notifyOn: "all",
    openCommand: "open",
    followDefault: true,
    shutdownGraceMs: 5000,
    ...overrides,
  };
}

describe("createNotifier", () => {
  test("uses terminal-notifier with -open when available and url given", () => {
    const spawned: string[][] = [];
    const notify = createNotifier(testConfig(), {
      which: () => "/opt/homebrew/bin/terminal-notifier",
      spawn: (args) => spawned.push(args),
    });
    notify("kairan", "新着: report.md", "http://127.0.0.1:5766/abc/report.md");
    expect(spawned).toEqual([
      [
        "/opt/homebrew/bin/terminal-notifier",
        "-title",
        "kairan",
        "-message",
        "新着: report.md",
        "-open",
        "http://127.0.0.1:5766/abc/report.md",
      ],
    ]);
  });

  test("terminal-notifier without url omits -open", () => {
    const spawned: string[][] = [];
    const notify = createNotifier(testConfig(), {
      which: () => "/opt/homebrew/bin/terminal-notifier",
      spawn: (args) => spawned.push(args),
    });
    notify("kairan", "hello");
    expect(spawned[0]).not.toContain("-open");
  });

  test("falls back to osascript when terminal-notifier is missing", () => {
    const spawned: string[][] = [];
    const notify = createNotifier(testConfig(), {
      which: () => null,
      spawn: (args) => spawned.push(args),
    });
    notify("kairan", 'say "hi" \\ done', "http://127.0.0.1:5766/abc/a.md");
    expect(spawned[0]?.[0]).toBe("osascript");
    expect(spawned[0]?.[2]).toBe(
      'display notification "say \\"hi\\" \\\\ done" with title "kairan"',
    );
  });

  test("notifications=false yields a no-op notifier", () => {
    const spawned: string[][] = [];
    const notify = createNotifier(testConfig({ notifications: false }), {
      which: () => "/opt/homebrew/bin/terminal-notifier",
      spawn: (args) => spawned.push(args),
    });
    notify("kairan", "hello", "http://example");
    expect(spawned).toHaveLength(0);
  });
});
