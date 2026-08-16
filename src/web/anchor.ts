import type { CommentAnchor } from "../shared/types.ts";

/** 引用に添える前後文脈の長さ */
const CONTEXT_LENGTH = 30;

/**
 * コメントの引用として保存できる最大長。デーモン側の anchor スキーマと揃える
 * （超えたまま送ると 400 になり、入力したコメントが黙って消える）
 */
export const MAX_QUOTE_LENGTH = 5000;

/** 選択範囲を「引用 + 前後文脈」に変換する。root は本文のルート要素 */
export function computeAnchor(root: Node, range: Range): CommentAnchor {
  const before = range.cloneRange();
  before.selectNodeContents(root);
  before.setEnd(range.startContainer, range.startOffset);
  const after = range.cloneRange();
  after.selectNodeContents(root);
  after.setStart(range.endContainer, range.endOffset);
  return {
    exact: range.toString(),
    prefix: before.toString().slice(-CONTEXT_LENGTH),
    suffix: after.toString().slice(0, CONTEXT_LENGTH),
  };
}

function commonSuffixLength(a: string, b: string): number {
  let count = 0;
  while (
    count < a.length &&
    count < b.length &&
    a[a.length - 1 - count] === b[b.length - 1 - count]
  ) {
    count += 1;
  }
  return count;
}

function commonPrefixLength(a: string, b: string): number {
  let count = 0;
  while (count < a.length && count < b.length && a[count] === b[count]) count += 1;
  return count;
}

/**
 * 保存された引用が本文のどこを指すかを求める。
 *
 * 同じ文言が複数回現れる文書（表・カード・繰り返しのセクション）では出現位置だけでは
 * 決まらないため、全ての出現について前後文脈の一致長を見て最も合うものを選ぶ。
 * 本文が書き換わって引用ごと消えた場合は null（ハイライトを諦める）。
 */
export function resolveQuoteOffsets(
  fullText: string,
  anchor: CommentAnchor,
): { start: number; end: number } | null {
  if (anchor.exact === "") return null;
  let best: { start: number; score: number } | null = null;
  for (let from = 0; ; ) {
    const start = fullText.indexOf(anchor.exact, from);
    if (start < 0) break;
    const end = start + anchor.exact.length;
    const score =
      commonSuffixLength(fullText.slice(0, start), anchor.prefix) +
      commonPrefixLength(fullText.slice(end), anchor.suffix);
    if (best == null || score > best.score) best = { start, score };
    from = start + 1;
  }
  if (best == null) return null;
  return { start: best.start, end: best.start + anchor.exact.length };
}

export interface TextSlice {
  node: Text;
  from: number;
  to: number;
}

/** 文字オフセットの範囲を、実際に囲むべきテキストノードの断片へ落とす */
export function collectTextSlices(root: Element, start: number, end: number): TextSlice[] {
  const doc = root.ownerDocument;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const slices: TextSlice[] = [];
  let pos = 0;
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    const nodeStart = pos;
    const nodeEnd = pos + node.data.length;
    if (nodeEnd > start && nodeStart < end) {
      slices.push({
        node,
        from: Math.max(0, start - nodeStart),
        to: Math.min(node.data.length, end - nodeStart),
      });
    }
    pos = nodeEnd;
    if (pos >= end) break;
  }
  return slices;
}

/**
 * 引用範囲を mark で囲む。囲めた要素を返す（要素境界を跨ぐ選択では複数になる）。
 * mark の見た目とイベントは呼び出し側が付ける（本体画面と文書内で振る舞いが違うため）
 */
export function wrapSlices(slices: TextSlice[], className: string): HTMLElement[] {
  const marks: HTMLElement[] = [];
  for (const slice of slices) {
    const doc = slice.node.ownerDocument;
    const range = doc.createRange();
    range.setStart(slice.node, slice.from);
    range.setEnd(slice.node, slice.to);
    const mark = doc.createElement("mark");
    mark.className = className;
    try {
      range.surroundContents(mark);
      marks.push(mark);
    } catch {
      // 断片は単一のテキストノード内に収めてあるので通常は失敗しない。
      // agent が生成した任意の DOM が相手なので、想定外の失敗でも残りの引用は貼り続ける
    }
  }
  return marks;
}

/** 貼ったハイライトを剥がして元のテキストへ戻す */
export function unwrapMarks(root: Element, className: string): void {
  for (const mark of [...root.querySelectorAll(`mark.${className}`)]) {
    const parent = mark.parentNode;
    if (parent == null) continue;
    while (mark.firstChild != null) parent.insertBefore(mark.firstChild, mark);
    mark.remove();
    parent.normalize();
  }
}
