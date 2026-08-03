import { describe, expect, test } from "bun:test";
import type { KairanConfig } from "../config.ts";
import type { Session } from "../shared/types.ts";
import { Store } from "./db.ts";
import { Hub } from "./hub.ts";
import { createApp, decideOpen } from "./routes.ts";

function testConfig(overrides: Partial<KairanConfig> = {}): KairanConfig {
  return {
    port: 5766,
    host: "127.0.0.1",
    dataDir: "/tmp/unused",
    autoOpen: "session-first",
    reopenWhenNoTab: false,
    notifications: true,
    notifyOn: "all",
    openCommand: "open",
    followDefault: true,
    shutdownGraceMs: 5000,
    ...overrides,
  };
}

function makeApp(configOverrides: Partial<KairanConfig> = {}) {
  const store = Store.openInMemory();
  const hub = new Hub();
  const opened: string[] = [];
  const notified: Array<{ title: string; body: string; url: string | undefined }> = [];
  let shutdownRequested = false;
  const app = createApp({
    store,
    hub,
    config: testConfig(configOverrides),
    version: "0.0.0-test",
    renderMarkdown: (src) => `<rendered>${src}</rendered>`,
    notify: (title, body, url) => notified.push({ title, body, url }),
    openInBrowser: (url) => opened.push(url),
    clientAssets: { js: "// js", css: "/* css */" },
    requestShutdown: () => {
      shutdownRequested = true;
    },
  });
  return {
    app,
    store,
    hub,
    opened,
    notified,
    isShutdownRequested: () => shutdownRequested,
  };
}

