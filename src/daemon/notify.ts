import type { KairanConfig } from "../config.ts";

export type Notifier = (title: string, body: string) => void;

/**
 * macOS 通知センターへの通知。osascript が無い環境では黙って失敗させる
 * （通知は補助機能であり、publish 自体を失敗させない）。
 */
export function createNotifier(config: KairanConfig): Notifier {
  if (!config.notifications) return () => {};
  return (title, body) => {
    try {
      // JSON.stringify は AppleScript 文字列リテラルのエスケープ（" と \）と互換
      const script = `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}`;
      Bun.spawn(["osascript", "-e", script], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      });
    } catch {
      // no-op
    }
  };
}
