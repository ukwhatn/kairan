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
    editorUrl: "vscode://file{path}",
    followDefault: true,
    shutdownGraceMs: 5000,
    archiveGraceMs: 10_000,
    reuseTab: true,
    feedbackWaitMs: 1_200_000,
    ...overrides,
  };
}

describe("createNotifier", () => {
  test("reuseTab: click executes a curl to /api/focus instead of -open", () => {
    const spawned: string[][] = [];
    const notify = createNotifier(testConfig(), {
      which: () => "/opt/homebrew/bin/terminal-notifier",
      spawn: (args) => spawned.push(args),
    });
    notify("kairan", "新着: report.md", "http://127.0.0.1:5766/abc/report.md");
    const args = spawned[0] ?? [];
    expect(args).not.toContain("-open");
    const executeIndex = args.indexOf("-execute");
    expect(executeIndex).toBeGreaterThan(0);
    const command = args[executeIndex + 1] ?? "";
    expect(command).toContain("http://127.0.0.1:5766/api/focus");
    expect(command).toContain("report.md");
  });

  test("reuseTab=false: click opens the url directly with -open", () => {
    const spawned: string[][] = [];
    const notify = createNotifier(testConfig({ reuseTab: false }), {
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
