import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute } from "node:path";
import { createPatch } from "diff";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import type { KairanConfig } from "../config.ts";
import { FAVICON_SVG } from "../shared/favicon.ts";
import { isValidSessionId } from "../shared/session-id.ts";
import type { AskQuestion, KairanEvent } from "../shared/types.ts";
import { daemonBaseUrl, localBaseUrls } from "../shared/url.ts";
import type { Store } from "./db.ts";
import type { Hub } from "./hub.ts";
import type { LocalFileOpener } from "./local-file.ts";
import { askKey, reviewKey, type SignalHub } from "./waiters.ts";

export interface AppDeps {
  store: Store;
  hub: Hub;
  signals: SignalHub;
  config: KairanConfig;
  version: string;
  renderMarkdown: (src: string) => string;
  notify: (title: string, body: string, url?: string) => void;
  openInBrowser: (url: string) => void;
  openLocalFile: LocalFileOpener;
  clientAssets: { js: string; css: string };
  requestShutdown: () => void;
}

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/**
 * Host ヘッダの宛先が loopback か。cloudflare tunnel 等の公開ホスト名で来た
 * リクエストにローカルアプリを起動させないための判定（ポート付きで届く）
 */
export function isLoopbackHost(host: string | undefined): boolean {
  if (host == null) return false;
  const parsed = URL.parse(`http://${host}`);
  if (parsed == null) return false;
  return LOOPBACK_HOSTNAMES.has(parsed.hostname);
}

/** rev 指定つきで落としたファイルが最新版と混ざらないよう、最新以外は rev を名前に残す */
export function downloadFileName(name: string, rev: number, latestRev: number): string {
  if (rev === latestRev) return name;
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return `${name}@rev${rev}`;
  return `${name.slice(0, dot)}@rev${rev}${name.slice(dot)}`;
}

/** 非 ASCII のファイル名でも保存名が壊れないよう RFC 8187 形式を併記する */
export function contentDispositionFor(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  // encodeURIComponent が残す ' ( ) * は RFC 8187 の attr-char に無いため、追加で潰す
  const encoded = encodeURIComponent(fileName).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
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
  // 相対パスは「どこから見た相対か」がデーモン側で決まらないため入口で弾く
  sourcePath: z
    .string()
    .max(4096)
    .refine((path) => isAbsolute(path) && !path.includes("\0"), {
      message: "sourcePath must be an absolute path",
    })
    .nullish(),
});

const labelSchema = z.string().max(200);

const createSessionSchema = z.object({
  id: z
    .string()
    .refine(isValidSessionId, {
      message:
        "session id must match [A-Za-z0-9][A-Za-z0-9._-]{0,63} and must not be a reserved path",
    })
    .optional(),
  label: labelSchema.optional(),
  cwd: z.string().min(1).max(1000).optional(),
  // agent 側のセッション識別子。同じキーで来たら前回のセッションへ戻す
  agentSessionKey: z.string().min(1).max(200).optional(),
});

const anchorSchema = z.object({
  exact: z.string().min(1).max(5000),
  prefix: z.string().max(500),
  suffix: z.string().max(500),
});

const commentCreateSchema = z.object({
  rev: z.number().int().positive(),
  anchor: anchorSchema.nullish(),
  body: z.string().min(1).max(20000),
});

const commentBodySchema = z.object({ body: z.string().min(1).max(20000) });

const replySchema = z.object({
  author: z.enum(["agent", "human"]),
  body: z.string().min(1).max(20000),
  resolve: z.boolean().optional(),
});

const summarySchema = z.object({ summary: z.string().max(20000) });

const askQuestionSchema = z.object({
  id: z.string().min(1).max(64),
  question: z.string().min(1).max(4000),
  header: z.string().max(32).optional(),
  options: z
    .array(
      z.object({
        label: z.string().min(1).max(300),
        description: z.string().max(2000).optional(),
      }),
    )
    .min(1)
    .max(8),
  multiSelect: z.boolean(),
});

const askCreateSchema = z.object({
  sessionId: z.string().min(1),
  fileName: fileNameSchema.optional(),
  questions: z.array(askQuestionSchema).min(1).max(8),
});

