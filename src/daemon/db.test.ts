import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { Store } from "./db.ts";

function makeStore(): { store: Store; clock: { now: number } } {
  const clock = { now: 1_000_000 };
  const store = Store.openInMemory({ now: () => clock.now });
  return { store, clock };
}

describe("sessions", () => {
  test("createSession は日時ベースの ID を振り、同じ分の2件目以降は連番で避ける", () => {
    const { store } = makeStore();
    const a = store.createSession();
    const b = store.createSession();
    const c = store.createSession();
    expect(a.id).toMatch(/^\d{4}-\d{4}$/);
    expect(b.id).toBe(`${a.id}-2`);
    expect(c.id).toBe(`${a.id}-3`);
    expect(a.status).toBe("active");
    expect(a.label).toBeNull();
  });

  test("createSession は label と cwd を保存する", () => {
    const { store } = makeStore();
    const session = store.createSession({ label: "設計レビュー", cwd: "/Users/me/proj" });
    expect(store.getSession(session.id)?.label).toBe("設計レビュー");
    expect(store.getSession(session.id)?.cwd).toBe("/Users/me/proj");
    expect(store.createSession().cwd).toBeNull();
  });

  test("label は重複してよい（表示名であって識別子ではない）", () => {
    const { store } = makeStore();
    const a = store.createSession({ label: "レビュー" });
    const b = store.createSession({ label: "レビュー" });
    expect(a.id).not.toBe(b.id);
    expect(store.listSessions(false)).toHaveLength(2);
  });

  test("upsertSession は ID 指定で作成し、二度目は同じセッションを再開する", () => {
    const { store } = makeStore();
    const first = store.upsertSession("my-review");
    const second = store.upsertSession("my-review");
    expect(second.id).toBe(first.id);
    expect(store.listSessions(false)).toHaveLength(1);
  });

  test("upsertSession は archived を復帰させる", () => {
    const { store } = makeStore();
    const session = store.upsertSession("my-review");
    store.archiveSession(session.id);
    expect(store.getSession(session.id)?.status).toBe("archived");
    const revived = store.upsertSession("my-review");
    expect(revived.id).toBe(session.id);
    expect(revived.status).toBe("active");
  });

  test("upsertSession は渡された分だけ上書きし、省略した項目は維持する", () => {
    const { store } = makeStore();
    expect(store.upsertSession("review", { cwd: "/proj/a", label: "初期" }).cwd).toBe("/proj/a");
    expect(store.upsertSession("review", { cwd: "/proj/b" }).cwd).toBe("/proj/b");
    const kept = store.upsertSession("review");
    expect(kept.cwd).toBe("/proj/b");
    expect(kept.label).toBe("初期");
  });

  test("agentSessionKey で前回のセッションを引ける（resume の復帰）", () => {
    const { store } = makeStore();
    const first = store.createSession({ agentSessionKey: "claude:abc", cwd: "/proj" });
    expect(store.getSessionByAgentSessionKey("claude:abc")?.id).toBe(first.id);
    expect(store.getSessionByAgentSessionKey("claude:other")).toBeNull();
  });

  test("agentSessionKey を持たないセッションは何個でも作れる", () => {
    const { store } = makeStore();
    store.createSession();
    store.createSession();
    expect(store.listSessions(false)).toHaveLength(2);
  });

  test("同じ agentSessionKey で2つ作ろうとすると弾かれる", () => {
    const { store } = makeStore();
    store.createSession({ agentSessionKey: "claude:abc" });
    expect(() => store.createSession({ agentSessionKey: "claude:abc" })).toThrow();
  });

  test("agent_session_key 列を持たない既存 DB でも起動して引ける", () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, label TEXT, status TEXT NOT NULL DEFAULT 'active',
        cwd TEXT, created_at INTEGER NOT NULL, last_active_at INTEGER NOT NULL
      );
      INSERT INTO sessions (id, label, status, cwd, created_at, last_active_at)
        VALUES ('0814-1200', '既存', 'active', '/proj', 1, 1);
    `);
    const store = new Store(db);
    expect(store.getSession("0814-1200")?.label).toBe("既存");
    const fresh = store.createSession({ agentSessionKey: "claude:new" });
    expect(store.getSessionByAgentSessionKey("claude:new")?.id).toBe(fresh.id);
  });

  test("setSessionLabel は表示名だけを差し替える", () => {
    const { store } = makeStore();
    const session = store.createSession({ label: "旧", cwd: "/proj" });
    const renamed = store.setSessionLabel(session.id, "新");
    expect(renamed?.label).toBe("新");
    expect(renamed?.cwd).toBe("/proj");
    expect(store.setSessionLabel(session.id, null)?.label).toBeNull();
  });

  test("cwd column is added to a database created before the column existed", () => {
    const db = new Database(":memory:");
    db.exec(`CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      name TEXT UNIQUE,
      status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL,
      last_active_at INTEGER NOT NULL
    )`);
    db.exec(
      "INSERT INTO sessions (id, name, status, created_at, last_active_at) VALUES ('old00000', NULL, 'active', 1, 1)",
    );
    const store = new Store(db);
    expect(store.getSession("old00000")?.cwd).toBeNull();
    const fresh = store.createSession({ cwd: "/proj/new" });
    expect(store.getSession(fresh.id)?.cwd).toBe("/proj/new");
  });

  test("復帰キーの列が無い DB でも relink の計画は立てられる", () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, label TEXT, status TEXT NOT NULL DEFAULT 'active',
        cwd TEXT, created_at INTEGER NOT NULL, last_active_at INTEGER NOT NULL
      );
      CREATE TABLE files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        name TEXT NOT NULL, format TEXT NOT NULL, title TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        UNIQUE(session_id, name)
      );
      CREATE TABLE asks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        status TEXT NOT NULL DEFAULT 'open', questions TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE reviews (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        summary TEXT NOT NULL DEFAULT '', state TEXT NOT NULL DEFAULT 'draft',
        created_at INTEGER NOT NULL
      );
      INSERT INTO sessions (id, label, status, cwd, created_at, last_active_at)
        VALUES ('abc12345', '設計レビュー', 'archived', '/proj', 1, 1);
      INSERT INTO files (id, session_id, name, format, title, created_at, updated_at)
        VALUES (1, 'abc12345', 'a.md', 'markdown', NULL, 1, 1);
    `);
    // 移行を伴わない接続（読み取り専用の計画作成と同じ状態）
    const store = new Store(db, { readOnly: true });

    expect(store.listSessionKeyStates()).toEqual([
      { id: "abc12345", agentSessionKey: null, status: "archived", contentCount: 1 },
    ]);
  });

  test("旧 name 列を持つ DB は label へ移行され、参照している行も壊れない", () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, name TEXT UNIQUE, status TEXT NOT NULL DEFAULT 'active',
        cwd TEXT, created_at INTEGER NOT NULL, last_active_at INTEGER NOT NULL
      );
      CREATE TABLE files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        name TEXT NOT NULL, format TEXT NOT NULL, title TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        UNIQUE(session_id, name)
      );
      CREATE TABLE revisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_id INTEGER NOT NULL REFERENCES files(id),
        rev INTEGER NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL,
        UNIQUE(file_id, rev)
      );
      INSERT INTO sessions (id, name, status, cwd, created_at, last_active_at)
        VALUES ('abc12345', 'my-review', 'active', '/proj', 1, 1);
      INSERT INTO files (id, session_id, name, format, title, created_at, updated_at)
        VALUES (1, 'abc12345', 'a.md', 'markdown', NULL, 1, 1);
      INSERT INTO revisions (file_id, rev, content, created_at) VALUES (1, 1, '# a', 1);
    `);
    const store = new Store(db);

    expect(store.getSession("abc12345")?.label).toBe("my-review");
    expect(store.getSession("abc12345")?.cwd).toBe("/proj");
    expect(db.query("PRAGMA foreign_key_check").all()).toHaveLength(0);
    expect(store.listFiles("abc12345")).toHaveLength(1);
    expect(store.getRevisionContent(1, 1)).toBe("# a");
    // 移行後は同じ label を持つセッションを作れる（UNIQUE 制約が外れている）
    expect(store.createSession({ label: "my-review" }).label).toBe("my-review");
  });

  test("listSessions(false) hides archived, listSessions(true) includes them", () => {
    const { store } = makeStore();
    const active = store.createSession();
    const archived = store.createSession();
    store.archiveSession(archived.id);
    expect(store.listSessions(false).map((s) => s.id)).toEqual([active.id]);
    expect(
      store
        .listSessions(true)
        .map((s) => s.id)
        .toSorted(),
    ).toEqual([active.id, archived.id].toSorted());
  });
});

describe("publish and revisions", () => {
  test("first publish creates file with revision 1 and isNew=true", () => {
    const { store } = makeStore();
    const session = store.createSession();
    const result = store.publish(session.id, "report.md", "markdown", "# はじめてのレポート");
    expect(result.isNew).toBe(true);
    expect(result.revision).toBe(1);
    expect(result.file.name).toBe("report.md");
    expect(result.file.format).toBe("markdown");
  });

  test("same name publish overwrites: revision increments, file count stays 1", () => {
    const { store } = makeStore();
    const session = store.createSession();
    store.publish(session.id, "report.md", "markdown", "v1");
    const second = store.publish(session.id, "report.md", "markdown", "v2 更新版");
    expect(second.isNew).toBe(false);
    expect(second.revision).toBe(2);
    expect(store.listFiles(session.id)).toHaveLength(1);
    expect(store.getRevisionContent(second.file.id, 1)).toBe("v1");
    expect(store.getRevisionContent(second.file.id, 2)).toBe("v2 更新版");
  });

  test("same file name in different sessions are independent", () => {
    const { store } = makeStore();
    const a = store.createSession();
    const b = store.createSession();
    store.publish(a.id, "report.md", "markdown", "in A");
    const inB = store.publish(b.id, "report.md", "markdown", "in B");
    expect(inB.isNew).toBe(true);
    expect(inB.revision).toBe(1);
  });

  test("sourcePath: 毎回上書きされる（title と違い「未指定 = 維持」ではない）", () => {
    const { store } = makeStore();
    const session = store.createSession();
    const withPath = store.publish(
      session.id,
      "report.md",
      "markdown",
      "v1",
      undefined,
      "/Users/me/report.md",
    );
    expect(withPath.file.hasLocalFile).toBe(true);
    expect(store.getFileSourcePath(withPath.file.id)).toBe("/Users/me/report.md");

    const withoutPath = store.publish(session.id, "report.md", "markdown", "v2");
    expect(withoutPath.file.hasLocalFile).toBe(false);
    expect(store.getFileSourcePath(withoutPath.file.id)).toBeNull();
  });

  test("source_path 列を持たない既存 DB でも起動して publish できる", () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, name TEXT UNIQUE, status TEXT NOT NULL DEFAULT 'active',
        created_at INTEGER NOT NULL, last_active_at INTEGER NOT NULL
      );
      CREATE TABLE files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        name TEXT NOT NULL, format TEXT NOT NULL, title TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        UNIQUE(session_id, name)
      );
      INSERT INTO sessions (id, name, status, created_at, last_active_at)
        VALUES ('old', NULL, 'active', 1, 1);
      INSERT INTO files (id, session_id, name, format, title, created_at, updated_at)
        VALUES (1, 'old', 'legacy.md', 'markdown', NULL, 1, 1);
    `);
    const store = new Store(db);
    expect(store.getFile("old", "legacy.md")?.hasLocalFile).toBe(false);
    const result = store.publish(
      "old",
      "new.md",
      "markdown",
      "# new",
      undefined,
      "/Users/me/new.md",
    );
    expect(result.file.hasLocalFile).toBe(true);
  });

  test("title: undefined keeps existing, provided value replaces", () => {
    const { store } = makeStore();
    const session = store.createSession();
    store.publish(session.id, "report.md", "markdown", "v1", "最初のタイトル");
    const kept = store.publish(session.id, "report.md", "markdown", "v2");
    expect(kept.file.title).toBe("最初のタイトル");
    const replaced = store.publish(session.id, "report.md", "markdown", "v3", "新タイトル");
    expect(replaced.file.title).toBe("新タイトル");
  });

  test("listFiles returns latestRev per file", () => {
    const { store } = makeStore();
    const session = store.createSession();
    store.publish(session.id, "a.md", "markdown", "1");
    store.publish(session.id, "a.md", "markdown", "2");
    store.publish(session.id, "b.html", "html", "<p>hi</p>");
    const files = store.listFiles(session.id);
    const byName = new Map(files.map((f) => [f.name, f]));
    expect(byName.get("a.md")?.latestRev).toBe(2);
    expect(byName.get("b.html")?.latestRev).toBe(1);
  });

  test("empty content is a valid revision", () => {
    const { store } = makeStore();
    const session = store.createSession();
    const result = store.publish(session.id, "empty.md", "markdown", "");
    expect(store.getRevisionContent(result.file.id, 1)).toBe("");
  });

  test("getRevisionContent returns null for missing revision", () => {
    const { store } = makeStore();
    const session = store.createSession();
    const result = store.publish(session.id, "a.md", "markdown", "x");
    expect(store.getRevisionContent(result.file.id, 99)).toBeNull();
  });

  test("publishing an existing name with a different format throws", () => {
    const { store } = makeStore();
    const session = store.createSession();
    store.publish(session.id, "report.md", "markdown", "v1");
    expect(() => store.publish(session.id, "report.md", "html", "<p>v2</p>")).toThrow(
      /format mismatch/,
    );
    expect(store.getFile(session.id, "report.md")?.latestRev).toBe(1);
  });

  test("publish to unknown session throws", () => {
    const { store } = makeStore();
    expect(() => store.publish("nosuchid", "a.md", "markdown", "x")).toThrow();
  });

  test("listRevisions returns metadata in rev order", () => {
    const { store, clock } = makeStore();
    const session = store.createSession();
    const first = store.publish(session.id, "a.md", "markdown", "1");
    clock.now = 2_000_000;
    store.publish(session.id, "a.md", "markdown", "2");
    const revisions = store.listRevisions(first.file.id);
    expect(revisions.map((r) => r.rev)).toEqual([1, 2]);
    expect(revisions[1]?.createdAt).toBe(2_000_000);
  });
});

