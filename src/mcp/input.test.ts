import { describe, expect, test } from "bun:test";
import { inferFormat, resolvePublishSource } from "./input.ts";

describe("inferFormat", () => {
  test("recognizes markdown and html extensions case-insensitively", () => {
    expect(inferFormat("a.md")).toBe("markdown");
    expect(inferFormat("a.markdown")).toBe("markdown");
    expect(inferFormat("A.MD")).toBe("markdown");
    expect(inferFormat("b.html")).toBe("html");
    expect(inferFormat("b.htm")).toBe("html");
  });

  test("returns null for unknown or missing extensions", () => {
    expect(inferFormat("a.txt")).toBeNull();
    expect(inferFormat("noext")).toBeNull();
    expect(inferFormat("")).toBeNull();
  });

  test("handles CJK file names", () => {
    expect(inferFormat("レポート.md")).toBe("markdown");
  });
});

describe("resolvePublishSource", () => {
  const cwd = "/work/project";

  test("path input: name defaults to basename, format inferred", () => {
    const resolved = resolvePublishSource({ path: "docs/report.md" }, cwd);
    expect(resolved).toEqual({
      kind: "path",
      path: "/work/project/docs/report.md",
      name: "report.md",
      format: "markdown",
    });
  });

  test("absolute path is kept as-is", () => {
    const resolved = resolvePublishSource({ path: "/tmp/out.html" }, cwd);
    expect(resolved.kind).toBe("path");
    if (resolved.kind === "path") expect(resolved.path).toBe("/tmp/out.html");
  });

  test("content input requires name", () => {
    expect(() => resolvePublishSource({ content: "# hi" }, cwd)).toThrow(/name/);
    const resolved = resolvePublishSource({ content: "# hi", name: "memo.md" }, cwd);
    expect(resolved).toEqual({
      kind: "content",
      content: "# hi",
      name: "memo.md",
      format: "markdown",
    });
  });

  test("explicit format wins over extension", () => {
    const resolved = resolvePublishSource(
      { content: "<p>x</p>", name: "snippet.md", format: "html" },
      cwd,
    );
    expect(resolved.format).toBe("html");
  });

  test("unknown extension without explicit format throws with guidance", () => {
    expect(() => resolvePublishSource({ content: "x", name: "data.txt" }, cwd)).toThrow(/format/);
  });

  test("both path and content is an error", () => {
    expect(() => resolvePublishSource({ path: "a.md", content: "x" }, cwd)).toThrow(/either/i);
  });

  test("neither path nor content is an error", () => {
    expect(() => resolvePublishSource({}, cwd)).toThrow(/either/i);
  });

  test("explicit name overrides basename for path input", () => {
    const resolved = resolvePublishSource({ path: "docs/report.md", name: "final.md" }, cwd);
    expect(resolved.name).toBe("final.md");
  });
});
