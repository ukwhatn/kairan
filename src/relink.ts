import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Store } from "./daemon/db.ts";
import { claudeAgentSessionKey } from "./shared/session-id.ts";
import type {
  DaemonState,
  RelinkAction,
  RelinkPlan,
  RelinkSkip,
  SessionKeyState,
} from "./shared/types.ts";

/** どの agent セッションが、その kairan セッションを最後に使ったか */
export interface TranscriptLink {
  agentSessionKey: string;
  lastSeenAt: number;
}

const KAIRAN_TOOL_PREFIX = "mcp__kairan__";
const SESSION_ID_IN_RESULT = /"sessionId":\s*"([^"]+)"/;

interface ContentBlock {
  type?: string;
  id?: string;
  name?: string;
  tool_use_id?: string;
  content?: unknown;
}

interface TranscriptEntry {
  sessionId?: string;
  timestamp?: string;
  message?: { content?: ContentBlock[] };
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => (block as { text?: string })?.text ?? "").join("\n");
}

function remember(
  links: Map<string, TranscriptLink>,
  kairanSessionId: string,
  link: TranscriptLink,
) {
  const known = links.get(kairanSessionId);
  // 同じセッションを複数の agent が触っていることがある。復帰先は最後に使った方に寄せる
  if (known != null && known.lastSeenAt >= link.lastSeenAt) return;
  links.set(kairanSessionId, link);
}

function collectFromTranscript(path: string, links: Map<string, TranscriptLink>): void {
  const text = readFileSync(path, "utf-8");
  if (!text.includes(KAIRAN_TOOL_PREFIX)) return;

  const kairanToolUseIds = new Set<string>();
  for (const line of text.split("\n")) {
    if (line === "") continue;
    let entry: TranscriptEntry;
    try {
      entry = JSON.parse(line) as TranscriptEntry;
    } catch {
      // 書き込み途中の行。その行だけ捨てて続ける
      continue;
    }
    const blocks = entry.message?.content;
    if (!Array.isArray(blocks)) continue;
    const agentSessionId = entry.sessionId;
    if (agentSessionId == null) continue;
    const seenAt = entry.timestamp == null ? 0 : Date.parse(entry.timestamp);
    const link: TranscriptLink = {
      agentSessionKey: claudeAgentSessionKey(agentSessionId),
      lastSeenAt: Number.isNaN(seenAt) ? 0 : seenAt,
    };

    for (const block of blocks) {
      if (block.type === "tool_use" && block.name?.startsWith(KAIRAN_TOOL_PREFIX) === true) {
        if (block.id != null) kairanToolUseIds.add(block.id);
        continue;
      }
      // 本文に ID が出るだけの行を拾わないよう、kairan の呼び出しに紐づく結果だけを見る
      if (block.type !== "tool_result") continue;
      if (block.tool_use_id == null || !kairanToolUseIds.has(block.tool_use_id)) continue;
      const found = SESSION_ID_IN_RESULT.exec(textOf(block.content));
      if (found?.[1] != null) remember(links, found[1], link);
    }
  }
}

/**
 * agent のトランスクリプトを読み、kairan セッションを最後に使った agent セッションを割り出す。
 * kairan は復帰キーを保存するようになる前のセッションを持っており、それを埋め直すために使う
 */
export function scanTranscripts(projectsRoot: string): Map<string, TranscriptLink> {
  const links = new Map<string, TranscriptLink>();
  if (!existsSync(projectsRoot)) return links;
  for (const project of readdirSync(projectsRoot, { withFileTypes: true })) {
    if (!project.isDirectory()) continue;
    const dir = join(projectsRoot, project.name);
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      collectFromTranscript(join(dir, entry.name), links);
    }
  }
  return links;
}

/**
 * 履歴と現在のセッションを突き合わせ、何を付け替え・何を消すかを決める。
 * 稼働中の agent から復帰キーを奪わないよう、キーの剥奪も削除も
 * 「畳まれていて中身が無い」セッションだけを対象にする
 */
