import { closeSync, mkdirSync, openSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { KairanConfig } from "../config.ts";
import type {
  Ask,
  AskQuestion,
  CommentReply,
  FeedbackBundle,
  FileEntry,
  PublishRequest,
  PublishResponse,
  Session,
} from "../shared/types.ts";
import { daemonBaseUrl } from "../shared/url.ts";

// 組み込み fetch は Bun 固有の preconnect 等を持つため typeof fetch を
// そのまま要求するとテストの fake が書けない。呼び出しに使う形だけを要求する
export type FetchLike = (url: string | URL, init?: RequestInit) => Promise<Response>;

interface DaemonClientDeps {
  fetchFn?: FetchLike;
  spawnDaemon?: () => void;
  pollIntervalMs?: number;
  spawnTimeoutMs?: number;
}

// 別プロセスが spawn 中に落ちて lock が残った場合の奪取猶予
const STALE_LOCK_MS = 15_000;

function defaultSpawnDaemon(): void {
  const cliPath = fileURLToPath(new URL("../cli.ts", import.meta.url));
  const proc = Bun.spawn([process.execPath, "run", cliPath, "daemon"], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  proc.unref();
}

/**
 * stdioランチャーから見たデーモンの操作窓口。
 * デーモンの生存保証(ensure)・spawn競合の排他・内部API呼び出しを担う。
 */
export class DaemonClient {
  private readonly config: KairanConfig;
  private readonly fetchFn: FetchLike;
  private readonly spawnDaemon: () => void;
  private readonly pollIntervalMs: number;
  private readonly spawnTimeoutMs: number;

  constructor(config: KairanConfig, deps: DaemonClientDeps = {}) {
    this.config = config;
    this.fetchFn = deps.fetchFn ?? fetch;
    this.spawnDaemon = deps.spawnDaemon ?? defaultSpawnDaemon;
    this.pollIntervalMs = deps.pollIntervalMs ?? 200;
    this.spawnTimeoutMs = deps.spawnTimeoutMs ?? 10_000;
  }

  private get baseUrl(): string {
    return daemonBaseUrl(this.config.host, this.config.port);
  }

  private get spawnLockPath(): string {
    return join(this.config.dataDir, "spawn.lock");
  }

  /** healthz の状態: alive | dead | 別アプリがportを使用 */
  private async checkHealth(): Promise<"alive" | "dead" | "foreign"> {
    try {
      const res = await this.fetchFn(`${this.baseUrl}/healthz`, {
        signal: AbortSignal.timeout(1000),
      });
      if (!res.ok) return "foreign";
      const json = (await res.json().catch(() => null)) as { app?: string } | null;
      return json?.app === "kairan" ? "alive" : "foreign";
    } catch {
      return "dead";
    }
  }

  private tryAcquireSpawnLock(): boolean {
    mkdirSync(this.config.dataDir, { recursive: true });
    try {
      closeSync(openSync(this.spawnLockPath, "wx"));
      return true;
    } catch {
      try {
        const age = Date.now() - statSync(this.spawnLockPath).mtimeMs;
        if (age > STALE_LOCK_MS) {
          rmSync(this.spawnLockPath, { force: true });
          closeSync(openSync(this.spawnLockPath, "wx"));
          return true;
        }
      } catch {
        // lock が消えた直後などは獲得失敗として扱い、healthz 待ちに回る
      }
      return false;
    }
  }

  private releaseSpawnLock(): void {
    rmSync(this.spawnLockPath, { force: true });
  }

  private async waitUntilHealthy(): Promise<void> {
    const deadline = Date.now() + this.spawnTimeoutMs;
    while (Date.now() < deadline) {
      const health = await this.checkHealth();
      if (health === "alive") return;
      if (health === "foreign") this.throwForeignPort();
      await Bun.sleep(this.pollIntervalMs);
    }
    throw new Error(
      `kairan daemon did not become healthy on ${this.baseUrl} within ${this.spawnTimeoutMs}ms`,
    );
  }

  private throwForeignPort(): never {
    throw new Error(
      `port ${this.config.port} is in use by another application. ` +
        `Change the port via KAIRAN_PORT or ~/.kairan/config.json`,
    );
  }

  async ensureDaemon(): Promise<void> {
    const health = await this.checkHealth();
    if (health === "alive") return;
    if (health === "foreign") this.throwForeignPort();

    if (this.tryAcquireSpawnLock()) {
      try {
        this.spawnDaemon();
        await this.waitUntilHealthy();
      } finally {
        this.releaseSpawnLock();
      }
    } else {
      // 他プロセスが spawn 中: 立ち上がりを待つだけでよい
      await this.waitUntilHealthy();
    }
  }

  private async api<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await this.fetchFn(`${this.baseUrl}${path}`, init);
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new Error(body?.error ?? `kairan daemon returned ${res.status} for ${path}`);
    }
    return (await res.json()) as T;
  }

  private postJson<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
    return this.api<T>(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  }

  async createSession(name?: string, cwd?: string): Promise<Session> {
    return this.api<Session>("/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...(name == null ? {} : { name }),
        ...(cwd == null ? {} : { cwd }),
      }),
    });
  }

  async publish(request: PublishRequest): Promise<PublishResponse> {
    return this.api<PublishResponse>("/api/publish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
  }

  async listFiles(sessionId: string): Promise<FileEntry[]> {
    return this.api<FileEntry[]>(`/api/sessions/${sessionId}/files`);
  }

  waitFeedback(
    sessionId: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<{ status: "feedback" | "pending"; bundle?: FeedbackBundle }> {
    return this.postJson("/api/feedback/wait", { sessionId, timeoutMs }, signal);
  }

  takeFeedback(sessionId: string): Promise<{ bundle: FeedbackBundle }> {
    return this.postJson("/api/feedback/take", { sessionId });
  }

  createAsk(sessionId: string, fileName: string | null, questions: AskQuestion[]): Promise<Ask> {
    return this.postJson("/api/asks", {
      sessionId,
      ...(fileName == null ? {} : { fileName }),
      questions,
    });
  }

  waitAsk(
    askId: number,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<{ status: "answered" | "cancelled" | "pending"; ask?: Ask }> {
    return this.postJson(`/api/asks/${askId}/wait`, { timeoutMs }, signal);
  }

  cancelAsk(askId: number): Promise<{ ok: boolean }> {
    return this.postJson(`/api/asks/${askId}/cancel`, {});
  }

  replyComment(commentId: number, body: string, resolve: boolean): Promise<CommentReply> {
    return this.postJson(`/api/comments/${commentId}/reply`, {
      author: "agent",
      body,
      resolve,
    });
  }

  /**
   * セッションの生存申告ストリームを張る。プロセス終了で TCP が切れ、
   * デーモン側が archive する。切断検知コールバックで再attachの判断を返す。
   */
  attachSession(sessionId: string, onDisconnect?: () => void): void {
    void (async () => {
      try {
        const res = await this.fetchFn(`${this.baseUrl}/api/attach?session_id=${sessionId}`);
        if (res.body == null) throw new Error("attach stream has no body");
        const reader = res.body.getReader();
        while (true) {
          const { done } = await reader.read();
          if (done) break;
        }
      } catch {
        // デーモン停止など。必要なら呼び出し側が再ensure時にattachし直す
      }
      onDisconnect?.();
    })();
  }
}