function seedFile(store: Store) {
  const session = store.createSession();
  const { file } = store.publish(session.id, "report.md", "markdown", "# 見出し\n本文です\n");
  return { session, file };
}

const anchor = { exact: "本文です", prefix: "# 見出し\n", suffix: "\n" };

describe("comments", () => {
  test("draft comment lifecycle: create (anchored / whole-file), update, delete", () => {
    const { store } = makeStore();
    const { file } = seedFile(store);
    const inline = store.createDraftComment(file.id, 1, anchor, "ここ直して");
    const whole = store.createDraftComment(file.id, 1, null, "全体的に長い");
    expect(inline.state).toBe("draft");
    expect(inline.anchor?.exact).toBe("本文です");
    expect(whole.anchor).toBeNull();

    store.updateDraftComment(inline.id, "ここを直してほしい");
    expect(store.getComment(inline.id)?.body).toBe("ここを直してほしい");

    store.deleteDraftComment(whole.id);
    expect(store.listFileComments(file.id)).toHaveLength(1);
  });

  test("update/delete reject non-draft comments", () => {
    const { store } = makeStore();
    const { session, file } = seedFile(store);
    const comment = store.createDraftComment(file.id, 1, anchor, "x");
    store.submitReview(session.id);
    expect(() => store.updateDraftComment(comment.id, "y")).toThrow(/draft/);
    expect(() => store.deleteDraftComment(comment.id)).toThrow(/draft/);
  });

  test("submitReview promotes draft comments to open and returns the review", () => {
    const { store, clock } = makeStore();
    const { session, file } = seedFile(store);
    store.createDraftComment(file.id, 1, anchor, "a");
    store.setDraftReviewSummary(session.id, "概ねOK、1点だけ");
    clock.now = 2_000_000;
    const review = store.submitReview(session.id);
    expect(review.state).toBe("submitted");
    expect(review.summary).toBe("概ねOK、1点だけ");
    expect(review.submittedAt).toBe(2_000_000);
    const comment = store.listFileComments(file.id)[0];
    expect(comment?.state).toBe("open");
    expect(comment?.submittedAt).toBe(2_000_000);
  });

  test("submitReview with no draft creates an empty submitted review (LGTM)", () => {
    const { store } = makeStore();
    const { session } = seedFile(store);
    const review = store.submitReview(session.id);
    expect(review.state).toBe("submitted");
    expect(review.summary).toBe("");
  });

  test("resolve and reopen toggle comment state", () => {
    const { store } = makeStore();
    const { session, file } = seedFile(store);
    const comment = store.createDraftComment(file.id, 1, anchor, "x");
    store.submitReview(session.id);
    store.resolveComment(comment.id);
    expect(store.getComment(comment.id)?.state).toBe("resolved");
    store.reopenComment(comment.id);
    expect(store.getComment(comment.id)?.state).toBe("open");
  });

  test("agent reply is submitted immediately; human reply stays draft until review submit", () => {
    const { store } = makeStore();
    const { session, file } = seedFile(store);
    const comment = store.createDraftComment(file.id, 1, anchor, "x");
    store.submitReview(session.id);

    const agentReply = store.addReply(comment.id, "agent", "対応しました");
    expect(agentReply.state).toBe("submitted");

    const humanReply = store.addReply(comment.id, "human", "まだ残ってます");
    expect(humanReply.state).toBe("draft");
    store.submitReview(session.id);
    expect(store.getComment(comment.id)?.replies.find((r) => r.id === humanReply.id)?.state).toBe(
      "submitted",
    );
  });

  test("countOpenComments counts open only", () => {
    const { store } = makeStore();
    const { session, file } = seedFile(store);
    const a = store.createDraftComment(file.id, 1, anchor, "a");
    store.createDraftComment(file.id, 1, null, "b");
    expect(store.countOpenComments(file.id)).toBe(0);
    store.submitReview(session.id);
    expect(store.countOpenComments(file.id)).toBe(2);
    store.resolveComment(a.id);
    expect(store.countOpenComments(file.id)).toBe(1);
  });
});