export function planRelink(
  sessions: SessionKeyState[],
  transcriptLinks: Map<string, TranscriptLink>,
  options: { pruneEmpty: boolean },
): RelinkPlan {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const holderOf = new Map<string, SessionKeyState>();
  for (const session of sessions) {
    if (session.agentSessionKey != null) holderOf.set(session.agentSessionKey, session);
  }

  const actions: RelinkAction[] = [];
  const skipped: RelinkSkip[] = [];
  const isEmptyArchived = (session: SessionKeyState): boolean =>
    session.status === "archived" && session.contentCount === 0;

  const pruning = new Set(
    options.pruneEmpty ? sessions.filter(isEmptyArchived).map((session) => session.id) : [],
  );

  // 1つの agent セッションが復帰できる先は1つだけ。複数の候補があれば最後に使った方を採る
  const claims = new Map<string, { session: SessionKeyState; lastSeenAt: number }>();
  for (const [sessionId, link] of transcriptLinks) {
    const session = byId.get(sessionId);
    if (session == null || pruning.has(sessionId)) continue;
    const claim = claims.get(link.agentSessionKey);
    if (claim != null && claim.lastSeenAt >= link.lastSeenAt) {
      skipped.push({
        sessionId,
        reason: `${claim.session.id} used the same agent more recently`,
      });
      continue;
    }
    if (claim != null) {
      skipped.push({
        sessionId: claim.session.id,
        reason: `${sessionId} used the same agent more recently`,
      });
    }
    claims.set(link.agentSessionKey, { session, lastSeenAt: link.lastSeenAt });
  }

  for (const [agentSessionKey, claim] of claims) {
    const target = claim.session;
    if (target.agentSessionKey === agentSessionKey) continue;
    if (target.agentSessionKey != null) {
      skipped.push({ sessionId: target.id, reason: "already linked to another agent session" });
      continue;
    }
    const holder = holderOf.get(agentSessionKey);
    if (holder == null) {
      actions.push({ kind: "link", sessionId: target.id, agentSessionKey });
      continue;
    }
    if (!isEmptyArchived(holder)) {
      skipped.push({ sessionId: target.id, reason: `${holder.id} is using the same agent` });
      continue;
    }
    actions.push({ kind: "move", sessionId: target.id, agentSessionKey, from: holder.id });
  }

  for (const sessionId of pruning) actions.push({ kind: "prune", sessionId });
  return { actions, skipped };
}

/** 移行と同じ手当て: 戻せない更新の前にファイルごと退避する（WAL の分を取り込んでからコピーする） */
function backupDatabase(dbPath: string): string {
  const db = new Database(dbPath);
  try {
    // 止めたデーモンが DB を手放しきる瞬間と重なることがあるので、少しだけ待てるようにする
    db.exec("PRAGMA busy_timeout = 3000");
    // 取り込めなかった分は例外ではなく busy として返る。気付かずコピーすると
    // 直近の publish を欠いたバックアップで先へ進んでしまう
    const checkpoint = db.query<{ busy: number }, []>("PRAGMA wal_checkpoint(TRUNCATE)").get();
    if (checkpoint == null || checkpoint.busy !== 0) {
      throw new Error(`could not flush the write-ahead log of ${dbPath}; someone else is using it`);
    }
  } finally {
    db.close();
  }
  const target = unusedBackupPath(`${dbPath}.pre-relink.bak`);
  copyFileSync(dbPath, target);
  return target;
}

/** 過去のバックアップを上書きしない（やり直すたびに直前の状態が消えると復旧手段が無くなる） */
function unusedBackupPath(base: string): string {
  if (!existsSync(base)) return base;
  for (let suffix = 2; suffix <= 100; suffix++) {
    const candidate = `${base}.${suffix}`;
    if (!existsSync(candidate)) return candidate;
  }
  throw new Error(`too many backups already exist next to ${base}`);
}

export interface RelinkDeps {
  /** agent のトランスクリプトが並ぶディレクトリ */
  projectsRoot: string;
  dbPath: string;
  pruneEmpty: boolean;
  dryRun: boolean;
  probeDaemon: () => Promise<DaemonState>;
  stopDaemon: () => Promise<void>;
  startDaemon: () => Promise<void>;
  /** デーモンの spawn を止める区間を取る。取れなければ null（他プロセスが spawn 中） */
  acquireSpawnLock: () => (() => void) | null;
  log: (message: string) => void;
}

export interface RelinkOutcome {
  plan: RelinkPlan;
  applied: RelinkAction[];
  skipped: RelinkSkip[];
  backupPath: string | null;
}

