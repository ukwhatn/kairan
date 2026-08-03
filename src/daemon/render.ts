import Shiki from "@shikijs/markdown-it";
import MarkdownIt from "markdown-it";
import type { BundledLanguage } from "shiki";

// shiki は特殊言語 "text"（プレーン表示）を実行時に受理するが、
// BundledLanguage 型に含まれない型定義の不備があるためここだけ閉じてアサートする
const PLAIN_TEXT_LANGUAGE = "text" as BundledLanguage;

/**
 * markdown → HTML のレンダラーを構築する。shiki のハイライター初期化が
 * 非同期のため factory も async。デーモン起動時に一度だけ呼ぶ。
 */
export async function createMarkdownRenderer(): Promise<(src: string) => string> {
  const md = new MarkdownIt({
    html: true,
    linkify: true,
  });

  md.use(
    await Shiki({
      themes: { light: "github-light", dark: "github-dark" },
      fallbackLanguage: PLAIN_TEXT_LANGUAGE,
    }),
  );

  // mermaid はクライアント側でレンダリングするため、shiki に渡さず素通しする。
  // fence ルールのラップは Shiki プラグイン適用後に行う必要がある（先に intercept するため）
  const defaultFence = md.renderer.rules.fence?.bind(md.renderer.rules);
  md.renderer.rules.fence = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    if (token != null && token.info.trim() === "mermaid") {
      return `<pre class="mermaid">${md.utils.escapeHtml(token.content)}</pre>\n`;
    }
    if (defaultFence != null) return defaultFence(tokens, idx, options, env, self);
    return self.renderToken(tokens, idx, options);
  };

  return (src: string) => md.render(src);
}