describe("feedback delivery", () => {
  test("takeUndeliveredFeedback returns a submitted review once", () => {
    const { store } = makeStore();
    const { session, file } = seedFile(store);
    store.createDraftComment(file.id, 1, anchor, "ここ直して");
    store.setDraftReviewSummary(session.id, "総評");
    store.submitReview(session.id);

    expect(store.countUndeliveredFeedback(session.id)).toBe(1);
    const bundle = store.takeUndeliveredFeedback(session.id);
    expect(bundle.reviews).toHaveLength(1);
    expect(bundle.reviews[0]?.review.summary).toBe("総評");
    expect(bundle.reviews[0]?.comments[0]?.fileName).toBe("report.md");
    expect(bundle.reviews[0]?.comments[0]?.anchor?.exact).toBe("本文です");

    expect(store.countUndeliveredFeedback(session.id)).toBe(0);
    expect(store.takeUndeliveredFeedback(session.id).reviews).toHaveLength(0);
  });

  test("human replies submitted with a later review are bundled with that review", () => {
    const { store } = makeStore();
    const { session, file } = seedFile(store);
    const comment = store.createDraftComment(file.id, 1, anchor, "元コメント");
    store.submitReview(session.id);
    store.takeUndeliveredFeedback(session.id);

    store.addReply(comment.id, "human", "まだ残ってます");
    store.submitReview(session.id);
    const bundle = store.takeUndeliveredFeedback(session.id);
    expect(bundle.reviews).toHaveLength(1);
    expect(bundle.reviews[0]?.comments).toHaveLength(0);
    expect(bundle.reviews[0]?.replies[0]?.body).toBe("まだ残ってます");
    expect(bundle.reviews[0]?.replies[0]?.commentBody).toBe("元コメント");
  });

  test("answered asks are delivered once via the bundle", () => {
    const { store } = makeStore();
    const { session } = seedFile(store);
    const ask = store.createAsk(session.id, null, [
      {
        id: "q1",
        question: "どっち?",
        options: [{ label: "A" }, { label: "B" }],
        multiSelect: false,
      },
    ]);
    store.answerAsk(ask.id, [{ questionId: "q1", selected: ["A"], freeText: null }]);
    const bundle = store.takeUndeliveredFeedback(session.id);
    expect(bundle.answeredAsks).toHaveLength(1);
    expect(bundle.answeredAsks[0]?.answers?.[0]?.selected).toEqual(["A"]);
    expect(store.takeUndeliveredFeedback(session.id).answeredAsks).toHaveLength(0);
  });
});

