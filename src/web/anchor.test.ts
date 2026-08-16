import { describe, expect, test } from "bun:test";
import { resolveQuoteOffsets } from "./anchor.ts";

const anchorOf = (exact: string, prefix = "", suffix = "") => ({ exact, prefix, suffix });

describe("resolveQuoteOffsets", () => {
  test("引用が1箇所しかなければそこを返す", () => {
    const text = "はじめに\n設計の方針\nおわりに";
    expect(resolveQuoteOffsets(text, anchorOf("設計の方針"))).toEqual({ start: 5, end: 10 });
  });

  test("本文から消えていれば null", () => {
    expect(resolveQuoteOffsets("書き換わった本文", anchorOf("元の引用"))).toBeNull();
  });

  test("前の文脈が一致する出現を選ぶ", () => {
    const text = "A: 承認\nB: 承認";
    const resolved = resolveQuoteOffsets(text, anchorOf("承認", "B: "));
    expect(resolved).toEqual({ start: 9, end: 11 });
  });

  test("前の文脈が同じでも、後ろの文脈で正しい出現を選ぶ", () => {
    // prefix はどちらの出現でも "状態: " で同一。suffix だけが違う
    const text = "状態: 承認（一次）\n状態: 承認（最終）";
    const resolved = resolveQuoteOffsets(text, anchorOf("承認", "状態: ", "（最終）"));
    expect(resolved).toEqual({ start: 15, end: 17 });
  });

  test("文脈が一致しなくても、引用があれば最初の出現へ落とす", () => {
    const text = "設計の方針\n設計の方針";
    // 前後文脈は本文の書き換えで失われうる。その場合でもハイライトは出す
    const resolved = resolveQuoteOffsets(text, anchorOf("設計の方針", "存在しない", "存在しない"));
    expect(resolved).toEqual({ start: 0, end: 5 });
  });

  test("先頭・末尾に接する引用でも前後文脈の比較が破綻しない", () => {
    const text = "先頭の段落\n本文";
    expect(resolveQuoteOffsets(text, anchorOf("先頭の段落", "", "\n本文"))).toEqual({
      start: 0,
      end: 5,
    });
  });

  test("空の引用は解決しない", () => {
    expect(resolveQuoteOffsets("本文", anchorOf(""))).toBeNull();
  });
});
