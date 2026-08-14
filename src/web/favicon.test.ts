import { describe, expect, test } from "bun:test";
import { computeFaviconStatus, computeTabTitle } from "./favicon.ts";

describe("computeFaviconStatus", () => {
  test("何もなければ idle", () => {
    expect(computeFaviconStatus({ attentionCount: 0, unreadCount: 0 })).toBe("idle");
  });

  test("未読の新着だけなら unread", () => {
    expect(computeFaviconStatus({ attentionCount: 0, unreadCount: 3 })).toBe("unread");
  });

  test("対応待ちがあれば未読より優先して attention", () => {
    expect(computeFaviconStatus({ attentionCount: 1, unreadCount: 5 })).toBe("attention");
  });
});

describe("computeTabTitle", () => {
  test("ファイル未選択・通知なしはアプリ名だけ", () => {
    expect(computeTabTitle({ attentionCount: 0, unreadCount: 0, fileLabel: null })).toBe("kairan");
  });

  test("表示中ファイル名を添える", () => {
    expect(computeTabTitle({ attentionCount: 0, unreadCount: 0, fileLabel: "report.md" })).toBe(
      "kairan · report.md",
    );
  });

  test("対応待ちは件数を先頭に出す", () => {
    expect(computeTabTitle({ attentionCount: 3, unreadCount: 0, fileLabel: "report.md" })).toBe(
      "(3) kairan · report.md",
    );
  });

  test("未読だけのときは件数ではなく印を出す", () => {
    expect(computeTabTitle({ attentionCount: 0, unreadCount: 2, fileLabel: null })).toBe(
      "(•) kairan",
    );
  });

  test("対応待ちがあれば未読は印を出さない", () => {
    expect(computeTabTitle({ attentionCount: 1, unreadCount: 2, fileLabel: null })).toBe(
      "(1) kairan",
    );
  });
});
