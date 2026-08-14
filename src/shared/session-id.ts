/**
 * セッション ID は URL の第1セグメントになるため、デーモンが先に登録している
 * パスと衝突すると deep link がその endpoint に化ける（Hono は登録順で解決する）
 */
const RESERVED_SESSION_IDS = new Set([
  "api",
  "raw",
  "assets",
  "healthz",
  "favicon.svg",
  "favicon.ico",
]);

const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function isValidSessionId(id: string): boolean {
  if (!SESSION_ID_PATTERN.test(id)) return false;
  return !RESERVED_SESSION_IDS.has(id.toLowerCase());
}

const pad = (value: number): string => String(value).padStart(2, "0");

/** 自動採番の ID。一覧でも URL でも「いつ始めたか」が読めるようにする */
export function formatSessionId(epochMs: number): string {
  const at = new Date(epochMs);
  return `${pad(at.getMonth() + 1)}${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}`;
}