async function createSession(app: ReturnType<typeof makeApp>["app"], name?: string) {
  const res = await app.request("/api/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(name == null ? {} : { name }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as Session;
}

async function publish(
  app: ReturnType<typeof makeApp>["app"],
  body: Record<string, unknown>,
): Promise<Response> {
  return app.request("/api/publish", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("healthz", () => {
  test("identifies itself as kairan", async () => {
    const { app } = makeApp();
    const res = await app.request("/healthz");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { app: string; version: string };
    expect(json.app).toBe("kairan");
    expect(json.version).toBe("0.0.0-test");
  });
});

describe("session creation", () => {
  test("anonymous sessions get distinct ids", async () => {
    const { app } = makeApp();
    const a = await createSession(app);
    const b = await createSession(app);
    expect(a.id).not.toBe(b.id);
  });

  test("named session is reused on second create", async () => {
    const { app } = makeApp();
    const a = await createSession(app, "review");
    const b = await createSession(app, "review");
    expect(b.id).toBe(a.id);
  });
});

describe("publish", () => {
  test("first publish returns url with session and encoded file name", async () => {
    const { app } = makeApp();
    const session = await createSession(app);
    const res = await publish(app, {
      sessionId: session.id,
      name: "レポート.md",
      format: "markdown",
      content: "# hi",
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { url: string; revision: number };
    expect(json.revision).toBe(1);
    expect(json.url).toBe(
      `http://127.0.0.1:5766/${session.id}/${encodeURIComponent("レポート.md")}`,
    );
  });

  test("publish to unknown session returns 404", async () => {
    const { app } = makeApp();
    const res = await publish(app, {
      sessionId: "missing1",
      name: "a.md",
      format: "markdown",
      content: "x",
    });
    expect(res.status).toBe(404);
  });

  test("file name containing a slash is rejected", async () => {
    const { app } = makeApp();
    const session = await createSession(app);
    const res = await publish(app, {
      sessionId: session.id,
      name: "a/b.md",
      format: "markdown",
      content: "x",
    });
    expect(res.status).toBe(400);
  });

  test("notifies on every publish when notifyOn=all, with the file url", async () => {
    const { app, notified } = makeApp();
    const session = await createSession(app);
    await publish(app, { sessionId: session.id, name: "a.md", format: "markdown", content: "1" });
    await publish(app, { sessionId: session.id, name: "a.md", format: "markdown", content: "2" });
    expect(notified).toHaveLength(2);
    expect(notified[0]?.url).toBe(`http://127.0.0.1:5766/${session.id}/a.md`);
  });

  test("notifies only on new file when notifyOn=new-file", async () => {
    const { app, notified } = makeApp({ notifyOn: "new-file" });
    const session = await createSession(app);
    await publish(app, { sessionId: session.id, name: "a.md", format: "markdown", content: "1" });
    await publish(app, { sessionId: session.id, name: "a.md", format: "markdown", content: "2" });
    expect(notified).toHaveLength(1);
  });

  test("session-first: opens browser on first publish only (reopenWhenNoTab=false)", async () => {
    const { app, opened } = makeApp();
    const session = await createSession(app);
    await publish(app, { sessionId: session.id, name: "a.md", format: "markdown", content: "1" });
    await publish(app, { sessionId: session.id, name: "b.md", format: "markdown", content: "2" });
    expect(opened).toHaveLength(1);
  });

  test("same name with different format is rejected with 409", async () => {
    const { app } = makeApp();
    const session = await createSession(app);
    await publish(app, { sessionId: session.id, name: "a.md", format: "markdown", content: "1" });
    const res = await publish(app, {
      sessionId: session.id,
      name: "a.md",
      format: "html",
      content: "<p>2</p>",
    });
    expect(res.status).toBe(409);
  });

  test("cross-origin mutating request is rejected, same-origin and no-origin pass", async () => {
    const { app } = makeApp();
    const make = (origin?: string) =>
      app.request("/api/shutdown", {
        method: "POST",
        headers: {
          host: "127.0.0.1:5766",
          ...(origin == null ? {} : { origin }),
        },
      });
    expect((await make("https://evil.example")).status).toBe(403);
    expect((await make("http://127.0.0.1:5766")).status).toBe(200);
    expect((await make()).status).toBe(200);
  });

  test("explicit open=false suppresses auto open", async () => {
    const { app, opened } = makeApp();
    const session = await createSession(app);
    await publish(app, {
      sessionId: session.id,
      name: "a.md",
      format: "markdown",
      content: "1",
      open: false,
    });
    expect(opened).toHaveLength(0);
  });
});

describe("read APIs", () => {
  test("files list, revisions, content and diff round-trip", async () => {
    const { app } = makeApp();
    const session = await createSession(app);
    await publish(app, {
      sessionId: session.id,
      name: "a.md",
      format: "markdown",
      content: "line1\n",
    });
    await publish(app, {
      sessionId: session.id,
      name: "a.md",
      format: "markdown",
      content: "line1\nline2\n",
    });

    const filesRes = await app.request(`/api/sessions/${session.id}/files`);
    const files = (await filesRes.json()) as Array<{ id: number; latestRev: number }>;
    expect(files).toHaveLength(1);
    const fileId = files[0]?.id;
    expect(files[0]?.latestRev).toBe(2);

    const revsRes = await app.request(`/api/files/${fileId}/revisions`);
    const revs = (await revsRes.json()) as Array<{ rev: number }>;
    expect(revs.map((r) => r.rev)).toEqual([1, 2]);

    const contentRes = await app.request(`/api/files/${fileId}/content?rev=1`);
    const content = (await contentRes.json()) as { content: string; html: string | null };
    expect(content.content).toBe("line1\n");
    expect(content.html).toBe("<rendered>line1\n</rendered>");

    const diffRes = await app.request(`/api/files/${fileId}/diff?from=1&to=2`);
    expect(diffRes.status).toBe(200);
    const diffText = await diffRes.text();
    expect(diffText).toContain("+line2");
  });

  test("content of latest revision when rev omitted", async () => {
    const { app } = makeApp();
    const session = await createSession(app);
    await publish(app, { sessionId: session.id, name: "a.md", format: "markdown", content: "v1" });
    await publish(app, { sessionId: session.id, name: "a.md", format: "markdown", content: "v2" });
    const files = (await (await app.request(`/api/sessions/${session.id}/files`)).json()) as Array<{
      id: number;
    }>;
    const res = await app.request(`/api/files/${files[0]?.id}/content`);
    const json = (await res.json()) as { content: string; rev: number };
    expect(json.rev).toBe(2);
    expect(json.content).toBe("v2");
  });

  test("raw html file is served as text/html", async () => {
    const { app } = makeApp();
    const session = await createSession(app);
    await publish(app, {
      sessionId: session.id,
      name: "page.html",
      format: "html",
      content: "<h1>raw</h1>",
    });
    const res = await app.request(`/raw/${session.id}/page.html`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toBe("<h1>raw</h1>");
  });

  test("unknown file returns 404", async () => {
    const { app } = makeApp();
    const res = await app.request("/api/files/9999/content");
    expect(res.status).toBe(404);
  });
});

describe("attach", () => {
  test("attach reactivates an archived session", async () => {
    const { app, store } = makeApp();
    const session = await createSession(app);
    store.archiveSession(session.id);
    const res = await app.request(`/api/attach?session_id=${session.id}`);
    expect(res.status).toBe(200);
    expect(store.getSession(session.id)?.status).toBe("active");
    await res.body?.cancel();
  });

  test("attach to unknown session returns 404", async () => {
    const { app } = makeApp();
    const res = await app.request("/api/attach?session_id=nosuch");
    expect(res.status).toBe(404);
  });
});

describe("shell and shutdown", () => {
  test("deep link paths serve the app shell", async () => {
    const { app } = makeApp();
    for (const path of ["/", "/somesession/", "/somesession/file.md"]) {
      const res = await app.request(path);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('id="app"');
    }
  });

  test("POST /api/shutdown triggers the callback", async () => {
    const { app, isShutdownRequested } = makeApp();
    const res = await app.request("/api/shutdown", { method: "POST" });
    expect(res.status).toBe(200);
    expect(isShutdownRequested()).toBe(true);
  });
});

describe("decideOpen", () => {
  const base = {
    explicit: undefined,
    autoOpen: "session-first" as const,
    reopenWhenNoTab: true,
    alreadyOpened: false,
    browserTabs: 0,
  };

  test("explicit flag always wins", () => {
    expect(decideOpen({ ...base, explicit: true, autoOpen: "never" })).toBe(true);
    expect(decideOpen({ ...base, explicit: false, autoOpen: "always" })).toBe(false);
  });

  test("always / never modes", () => {
    expect(decideOpen({ ...base, autoOpen: "always", alreadyOpened: true, browserTabs: 3 })).toBe(
      true,
    );
    expect(decideOpen({ ...base, autoOpen: "never" })).toBe(false);
  });

  test("session-first: opens first time, then only when no tab is watching", () => {
    expect(decideOpen(base)).toBe(true);
    expect(decideOpen({ ...base, alreadyOpened: true, browserTabs: 1 })).toBe(false);
    expect(decideOpen({ ...base, alreadyOpened: true, browserTabs: 0 })).toBe(true);
    expect(
      decideOpen({ ...base, alreadyOpened: true, browserTabs: 0, reopenWhenNoTab: false }),
    ).toBe(false);
  });
});
