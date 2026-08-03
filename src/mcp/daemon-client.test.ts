import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KairanConfig } from "../config.ts";
import { DaemonClient } from "./daemon-client.ts";

function testConfig(dataDir: string): KairanConfig {
  return {
    port: 5766,
    host: "127.0.0.1",
    dataDir,
    autoOpen: "session-first",
    reopenWhenNoTab: true,
    notifications: true,
    notifyOn: "all",
    openCommand: "open",
    followDefault: true,
    shutdownGraceMs: 5000,
    reuseTab: true,
  };
}

function tempDataDir(): string {
  return mkdtempSync(join(tmpdir(), "kairan-test-"));
}

const aliveHealthz = new Response(JSON.stringify({ app: "kairan", pid: 1, version: "0.0.0" }), {
  headers: { "content-type": "application/json" },
});

describe("ensureDaemon", () => {
  test("does not spawn when daemon is already healthy", async () => {
    let spawned = 0;
    const client = new DaemonClient(testConfig(tempDataDir()), {
      fetchFn: async () => aliveHealthz.clone(),
      spawnDaemon: () => {
        spawned++;
      },
      pollIntervalMs: 1,
    });
    await client.ensureDaemon();
    expect(spawned).toBe(0);
  });

  test("spawns and waits until healthz responds", async () => {
    let spawned = 0;
    let alive = false;
    const client = new DaemonClient(testConfig(tempDataDir()), {
      fetchFn: async () => {
        if (!alive) throw new Error("connection refused");
        return aliveHealthz.clone();
      },
      spawnDaemon: () => {
        spawned++;
        alive = true;
      },
      pollIntervalMs: 1,
    });
    await client.ensureDaemon();
    expect(spawned).toBe(1);
  });

  test("fails clearly when the port is occupied by another app", async () => {
    const client = new DaemonClient(testConfig(tempDataDir()), {
      fetchFn: async () =>
        new Response("<html>somebody else</html>", { headers: { "content-type": "text/html" } }),
      spawnDaemon: () => {},
      pollIntervalMs: 1,
    });
    expect(client.ensureDaemon()).rejects.toThrow(/port/i);
  });

  test("times out when daemon never becomes healthy", async () => {
    const client = new DaemonClient(testConfig(tempDataDir()), {
      fetchFn: async () => {
        throw new Error("connection refused");
      },
      spawnDaemon: () => {},
      pollIntervalMs: 1,
      spawnTimeoutMs: 30,
    });
    expect(client.ensureDaemon()).rejects.toThrow(/did not become healthy/i);
  });

  test("concurrent ensureDaemon calls spawn only once (spawn lock)", async () => {
    const dataDir = tempDataDir();
    let spawned = 0;
    let alive = false;
    const makeClient = () =>
      new DaemonClient(testConfig(dataDir), {
        fetchFn: async () => {
          if (!alive) throw new Error("connection refused");
          return aliveHealthz.clone();
        },
        spawnDaemon: () => {
          spawned++;
          setTimeout(() => {
            alive = true;
          }, 20);
        },
        pollIntervalMs: 5,
      });
    await Promise.all([makeClient().ensureDaemon(), makeClient().ensureDaemon()]);
    expect(spawned).toBe(1);
  });
});

describe("api calls", () => {
  test("createSession and publish talk to the daemon api", async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    const client = new DaemonClient(testConfig(tempDataDir()), {
      fetchFn: async (url, init) => {
        const path = new URL(String(url)).pathname;
        if (path === "/healthz") return aliveHealthz.clone();
        requests.push({
          url: String(url),
          body: init?.body == null ? null : JSON.parse(String(init.body)),
        });
        if (path === "/api/sessions") {
          return Response.json({ id: "abc12345", name: null, status: "active" });
        }
        if (path === "/api/publish") {
          return Response.json({
            url: "http://127.0.0.1:5766/abc12345/a.md",
            sessionId: "abc12345",
            fileId: 1,
            revision: 1,
          });
        }
        return new Response("not found", { status: 404 });
      },
      spawnDaemon: () => {},
      pollIntervalMs: 1,
    });

    const session = await client.createSession();
    expect(session.id).toBe("abc12345");
    const published = await client.publish({
      sessionId: session.id,
      name: "a.md",
      format: "markdown",
      content: "# hi",
    });
    expect(published.revision).toBe(1);
    expect(requests.some((r) => r.url.endsWith("/api/publish"))).toBe(true);
  });

  test("api error responses become thrown errors with the server message", async () => {
    const client = new DaemonClient(testConfig(tempDataDir()), {
      fetchFn: async (url) => {
        if (String(url).endsWith("/healthz")) return aliveHealthz.clone();
        return Response.json({ error: "unknown session: xyz" }, { status: 404 });
      },
      spawnDaemon: () => {},
      pollIntervalMs: 1,
    });
    expect(
      client.publish({ sessionId: "xyz", name: "a.md", format: "markdown", content: "x" }),
    ).rejects.toThrow(/unknown session/);
  });
});
