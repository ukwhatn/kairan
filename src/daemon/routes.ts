import { createPatch } from "diff";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import type { KairanConfig } from "../config.ts";
import type { KairanEvent } from "../shared/types.ts";
import type { Store } from "./db.ts";
import type { Hub } from "./hub.ts";

export interface AppDeps {
  store: Store;
  hub: Hub;
  config: KairanConfig;
  version: string;
  renderMarkdown: (src: string) => string;
  notify: (title: string, body: string) => void;
  openInBrowser: (url: string) => void;
  clientAssets: { js: string; css: string };
  requestShutdown: () => void;
}

interface OpenDecisionInput {
  explicit: boolean | undefined;
  autoOpen: KairanConfig["autoOpen"];
  reopenWhenNoTab: boolean;
  alreadyOpened: boolean;
  browserTabs: number;
}

export function decideOpen(input: OpenDecisionInput): boolean {
  if (input.explicit != null) return input.explicit;
  switch (input.autoOpen) {
    case "always":
      return true;
    case "never":
      return false;
    case "session-first":
      if (!input.alreadyOpened) return true;
      return input.reopenWhenNoTab && input.browserTabs === 0;
  }
}

const fileNameSchema = z
  .string()
  .min(1)
  .max(200)
  .refine((name) => !name.includes("/") && !name.includes("\\") && name !== "." && name !== "..", {
    message: "file name must not contain path separators",
  });

const publishSchema = z.object({
  sessionId: z.string().min(1),
  name: fileNameSchema,
  format: z.enum(["markdown", "html"]),
  content: z.string(),
  title: z.string().max(500).optional(),
  open: z.boolean().optional(),
});

const createSessionSchema = z.object({
  name: z.string().min(1).max(100).optional(),
});

const SSE_KEEPALIVE_MS = 15_000;