const askAnswerSchema = z.object({
  answers: z.array(
    z.object({
      questionId: z.string().min(1).max(64),
      selected: z.array(z.string().max(300)).max(8),
      freeText: z.string().max(20000).nullable(),
    }),
  ),
});

const waitSchema = z.object({
  sessionId: z.string().min(1),
  timeoutMs: z
    .number()
    .int()
    .min(1)
    .max(30 * 60 * 1000)
    .optional(),
});

const askWaitSchema = z.object({
  timeoutMs: z
    .number()
    .int()
    .min(1)
    .max(30 * 60 * 1000)
    .optional(),
});

const SSE_KEEPALIVE_MS = 15_000;

// publish された文書は agent が生成した信頼できない内容を含みうる。allow-same-origin を
// 与えないことで opaque origin になり、同一オリジンとして kairan の API を読み書きする経路
// （なりすましレビュー送信・ローカルファイルを開く API の悪用）が閉じる
const RAW_SANDBOX_HEADERS = {
  "content-security-policy":
    "sandbox allow-scripts allow-popups allow-modals allow-forms allow-downloads",
} as const;

// markdown は `html: true` でレンダリングされ、結果が本体画面の innerHTML に入る。
// つまり publish された文書は `<img onerror=...>` のような inline handler を本体の
// オリジンで走らせられる（/raw の sandbox はこの経路を塞がない）。script-src で
// inline 実行を禁じ、文書から API を叩けないようにする。
// style は shiki / mermaid が inline で吐くため許可し、img は外部画像の表示を保つ
const APP_SHELL_HEADERS = {
  "content-security-policy": [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src * data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "frame-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; "),
} as const;

