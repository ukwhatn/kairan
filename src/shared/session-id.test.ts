import { describe, expect, test } from "bun:test";
import { formatSessionId, isValidSessionId } from "./session-id.ts";

describe("isValidSessionId", () => {
  test("英数字・ドット・ハイフン・アンダースコアを受け付ける", () => {
    expect(isValidSessionId("0814-1345")).toBe(true);
    expect(isValidSessionId("release_v2")).toBe(true);
    expect(isValidSessionId("a.b-c_1")).toBe(true);
    expect(isValidSessionId("A1")).toBe(true);
  });

  test("URL セグメントとして壊れる文字を拒否する", () => {
    expect(isValidSessionId("a/b")).toBe(false);
    expect(isValidSessionId("a b")).toBe(false);
    expect(isValidSessionId("a?b")).toBe(false);
    expect(isValidSessionId("a#b")).toBe(false);
    expect(isValidSessionId("設計")).toBe(false);
    expect(isValidSessionId("")).toBe(false);
  });

  test("先頭は英数字に限る（. や - で始まるパスを作らせない）", () => {
    expect(isValidSessionId(".hidden")).toBe(false);
    expect(isValidSessionId("-x")).toBe(false);
    expect(isValidSessionId("_x")).toBe(false);
    expect(isValidSessionId(".")).toBe(false);
    expect(isValidSessionId("..")).toBe(false);
  });

  test("デーモンが先に握っているパスは予約語として拒否する", () => {
    // これらを許すと /api/sessions などが文書ではなく既存 endpoint に化ける
    expect(isValidSessionId("api")).toBe(false);
    expect(isValidSessionId("raw")).toBe(false);
    expect(isValidSessionId("assets")).toBe(false);
    expect(isValidSessionId("healthz")).toBe(false);
    expect(isValidSessionId("favicon.svg")).toBe(false);
    expect(isValidSessionId("favicon.ico")).toBe(false);
  });

  test("予約語の判定は大文字小文字を区別しない", () => {
    expect(isValidSessionId("API")).toBe(false);
    expect(isValidSessionId("Raw")).toBe(false);
  });

  test("長すぎる ID を拒否する", () => {
    expect(isValidSessionId("a".repeat(64))).toBe(true);
    expect(isValidSessionId("a".repeat(65))).toBe(false);
  });
});

describe("formatSessionId", () => {
  const at = (iso: string) => formatSessionId(new Date(iso).getTime());

  test("MMDD-HHmm 形式で日時を表す", () => {
    expect(at("2026-08-14T13:45:00")).toBe("0814-1345");
  });

  test("1桁の月日時分をゼロ埋めする", () => {
    expect(at("2026-01-02T03:04:00")).toBe("0102-0304");
  });

  test("連番を付けても ID として妥当なまま", () => {
    expect(isValidSessionId(`${at("2026-08-14T13:45:00")}-2`)).toBe(true);
  });
});
