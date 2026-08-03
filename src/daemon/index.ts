import { mkdirSync } from "node:fs";
import { join } from "node:path";
import packageJson from "../../package.json" with { type: "json" };
import { loadConfig } from "../config.ts";
import { buildClientAssets } from "./bundle.ts";
import { Store } from "./db.ts";
import { Hub } from "./hub.ts";
import { createNotifier } from "./notify.ts";
import { createOpener } from "./open.ts";
import { createMarkdownRenderer } from "./render.ts";
import { createApp } from "./routes.ts";

export async function runDaemon(): Promise<void> {
  const config = loadConfig();
  mkdirSync(config.dataDir, { recursive: true });

  const store = Store.open(join(config.dataDir, "kairan.db"));
  // 前回プロセスの異常終了で active のまま残ったセッションを補正する
  // （attach が生きているセッションはこの後の再attachで active に戻る）
  store.archiveAllActive();

  const hub = new Hub();
  const renderMarkdown = await createMarkdownRenderer();
  const clientAssets = await buildClientAssets();

  let stopping = false;
  const shutdown = (): void => {
    if (stopping) return;
    stopping = true;
    server.stop(true);
    store.close();
    process.exit(0);
  };

  hub.onSessionDetached = (sessionId) => {
    store.archiveSession(sessionId);
    hub.broadcast({ type: "session:archived", sessionId });
  };

  let shutdownTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleShutdownCheck = (): void => {
    if (shutdownTimer != null) clearTimeout(shutdownTimer);
    shutdownTimer = setTimeout(() => {
      if (hub.isEmpty()) shutdown();
    }, config.shutdownGraceMs);
  };
  hub.onEmpty = scheduleShutdownCheck;

  const app = createApp({
    store,
    hub,
    config,
    version: packageJson.version,
    renderMarkdown,
    notify: createNotifier(config),
    openInBrowser: createOpener(config),
    clientAssets,
    requestShutdown: shutdown,
  });

  const server = Bun.serve({
    port: config.port,
    hostname: config.host,
    fetch: app.fetch,
    // SSE を張りっぱなしにするため idle timeout を無効化する
    idleTimeout: 0,
  });

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  // spawn されたが誰も接続しに来なかった場合に残留しないための初期チェック
  scheduleShutdownCheck();

  console.log(
    `kairan daemon listening on http://${config.host}:${config.port} (pid ${process.pid})`,
  );
}
