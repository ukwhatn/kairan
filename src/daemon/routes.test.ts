import { describe, expect, test } from "bun:test";
import type { KairanConfig } from "../config.ts";
import type { Ask, FeedbackBundle, FileComment, Review, Session } from "../shared/types.ts";
import { Store } from "./db.ts";
import { Hub } from "./hub.ts";
import { createApp, decideOpen } from "./routes.ts";
import { SignalHub } from "./waiters.ts";

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
    reuseTab: true,
    feedbackWaitMs: 20 * 60 * 1000,
    ...overrides,
  };
}

function makeApp(configOverrides: Partial<KairanConfig> = {}) {
  const store = Store.openInMemory();
  const hub = new Hub();
  const signals = new SignalHub();
  const opened: string[] = [];
  const notified: Array<{ title: string; body: string; url: string | undefined }> = [];
  let shutdownRequested = false;
  const app = createApp({
    store,
    hub,
    signals,
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
    signals,
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

  test("reusing an active named session broadcasts session:updated (cwd regrouping)", async () => {
    const { app, hub } = makeApp();
    const events: string[] = [];
    hub.addBrowser(null, (event) => events.push(event.type));
    const make = (cwd: string) =>
      app.request("/api/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "review", cwd }),
      });
    await make("/proj/a");
    await make("/proj/b");
    expect(events).toEqual(["session:created", "session:updated"]);
  });

  test("session cwd is stored and returned in the sessions list", async () => {
    const { app } = makeApp();
    const created = (await (
      await app.request("/api/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cwd: "/Users/me/workspace/proj" }),
      })
    ).json()) as Session;
    expect(created.cwd).toBe("/Users/me/workspace/proj");
    const listed = (await (await app.request("/api/sessions")).json()) as Session[];
    expect(listed[0]?.cwd).toBe("/Users/me/workspace/proj");
  });

  test("config exposes homeDir for path shortening", async () => {
    const { app } = makeApp();
    const config = (await (await app.request("/api/config")).json()) as {
      homeDir: string | null;
    };
    expect(typeof config.homeDir).toBe("string");
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

describe("focus", () => {
  test("own url is routed to the opener", async () => {
    const { app, opened } = makeApp();
    const res = await app.request("/api/focus", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "http://localhost:5766/abc12345/report.md" }),
    });
    expect(res.status).toBe(200);
    expect(opened).toEqual(["http://localhost:5766/abc12345/report.md"]);
  });

  test("non-kairan url is rejected", async () => {
    const { app, opened } = makeApp();
    const res = await app.request("/api/focus", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://evil.example/phish" }),
    });
    expect(res.status).toBe(400);
    expect(opened).toHaveLength(0);
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

async function postJson(
  app: ReturnType<typeof makeApp>["app"],
  path: string,
  body?: Record<string, unknown>,
): Promise<Response> {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
}

const testAnchor = { exact: "本文", prefix: "# 見出し\n", suffix: "です" };
const testQuestions = [
  {
    id: "q1",
    question: "どちらの方針にしますか?",
    options: [{ label: "案1", description: "説明1" }, { label: "案2" }],
    multiSelect: false,
  },
];

async function seedSessionFile(app: ReturnType<typeof makeApp>["app"]) {
  const session = await createSession(app);
  const res = await publish(app, {
    sessionId: session.id,
    name: "report.md",
    format: "markdown",
    content: "# 見出し\n本文です\n",
  });
  const { fileId } = (await res.json()) as { fileId: number };
  return { session, fileId };
}

describe("comment api", () => {
  test("draft comment create/list/update/delete round-trip", async () => {
    const { app } = makeApp();
    const { fileId } = await seedSessionFile(app);
    const created = (await (
      await postJson(app, `/api/files/${fileId}/comments`, {
        rev: 1,
        anchor: testAnchor,
        body: "ここ直して",
      })
    ).json()) as FileComment;
    expect(created.state).toBe("draft");

    await postJson(app, `/api/comments/${created.id}/update`, { body: "修正希望" });
    const listed = (await (
      await app.request(`/api/files/${fileId}/comments`)
    ).json()) as FileComment[];
    expect(listed[0]?.body).toBe("修正希望");

    expect((await postJson(app, `/api/comments/${created.id}/delete`)).status).toBe(200);
    expect(
      (await (await app.request(`/api/files/${fileId}/comments`)).json()) as FileComment[],
    ).toHaveLength(0);
  });

  test("comment on unknown revision is rejected", async () => {
    const { app } = makeApp();
    const { fileId } = await seedSessionFile(app);
    const res = await postJson(app, `/api/files/${fileId}/comments`, {
      rev: 99,
      anchor: null,
      body: "x",
    });
    expect(res.status).toBe(400);
  });

  test("reply with resolve=true to an already-resolved comment succeeds idempotently", async () => {
    const { app, store } = makeApp();
    const { session, fileId } = await seedSessionFile(app);
    const comment = store.createDraftComment(fileId, 1, null, "x");
    store.submitReview(session.id);
    store.resolveComment(comment.id);

    const res = await postJson(app, `/api/comments/${comment.id}/reply`, {
      author: "agent",
      body: "対応済みでした",
      resolve: true,
    });
    expect(res.status).toBe(200);
    const updated = store.getComment(comment.id);
    expect(updated?.state).toBe("resolved");
    expect(updated?.replies).toHaveLength(1);
  });

  test("ask with the same questions but a different file gets its own card", async () => {
    const { app } = makeApp();
    const { session } = await seedSessionFile(app);
    const sessionWide = (await (
      await postJson(app, "/api/asks", { sessionId: session.id, questions: testQuestions })
    ).json()) as Ask;
    const fileScoped = (await (
      await postJson(app, "/api/asks", {
        sessionId: session.id,
        fileName: "report.md",
        questions: testQuestions,
      })
    ).json()) as Ask;
    expect(fileScoped.id).not.toBe(sessionWide.id);
    const listed = (await (await app.request(`/api/sessions/${session.id}/asks`)).json()) as Ask[];
    expect(listed).toHaveLength(2);
  });

  test("agent reply with resolve=true resolves the comment", async () => {
    const { app, store } = makeApp();
    const { session, fileId } = await seedSessionFile(app);
    const comment = store.createDraftComment(fileId, 1, null, "全体コメント");
    store.submitReview(session.id);

    const res = await postJson(app, `/api/comments/${comment.id}/reply`, {
      author: "agent",
      body: "対応しました",
      resolve: true,
    });
    expect(res.status).toBe(200);
    const updated = store.getComment(comment.id);
    expect(updated?.state).toBe("resolved");
    expect(updated?.replies[0]?.body).toBe("対応しました");

    expect((await postJson(app, `/api/comments/${comment.id}/reopen`)).status).toBe(200);
    expect(store.getComment(comment.id)?.state).toBe("open");
  });
});

describe("review api", () => {
  test("summary draft is persisted and review submit wakes a pending wait", async () => {
    const { app } = makeApp();
    const { session, fileId } = await seedSessionFile(app);
    await postJson(app, `/api/files/${fileId}/comments`, {
      rev: 1,
      anchor: null,
      body: "気になる",
    });
    await postJson(app, `/api/sessions/${session.id}/review/summary`, { summary: "概ねOK" });

    const draft = (await (await app.request(`/api/sessions/${session.id}/review`)).json()) as {
      draft: Review | null;
      comments: FileComment[];
    };
    expect(draft.draft?.summary).toBe("概ねOK");
    expect(draft.comments).toHaveLength(1);

    const waiting = postJson(app, "/api/feedback/wait", { sessionId: session.id, timeoutMs: 3000 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await postJson(app, `/api/sessions/${session.id}/review/submit`)).status).toBe(200);

    const result = (await (await waiting).json()) as { status: string; bundle: FeedbackBundle };
    expect(result.status).toBe("feedback");
    expect(result.bundle.reviews[0]?.review.summary).toBe("概ねOK");
    expect(result.bundle.reviews[0]?.comments[0]?.fileName).toBe("report.md");
  });

  test("wait returns immediately when undelivered feedback already exists", async () => {
    const { app, store } = makeApp();
    const { session } = await seedSessionFile(app);
    store.submitReview(session.id);
    const res = await postJson(app, "/api/feedback/wait", { sessionId: session.id, timeoutMs: 5 });
    const json = (await res.json()) as { status: string };
    expect(json.status).toBe("feedback");
  });

  test("wait times out with status pending", async () => {
    const { app } = makeApp();
    const { session } = await seedSessionFile(app);
    const res = await postJson(app, "/api/feedback/wait", { sessionId: session.id, timeoutMs: 5 });
    expect(((await res.json()) as { status: string }).status).toBe("pending");
  });

  test("take returns the bundle without waiting", async () => {
    const { app, store } = makeApp();
    const { session } = await seedSessionFile(app);
    store.submitReview(session.id);
    const res = await postJson(app, "/api/feedback/take", { sessionId: session.id });
    const json = (await res.json()) as { bundle: FeedbackBundle };
    expect(json.bundle.reviews).toHaveLength(1);
  });

  test("first review wait notifies and opens when no browser tab", async () => {
    const { app, notified, opened } = makeApp({ reopenWhenNoTab: true });
    const { session } = await seedSessionFile(app);
    opened.length = 0;
    await postJson(app, "/api/feedback/wait", { sessionId: session.id, timeoutMs: 5 });
    expect(notified.some((n) => n.body.includes("レビュー"))).toBe(true);
    expect(opened).toHaveLength(1);
  });
});

describe("ask api", () => {
  test("create → answer → wait returns the answers; identical create reuses the ask", async () => {
    const { app } = makeApp();
    const { session } = await seedSessionFile(app);
    const ask = (await (
      await postJson(app, "/api/asks", { sessionId: session.id, questions: testQuestions })
    ).json()) as Ask;
    expect(ask.status).toBe("open");

    const again = (await (
      await postJson(app, "/api/asks", { sessionId: session.id, questions: testQuestions })
    ).json()) as Ask;
    expect(again.id).toBe(ask.id);

    const waiting = postJson(app, `/api/asks/${ask.id}/wait`, { timeoutMs: 3000 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const answerRes = await postJson(app, `/api/asks/${ask.id}/answer`, {
      answers: [{ questionId: "q1", selected: ["案2"], freeText: null }],
    });
    expect(answerRes.status).toBe(200);

    const result = (await (await waiting).json()) as { status: string; ask: Ask };
    expect(result.status).toBe("answered");
    expect(result.ask.answers?.[0]?.selected).toEqual(["案2"]);
  });

  test("answer must cover every question with a selection or free text", async () => {
    const { app } = makeApp();
    const { session } = await seedSessionFile(app);
    const ask = (await (
      await postJson(app, "/api/asks", { sessionId: session.id, questions: testQuestions })
    ).json()) as Ask;
    const res = await postJson(app, `/api/asks/${ask.id}/answer`, {
      answers: [{ questionId: "q1", selected: [], freeText: null }],
    });
    expect(res.status).toBe(400);
  });

  test("ask with fileName ties the ask to the file", async () => {
    const { app } = makeApp();
    const { session, fileId } = await seedSessionFile(app);
    const ask = (await (
      await postJson(app, "/api/asks", {
        sessionId: session.id,
        fileName: "report.md",
        questions: testQuestions,
      })
    ).json()) as Ask;
    expect(ask.fileId).toBe(fileId);
    const listed = (await (await app.request(`/api/sessions/${session.id}/asks`)).json()) as Ask[];
    expect(listed).toHaveLength(1);
  });

  test("answered ask delivered via wait does not reappear in the feedback bundle", async () => {
    const { app, store } = makeApp();
    const { session } = await seedSessionFile(app);
    const ask = (await (
      await postJson(app, "/api/asks", { sessionId: session.id, questions: testQuestions })
    ).json()) as Ask;
    await postJson(app, `/api/asks/${ask.id}/answer`, {
      answers: [{ questionId: "q1", selected: ["案1"], freeText: null }],
    });
    const result = (await (
      await postJson(app, `/api/asks/${ask.id}/wait`, { timeoutMs: 5 })
    ).json()) as { status: string };
    expect(result.status).toBe("answered");
    expect(store.takeUndeliveredFeedback(session.id).answeredAsks).toHaveLength(0);
  });
});

describe("feedback badges", () => {
  test("sessions list carries openAskCount and reviewWaiting", async () => {
    const { app } = makeApp();
    const { session } = await seedSessionFile(app);
    await postJson(app, "/api/asks", { sessionId: session.id, questions: testQuestions });
    const waiting = postJson(app, "/api/feedback/wait", { sessionId: session.id, timeoutMs: 500 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const sessions = (await (await app.request("/api/sessions")).json()) as Array<
      Session & { openAskCount: number; reviewWaiting: boolean }
    >;
    expect(sessions[0]?.openAskCount).toBe(1);
    expect(sessions[0]?.reviewWaiting).toBe(true);
    await waiting;
  });

  test("files list carries comment counts and hasOpenAsk", async () => {
    const { app, store } = makeApp();
    const { session, fileId } = await seedSessionFile(app);
    store.createDraftComment(fileId, 1, null, "draft");
    store.createDraftComment(fileId, 1, null, "open");
    store.submitReview(session.id);
    store.createDraftComment(fileId, 1, null, "draft2");
    await postJson(app, "/api/asks", {
      sessionId: session.id,
      fileName: "report.md",
      questions: testQuestions,
    });
    const files = (await (await app.request(`/api/sessions/${session.id}/files`)).json()) as Array<{
      openCommentCount: number;
      draftCommentCount: number;
      hasOpenAsk: boolean;
    }>;
    expect(files[0]?.openCommentCount).toBe(2);
    expect(files[0]?.draftCommentCount).toBe(1);
    expect(files[0]?.hasOpenAsk).toBe(true);
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