describe("asks", () => {
  const questions = [
    {
      id: "q1",
      question: "方針は?",
      options: [{ label: "案1", description: "説明" }, { label: "案2" }],
      multiSelect: false,
    },
  ];

  test("createAsk stores questions and starts open", () => {
    const { store } = makeStore();
    const { session, file } = seedFile(store);
    const ask = store.createAsk(session.id, file.id, questions);
    expect(ask.status).toBe("open");
    expect(ask.fileId).toBe(file.id);
    expect(store.getAsk(ask.id)?.questions[0]?.question).toBe("方針は?");
    expect(store.listOpenAsks(session.id)).toHaveLength(1);
  });

  test("findOpenAsk matches identical questions for idempotent re-wait", () => {
    const { store } = makeStore();
    const { session } = seedFile(store);
    const ask = store.createAsk(session.id, null, questions);
    expect(store.findOpenAsk(session.id, questions, null)?.id).toBe(ask.id);
    const altered = questions.map((q) => ({ ...q, question: "別の質問" }));
    expect(store.findOpenAsk(session.id, altered, null)).toBeNull();
  });

  test("findOpenAsk distinguishes the target file (same text, different file)", () => {
    const { store } = makeStore();
    const { session, file } = seedFile(store);
    const sessionWide = store.createAsk(session.id, null, questions);
    const fileScoped = store.createAsk(session.id, file.id, questions);
    expect(store.findOpenAsk(session.id, questions, null)?.id).toBe(sessionWide.id);
    expect(store.findOpenAsk(session.id, questions, file.id)?.id).toBe(fileScoped.id);
    expect(store.findOpenAsk(session.id, questions, 9999)).toBeNull();
  });

  test("answerAsk records answers; cancelAsk closes without answers", () => {
    const { store, clock } = makeStore();
    const { session } = seedFile(store);
    const a = store.createAsk(session.id, null, questions);
    clock.now = 3_000_000;
    const answered = store.answerAsk(a.id, [
      { questionId: "q1", selected: ["案2"], freeText: "補足あり" },
    ]);
    expect(answered.status).toBe("answered");
    expect(answered.answeredAt).toBe(3_000_000);
    expect(() => store.answerAsk(a.id, [])).toThrow(/not open/);

    const b = store.createAsk(session.id, null, questions);
    store.cancelAsk(b.id);
    expect(store.getAsk(b.id)?.status).toBe("cancelled");
    expect(store.listOpenAsks(session.id)).toHaveLength(0);
  });
});
