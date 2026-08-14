import { APP_NAME } from "../shared/consts.ts";
import {
  FAVICON_COLORS,
  FAVICON_MARK_LINE_HEIGHT,
  FAVICON_MARK_LINES,
  FAVICON_SIZE,
} from "../shared/favicon.ts";

export type FaviconStatus = "idle" | "unread" | "attention";

export interface TabIndicator {
  /** 人間の対応待ち（未回答の質問数 + レビュー待ちセッション数） */
  attentionCount: number;
  /** このタブを開いている間に届いた、まだ表示していない publish の数 */
  unreadCount: number;
}

export function computeFaviconStatus(indicator: TabIndicator): FaviconStatus {
  if (indicator.attentionCount > 0) return "attention";
  if (indicator.unreadCount > 0) return "unread";
  return "idle";
}

export function computeTabTitle(indicator: TabIndicator & { fileLabel: string | null }): string {
  const suffix = indicator.fileLabel == null ? "" : ` · ${indicator.fileLabel}`;
  // 未読は「何件あるか」より「見ていないものがある」だけが行動を変えるため印にとどめる
  const prefix =
    indicator.attentionCount > 0
      ? `(${indicator.attentionCount}) `
      : indicator.unreadCount > 0
        ? "(•) "
        : "";
  return `${prefix}${APP_NAME}${suffix}`;
}

const STATIC_LINK_SELECTOR = 'link[rel="icon"][type="image/svg+xml"]';
const STATUS_LINK_ID = "favicon-status";

function drawMark(context: CanvasRenderingContext2D): void {
  context.fillStyle = FAVICON_COLORS.base;
  context.beginPath();
  context.roundRect(0, 0, FAVICON_SIZE, FAVICON_SIZE, 7);
  context.fill();

  context.fillStyle = FAVICON_COLORS.mark;
  for (const [x, y, width] of FAVICON_MARK_LINES) {
    context.beginPath();
    context.roundRect(x, y, width, FAVICON_MARK_LINE_HEIGHT, 1.25);
    context.fill();
  }
}

function drawBadge(context: CanvasRenderingContext2D, color: string): void {
  const center = FAVICON_SIZE - 9;
  // 白いリングを敷いてから塗る（ベース色と重なっても輪郭が潰れないように）
  context.fillStyle = FAVICON_COLORS.mark;
  context.beginPath();
  context.arc(center, center, 9, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = color;
  context.beginPath();
  context.arc(center, center, 6.5, 0, Math.PI * 2);
  context.fill();
}

function renderStatusIcon(status: Exclude<FaviconStatus, "idle">): string | null {
  const canvas = document.createElement("canvas");
  canvas.width = FAVICON_SIZE;
  canvas.height = FAVICON_SIZE;
  const context = canvas.getContext("2d");
  if (context == null) return null;
  drawMark(context);
  drawBadge(context, status === "attention" ? FAVICON_COLORS.attention : FAVICON_COLORS.unread);
  return canvas.toDataURL("image/png");
}

let appliedStatus: FaviconStatus | null = null;
let staticLink: HTMLLinkElement | null = null;

/**
 * favicon をステータスつきに差し替える。SVG の data URI を favicon にできないブラウザが
 * あるため、動的側は canvas で PNG を作る。静的 link と併存させるとどちらを採用するかが
 * ブラウザ依存になるので、head には常にどちらか一方だけを置く
 */
export function applyFavicon(status: FaviconStatus): void {
  if (status === appliedStatus) return;
  staticLink ??= document.querySelector<HTMLLinkElement>(STATIC_LINK_SELECTOR);

  if (status === "idle") {
    document.getElementById(STATUS_LINK_ID)?.remove();
    if (staticLink != null && staticLink.parentNode == null) document.head.append(staticLink);
    appliedStatus = status;
    return;
  }

  const href = renderStatusIcon(status);
  if (href == null) return;
  const existing = document.getElementById(STATUS_LINK_ID);
  const link = existing instanceof HTMLLinkElement ? existing : document.createElement("link");
  link.id = STATUS_LINK_ID;
  link.rel = "icon";
  link.type = "image/png";
  link.setAttribute("sizes", `${FAVICON_SIZE}x${FAVICON_SIZE}`);
  link.href = href;
  staticLink?.remove();
  if (link.parentNode == null) document.head.append(link);
  appliedStatus = status;
}
