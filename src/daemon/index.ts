import { mkdirSync } from "node:fs";
import { join } from "node:path";
import packageJson from "../../package.json" with { type: "json" };
import { loadConfig } from "../config.ts";
import { daemonBaseUrl } from "../shared/url.ts";
import { buildClientAssets } from "./bundle.ts";
import { Store } from "./db.ts";
import { Hub } from "./hub.ts";
import { createLocalFileOpener } from "./local-file.ts";
import { createNotifier } from "./notify.ts";
import { createOpener } from "./open.ts";
import { createMarkdownRenderer } from "./render.ts";
import { createApp } from "./routes.ts";
import { SignalHub } from "./waiters.ts";

export async function runDaemon(): Promise<void> {
  const config = loadConfig();
  mkdirSync(config.dataDir, { recursive: true });

  const store = Store.open(join(config.dataDir, "kairan.db"));
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
    // デーモン停止時は全 attach がまとめて切れるが、それは agent の終了を意味しない。
    // ここで archive すると restart のたびに全セッションが archived になる
    if (stopping) return;
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
    signals: new SignalHub(),
    config,
    version: packageJson.version,
    renderMarkdown,
    notify: createNotifier(config),
    openInBrowser: createOpener(config),
    openLocalFile: createLocalFileOpener(config),
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

  // デーモンは「どの agent が生きているか」をメモリにしか持たないため、再起動直後は
  // 判別できない。猶予を置き、それでも attach が来なかったセッションだけを終了扱いにする
  // （即座に archive すると、稼働中の agent のセッションまで archived に見える）
  setTimeout(() => {
    for (const session of store.listSessions(false)) {
      if (hub.attachCount(session.id) > 0) continue;
      store.archiveSession(session.id);
      hub.broadcast({ type: "session:archived", sessionId: session.id });
    }
  }, config.archiveGraceMs).unref();

  console.log(
    `kairan daemon listening on ${daemonBaseUrl(config.host, config.port)} (pid ${process.pid})`,
  );
}
