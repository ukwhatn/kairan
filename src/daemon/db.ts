import { Database } from "bun:sqlite";
import type {
  Ask,
  AskAnswer,
  AskQuestion,
  CommentAnchor,
  CommentReply,
  DocFormat,
  FeedbackBundle,
  FileComment,
  FileEntry,
  Review,
  RevisionMeta,
  Session,
} from "../shared/types.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  name TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  last_active_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  name TEXT NOT NULL,
  format TEXT NOT NULL,
  title TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(session_id, name)
);
CREATE TABLE IF NOT EXISTS revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id INTEGER NOT NULL REFERENCES files(id),
  rev INTEGER NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(file_id, rev)
);
CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  summary TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'draft',
  created_at INTEGER NOT NULL,
  submitted_at INTEGER,
  delivered_at INTEGER
);
CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id INTEGER NOT NULL REFERENCES files(id),
  rev INTEGER NOT NULL,
  quote TEXT,
  prefix TEXT,
  suffix TEXT,
  body TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'draft',
  review_id INTEGER REFERENCES reviews(id),
  created_at INTEGER NOT NULL,
  submitted_at INTEGER,
  resolved_at INTEGER
);
CREATE TABLE IF NOT EXISTS comment_replies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  comment_id INTEGER NOT NULL REFERENCES comments(id),
  author TEXT NOT NULL,
  body TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'submitted',
  review_id INTEGER REFERENCES reviews(id),
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS asks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  file_id INTEGER REFERENCES files(id),
  status TEXT NOT NULL DEFAULT 'open',
  questions TEXT NOT NULL,
  answers TEXT,
  created_at INTEGER NOT NULL,
  answered_at INTEGER,
  delivered_at INTEGER
);
`;

interface SessionRow {
  id: string;
  name: string | null;
  status: string;
  created_at: number;
  last_active_at: number;
}

interface FileRow {
  id: number;
  session_id: string;
  name: string;
  format: string;
  title: string | null;
  created_at: number;
  updated_at: number;
  latest_rev: number;
}

export interface PublishResult {
  file: FileEntry;
  revision: number;
  isNew: boolean;
}

interface CommentRow {
  id: number;
  file_id: number;
  rev: number;
  quote: string | null;
  prefix: string | null;
  suffix: string | null;
  body: string;
  state: string;
  review_id: number | null;
  created_at: number;
  submitted_at: number | null;
  resolved_at: number | null;
}

interface ReplyRow {
  id: number;
  comment_id: number;
  author: string;
  body: string;
  state: string;
  review_id: number | null;
  created_at: number;
}

interface ReviewRow {
  id: number;
  session_id: string;
  summary: string;
  state: string;
  created_at: number;
  submitted_at: number | null;
  delivered_at: number | null;
}

interface AskRow {
  id: number;
  session_id: string;
  file_id: number | null;
  status: string;
  questions: string;
  answers: string | null;
  created_at: number;
  answered_at: number | null;
  delivered_at: number | null;
}

function toAnchor(row: CommentRow): CommentAnchor | null {
  if (row.quote == null) return null;
  return { exact: row.quote, prefix: row.prefix ?? "", suffix: row.suffix ?? "" };
}

function toReply(row: ReplyRow): CommentReply {
  return {
    id: row.id,
    commentId: row.comment_id,
    author: row.author === "agent" ? "agent" : "human",
    body: row.body,
    state: row.state === "draft" ? "draft" : "submitted",
    createdAt: row.created_at,
  };
}

function toComment(row: CommentRow, replies: CommentReply[]): FileComment {
  return {
    id: row.id,
    fileId: row.file_id,
    rev: row.rev,
    anchor: toAnchor(row),
    body: row.body,
    state: row.state === "draft" ? "draft" : row.state === "resolved" ? "resolved" : "open",
    createdAt: row.created_at,
    submittedAt: row.submitted_at,
    resolvedAt: row.resolved_at,
    replies,
  };
}

function toReview(row: ReviewRow): Review {
  return {
    id: row.id,
    sessionId: row.session_id,
    summary: row.summary,
    state: row.state === "draft" ? "draft" : "submitted",
    createdAt: row.created_at,
    submittedAt: row.submitted_at,
  };
}

function toAsk(row: AskRow): Ask {
  return {
    id: row.id,
    sessionId: row.session_id,
    fileId: row.file_id,
    status:
      row.status === "answered" ? "answered" : row.status === "cancelled" ? "cancelled" : "open",
    questions: JSON.parse(row.questions) as AskQuestion[],
    answers: row.answers == null ? null : (JSON.parse(row.answers) as AskAnswer[]),
    createdAt: row.created_at,
    answeredAt: row.answered_at,
  };
}

interface StoreOptions {
  now?: () => number;
  genId?: () => string;
}

function randomSessionId(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

function toSession(row: SessionRow): Session {
  return {
    id: row.id,
    name: row.name,
    status: row.status === "archived" ? "archived" : "active",
    createdAt: row.created_at,
    lastActiveAt: row.last_active_at,
  };
}

function toFileEntry(row: FileRow): FileEntry {
  return {
    id: row.id,
    sessionId: row.session_id,
    name: row.name,
    format: row.format === "html" ? "html" : "markdown",
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    latestRev: row.latest_rev,
  };
}

const FILE_SELECT = `
  SELECT f.*, (SELECT MAX(rev) FROM revisions r WHERE r.file_id = f.id) AS latest_rev
  FROM files f
