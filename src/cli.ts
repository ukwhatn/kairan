#!/usr/bin/env bun
import { loadConfig } from "./config.ts";

const USAGE = `kairan - circulate agent-generated documents to your browser

Usage:
  kairan mcp             Run as stdio MCP server (register this in your agent)
  kairan daemon          Run the web daemon in the foreground (usually spawned automatically)
  kairan stop            Stop the running daemon
  kairan status          Show daemon status
`;

async function stopDaemon(): Promise<void> {
  const config = loadConfig();
  const base = `http://${config.host}:${config.port}`;
  try {
    // port を専有しているのが kairan 本人であることを確認してから停止を送る
    // （衝突時に無関係なサービスへ状態変更リクエストを投げないため）
    const res = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(2000) });
    const json = (await res.json().catch(() => null)) as { app?: string } | null;
    if (json?.app !== "kairan") {
      console.log(`port ${config.port} is in use by another application; not stopping it`);
      process.exit(1);
    }
    await fetch(`${base}/api/shutdown`, { method: "POST", signal: AbortSignal.timeout(2000) });
    console.log("kairan daemon stopped");
  } catch {
    console.log("kairan daemon is not running");
  }
}

async function showStatus(): Promise<void> {
  const config = loadConfig();
  const base = `http://${config.host}:${config.port}`;
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
