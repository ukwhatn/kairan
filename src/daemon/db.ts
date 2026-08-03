import { Database } from "bun:sqlite";
import type { DocFormat, FileEntry, RevisionMeta, Session } from "../shared/types.ts";

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
}
