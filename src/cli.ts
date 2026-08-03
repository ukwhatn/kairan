#!/usr/bin/env bun

const USAGE = `kairan - circulate agent-generated documents to your browser

Usage:
  kairan mcp             Run as stdio MCP server (register this in your agent)
  kairan daemon          Run the web daemon (usually spawned automatically)
  kairan stop            Stop the running daemon
  kairan status          Show daemon status
`;

async function main(): Promise<void> {
  const command = process.argv[2];
  switch (command) {
    case "mcp":
    case "daemon":
    case "stop":
    case "status":
      throw new Error(`not implemented: ${command}`);
    default:
      console.log(USAGE);
      process.exit(command == null ? 0 : 1);
  }
}

await main();