function describe(action: RelinkAction): string {
  if (action.kind === "link") return `link  ${action.sessionId} <- ${action.agentSessionKey}`;
  if (action.kind === "move") {
    return `move  ${action.sessionId} <- ${action.agentSessionKey} (was on ${action.from})`;
  }
  return `prune ${action.sessionId} (archived, nothing in it)`;
}

function buildPlan(deps: RelinkDeps): RelinkPlan {
  const links = scanTranscripts(deps.projectsRoot);
  // 計画を立てるだけの経路で schema を触らない（--dry-run が黙って移行を走らせないため）
  const store = Store.openReadOnly(deps.dbPath);
  try {
    return planRelink(store.listSessionKeyStates(), links, { pruneEmpty: deps.pruneEmpty });
  } finally {
    store.close();
  }
}

function applyPlan(deps: RelinkDeps, plan: RelinkPlan) {
  const store = Store.open(deps.dbPath);
  try {
    return store.applyRelinkPlan(plan.actions);
  } finally {
    store.close();
  }
}

/**
 * 履歴から復帰キーを埋め直す。デーモンを止めてから計画を作り直して適用するため、
 * 判定と適用の間に別のプロセスがセッションを書き換えることがない
 */
export async function runRelink(deps: RelinkDeps): Promise<RelinkOutcome> {
  const empty: RelinkOutcome = {
    plan: { actions: [], skipped: [] },
    applied: [],
    skipped: [],
    backupPath: null,
  };
  if (!existsSync(deps.dbPath)) {
    deps.log(`no kairan database at ${deps.dbPath} yet — nothing to relink`);
    return empty;
  }

  if (deps.dryRun) {
    const plan = buildPlan(deps);
    reportPlan(deps, plan);
    deps.log("dry run: nothing was changed");
    return { ...empty, plan, skipped: plan.skipped };
  }

  const state = await deps.probeDaemon();
  if (state === "foreign") {
    throw new Error("the kairan port is held by another application; not touching it");
  }
  const wasRunning = state === "kairan";

  // 止めるだけでは足りない。フィードバック待ちの agent は切断に気付くと自分で
  // 起こし直すため、spawn の権利を握っている間に DB を触る
  const releaseSpawnLock = deps.acquireSpawnLock();
  if (releaseSpawnLock == null) {
    throw new Error("another process is starting the kairan daemon; try again in a moment");
  }

  let outcome: RelinkOutcome | null = null;
  let applyError: unknown = null;
  try {
    if (wasRunning) {
      await deps.stopDaemon();
      if ((await deps.probeDaemon()) !== "down") {
        throw new Error("the kairan daemon is still running; stop it before relinking");
      }
    }
    const backupPath = backupDatabase(deps.dbPath);
    deps.log(`backed up the database to ${backupPath}`);
    // 停止してから作り直す。止める前に作った計画は、その間の publish を知らない
    const plan = buildPlan(deps);
    reportPlan(deps, plan);
    if ((await deps.probeDaemon()) !== "down") {
      throw new Error("the kairan daemon came back while relinking; nothing was changed");
    }
    const { applied, skipped } = applyPlan(deps, plan);
    for (const skip of skipped) deps.log(`skipped ${skip.sessionId}: ${skip.reason}`);
    deps.log(`applied ${applied.length} of ${plan.actions.length} changes`);
    outcome = { plan, applied, skipped: [...plan.skipped, ...skipped], backupPath };
  } catch (err) {
    applyError = err;
  } finally {
    // 起動し直す前に手放す（自分の ensureDaemon も同じ lock を取るため）
    releaseSpawnLock();
  }

  let restartError: unknown = null;
  if (wasRunning) {
    try {
      await deps.startDaemon();
    } catch (err) {
      restartError = err;
    }
  }
  if (applyError != null || restartError != null) {
    const reasons = [applyError, restartError].filter((err) => err != null).map(String);
    if (restartError != null) reasons.push("the kairan daemon is left stopped");
    throw new Error(reasons.join("; "));
  }
  if (outcome == null) throw new Error("relink produced no outcome");
  return outcome;
}

function reportPlan(deps: RelinkDeps, plan: RelinkPlan): void {
  if (plan.actions.length === 0) deps.log("nothing to change");
  for (const action of plan.actions) deps.log(describe(action));
  for (const skip of plan.skipped) deps.log(`skip  ${skip.sessionId}: ${skip.reason}`);
}
