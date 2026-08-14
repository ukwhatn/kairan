#!/usr/bin/env bun
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import type { DaemonState } from "./shared/types.ts";
import { daemonBaseUrl } from "./shared/url.ts";

const USAGE = `kairan - circulate agent-generated documents to your browser

Usage:
  kairan mcp             Run as stdio MCP server (register this in your agent)
  kairan daemon          Run the web daemon in the foreground (usually spawned automatically)
  kairan restart         Restart the daemon (reflects code/config changes)
  kairan stop            Stop the running daemon
  kairan status          Show daemon status
  kairan relink          Reconnect past sessions to their agent sessions using Claude Code history,
                         and drop archived sessions that never got any content
                         (--dry-run to only print what it would do, --keep-empty to keep them)
`;

async function probeDaemon(base: string): Promise<DaemonState> {
  try {
    const res = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(2000) });
    const json = (await res.json().catch(() => null)) as { app?: string } | null;
    return json?.app === "kairan" ? "kairan" : "foreign";
  } catch {
    return "down";
  }
}

/** kairan 本人であることを確認済みの前提で shutdown を送り、port 解放まで待つ */
async function shutdownAndWait(base: string): Promise<void> {
  await fetch(`${base}/api/shutdown`, { method: "POST", signal: AbortSignal.timeout(2000) }).catch(
    () => {},
  );
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if ((await probeDaemon(base)) === "down") return;
    await Bun.sleep(150);
  }
}

async function stopDaemon(): Promise<void> {
  const config = loadConfig();
  const base = daemonBaseUrl(config.host, config.port);
  // port を専有しているのが kairan 本人であることを確認してから停止を送る
  // （衝突時に無関係なサービスへ状態変更リクエストを投げないため）
  const daemonState = await probeDaemon(base);
  if (daemonState === "down") {
    console.log("kairan daemon is not running");
    return;
  }
  if (daemonState === "foreign") {
    console.log(`port ${config.port} is in use by another application; not stopping it`);
    process.exit(1);
  }
  await shutdownAndWait(base);
  console.log("kairan daemon stopped");
}

async function restartDaemon(): Promise<void> {
  const config = loadConfig();
  const base = daemonBaseUrl(config.host, config.port);
  const daemonState = await probeDaemon(base);
  if (daemonState === "foreign") {
    console.log(`port ${config.port} is in use by another application; not restarting it`);
    process.exit(1);
  }
  if (daemonState === "kairan") {
    await shutdownAndWait(base);
  }
  const { DaemonClient } = await import("./mcp/daemon-client.ts");
  await new DaemonClient(config).ensureDaemon();
  console.log(`kairan daemon restarted on ${base}`);
}

const RELINK_FLAGS = ["--dry-run", "--keep-empty"];

async function relinkSessions(args: string[]): Promise<void> {
  const unknown = args.filter((arg) => !RELINK_FLAGS.includes(arg));
  if (unknown.length > 0) {
    console.log(`unknown option: ${unknown.join(" ")}`);
    console.log(USAGE);
    process.exit(1);
  }
  const config = loadConfig();
  const base = daemonBaseUrl(config.host, config.port);
  const { runRelink } = await import("./relink.ts");
  await runRelink({
    projectsRoot: join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects"),
    dbPath: join(config.dataDir, "kairan.db"),
    pruneEmpty: !args.includes("--keep-empty"),
    dryRun: args.includes("--dry-run"),
    probeDaemon: () => probeDaemon(base),
    stopDaemon: () => shutdownAndWait(base),
    startDaemon: async () => {
      const { DaemonClient } = await import("./mcp/daemon-client.ts");
      await new DaemonClient(config).ensureDaemon();
    },
    log: (message) => console.log(message),
  });
}

async function showStatus(): Promise<void> {
  const config = loadConfig();
  const base = daemonBaseUrl(config.host, config.port);
  try {
    const res = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(2000) });
    const json = (await res.json()) as { app?: string; pid?: number; version?: string };
    if (json.app !== "kairan") {
      console.log(`port ${config.port} is in use by another application`);
      process.exit(1);
    }
    console.log(`kairan daemon running: ${base} (pid ${json.pid}, v${json.version})`);
  } catch {
    console.log("kairan daemon is not running");
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const command = process.argv[2];
  switch (command) {
    case "mcp": {
      const { runMcpServer } = await import("./mcp/server.ts");
      await runMcpServer();
      break;
    }
    case "daemon": {
      const { runDaemon } = await import("./daemon/index.ts");
      await runDaemon();
      break;
    }
    case "restart":
      await restartDaemon();
      break;
    case "stop":
      await stopDaemon();
      break;
    case "status":
      await showStatus();
      break;
    case "relink":
      await relinkSessions(process.argv.slice(3));
      break;
    default:
      console.log(USAGE);
      process.exit(command == null ? 0 : 1);
  }
}

await main();
