import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./daemon/db.ts";
import { planRelink, runRelink, scanTranscripts, type TranscriptLink } from "./relink.ts";
import type { DaemonState, RelinkAction, SessionKeyState } from "./shared/types.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "kairan-relink-"));
}

function kairanToolUse(id: string) {
  return { type: "tool_use", id, name: "mcp__kairan__publish", input: {} };
}

function toolResult(toolUseId: string, text: string) {
  return { type: "tool_result", tool_use_id: toolUseId, content: [{ type: "text", text }] };
}

function assistantLine(agentSessionId: string, timestamp: string, content: unknown[]): string {
  return JSON.stringify({
    type: "assistant",
    sessionId: agentSessionId,
    timestamp,
    message: { role: "assistant", content },
  });
}

function userLine(agentSessionId: string, timestamp: string, content: unknown[]): string {
  return JSON.stringify({
    type: "user",
    sessionId: agentSessionId,
    timestamp,
    message: { role: "user", content },
  });
}

/** publish の結果として kairan が返す本文（走査はこの形を探す） */
function publishResult(kairanSessionId: string, title = "設計レビュー"): string {
  return JSON.stringify(
    {
      url: `http://127.0.0.1:5766/${kairanSessionId}/plan`,
      sessionId: kairanSessionId,
      title,
      revision: 1,
    },
    null,
    2,
  );
}

