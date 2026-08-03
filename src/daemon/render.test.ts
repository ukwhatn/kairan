import { beforeAll, describe, expect, test } from "bun:test";
import { createMarkdownRenderer } from "./render.ts";

let render: (src: string) => string;

beforeAll(async () => {
  render = await createMarkdownRenderer();
});

describe("createMarkdownRenderer", () => {
  test("renders headings and paragraphs", () => {
    const html = render("# 見出し\n\n本文です。");
    expect(html).toContain("<h1>見出し</h1>");
    expect(html).toContain("<p>本文です。</p>");
  });

  test("renders GFM tables", () => {
    const html = render("| a | b |\n|---|---|\n| 1 | 2 |");
    expect(html).toContain("<table>");
    expect(html).toContain("<td>1</td>");
  });

  test("highlights fenced code with shiki", () => {
    const html = render("```typescript\nconst x: number = 1;\n```");
    expect(html).toContain("shiki");
    expect(html).toContain("const");
  });

  test("mermaid fence becomes a pre.mermaid block, not highlighted code", () => {
    const html = render("```mermaid\ngraph TD;\nA-->B;\n```");
    expect(html).toContain('<pre class="mermaid">');
    expect(html).toContain("A--&gt;B;");
    expect(html).not.toContain("shiki");
  });

  test("unknown language does not throw", () => {
    const html = render("```nosuchlang\nhello\n```");
    expect(html).toContain("hello");
  });

  test("raw HTML in markdown passes through", () => {
    const html = render('before\n\n<div class="custom">inner</div>\n\nafter');
    expect(html).toContain('<div class="custom">inner</div>');
  });

  test("empty string renders to empty output", () => {
    expect(render("").trim()).toBe("");
  });
});
