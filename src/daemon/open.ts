import type { KairanConfig } from "../config.ts";
import { localBaseUrls } from "../shared/url.ts";

export type Opener = (url: string) => void;

interface OpenerDeps {
  runJxa?: (script: string, args: string[]) => Promise<string>;
  plainOpen?: (url: string) => void;
}

// 既に開いている kairan タブを探して URL 差し替え + 前面化する。
// stdin からスクリプトを渡す想定（osascript -l JavaScript - <args> で run(argv) が呼ばれる）
const REUSE_TAB_SCRIPT = `
function run(argv) {
  const targetUrl = argv[0];
  const bases = argv.slice(1);
  const matches = (u) => u != null && bases.some((b) => u.startsWith(b));

  const chromiums = ["Google Chrome", "Microsoft Edge", "Brave Browser", "Vivaldi", "Chromium"];
  for (const name of chromiums) {
    try {
      const app = Application(name);
      if (!app.running()) continue;
      const windows = app.windows();
      for (let wi = 0; wi < windows.length; wi++) {
        const tabs = windows[wi].tabs();
        for (let ti = 0; ti < tabs.length; ti++) {
          if (matches(tabs[ti].url())) {
            tabs[ti].url = targetUrl;
            windows[wi].activeTabIndex = ti + 1;
            windows[wi].index = 1;
            app.activate();
            return "reused";
          }
        }
      }
    } catch (e) {}
  }

  try {
    const safari = Application("Safari");
    if (safari.running()) {
      const windows = safari.windows();
      for (let wi = 0; wi < windows.length; wi++) {
        const tabs = windows[wi].tabs();
        for (let ti = 0; ti < tabs.length; ti++) {
          if (matches(tabs[ti].url())) {
            tabs[ti].url = targetUrl;
            windows[wi].currentTab = tabs[ti];
            windows[wi].index = 1;
            safari.activate();
            return "reused";
          }
        }
      }
    }
  } catch (e) {}
  return "none";
}
`;

async function defaultRunJxa(script: string, args: string[]): Promise<string> {
  const proc = Bun.spawn(["osascript", "-l", "JavaScript", "-", ...args], {
    stdin: new TextEncoder().encode(script),
    stdout: "pipe",
    stderr: "ignore",
    // 初回の Automation 許可プロンプト等で応答が返らない場合に備える
    timeout: 8000,
  });
  const output = await new Response(proc.stdout).text();
  await proc.exited;
  return output.trim();
}

/**
 * ブラウザで URL を開く。reuseTab 有効時は既存の kairan タブを
 * 探して再利用（URL 差し替え + 前面化）し、見つからない・失敗した
 * 場合のみ新規に開く。
 */
export function createOpener(config: KairanConfig, deps: OpenerDeps = {}): Opener {
  const plainOpen =
    deps.plainOpen ??
    ((url: string) => {
      try {
        Bun.spawn([config.openCommand, url], {
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        });
      } catch {
        // ブラウザを開けなくても publish 自体は成功させる
      }
    });

  if (!config.reuseTab) return plainOpen;

  const runJxa = deps.runJxa ?? defaultRunJxa;
  const bases = localBaseUrls(config.port);
  return (url) => {
    void (async () => {
      try {
        const result = await runJxa(REUSE_TAB_SCRIPT, [url, ...bases]);
        if (result === "reused") return;
      } catch {
        // osascript が使えない環境では常に新規オープンにフォールバック
      }
      plainOpen(url);
    })();
  };
}