function writeTranscript(root: string, project: string, agentSessionId: string, lines: string[]) {
  const dir = join(root, project);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${agentSessionId}.jsonl`), `${lines.join("\n")}\n`);
}

function publishTranscript(
  root: string,
  project: string,
  agentSessionId: string,
  kairanSessionId: string,
  timestamp: string,
): void {
  writeTranscript(root, project, agentSessionId, [
    assistantLine(agentSessionId, timestamp, [kairanToolUse("toolu_1")]),
    userLine(agentSessionId, timestamp, [toolResult("toolu_1", publishResult(kairanSessionId))]),
  ]);
}

describe("scanTranscripts", () => {
  test("kairan の呼び出しに紐づく結果からセッションの持ち主を割り出す", () => {
    const root = tempDir();
    publishTranscript(root, "-Users-me-proj", "agent-a", "zp5bw4sk", "2026-08-14T04:56:13.419Z");
    const links = scanTranscripts(root);
    expect(links.get("zp5bw4sk")).toEqual({
      agentSessionKey: "claude:agent-a",
      lastSeenAt: Date.parse("2026-08-14T04:56:13.419Z"),
    });
  });

  test("kairan 以外のツールの出力に同じ形の本文があっても拾わない", () => {
    const root = tempDir();
    writeTranscript(root, "-Users-me-proj", "agent-a", [
      assistantLine("agent-a", "2026-08-14T04:00:00.000Z", [
        { type: "tool_use", id: "toolu_bash", name: "Bash", input: {} },
        kairanToolUse("toolu_kairan"),
      ]),
      userLine("agent-a", "2026-08-14T04:00:01.000Z", [
        toolResult("toolu_bash", publishResult("from-bash-output")),
        toolResult("toolu_kairan", publishResult("from-kairan")),
      ]),
    ]);
    const links = scanTranscripts(root);
    expect(links.has("from-bash-output")).toBe(false);
    expect(links.has("from-kairan")).toBe(true);
  });

  test("書き込み途中の壊れた行があってもその行だけ捨てて続ける", () => {
    const root = tempDir();
    writeTranscript(root, "-Users-me-proj", "agent-a", [
      assistantLine("agent-a", "2026-08-14T04:00:00.000Z", [kairanToolUse("toolu_1")]),
      '{"type":"user","sessionId":"agent-a","message":{"content":[{"type":"tool_res',
      userLine("agent-a", "2026-08-14T04:00:02.000Z", [
        toolResult("toolu_1", publishResult("zp5bw4sk", "日本語のタイトル")),
      ]),
    ]);
    expect(scanTranscripts(root).has("zp5bw4sk")).toBe(true);
  });

  test("同じ kairan セッションを複数の agent が触っていたら最後に使った方を採る", () => {
    const root = tempDir();
    publishTranscript(root, "-Users-me-proj", "agent-old", "shared", "2026-08-01T00:00:00.000Z");
    publishTranscript(root, "-Users-me-other", "agent-new", "shared", "2026-08-14T00:00:00.000Z");
    expect(scanTranscripts(root).get("shared")?.agentSessionKey).toBe("claude:agent-new");
  });

  test("kairan を使っていないトランスクリプトも、存在しないディレクトリも素通りする", () => {
    const root = tempDir();
    writeTranscript(root, "-Users-me-proj", "agent-a", [
      assistantLine("agent-a", "2026-08-14T04:00:00.000Z", [
        { type: "text", text: "sessionId は本文にも出る: zp5bw4sk" },
      ]),
    ]);
    expect(scanTranscripts(root).size).toBe(0);
    expect(scanTranscripts(join(root, "missing")).size).toBe(0);
  });
});

function state(overrides: Partial<SessionKeyState> & { id: string }): SessionKeyState {
  return {
    agentSessionKey: null,
    status: "archived",
    contentCount: 1,
    ...overrides,
  };
}

function links(entries: Array<[string, string, number]>): Map<string, TranscriptLink> {
  return new Map(
    entries.map(([sessionId, agentSessionKey, lastSeenAt]) => [
      sessionId,
      { agentSessionKey, lastSeenAt },
    ]),
  );
}

describe("planRelink", () => {
  test("復帰キーの無いセッションに履歴のキーを付ける", () => {
    const plan = planRelink([state({ id: "a" })], links([["a", "claude:x", 10]]), {
      pruneEmpty: false,
    });
    expect(plan.actions).toEqual([{ kind: "link", sessionId: "a", agentSessionKey: "claude:x" }]);
  });

  test("空の畳まれたセッションが握っているキーは本来の持ち主へ移す", () => {
    const sessions = [
      state({ id: "old", contentCount: 3 }),
      state({ id: "noise", agentSessionKey: "claude:x", contentCount: 0 }),
    ];
    const plan = planRelink(sessions, links([["old", "claude:x", 10]]), { pruneEmpty: false });
    expect(plan.actions).toEqual([
      { kind: "move", sessionId: "old", agentSessionKey: "claude:x", from: "noise" },
    ]);
  });

  test("稼働中のセッションからはキーを奪わない", () => {
    const sessions = [
      state({ id: "old", contentCount: 3 }),
      state({ id: "live", agentSessionKey: "claude:x", contentCount: 0, status: "active" }),
    ];
    const plan = planRelink(sessions, links([["old", "claude:x", 10]]), { pruneEmpty: false });
    expect(plan.actions).toEqual([]);
    expect(plan.skipped[0]?.reason).toContain("live");
  });

  test("中身のあるセッションからはキーを奪わない", () => {
    const sessions = [
      state({ id: "old", contentCount: 3 }),
      state({ id: "other", agentSessionKey: "claude:x", contentCount: 2 }),
    ];
    const plan = planRelink(sessions, links([["old", "claude:x", 10]]), { pruneEmpty: false });
    expect(plan.actions).toEqual([]);
  });

  test("既にキーを持つセッションは触らない", () => {
    const sessions = [state({ id: "a", agentSessionKey: "claude:other" })];
    const plan = planRelink(sessions, links([["a", "claude:x", 10]]), { pruneEmpty: false });
    expect(plan.actions).toEqual([]);
    expect(plan.skipped[0]?.sessionId).toBe("a");
  });

  test("1つの agent が複数セッションに紐づくときは最後に使った方だけに付ける", () => {
    const sessions = [state({ id: "older" }), state({ id: "newer" })];
    const plan = planRelink(
      sessions,
      links([
        ["older", "claude:x", 10],
        ["newer", "claude:x", 20],
      ]),
      { pruneEmpty: false },
    );
    expect(plan.actions).toEqual([
      { kind: "link", sessionId: "newer", agentSessionKey: "claude:x" },
    ]);
    expect(plan.skipped.map((skip) => skip.sessionId)).toContain("older");
  });

  test("DB に無いセッションの履歴は無視する", () => {
    const plan = planRelink([state({ id: "a" })], links([["deleted", "claude:x", 10]]), {
      pruneEmpty: false,
    });
    expect(plan.actions).toEqual([]);
  });

  test("prune は畳まれた空セッションだけを対象にする", () => {
    const sessions = [
      state({ id: "empty", contentCount: 0 }),
      state({ id: "live", contentCount: 0, status: "active" }),
      state({ id: "filled", contentCount: 1 }),
    ];
    const plan = planRelink(sessions, new Map(), { pruneEmpty: true });
    expect(plan.actions).toEqual([{ kind: "prune", sessionId: "empty" }]);
  });

  test("消すセッションにはキーを付けない", () => {
    const sessions = [state({ id: "empty", contentCount: 0 })];
    const plan = planRelink(sessions, links([["empty", "claude:x", 10]]), { pruneEmpty: true });
    expect(plan.actions).toEqual([{ kind: "prune", sessionId: "empty" }]);
  });
});

describe("Store.applyRelinkPlan", () => {
  test("計画を作った後に中身が増えたセッションは消さない", () => {
    const store = Store.openInMemory();
    const session = store.createSession();
    store.archiveSession(session.id);
    const actions: RelinkAction[] = [{ kind: "prune", sessionId: session.id }];
    store.publish(session.id, "plan.md", "markdown", "# あとから増えた");
    store.archiveSession(session.id);

    const { applied, skipped } = store.applyRelinkPlan(actions);
    expect(applied).toEqual([]);
    expect(skipped[0]?.reason).toContain("empty archived");
    expect(store.getSession(session.id)).not.toBeNull();
  });

  test("計画を作った後に active へ戻ったセッションは消さない", () => {
    const store = Store.openInMemory();
    const session = store.createSession();
    const { applied } = store.applyRelinkPlan([{ kind: "prune", sessionId: session.id }]);
    expect(applied).toEqual([]);
    expect(store.getSession(session.id)).not.toBeNull();
  });

  test("消えたセッションへの付け替えは飛ばす", () => {
    const store = Store.openInMemory();
    const { applied, skipped } = store.applyRelinkPlan([
      { kind: "link", sessionId: "gone", agentSessionKey: "claude:x" },
    ]);
    expect(applied).toEqual([]);
    expect(skipped[0]?.reason).toContain("gone");
  });

  test("先に消してからキーを移すので、空セッションが握っていたキーも通る", () => {
    const store = Store.openInMemory();
    const noise = store.createSession({ agentSessionKey: "claude:x" });
    store.archiveSession(noise.id);
    const target = store.createSession();
    store.publish(target.id, "plan.md", "markdown", "# 本体");

    const { applied } = store.applyRelinkPlan([
      { kind: "move", sessionId: target.id, agentSessionKey: "claude:x", from: noise.id },
      { kind: "prune", sessionId: noise.id },
    ]);
    expect(applied).toHaveLength(2);
    expect(store.getSession(noise.id)).toBeNull();
    expect(store.getSessionByAgentSessionKey("claude:x")?.id).toBe(target.id);
  });

  test("計画を作った後に自分でキーを名乗ったセッションは上書きしない", () => {
    const store = Store.openInMemory();
    const target = store.createSession();
    store.publish(target.id, "plan.md", "markdown", "# 本体");
    const actions: RelinkAction[] = [
      { kind: "link", sessionId: target.id, agentSessionKey: "claude:from-history" },
    ];
    store.upsertSession(target.id, { agentSessionKey: "claude:new-owner" });

    const { applied, skipped } = store.applyRelinkPlan(actions);
    expect(applied).toEqual([]);
    expect(skipped[0]?.reason).toContain("already linked");
    expect(store.getSessionByAgentSessionKey("claude:new-owner")?.id).toBe(target.id);
  });

  test("稼働中のセッションが握り直したキーは奪わない", () => {
    const store = Store.openInMemory();
    const holder = store.createSession({ agentSessionKey: "claude:x" });
    store.publish(holder.id, "plan.md", "markdown", "# 使用中");
    const target = store.createSession();

    const { applied, skipped } = store.applyRelinkPlan([
      { kind: "link", sessionId: target.id, agentSessionKey: "claude:x" },
    ]);
    expect(applied).toEqual([]);
    expect(skipped[0]?.reason).toContain(holder.id);
    expect(store.getSessionByAgentSessionKey("claude:x")?.id).toBe(holder.id);
  });
});

interface FakeDaemon {
  states: DaemonState[];
  stopped: number;
  started: number;
  logs: string[];
}

function relinkDeps(
  dbPath: string,
  projectsRoot: string,
  daemon: FakeDaemon,
  overrides: { dryRun?: boolean; pruneEmpty?: boolean; failStart?: boolean } = {},
) {
  return {
    projectsRoot,
    dbPath,
    pruneEmpty: overrides.pruneEmpty ?? true,
    dryRun: overrides.dryRun ?? false,
    probeDaemon: async (): Promise<DaemonState> => daemon.states.shift() ?? "down",
    stopDaemon: async () => {
      daemon.stopped++;
    },
    startDaemon: async () => {
      daemon.started++;
      if (overrides.failStart === true) throw new Error("spawn failed");
    },
    log: (message: string) => daemon.logs.push(message),
  };
}

function seedDatabase(dir: string): { dbPath: string; sessionId: string } {
  const dbPath = join(dir, "kairan.db");
  const store = Store.open(dbPath);
  const session = store.createSession();
  store.publish(session.id, "plan.md", "markdown", "# 計画");
  store.archiveSession(session.id);
  store.close();
  return { dbPath, sessionId: session.id };
}

describe("runRelink", () => {
  test("DB がまだ無ければ何もしない", async () => {
    const daemon: FakeDaemon = { states: [], stopped: 0, started: 0, logs: [] };
    const dir = tempDir();
    const outcome = await runRelink(relinkDeps(join(dir, "kairan.db"), dir, daemon));
    expect(outcome.applied).toEqual([]);
    expect(daemon.stopped).toBe(0);
  });

  test("--dry-run はデーモンにも DB にも触らない", async () => {
    const dir = tempDir();
    const { dbPath, sessionId } = seedDatabase(dir);
    const projectsRoot = tempDir();
    publishTranscript(projectsRoot, "-p", "agent-a", sessionId, "2026-08-14T04:00:00.000Z");
    const daemon: FakeDaemon = { states: [], stopped: 0, started: 0, logs: [] };

    const outcome = await runRelink(relinkDeps(dbPath, projectsRoot, daemon, { dryRun: true }));
    expect(outcome.plan.actions).toHaveLength(1);
    expect(outcome.applied).toEqual([]);
    expect(daemon.stopped).toBe(0);
    const store = Store.open(dbPath);
    expect(store.getSessionByAgentSessionKey("claude:agent-a")).toBeNull();
    store.close();
  });

  test("計画を作るだけの経路は DB に書き込まない", async () => {
    const dir = tempDir();
    const { dbPath } = seedDatabase(dir);
    const readOnly = Store.openReadOnly(dbPath);
    expect(readOnly.listSessionKeyStates()).toHaveLength(1);
    expect(() => readOnly.createSession()).toThrow();
    readOnly.close();
  });

  test("デーモンを止めてから適用し、元が稼働中なら起動し直す", async () => {
    const dir = tempDir();
    const { dbPath, sessionId } = seedDatabase(dir);
    const projectsRoot = tempDir();
    publishTranscript(projectsRoot, "-p", "agent-a", sessionId, "2026-08-14T04:00:00.000Z");
    const daemon: FakeDaemon = {
      states: ["kairan", "down", "down"],
      stopped: 0,
      started: 0,
      logs: [],
    };

    const outcome = await runRelink(relinkDeps(dbPath, projectsRoot, daemon));
    expect(outcome.applied).toEqual([
      { kind: "link", sessionId, agentSessionKey: "claude:agent-a" },
    ]);
    expect(daemon.stopped).toBe(1);
    expect(daemon.started).toBe(1);
    expect(outcome.backupPath).toBe(`${dbPath}.pre-relink.bak`);
    const store = Store.open(dbPath);
    expect(store.getSessionByAgentSessionKey("claude:agent-a")?.id).toBe(sessionId);
    store.close();
  });

  test("バックアップは過去の分を上書きしない", async () => {
    const dir = tempDir();
    const { dbPath } = seedDatabase(dir);
    const projectsRoot = tempDir();
    const run = () =>
      runRelink(relinkDeps(dbPath, projectsRoot, { states: [], stopped: 0, started: 0, logs: [] }));
    expect((await run()).backupPath).toBe(`${dbPath}.pre-relink.bak`);
    expect((await run()).backupPath).toBe(`${dbPath}.pre-relink.bak.2`);
  });

  test("デーモンが止まらなければ適用しない", async () => {
    const dir = tempDir();
    const { dbPath } = seedDatabase(dir);
    const daemon: FakeDaemon = { states: ["kairan", "kairan"], stopped: 0, started: 0, logs: [] };
    await expect(runRelink(relinkDeps(dbPath, tempDir(), daemon))).rejects.toThrow("still running");
    // 止めきれていないので起動し直しもしない（二重起動を避ける）
    expect(daemon.started).toBe(0);
  });

  test("他アプリが port を握っていたら何もしない", async () => {
    const dir = tempDir();
    const { dbPath } = seedDatabase(dir);
    const daemon: FakeDaemon = { states: ["foreign"], stopped: 0, started: 0, logs: [] };
    await expect(runRelink(relinkDeps(dbPath, tempDir(), daemon))).rejects.toThrow(
      "another application",
    );
    expect(daemon.stopped).toBe(0);
  });

  test("書き込み直前にデーモンが復活していたら適用しない", async () => {
    const dir = tempDir();
    const { dbPath, sessionId } = seedDatabase(dir);
    const projectsRoot = tempDir();
    publishTranscript(projectsRoot, "-p", "agent-a", sessionId, "2026-08-14T04:00:00.000Z");
    const daemon: FakeDaemon = {
      states: ["kairan", "down", "kairan"],
      stopped: 0,
      started: 0,
      logs: [],
    };

    await expect(runRelink(relinkDeps(dbPath, projectsRoot, daemon))).rejects.toThrow("came back");
    expect(daemon.started).toBe(1);
    const store = Store.open(dbPath);
    expect(store.getSessionByAgentSessionKey("claude:agent-a")).toBeNull();
    store.close();
  });

  test("適用にも再起動にも失敗したら両方を報告する", async () => {
    const dir = tempDir();
    const { dbPath } = seedDatabase(dir);
    const daemon: FakeDaemon = {
      states: ["kairan", "down", "kairan"],
      stopped: 0,
      started: 0,
      logs: [],
    };
    await expect(
      runRelink(relinkDeps(dbPath, tempDir(), daemon, { failStart: true })),
    ).rejects.toThrow(/came back[\s\S]*spawn failed[\s\S]*left stopped/);
  });
});
