/** 静的 SVG（デーモンが配信）と canvas 描画（ブラウザ）で見た目を揃えるための共有定義 */
export const FAVICON_COLORS = {
  base: "#435ad2",
  mark: "#ffffff",
  /** 人間の対応待ち（未回答の質問・レビュー待ち） */
  attention: "#e5484d",
  /** 未読の新着 publish */
  unread: "#38bdf8",
} as const;

export const FAVICON_SIZE = 32;

/** 書類の横線（x, y, width）。canvas 側も同じ座標で描く */
export const FAVICON_MARK_LINES: ReadonlyArray<readonly [number, number, number]> = [
  [8, 9, 16],
  [8, 14.75, 16],
  [8, 20.5, 10],
];

export const FAVICON_MARK_LINE_HEIGHT = 2.5;

export const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${FAVICON_SIZE} ${FAVICON_SIZE}" width="${FAVICON_SIZE}" height="${FAVICON_SIZE}">
<rect width="${FAVICON_SIZE}" height="${FAVICON_SIZE}" rx="7" fill="${FAVICON_COLORS.base}"/>
${FAVICON_MARK_LINES.map(
  ([x, y, width]) =>
    `<rect x="${x}" y="${y}" width="${width}" height="${FAVICON_MARK_LINE_HEIGHT}" rx="1.25" fill="${FAVICON_COLORS.mark}"/>`,
).join("\n")}
</svg>`;