`;

export class Store {
  private readonly db: Database;
  private readonly now: () => number;
  private readonly genId: () => string;

  constructor(db: Database, options: StoreOptions = {}) {
    this.db = db;
    this.now = options.now ?? Date.now;
    this.genId = options.genId ?? randomSessionId;
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec(SCHEMA);
  }

  static open(path: string, options: StoreOptions = {}): Store {
    return new Store(new Database(path, { create: true }), options);
  }

  static openInMemory(options: StoreOptions = {}): Store {
    return new Store(new Database(":memory:"), options);
  }

  close(): void {
    this.db.close();
  }

  createSession(name?: string): Session {
    const timestamp = this.now();
    // ランダムIDのPK衝突は理論上あり得るためリトライで吸収する
    for (let attempt = 0; attempt < 5; attempt++) {
      const id = this.genId();
      try {
        this.db
          .query(
            "INSERT INTO sessions (id, name, status, created_at, last_active_at) VALUES (?, ?, 'active', ?, ?)",
          )
          .run(id, name ?? null, timestamp, timestamp);
        const session = this.getSession(id);
        if (session == null) throw new Error("session vanished after insert");
        return session;
      } catch (err) {
        if (attempt === 4 || !String(err).includes("UNIQUE constraint failed: sessions.id")) {
          throw err;
        }
      }
    }
    throw new Error("unreachable");
  }

  upsertNamedSession(name: string): Session {
    const existing = this.getSessionByName(name);
    if (existing == null) return this.createSession(name);
    this.activateSession(existing.id);
    const session = this.getSession(existing.id);
    if (session == null) throw new Error(`session ${existing.id} vanished`);
    return session;
  }

  getSession(id: string): Session | null {
    const row = this.db.query<SessionRow, [string]>("SELECT * FROM sessions WHERE id = ?").get(id);
    return row == null ? null : toSession(row);
  }

  getSessionByName(name: string): Session | null {
    const row = this.db
      .query<SessionRow, [string]>("SELECT * FROM sessions WHERE name = ?")
      .get(name);
    return row == null ? null : toSession(row);
  }

  listSessions(includeArchived: boolean): Session[] {
    const sql = includeArchived
      ? "SELECT * FROM sessions ORDER BY last_active_at DESC"
      : "SELECT * FROM sessions WHERE status = 'active' ORDER BY last_active_at DESC";
    return this.db.query<SessionRow, []>(sql).all().map(toSession);
  }

  archiveSession(id: string): void {
    this.db.query("UPDATE sessions SET status = 'archived' WHERE id = ?").run(id);
  }

  activateSession(id: string): void {
    this.db
      .query("UPDATE sessions SET status = 'active', last_active_at = ? WHERE id = ?")
      .run(this.now(), id);
  }

  archiveAllActive(): void {
    this.db.query("UPDATE sessions SET status = 'archived' WHERE status = 'active'").run();
  }

  countActiveSessions(): number {
    const row = this.db
      .query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM sessions WHERE status = 'active'",
      )
      .get();
    return row?.count ?? 0;
  }

  touchSession(id: string): void {
    this.db.query("UPDATE sessions SET last_active_at = ? WHERE id = ?").run(this.now(), id);
  }

  publish(
    sessionId: string,
    name: string,
    format: DocFormat,
    content: string,
    title?: string,
  ): PublishResult {
    if (this.getSession(sessionId) == null) {
      throw new Error(`unknown session: ${sessionId}`);
    }
    const run = this.db.transaction((): PublishResult => {
      const timestamp = this.now();
      const existing = this.db
        .query<FileRow, [string, string]>(`${FILE_SELECT} WHERE f.session_id = ? AND f.name = ?`)
        .get(sessionId, name);

      let fileId: number;
      let revision: number;
      if (existing == null) {
        const inserted = this.db
          .query<{ id: number }, [string, string, string, string | null, number, number]>(
            "INSERT INTO files (session_id, name, format, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id",
          )
          .get(sessionId, name, format, title ?? null, timestamp, timestamp);
        if (inserted == null) throw new Error("insert into files returned no row");
        fileId = inserted.id;
        revision = 1;
      } else {
        // リビジョンは content のみを積み、表示形式は files.format を共有するため
        // 途中で format を変えると過去リビジョンの表示が壊れる。作成時で固定する
        if (existing.format !== format) {
          throw new Error(
            `format mismatch: "${name}" is ${existing.format}, publish under a different name to change format`,
          );
        }
        fileId = existing.id;
        revision = existing.latest_rev + 1;
        // title 未指定は「変更しない」。COALESCE で既存値を維持する
        this.db
          .query("UPDATE files SET title = COALESCE(?, title), updated_at = ? WHERE id = ?")
          .run(title ?? null, timestamp, fileId);
      }
      this.db
        .query("INSERT INTO revisions (file_id, rev, content, created_at) VALUES (?, ?, ?, ?)")
        .run(fileId, revision, content, timestamp);
      this.touchSession(sessionId);

      const file = this.getFileById(fileId);
      if (file == null) throw new Error(`file ${fileId} vanished during publish`);
      return { file, revision, isNew: existing == null };
    });
    return run();
  }

  listFiles(sessionId: string): FileEntry[] {
    return this.db
      .query<FileRow, [string]>(`${FILE_SELECT} WHERE f.session_id = ? ORDER BY f.updated_at DESC`)
      .all(sessionId)
      .map(toFileEntry);
  }

  getFile(sessionId: string, name: string): FileEntry | null {
    const row = this.db
      .query<FileRow, [string, string]>(`${FILE_SELECT} WHERE f.session_id = ? AND f.name = ?`)
      .get(sessionId, name);
    return row == null ? null : toFileEntry(row);
  }

  getFileById(id: number): FileEntry | null {
    const row = this.db.query<FileRow, [number]>(`${FILE_SELECT} WHERE f.id = ?`).get(id);
    return row == null ? null : toFileEntry(row);
  }

  listRevisions(fileId: number): RevisionMeta[] {
    return this.db
      .query<{ rev: number; created_at: number }, [number]>(
        "SELECT rev, created_at FROM revisions WHERE file_id = ? ORDER BY rev ASC",
      )
      .all(fileId)
      .map((row) => ({ rev: row.rev, createdAt: row.created_at }));
  }

  getRevisionContent(fileId: number, rev: number): string | null {
    const row = this.db
      .query<{ content: string }, [number, number]>(
        "SELECT content FROM revisions WHERE file_id = ? AND rev = ?",
      )
      .get(fileId, rev);
    return row?.content ?? null;
  }

  // --- comments ---

  private repliesFor(commentId: number): CommentReply[] {
    return this.db
      .query<ReplyRow, [number]>(
        "SELECT * FROM comment_replies WHERE comment_id = ? ORDER BY created_at ASC, id ASC",
      )
      .all(commentId)
      .map(toReply);
  }

  createDraftComment(
    fileId: number,
    rev: number,
    anchor: CommentAnchor | null,
    body: string,
  ): FileComment {
    if (this.getFileById(fileId) == null) throw new Error(`unknown file: ${fileId}`);
    const row = this.db
      .query<
        CommentRow,
        [number, number, string | null, string | null, string | null, string, number]
      >(
        "INSERT INTO comments (file_id, rev, quote, prefix, suffix, body, state, created_at) VALUES (?, ?, ?, ?, ?, ?, 'draft', ?) RETURNING *",
      )
      .get(
        fileId,
        rev,
        anchor?.exact ?? null,
        anchor?.prefix ?? null,
        anchor?.suffix ?? null,
        body,
        this.now(),
      );
    if (row == null) throw new Error("insert into comments returned no row");
    return toComment(row, []);
  }

  updateDraftComment(commentId: number, body: string): FileComment {
    const changed = this.db
      .query("UPDATE comments SET body = ? WHERE id = ? AND state = 'draft'")
      .run(body, commentId);
    if (changed.changes === 0) throw new Error(`comment ${commentId} is not an editable draft`);
    const comment = this.getComment(commentId);
    if (comment == null) throw new Error(`comment ${commentId} vanished`);
    return comment;
  }

  deleteDraftComment(commentId: number): void {
    const changed = this.db
      .query("DELETE FROM comments WHERE id = ? AND state = 'draft'")
      .run(commentId);
    if (changed.changes === 0) throw new Error(`comment ${commentId} is not a deletable draft`);
  }

  getComment(commentId: number): FileComment | null {
    const row = this.db
      .query<CommentRow, [number]>("SELECT * FROM comments WHERE id = ?")
      .get(commentId);
    return row == null ? null : toComment(row, this.repliesFor(row.id));
  }

  listFileComments(fileId: number): FileComment[] {
    return this.db
      .query<CommentRow, [number]>(
        "SELECT * FROM comments WHERE file_id = ? ORDER BY created_at ASC, id ASC",
      )
      .all(fileId)
      .map((row) => toComment(row, this.repliesFor(row.id)));
  }

  countOpenComments(fileId: number): number {
    const row = this.db
      .query<{ count: number }, [number]>(
        "SELECT COUNT(*) AS count FROM comments WHERE file_id = ? AND state = 'open'",
      )
      .get(fileId);
    return row?.count ?? 0;
  }

  resolveComment(commentId: number): FileComment {
    const changed = this.db
      .query(
        "UPDATE comments SET state = 'resolved', resolved_at = ? WHERE id = ? AND state = 'open'",
      )
      .run(this.now(), commentId);
    if (changed.changes === 0) throw new Error(`comment ${commentId} is not open`);
    const comment = this.getComment(commentId);
    if (comment == null) throw new Error(`comment ${commentId} vanished`);
    return comment;
  }

  reopenComment(commentId: number): FileComment {
    const changed = this.db
      .query(
        "UPDATE comments SET state = 'open', resolved_at = NULL WHERE id = ? AND state = 'resolved'",
      )
      .run(commentId);
    if (changed.changes === 0) throw new Error(`comment ${commentId} is not resolved`);
    const comment = this.getComment(commentId);
    if (comment == null) throw new Error(`comment ${commentId} vanished`);
    return comment;
  }

  addReply(commentId: number, author: "agent" | "human", body: string): CommentReply {
    const comment = this.getComment(commentId);
    if (comment == null) throw new Error(`unknown comment: ${commentId}`);
    if (comment.state === "draft") throw new Error(`comment ${commentId} is not submitted yet`);
    // agent の返信は即時可視、人間の返信はレビュー送信までまとめる（一括送信モデル）
    const state = author === "agent" ? "submitted" : "draft";
    const row = this.db
      .query<ReplyRow, [number, string, string, string, number]>(
        "INSERT INTO comment_replies (comment_id, author, body, state, created_at) VALUES (?, ?, ?, ?, ?) RETURNING *",
      )
      .get(commentId, author, body, state, this.now());
    if (row == null) throw new Error("insert into comment_replies returned no row");
    return toReply(row);
  }

  // --- reviews ---

  getDraftReview(sessionId: string): Review | null {
    const row = this.db
      .query<ReviewRow, [string]>("SELECT * FROM reviews WHERE session_id = ? AND state = 'draft'")
      .get(sessionId);
    return row == null ? null : toReview(row);
  }

  setDraftReviewSummary(sessionId: string, summary: string): Review {
    if (this.getSession(sessionId) == null) throw new Error(`unknown session: ${sessionId}`);
    const existing = this.getDraftReview(sessionId);
    if (existing == null) {
      const row = this.db
        .query<ReviewRow, [string, string, number]>(
          "INSERT INTO reviews (session_id, summary, state, created_at) VALUES (?, ?, 'draft', ?) RETURNING *",
        )
        .get(sessionId, summary, this.now());
      if (row == null) throw new Error("insert into reviews returned no row");
      return toReview(row);
    }
    this.db.query("UPDATE reviews SET summary = ? WHERE id = ?").run(summary, existing.id);
    return { ...existing, summary };
  }

  listSessionDraftComments(sessionId: string): Array<FileComment & { fileName: string }> {
    return this.db
      .query<CommentRow & { file_name: string }, [string]>(
        `SELECT c.*, f.name AS file_name FROM comments c
         JOIN files f ON f.id = c.file_id
         WHERE f.session_id = ? AND c.state = 'draft'
         ORDER BY c.created_at ASC, c.id ASC`,
      )
      .all(sessionId)
      .map((row) => ({ ...toComment(row, []), fileName: row.file_name }));
  }

  submitReview(sessionId: string): Review {
    if (this.getSession(sessionId) == null) throw new Error(`unknown session: ${sessionId}`);
    const run = this.db.transaction((): Review => {
      const timestamp = this.now();
      const draft = this.getDraftReview(sessionId) ?? this.setDraftReviewSummary(sessionId, "");
      this.db
        .query("UPDATE reviews SET state = 'submitted', submitted_at = ? WHERE id = ?")
        .run(timestamp, draft.id);
      this.db
        .query(
          `UPDATE comments SET state = 'open', submitted_at = ?, review_id = ?
           WHERE state = 'draft' AND file_id IN (SELECT id FROM files WHERE session_id = ?)`,
        )
        .run(timestamp, draft.id, sessionId);
      this.db
        .query(
          `UPDATE comment_replies SET state = 'submitted', review_id = ?
           WHERE state = 'draft' AND comment_id IN (
             SELECT c.id FROM comments c JOIN files f ON f.id = c.file_id WHERE f.session_id = ?
           )`,
        )
        .run(draft.id, sessionId);
      const review = this.db
        .query<ReviewRow, [number]>("SELECT * FROM reviews WHERE id = ?")
        .get(draft.id);
      if (review == null) throw new Error(`review ${draft.id} vanished during submit`);
      return toReview(review);
    });
    return run();
  }

  // --- asks ---

  createAsk(sessionId: string, fileId: number | null, questions: AskQuestion[]): Ask {
    if (this.getSession(sessionId) == null) throw new Error(`unknown session: ${sessionId}`);
    const row = this.db
      .query<AskRow, [string, number | null, string, number]>(
        "INSERT INTO asks (session_id, file_id, status, questions, created_at) VALUES (?, ?, 'open', ?, ?) RETURNING *",
      )
      .get(sessionId, fileId, JSON.stringify(questions), this.now());
    if (row == null) throw new Error("insert into asks returned no row");
    return toAsk(row);
  }

  getAsk(askId: number): Ask | null {
    const row = this.db.query<AskRow, [number]>("SELECT * FROM asks WHERE id = ?").get(askId);
    return row == null ? null : toAsk(row);
  }

  listOpenAsks(sessionId: string): Ask[] {
    return this.db
      .query<AskRow, [string]>(
        "SELECT * FROM asks WHERE session_id = ? AND status = 'open' ORDER BY created_at ASC, id ASC",
      )
      .all(sessionId)
      .map(toAsk);
  }

  /**
   * timeout 後の再呼び出しで同一質問の open ask を再利用する（重複カード防止）。
   * 対象ファイルも一致条件に含める（同一文面でも別ファイル宛は別カード）
   */
  findOpenAsk(sessionId: string, questions: AskQuestion[], fileId: number | null): Ask | null {
    const serialized = JSON.stringify(questions);
    const row = this.db
      .query<AskRow, [string, string, number | null]>(
        "SELECT * FROM asks WHERE session_id = ? AND status = 'open' AND questions = ? AND file_id IS ?",
      )
      .get(sessionId, serialized, fileId);
    return row == null ? null : toAsk(row);
  }

  answerAsk(askId: number, answers: AskAnswer[]): Ask {
    const changed = this.db
      .query(
        "UPDATE asks SET status = 'answered', answers = ?, answered_at = ? WHERE id = ? AND status = 'open'",
      )
      .run(JSON.stringify(answers), this.now(), askId);
    if (changed.changes === 0) throw new Error(`ask ${askId} is not open`);
    const ask = this.getAsk(askId);
    if (ask == null) throw new Error(`ask ${askId} vanished`);
    return ask;
  }

  cancelAsk(askId: number): void {
    this.db
      .query("UPDATE asks SET status = 'cancelled' WHERE id = ? AND status = 'open'")
      .run(askId);
  }

  /** ask/wait 経由で直接回答を受け取った場合に、bundle での二重配信を防ぐ */
  markAskDelivered(askId: number): void {
    this.db.query("UPDATE asks SET delivered_at = ? WHERE id = ?").run(this.now(), askId);
  }

  countDraftComments(fileId: number): number {
    const row = this.db
      .query<{ count: number }, [number]>(
        "SELECT COUNT(*) AS count FROM comments WHERE file_id = ? AND state = 'draft'",
      )
      .get(fileId);
    return row?.count ?? 0;
  }

  // --- feedback delivery ---

  countUndeliveredFeedback(sessionId: string): number {
    const reviews = this.db
      .query<{ count: number }, [string]>(
        "SELECT COUNT(*) AS count FROM reviews WHERE session_id = ? AND state = 'submitted' AND delivered_at IS NULL",
      )
      .get(sessionId);
    const asks = this.db
      .query<{ count: number }, [string]>(
        "SELECT COUNT(*) AS count FROM asks WHERE session_id = ? AND status = 'answered' AND delivered_at IS NULL",
      )
      .get(sessionId);
    return (reviews?.count ?? 0) + (asks?.count ?? 0);
  }

  /** 未受領のフィードバックを返し、受領済みにマークする（1回だけ返る） */
  takeUndeliveredFeedback(sessionId: string): FeedbackBundle {
    const run = this.db.transaction((): FeedbackBundle => {
      const timestamp = this.now();
      const reviewRows = this.db
        .query<ReviewRow, [string]>(
          "SELECT * FROM reviews WHERE session_id = ? AND state = 'submitted' AND delivered_at IS NULL ORDER BY submitted_at ASC, id ASC",
        )
        .all(sessionId);
      const reviews = reviewRows.map((reviewRow) => {
        const comments = this.db
          .query<CommentRow & { file_name: string }, [number]>(
            `SELECT c.*, f.name AS file_name FROM comments c
             JOIN files f ON f.id = c.file_id
             WHERE c.review_id = ? ORDER BY c.created_at ASC, c.id ASC`,
          )
          .all(reviewRow.id)
          .map((row) => ({ ...toComment(row, []), fileName: row.file_name }));
        const replies = this.db
          .query<ReplyRow & { file_name: string; comment_body: string }, [number]>(
            `SELECT r.*, f.name AS file_name, c.body AS comment_body FROM comment_replies r
             JOIN comments c ON c.id = r.comment_id
             JOIN files f ON f.id = c.file_id
             WHERE r.review_id = ? ORDER BY r.created_at ASC, r.id ASC`,
          )
          .all(reviewRow.id)
          .map((row) => ({
            ...toReply(row),
            fileName: row.file_name,
            commentBody: row.comment_body,
          }));
        this.db
          .query("UPDATE reviews SET delivered_at = ? WHERE id = ?")
          .run(timestamp, reviewRow.id);
        return { review: toReview(reviewRow), comments, replies };
      });

      const askRows = this.db
        .query<AskRow, [string]>(
          "SELECT * FROM asks WHERE session_id = ? AND status = 'answered' AND delivered_at IS NULL ORDER BY answered_at ASC, id ASC",
        )
        .all(sessionId);
      for (const row of askRows) {
        this.db.query("UPDATE asks SET delivered_at = ? WHERE id = ?").run(timestamp, row.id);
      }
      return { reviews, answeredAsks: askRows.map(toAsk) };
    });
    return run();
  }
}