function appShell(): string {
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>kairan</title>
<link rel="stylesheet" href="/assets/app.css">
<script type="module" src="/assets/app.js"></script>
</head>
<body><div id="app"></div></body>
</html>`;
}

export function createApp(deps: AppDeps): Hono {
  const { store, hub, config, renderMarkdown } = deps;
  const app = new Hono({ strict: false });
  // 「このセッションは一度自動オープン済みか」はデーモンの生存期間だけ持てばよい
  // （再起動後は初回扱いで開き直すのが自然な挙動のため、DB には持たない）
  const openedSessions = new Set<string>();

  const baseUrl = (): string => {
    const host = config.host === "::1" ? "[::1]" : config.host;
    return `http://${host}:${config.port}`;
  };
  const fileUrl = (sessionId: string, fileName: string): string =>
    `${baseUrl()}/${sessionId}/${encodeURIComponent(fileName)}`;

  // loopback bind でもブラウザ経由の CSRF は防げないため、状態変更系は
  // cross-origin を拒否する。Origin ヘッダの無い呼び出し（MCPランチャー・curl）は通す
  app.use("/api/*", async (c, next) => {
    if (c.req.method !== "GET") {
      const origin = c.req.header("origin");
      if (origin != null) {
        const originHost = URL.canParse(origin) ? new URL(origin).host : null;
        if (originHost == null || originHost !== c.req.header("host")) {
          return c.json({ error: "cross-origin request rejected" }, 403);
        }
      }
    }
    await next();
  });

  app.get("/healthz", (c) => c.json({ app: "kairan", pid: process.pid, version: deps.version }));

  app.get("/api/config", (c) => c.json({ followDefault: config.followDefault }));

  app.post("/api/sessions", async (c) => {
    const parsed = createSessionSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const { name } = parsed.data;

    if (name == null) {
      const session = store.createSession();
      hub.broadcast({ type: "session:created", session });
      return c.json(session);
    }
    const existing = store.getSessionByName(name);
    const session = store.upsertNamedSession(name);
    if (existing == null) {
      hub.broadcast({ type: "session:created", session });
    } else if (existing.status === "archived") {
      hub.broadcast({ type: "session:activated", sessionId: session.id });
    }
    return c.json(session);
  });

  app.get("/api/sessions", (c) => {
    const includeArchived = c.req.query("include_archived") === "true";
    return c.json(store.listSessions(includeArchived));
  });

  app.post("/api/publish", async (c) => {
    const parsed = publishSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const { sessionId, name, format, content, title, open } = parsed.data;

    const session = store.getSession(sessionId);
    if (session == null) return c.json({ error: `unknown session: ${sessionId}` }, 404);

    const existingFile = store.getFile(sessionId, name);
    if (existingFile != null && existingFile.format !== format) {
      return c.json(
        {
          error:
            `"${name}" already exists as ${existingFile.format}. ` +
            "Revisions share one format; publish under a different name to change format",
        },
        409,
      );
    }

    const result = store.publish(sessionId, name, format, content, title);
    const url = fileUrl(sessionId, name);

    hub.broadcast({
      type: "file:published",
      sessionId,
      fileName: name,
      fileId: result.file.id,
      revision: result.revision,
      isNew: result.isNew,
      title: result.file.title,
    });

    if (config.notifyOn === "all" || result.isNew) {
      const label = result.file.title ?? name;
      deps.notify(
        "kairan",
        result.isNew ? `新着: ${label}` : `更新 (rev ${result.revision}): ${label}`,
      );
    }

    const shouldOpen = decideOpen({
      explicit: open,
      autoOpen: config.autoOpen,
      reopenWhenNoTab: config.reopenWhenNoTab,
      alreadyOpened: openedSessions.has(sessionId),
      browserTabs: hub.browserCount(sessionId),
    });
    if (shouldOpen) {
      openedSessions.add(sessionId);
      deps.openInBrowser(url);
    }

    return c.json({ url, sessionId, fileId: result.file.id, revision: result.revision });
  });

  app.get("/api/sessions/:id/files", (c) => {
    const session = store.getSession(c.req.param("id"));
    if (session == null) return c.json({ error: "unknown session" }, 404);
    return c.json(store.listFiles(session.id));
  });

  app.get("/api/files/:id/revisions", (c) => {
    const file = store.getFileById(Number(c.req.param("id")));
    if (file == null) return c.json({ error: "unknown file" }, 404);
    return c.json(store.listRevisions(file.id));
  });

  app.get("/api/files/:id/content", (c) => {
    const file = store.getFileById(Number(c.req.param("id")));
    if (file == null) return c.json({ error: "unknown file" }, 404);
    const revParam = c.req.query("rev");
    const rev = revParam == null ? file.latestRev : Number(revParam);
    const content = store.getRevisionContent(file.id, rev);
    if (content == null) return c.json({ error: `unknown revision: ${rev}` }, 404);
    return c.json({
      file,
      rev,
      content,
      html: file.format === "markdown" ? renderMarkdown(content) : null,
    });
  });

  app.get("/api/files/:id/diff", (c) => {
    const file = store.getFileById(Number(c.req.param("id")));
    if (file == null) return c.json({ error: "unknown file" }, 404);
    const from = Number(c.req.query("from"));
    const to = Number(c.req.query("to"));
    const oldContent = store.getRevisionContent(file.id, from);
    const newContent = store.getRevisionContent(file.id, to);
    if (oldContent == null || newContent == null) {
      return c.json({ error: "unknown revision" }, 404);
    }
    const patch = createPatch(file.name, oldContent, newContent, `rev ${from}`, `rev ${to}`);
    return c.text(patch);
  });

  app.get("/api/attach", (c) => {
    const sessionId = c.req.query("session_id");
    const session = sessionId == null ? null : store.getSession(sessionId);
    if (sessionId == null || session == null) {
      return c.json({ error: "unknown session" }, 404);
    }
    // デーモン再起動後の再attach（起動時に全セッションがarchive補正されるため）
    if (session.status === "archived") {
      store.activateSession(sessionId);
      hub.broadcast({ type: "session:activated", sessionId });
    }
    return streamSSE(c, async (stream) => {
      const detach = hub.attach(sessionId);
      stream.onAbort(detach);
      await stream.writeSSE({ event: "attached", data: sessionId });
      while (!stream.aborted) {
        await stream.sleep(SSE_KEEPALIVE_MS);
        await stream.writeSSE({ event: "ping", data: "" });
      }
    });
  });

  app.get("/api/events", (c) => {
    const sessionId = c.req.query("session") ?? null;
    return streamSSE(c, async (stream) => {
      const remove = hub.addBrowser(sessionId, (event: KairanEvent) => {
        void stream.writeSSE({ event: event.type, data: JSON.stringify(event) });
      });
      stream.onAbort(remove);
      while (!stream.aborted) {
        await stream.sleep(SSE_KEEPALIVE_MS);
        await stream.writeSSE({ event: "ping", data: "" });
      }
    });
  });

  app.post("/api/shutdown", (c) => {
    deps.requestShutdown();
    return c.json({ ok: true });
  });

  app.get("/raw/:sessionId/:fileName", (c) => {
    const file = store.getFile(c.req.param("sessionId"), c.req.param("fileName"));
    if (file == null) return c.text("not found", 404);
    const revParam = c.req.query("rev");
    const rev = revParam == null ? file.latestRev : Number(revParam);
    const content = store.getRevisionContent(file.id, rev);
    if (content == null) return c.text("not found", 404);
    if (file.format === "html") return c.html(content);
    return c.html(
      `<!doctype html><html><head><meta charset="utf-8"></head><body>${renderMarkdown(content)}</body></html>`,
    );
  });

  app.get("/assets/app.js", (c) =>
    c.body(deps.clientAssets.js, 200, { "content-type": "text/javascript; charset=utf-8" }),
  );
  app.get("/assets/app.css", (c) =>
    c.body(deps.clientAssets.css, 200, { "content-type": "text/css; charset=utf-8" }),
  );

  app.get("/", (c) => c.html(appShell()));
  app.get("/:sessionId", (c) => c.html(appShell()));
  app.get("/:sessionId/:fileName", (c) => c.html(appShell()));

  return app;
}