function appShell(): string {
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>kairan</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link rel="stylesheet" href="/assets/app.css">
<script type="module" src="/assets/app.js"></script>
</head>
<body><div id="app"></div></body>
</html>`;
}

export function createApp(deps: AppDeps): Hono {
  const { store, hub, signals, config, renderMarkdown } = deps;
  const app = new Hono({ strict: false });
  // 「このセッションは一度自動オープン済みか」はデーモンの生存期間だけ持てばよい
  // （再起動後は初回扱いで開き直すのが自然な挙動のため、DB には持たない）
  const openedSessions = new Set<string>();

  const fileUrl = (sessionId: string, fileName: string): string =>
    `${daemonBaseUrl(config.host, config.port)}/${sessionId}/${encodeURIComponent(fileName)}`;
  const sessionUrl = (sessionId: string): string =>
    `${daemonBaseUrl(config.host, config.port)}/${sessionId}`;

  signals.onWaitersChanged = (key, count) => {
    if (!key.startsWith("review:")) return;
    hub.broadcast({
      type: "review:waiting",
      sessionId: key.slice("review:".length),
      waiting: count > 0,
    });
  };

  /**
   * 削除した対象を待っている agent を起こす。commit 後に呼ぶこと
   * （起こされた側は対象の存在を確認し直し、消えていれば "deleted" を返す）
   */
  const releaseWaiters = (sessionId: string, askIds: number[]): void => {
    for (const askId of askIds) signals.notify(askKey(askId));
    signals.notify(reviewKey(sessionId));
  };

  // レビュー依頼・質問は人間の応答が必要なので、見ているタブが無ければ開き直す
  const surfaceToHuman = (sessionId: string, url: string): void => {
    if (config.reopenWhenNoTab && hub.browserCount(sessionId) === 0) {
      deps.openInBrowser(url);
    }
  };

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

  // homeDir はセッションのプロジェクトパスを UI 側で ~ 短縮するために渡す
  app.get("/api/config", (c) =>
    c.json({
      followDefault: config.followDefault,
      homeDir: homedir(),
      editorEnabled: config.editorUrl !== "",
    }),
  );

  app.post("/api/sessions", async (c) => {
    const parsed = createSessionSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const { id, label, cwd, agentSessionKey } = parsed.data;

    // ID の明示指定が最優先（別プロセスから特定のセッションを継続する経路）。
    // 指定が無ければ agent セッションのキーで前回のセッションを探す（resume の復帰）
    const resumeTarget =
      id ??
      (agentSessionKey == null ? null : store.getSessionByAgentSessionKey(agentSessionKey)?.id);
    if (resumeTarget == null) {
      const session = store.createSession({ label, cwd, agentSessionKey });
      hub.broadcast({ type: "session:created", session });
      return c.json(session);
    }
    const existing = store.getSession(resumeTarget);
    const session = store.upsertSession(resumeTarget, { label, cwd, agentSessionKey });
    if (existing == null) {
      hub.broadcast({ type: "session:created", session });
    } else if (existing.status === "archived") {
      hub.broadcast({ type: "session:activated", sessionId: session.id });
    } else {
      // 稼働中セッションの再利用でも cwd・last_active_at が変わるため一覧を更新させる
      hub.broadcast({ type: "session:updated", sessionId: session.id });
    }
    return c.json(session);
  });

  app.post("/api/sessions/:id/label", async (c) => {
    const sessionId = c.req.param("id");
    if (store.getSession(sessionId) == null) return c.json({ error: "unknown session" }, 404);
    const parsed = z.object({ label: labelSchema }).safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    // 空欄で保存されたら「名前なし」に戻す（空文字のラベルを表示させない）
    const label = parsed.data.label.trim();
    const session = store.setSessionLabel(sessionId, label === "" ? null : label);
    hub.broadcast({ type: "session:updated", sessionId });
    return c.json(session);
  });

  app.post("/api/sessions/:id/archive", (c) => {
    const sessionId = c.req.param("id");
    if (store.getSession(sessionId) == null) return c.json({ error: "unknown session" }, 404);
    store.archiveSession(sessionId);
    hub.broadcast({ type: "session:archived", sessionId });
    return c.json({ ok: true });
  });

  app.post("/api/sessions/:id/delete", (c) => {
    const sessionId = c.req.param("id");
    if (store.getSession(sessionId) == null) return c.json({ error: "unknown session" }, 404);
    // 生存申告を先に閉じる。残したままだとデーモンが停止しなくなり、
    // launcher も消えたセッションへ張り直し続ける
    hub.closeAttachments(sessionId);
    const { deletedAskIds } = store.deleteSession(sessionId);
    releaseWaiters(sessionId, deletedAskIds);
    hub.broadcast({ type: "session:deleted", sessionId });
    return c.json({ ok: true });
  });

  app.post("/api/files/:id/delete", (c) => {
    const file = store.getFileById(Number(c.req.param("id")));
    if (file == null) return c.json({ error: "unknown file" }, 404);
    const { deletedAskIds } = store.deleteFile(file.id);
    releaseWaiters(file.sessionId, deletedAskIds);
    hub.broadcast({ type: "file:deleted", sessionId: file.sessionId, fileId: file.id });
    return c.json({ ok: true });
  });

  app.get("/api/sessions", (c) => {
    const includeArchived = c.req.query("include_archived") === "true";
    return c.json(
      store.listSessions(includeArchived).map((session) => ({
        ...session,
        openAskCount: store.listOpenAsks(session.id).length,
        reviewWaiting: signals.waiterCount(reviewKey(session.id)) > 0,
      })),
    );
  });

  app.post("/api/publish", async (c) => {
    const parsed = publishSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const { sessionId, name, format, content, title, open, sourcePath } = parsed.data;

    const session = store.getSession(sessionId);
    if (session == null) return c.json({ error: `unknown session: ${sessionId}` }, 404);
    // 人間が畳んだあとに agent が動き出したら戻す。attach は張りっぱなしなので
    // 再 attach の経路（/api/attach）を通らず、ここで戻さないと隠れたままになる
    if (session.status === "archived") {
      store.activateSession(sessionId);
      hub.broadcast({ type: "session:activated", sessionId });
    }

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

    const result = store.publish(sessionId, name, format, content, title, sourcePath ?? null);
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
        url,
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

    return c.json({
      url,
      sessionId,
      fileId: result.file.id,
      revision: result.revision,
      pendingFeedback: store.countUndeliveredFeedback(sessionId),
    });
  });

  app.get("/api/sessions/:id/files", (c) => {
    const session = store.getSession(c.req.param("id"));
    if (session == null) return c.json({ error: "unknown session" }, 404);
    const askFileIds = new Set(
      store
        .listOpenAsks(session.id)
        .map((ask) => ask.fileId)
        .filter((id) => id != null),
    );
    return c.json(
      store.listFiles(session.id).map((file) => ({
        ...file,
        openCommentCount: store.countOpenComments(file.id),
        draftCommentCount: store.countDraftComments(file.id),
        hasOpenAsk: askFileIds.has(file.id),
      })),
    );
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

  app.get("/api/files/:id/download", (c) => {
    const file = store.getFileById(Number(c.req.param("id")));
    if (file == null) return c.json({ error: "unknown file" }, 404);
    const revParam = c.req.query("rev");
    const rev = revParam == null ? file.latestRev : Number(revParam);
    const content = store.getRevisionContent(file.id, rev);
    if (content == null) return c.json({ error: `unknown revision: ${rev}` }, 404);
    return c.body(content, 200, {
      "content-type":
        file.format === "html" ? "text/html; charset=utf-8" : "text/markdown; charset=utf-8",
      "content-disposition": contentDispositionFor(
        downloadFileName(file.name, rev, file.latestRev),
      ),
    });
  });

  app.post("/api/files/:id/reveal", async (c) => {
    // tunnel 越しの閲覧者にローカルアプリを起動させない
    // （Host ヘッダが無い経路でも判定できるよう、リクエスト URL の host に落とす）
    if (!isLoopbackHost(c.req.header("host") ?? URL.parse(c.req.url)?.host)) {
      return c.json({ error: "local file actions are available only from localhost" }, 403);
    }
    const file = store.getFileById(Number(c.req.param("id")));
    if (file == null) return c.json({ error: "unknown file" }, 404);
    const parsed = z
      .object({ target: z.enum(["finder", "editor"]) })
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);

    const path = store.getFileSourcePath(file.id);
    if (path == null) {
      return c.json({ error: "this document was published without a source file" }, 409);
    }
    if (!existsSync(path)) return c.json({ error: `file no longer exists: ${path}` }, 404);
    try {
      await deps.openLocalFile(parsed.data.target, path);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
    }
    return c.json({ ok: true });
  });

  app.get("/api/attach", (c) => {
    const sessionId = c.req.query("session_id");
    const session = sessionId == null ? null : store.getSession(sessionId);
    if (sessionId == null || session == null) {
      return c.json({ error: "unknown session" }, 404);
    }
    // 終了した agent を人間が畳んだあとでも、生きていれば戻ってきてよい
    // （PC 再起動などで attach し直したケース）
    if (session.status === "archived") {
      store.activateSession(sessionId);
      hub.broadcast({ type: "session:activated", sessionId });
    }
    return streamSSE(c, async (stream) => {
      let closedByServer = false;
      const detach = hub.attach(sessionId, () => {
        closedByServer = true;
        void stream.close();
      });
      stream.onAbort(detach);
      await stream.writeSSE({ event: "attached", data: sessionId });
      while (!stream.aborted && !closedByServer) {
        await stream.sleep(SSE_KEEPALIVE_MS);
        if (stream.aborted || closedByServer) break;
        await stream.writeSSE({ event: "ping", data: "" });
      }
      detach();
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

  // 通知クリック(terminal-notifier -execute)の着地点。opener がタブ再利用を担う
  app.post("/api/focus", async (c) => {
    const parsed = z
      .object({ url: z.string().max(2000) })
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const { url } = parsed.data;
    if (!localBaseUrls(config.port).some((base) => url.startsWith(base))) {
      return c.json({ error: "only kairan's own urls can be opened" }, 400);
    }
    deps.openInBrowser(url);
    return c.json({ ok: true });
  });

  // --- feedback: comments ---

  app.get("/api/files/:id/comments", (c) => {
    const file = store.getFileById(Number(c.req.param("id")));
    if (file == null) return c.json({ error: "unknown file" }, 404);
    return c.json(store.listFileComments(file.id));
  });

  app.post("/api/files/:id/comments", async (c) => {
    const file = store.getFileById(Number(c.req.param("id")));
    if (file == null) return c.json({ error: "unknown file" }, 404);
    const parsed = commentCreateSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const { rev, anchor, body } = parsed.data;
    if (store.getRevisionContent(file.id, rev) == null) {
      return c.json({ error: `unknown revision: ${rev}` }, 400);
    }
    const comment = store.createDraftComment(file.id, rev, anchor ?? null, body);
    hub.broadcast({ type: "feedback:changed", sessionId: file.sessionId, fileId: file.id });
    return c.json(comment);
  });

  const withComment = (c: {
    req: { param: (name: string) => string };
  }): { commentId: number; sessionId: string; fileId: number } | null => {
    const commentId = Number(c.req.param("id"));
    const comment = store.getComment(commentId);
    if (comment == null) return null;
    const file = store.getFileById(comment.fileId);
    if (file == null) return null;
    return { commentId, sessionId: file.sessionId, fileId: file.id };
  };

  app.post("/api/comments/:id/update", async (c) => {
    const target = withComment(c);
    if (target == null) return c.json({ error: "unknown comment" }, 404);
    const parsed = commentBodySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    try {
      const comment = store.updateDraftComment(target.commentId, parsed.data.body);
      hub.broadcast({
        type: "feedback:changed",
        sessionId: target.sessionId,
        fileId: target.fileId,
      });
      return c.json(comment);
    } catch (err) {
      return c.json({ error: String(err) }, 409);
    }
  });

  app.post("/api/comments/:id/delete", (c) => {
    const target = withComment(c);
    if (target == null) return c.json({ error: "unknown comment" }, 404);
    try {
      store.deleteDraftComment(target.commentId);
    } catch (err) {
      return c.json({ error: String(err) }, 409);
    }
    hub.broadcast({ type: "feedback:changed", sessionId: target.sessionId, fileId: target.fileId });
    return c.json({ ok: true });
  });

  app.post("/api/comments/:id/reply", async (c) => {
    const target = withComment(c);
    if (target == null) return c.json({ error: "unknown comment" }, 404);
    const parsed = replySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const { author, body, resolve } = parsed.data;
    try {
      const reply = store.addReply(target.commentId, author, body);
      // resolve は冪等: 人間が先に解決済みでも返信保存を部分成功にしない
      // （409 を返すと agent の再試行で返信が重複する）
      if (resolve === true && author === "agent") {
        if (store.getComment(target.commentId)?.state === "open") {
          store.resolveComment(target.commentId);
        }
      }
      hub.broadcast({
        type: "feedback:changed",
        sessionId: target.sessionId,
        fileId: target.fileId,
      });
      return c.json(reply);
    } catch (err) {
      return c.json({ error: String(err) }, 409);
    }
  });

  app.post("/api/comments/:id/resolve", (c) => {
    const target = withComment(c);
    if (target == null) return c.json({ error: "unknown comment" }, 404);
    try {
      const comment = store.resolveComment(target.commentId);
      hub.broadcast({
        type: "feedback:changed",
        sessionId: target.sessionId,
        fileId: target.fileId,
      });
      return c.json(comment);
    } catch (err) {
      return c.json({ error: String(err) }, 409);
    }
  });

  app.post("/api/comments/:id/reopen", (c) => {
    const target = withComment(c);
    if (target == null) return c.json({ error: "unknown comment" }, 404);
    try {
      const comment = store.reopenComment(target.commentId);
      hub.broadcast({
        type: "feedback:changed",
        sessionId: target.sessionId,
        fileId: target.fileId,
      });
      return c.json(comment);
    } catch (err) {
      return c.json({ error: String(err) }, 409);
    }
  });

  // --- feedback: review draft / submit ---

  app.get("/api/sessions/:id/review", (c) => {
    const session = store.getSession(c.req.param("id"));
    if (session == null) return c.json({ error: "unknown session" }, 404);
    return c.json({
      draft: store.getDraftReview(session.id),
      comments: store.listSessionDraftComments(session.id),
    });
  });

  app.post("/api/sessions/:id/review/summary", async (c) => {
    const session = store.getSession(c.req.param("id"));
    if (session == null) return c.json({ error: "unknown session" }, 404);
    const parsed = summarySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    return c.json(store.setDraftReviewSummary(session.id, parsed.data.summary));
  });

  app.post("/api/sessions/:id/review/submit", (c) => {
    const session = store.getSession(c.req.param("id"));
    if (session == null) return c.json({ error: "unknown session" }, 404);
    const review = store.submitReview(session.id);
    hub.broadcast({ type: "feedback:changed", sessionId: session.id, fileId: null });
    signals.notify(reviewKey(session.id));
    return c.json(review);
  });

  // --- feedback: asks ---

  app.get("/api/sessions/:id/asks", (c) => {
    const session = store.getSession(c.req.param("id"));
    if (session == null) return c.json({ error: "unknown session" }, 404);
    return c.json(store.listOpenAsks(session.id));
  });

  app.post("/api/asks", async (c) => {
    const parsed = askCreateSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const { sessionId, fileName, questions } = parsed.data;
    const session = store.getSession(sessionId);
    if (session == null) return c.json({ error: `unknown session: ${sessionId}` }, 404);
    // 質問も「agent が動いた」合図なので、畳まれていたら戻す（publish と同じ扱い）
    if (session.status === "archived") {
      store.activateSession(sessionId);
      hub.broadcast({ type: "session:activated", sessionId });
    }
    let fileId: number | null = null;
    if (fileName != null) {
      const file = store.getFile(sessionId, fileName);
      if (file == null) return c.json({ error: `unknown file: ${fileName}` }, 404);
      fileId = file.id;
    }
    // timeout 後の再呼び出し（同一質問）は既存カードを増やさず待ち直す
    const existing = store.findOpenAsk(sessionId, questions as AskQuestion[], fileId);
    if (existing != null) return c.json(existing);

    const ask = store.createAsk(sessionId, fileId, questions as AskQuestion[]);
    hub.broadcast({ type: "ask:changed", sessionId });
    const url = fileName != null ? fileUrl(sessionId, fileName) : sessionUrl(sessionId);
    deps.notify(
      "kairan",
      `質問があります (${questions.length}問): セッション ${session.label ?? sessionId}`,
      url,
    );
    surfaceToHuman(sessionId, url);
    return c.json(ask);
  });

  app.post("/api/asks/:id/answer", async (c) => {
    const ask = store.getAsk(Number(c.req.param("id")));
    if (ask == null) return c.json({ error: "unknown ask" }, 404);
    if (ask.status !== "open") return c.json({ error: "ask is not open" }, 409);
    const parsed = askAnswerSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const { answers } = parsed.data;
    for (const question of ask.questions) {
      const answer = answers.find((a) => a.questionId === question.id);
      const answered =
        answer != null && (answer.selected.length > 0 || (answer.freeText ?? "") !== "");
      if (!answered) {
        return c.json({ error: `question "${question.id}" is not answered` }, 400);
      }
    }
    const answered = store.answerAsk(ask.id, answers);
    hub.broadcast({ type: "ask:changed", sessionId: ask.sessionId });
    signals.notify(askKey(ask.id));
    // ask_user が待っていない場合でも request_review / list_feedback 側で回収できるよう起こす
    signals.notify(reviewKey(ask.sessionId));
    return c.json(answered);
  });

  app.post("/api/asks/:id/cancel", (c) => {
    const ask = store.getAsk(Number(c.req.param("id")));
    if (ask == null) return c.json({ error: "unknown ask" }, 404);
    store.cancelAsk(ask.id);
    hub.broadcast({ type: "ask:changed", sessionId: ask.sessionId });
    signals.notify(askKey(ask.id));
    return c.json({ ok: true });
  });

  app.post("/api/asks/:id/wait", async (c) => {
    const askId = Number(c.req.param("id"));
    const ask = store.getAsk(askId);
    if (ask == null) return c.json({ error: "unknown ask" }, 404);
    const parsed = askWaitSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);

    const finish = (): Response | null => {
      const current = store.getAsk(askId);
      // 待っている間に人間が質問ごと削除することがある。404 では「取得に失敗した」と
      // 区別できないため、消えたことが分かる結果を返す
      if (current == null) return c.json({ status: "deleted" });
      if (current.status === "answered") {
        store.markAskDelivered(askId);
        return c.json({ status: "answered", ask: current });
      }
      if (current.status === "cancelled") return c.json({ status: "cancelled" });
      return null;
    };

    const immediate = finish();
    if (immediate != null) return immediate;
    await signals.wait(
      askKey(askId),
      parsed.data.timeoutMs ?? config.feedbackWaitMs,
      c.req.raw.signal,
    );
    return finish() ?? c.json({ status: "pending" });
  });

  // --- feedback: wait / take (MCP ランチャー向け) ---

  app.post("/api/feedback/wait", async (c) => {
    const parsed = waitSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const { sessionId, timeoutMs } = parsed.data;
    const session = store.getSession(sessionId);
    if (session == null) return c.json({ error: `unknown session: ${sessionId}` }, 404);

    if (store.countUndeliveredFeedback(sessionId) > 0) {
      return c.json({ status: "feedback", bundle: store.takeUndeliveredFeedback(sessionId) });
    }
    if (signals.waiterCount(reviewKey(sessionId)) === 0) {
      const url = sessionUrl(sessionId);
      deps.notify("kairan", `レビュー依頼: セッション ${session.label ?? sessionId}`, url);
      surfaceToHuman(sessionId, url);
    }
    await signals.wait(reviewKey(sessionId), timeoutMs ?? config.feedbackWaitMs, c.req.raw.signal);
    if (store.countUndeliveredFeedback(sessionId) > 0) {
      return c.json({ status: "feedback", bundle: store.takeUndeliveredFeedback(sessionId) });
    }
    // 待っている間にセッションごと削除された場合、pending を返すと agent が
    // 「まだレビュー中」と誤認して待ち続ける
    if (store.getSession(sessionId) == null) return c.json({ status: "deleted" });
    return c.json({ status: "pending" });
  });

  app.post("/api/feedback/take", async (c) => {
    const parsed = z
      .object({ sessionId: z.string().min(1) })
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const session = store.getSession(parsed.data.sessionId);
    if (session == null) return c.json({ error: "unknown session" }, 404);
    return c.json({ bundle: store.takeUndeliveredFeedback(session.id) });
  });

  app.get("/raw/:sessionId/:fileName", (c) => {
    const file = store.getFile(c.req.param("sessionId"), c.req.param("fileName"));
    if (file == null) return c.text("not found", 404);
    const revParam = c.req.query("rev");
    const rev = revParam == null ? file.latestRev : Number(revParam);
    const content = store.getRevisionContent(file.id, rev);
    if (content == null) return c.text("not found", 404);
    if (file.format === "html") return c.html(content, 200, RAW_SANDBOX_HEADERS);
    return c.html(
      `<!doctype html><html><head><meta charset="utf-8"><link rel="icon" type="image/svg+xml" href="/favicon.svg"></head><body>${renderMarkdown(content)}</body></html>`,
      200,
      RAW_SANDBOX_HEADERS,
    );
  });

  // catch-all（/:sessionId）より前に置く
  app.get("/favicon.svg", (c) =>
    c.body(FAVICON_SVG, 200, {
      "content-type": "image/svg+xml; charset=utf-8",
      "cache-control": "no-cache",
    }),
  );

  app.get("/assets/app.js", (c) =>
    c.body(deps.clientAssets.js, 200, { "content-type": "text/javascript; charset=utf-8" }),
  );
  app.get("/assets/app.css", (c) =>
    c.body(deps.clientAssets.css, 200, { "content-type": "text/css; charset=utf-8" }),
  );

  app.get("/", (c) => c.html(appShell(), 200, APP_SHELL_HEADERS));
  app.get("/:sessionId", (c) => c.html(appShell(), 200, APP_SHELL_HEADERS));
  app.get("/:sessionId/:fileName", (c) => c.html(appShell(), 200, APP_SHELL_HEADERS));

  return app;
}
