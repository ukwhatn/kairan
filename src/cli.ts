#!/usr/bin/env bun
import { loadConfig } from "./config.ts";
import { daemonBaseUrl } from "./shared/url.ts";

const USAGE = `kairan - circulate agent-generated documents to your browser

Usage:
  kairan mcp             Run as stdio MCP server (register this in your agent)
  kairan daemon          Run the web daemon in the foreground (usually spawned automatically)
  kairan restart         Restart the daemon (reflects code/config changes)
  kairan stop            Stop the running daemon
  kairan status          Show daemon status
`;

type DaemonState = "kairan" | "foreign" | "down";

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
    default:
      console.log(USAGE);
      process.exit(command == null ? 0 : 1);
  }
}

await main();
