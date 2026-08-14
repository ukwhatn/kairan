import { describe, expect, test } from "bun:test";
import { createLocalFileOpener, editorUrlFor } from "./local-file.ts";

describe("editorUrlFor", () => {
  test("{path} を絶対パスに置換する", () => {
    expect(editorUrlFor("vscode://file{path}", "/Users/me/report.md")).toBe(
      "vscode://file/Users/me/report.md",
    );
  });

  test("空白を percent-encode する", () => {
    expect(editorUrlFor("vscode://file{path}", "/Users/me/my report.md")).toBe(
      "vscode://file/Users/me/my%20report.md",
    );
  });

  test("fragment・query として解釈される記号を encode する", () => {
    const url = editorUrlFor("vscode://file{path}", "/tmp/a#b?c%d.md");
    expect(url).toBe("vscode://file/tmp/a%23b%3Fc%25d.md");
    expect(new URL(url).hash).toBe("");
    expect(new URL(url).search).toBe("");
  });

  test("日本語ファイル名を UTF-8 で encode する", () => {
    expect(editorUrlFor("vscode://file{path}", "/tmp/設計メモ.md")).toBe(
      "vscode://file/tmp/%E8%A8%AD%E8%A8%88%E3%83%A1%E3%83%A2.md",
    );
  });

  test("別エディタのテンプレートにも使える", () => {
    expect(editorUrlFor("cursor://file{path}", "/tmp/a.md")).toBe("cursor://file/tmp/a.md");
  });
});

describe("createLocalFileOpener", () => {
  const configWith = (editorUrl: string) =>
    ({ editorUrl }) as unknown as Parameters<typeof createLocalFileOpener>[0];

  test("finder は open -R でパスを渡す", async () => {
    const calls: string[][] = [];
    const open = createLocalFileOpener(configWith("vscode://file{path}"), {
      runCommand: async (command) => {
        calls.push(command);
        return { exitCode: 0, stderr: "" };
      },
    });
    await open("finder", "/tmp/a.md");
    expect(calls).toEqual([["open", "-R", "/tmp/a.md"]]);
  });

  test("editor は組み立てた URL を open に渡す", async () => {
    const calls: string[][] = [];
    const open = createLocalFileOpener(configWith("vscode://file{path}"), {
      runCommand: async (command) => {
        calls.push(command);
        return { exitCode: 0, stderr: "" };
      },
    });
    await open("editor", "/tmp/my note.md");
    expect(calls).toEqual([["open", "vscode://file/tmp/my%20note.md"]]);
  });

  test("editorUrl が空なら editor を拒否する", async () => {
    const open = createLocalFileOpener(configWith(""), {
      runCommand: async () => ({ exitCode: 0, stderr: "" }),
    });
    expect(open("editor", "/tmp/a.md")).rejects.toThrow(/editorUrl/);
  });

  test("非ゼロ終了は失敗として伝える", async () => {
    const open = createLocalFileOpener(configWith("vscode://file{path}"), {
      runCommand: async () => ({ exitCode: 1, stderr: "no application knows how to open" }),
    });
    expect(open("editor", "/tmp/a.md")).rejects.toThrow(/no application knows how to open/);
  });
});
