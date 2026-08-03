import type { KairanConfig } from "../config.ts";

export type Notifier = (title: string, body: string, url?: string) => void;

interface NotifierDeps {
  which?: (command: string) => string | null;
  spawn?: (args: string[]) => void;
}

function defaultSpawn(args: string[]): void {
  Bun.spawn(args, {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
}

/**
 * macOS 通知センターへの通知。terminal-notifier があればクリックで URL を
 * 開ける通知にし、無ければ osascript（クリック遷移なし）にフォールバックする。
 * 通知は補助機能なので、どちらの経路でも失敗は publish に波及させない。
 */
export function createNotifier(config: KairanConfig, deps: NotifierDeps = {}): Notifier {
  if (!config.notifications) return () => {};
  const which = deps.which ?? Bun.which;
  const spawn = deps.spawn ?? defaultSpawn;

  const terminalNotifier = which("terminal-notifier");
  if (terminalNotifier != null) {
    return (title, body, url) => {
      try {
        const args = [terminalNotifier, "-title", title, "-message", body];
        if (url != null) args.push("-open", url);
        spawn(args);
      } catch {
        // no-op
      }
    };
  }

  return (title, body) => {
    try {
      // JSON.stringify は AppleScript 文字列リテラルのエスケープ（" と \）と互換
      const script = `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}`;
      spawn(["osascript", "-e", script]);
    } catch {
      // no-op
    }
  };
}
