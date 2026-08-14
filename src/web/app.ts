import { html as renderDiffHtml } from "diff2html";
import mermaid from "mermaid";
import type {
  Ask,
  CommentAnchor,
  FileComment,
  FileEntry,
  KairanEvent,
  RevisionMeta,
  Session,
} from "../shared/types.ts";
import { applyFavicon, computeFaviconStatus, computeTabTitle } from "./favicon.ts";

type ViewMode = "rendered" | "source" | "diff";
type DiffStyle = "line-by-line" | "side-by-side";

type SessionItem = Session & { openAskCount: number; reviewWaiting: boolean };
type FileItem = FileEntry & {
  openCommentCount: number;
  draftCommentCount: number;
  hasOpenAsk: boolean;
};

interface ContentResponse {
  file: FileEntry;
  rev: number;
  content: string;
  html: string | null;
}

interface State {
  sessions: SessionItem[];
  includeArchived: boolean;
  currentSessionId: string | null;
  files: FileItem[];
  currentFileName: string | null;
  currentRev: number | null; // null = 最新
  revisions: RevisionMeta[];
  viewMode: ViewMode;
  diffFrom: number;
  diffTo: number;
  diffStyle: DiffStyle;
  follow: boolean;
  comments: FileComment[];
  openAsks: Ask[];
  reviewSummary: string;
  reviewDraftCount: number;
  commentsOpen: boolean;
  homeDir: string | null;
  editorEnabled: boolean;
  /** このタブを開いている間に届いた、まだ表示していない publish（fileId → sessionId） */
  unreadFiles: Map<number, string>;
}

const state: State = {
  sessions: [],
  includeArchived: false,
  currentSessionId: null,
  files: [],
  currentFileName: null,
  currentRev: null,
  revisions: [],
  viewMode: "rendered",
  diffFrom: 1,
  diffTo: 1,
  diffStyle: "line-by-line",
  follow: true,
  comments: [],
  openAsks: [],
  reviewSummary: "",
  reviewDraftCount: 0,
  commentsOpen: false,
  homeDir: null,
  editorEnabled: false,
  unreadFiles: new Map(),
};

mermaid.initialize({ startOnLoad: false });

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} for ${url}`);
  return (await res.json()) as T;
}

async function postJson<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok) throw new Error(`${res.status} for ${url}`);
  return (await res.json()) as T;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: Array<Node | string>
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "class") node.className = value;
    else node.setAttribute(key, value);
  }
  node.append(...children);
  return node;
}

/** Cmd+Enter（macOS）/ Ctrl+Enter で送信ボタン相当の動作を実行する */
function submitOnCmdEnter(textarea: HTMLTextAreaElement, submit: () => void): void {
  textarea.addEventListener("keydown", (event) => {
    // 変換中に送ると未確定の文字列がそのまま本文になる
    if (event.isComposing) return;
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      submit();
    }
  });
}

function formatTime(epochMs: number): string {
  const d = new Date(epochMs);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// --- URL 同期 -------------------------------------------------------------

function parsePath(): { sessionId: string | null; fileName: string | null; rev: number | null } {
  const segments = location.pathname.split("/").filter((s) => s.length > 0);
  const rev = new URLSearchParams(location.search).get("rev");
  return {
    sessionId: segments[0] ?? null,
    fileName: segments[1] != null ? decodeURIComponent(segments[1]) : null,
    rev: rev == null ? null : Number(rev),
  };
}

function pushUrl(): void {
  let path = "/";
  if (state.currentSessionId != null) {
    path = `/${state.currentSessionId}`;
    if (state.currentFileName != null) {
      path += `/${encodeURIComponent(state.currentFileName)}`;
      if (state.currentRev != null) path += `?rev=${state.currentRev}`;
    }
  }
  if (location.pathname + location.search !== path) history.pushState(null, "", path);
}

// --- データ取得 -----------------------------------------------------------

// 近接イベントで並行実行された取得の応答逆転で古い一覧に巻き戻らないよう、
// 最後に開始した取得だけを適用する（loadFiles と同型）
let sessionsGeneration = 0;

async function loadSessions(): Promise<void> {
  const generation = ++sessionsGeneration;
  const sessions = await fetchJson<SessionItem[]>(
    `/api/sessions?include_archived=${state.includeArchived}`,
  );
  if (generation !== sessionsGeneration) return;
  state.sessions = sessions;
  renderSessions();
  renderReviewBar();
  refreshTabIndicator();
}

// 応答順の逆転で古い一覧が新しい一覧を上書きしないよう、最後に開始した取得だけを適用する
let filesGeneration = 0;

async function loadFiles(): Promise<void> {
  const generation = ++filesGeneration;
  const sessionId = state.currentSessionId;
  if (sessionId == null) {
    state.files = [];
    renderFiles();
    return;
  }
  let files: FileItem[];
  try {
    files = await fetchJson<FileItem[]>(`/api/sessions/${sessionId}/files`);
  } catch {
    files = [];
  }
  if (generation !== filesGeneration) return;
  if (sessionId !== state.currentSessionId) return;
  state.files = files;
  renderFiles();
}

// --- フィードバック系のデータ取得 -------------------------------------------

let commentsGeneration = 0;

async function loadComments(): Promise<void> {
  const generation = ++commentsGeneration;
  const file = currentFile();
  if (file == null) {
    state.comments = [];
    renderCommentsPanel();
    return;
  }
  let comments: FileComment[];
  try {
    comments = await fetchJson<FileComment[]>(`/api/files/${file.id}/comments`);
  } catch {
    comments = [];
  }
  if (generation !== commentsGeneration) return;
  if (currentFile()?.id !== file.id) return;
  state.comments = comments;
  renderCommentsPanel();
  renderCommentToggle();
  applyCommentHighlights();
  renderMarginComments();
}

let asksGeneration = 0;

async function loadAsks(): Promise<void> {
  const generation = ++asksGeneration;
  const sessionId = state.currentSessionId;
  if (sessionId == null) {
    state.openAsks = [];
    renderAsks();
    return;
  }
  let asks: Ask[];
  try {
    asks = await fetchJson<Ask[]>(`/api/sessions/${sessionId}/asks`);
  } catch {
    asks = [];
  }
  if (generation !== asksGeneration) return;
  if (sessionId !== state.currentSessionId) return;
  state.openAsks = asks;
  renderAsks();
}

let reviewGeneration = 0;

async function loadReviewDraft(): Promise<void> {
  const generation = ++reviewGeneration;
  const sessionId = state.currentSessionId;
  if (sessionId == null) {
    state.reviewSummary = "";
    state.reviewDraftCount = 0;
    renderReviewBar();
    return;
  }
  try {
    const data = await fetchJson<{
      draft: { summary: string } | null;
      comments: FileComment[];
    }>(`/api/sessions/${sessionId}/review`);
    if (generation !== reviewGeneration || sessionId !== state.currentSessionId) return;
    state.reviewSummary = data.draft?.summary ?? "";
    state.reviewDraftCount = data.comments.length;
  } catch {
    if (generation !== reviewGeneration) return;
    state.reviewSummary = "";
    state.reviewDraftCount = 0;
  }
  renderReviewBar();
}

function currentFile(): FileItem | null {
  return state.files.find((f) => f.name === state.currentFileName) ?? null;
}

// --- タブの見た目（favicon / タイトル）--------------------------------------

/**
 * favicon とタイトルを現在の state に合わせる。state を変える経路が複数あるため
 * （選択・戻る進む・SSE・follow による自動遷移）、更新はここに集約する
 */
function refreshTabIndicator(): void {
  const indicator = {
    attentionCount: state.sessions
      .filter((session) => session.status !== "archived")
      .reduce(
        (total, session) => total + session.openAskCount + (session.reviewWaiting ? 1 : 0),
        0,
      ),
    unreadCount: state.unreadFiles.size,
  };
  const file = currentFile();
  document.title = computeTabTitle({
    ...indicator,
    fileLabel: file == null ? state.currentFileName : (file.title ?? file.name),
  });
  applyFavicon(computeFaviconStatus(indicator));
}

function markUnread(fileId: number, sessionId: string): void {
  state.unreadFiles.set(fileId, sessionId);
  refreshTabIndicator();
}

/** セッションごと消えた未読は、開いて既読にすることができないのでここで落とす */
function forgetUnreadOfSession(sessionId: string): void {
  for (const [fileId, owner] of state.unreadFiles) {
    if (owner === sessionId) state.unreadFiles.delete(fileId);
  }
}

// 並行して走った古い loadView が、後から選択したファイルの表示を上書きしないための世代番号
let viewGeneration = 0;

async function loadView(): Promise<void> {
  const generation = ++viewGeneration;
  const file = currentFile();
  const main = document.getElementById("view");
  if (main == null) return;
  if (file == null) {
    main.replaceChildren(
      el("div", { class: "placeholder" }, "ファイルを選択するか、agent から publish してください"),
    );
    refreshTabIndicator();
    return;
  }
  // 表示に至る経路（選択・戻る進む・follow による自動遷移）はすべてここを通るため、
  // 既読化もここで行う
  state.unreadFiles.delete(file.id);
  refreshTabIndicator();
  const revisions = await fetchJson<RevisionMeta[]>(`/api/files/${file.id}/revisions`);
  if (generation !== viewGeneration) return;
  state.revisions = revisions;
  renderViewChrome(file);
  await renderViewBody(file, generation);
  if (generation === viewGeneration) void loadComments();
}

// --- 描画: セッションリスト ------------------------------------------------

/** ホームディレクトリを ~ に縮めてパスを表示用にする */
function shortenPath(path: string): string {
  const home = state.homeDir;
  if (home != null && (path === home || path.startsWith(`${home}/`))) {
    return `~${path.slice(home.length)}`;
  }
  return path;
}

/**
 * 破壊的な操作の確認。`confirm()` はダイアログ中ブラウザの応答を止めるため使わない
 * （その間に届く SSE も処理できなくなる）
 */
function confirmDestructive(anchor: HTMLElement, message: string, onConfirm: () => void): void {
  document.getElementById("confirm-popover")?.remove();
  const cancel = el("button", { class: "btn-ghost", type: "button" }, "やめる");
  const run = el("button", { class: "btn-danger", type: "button" }, "削除する");
  const popover = el(
    "div",
    { id: "confirm-popover", class: "confirm-popover", role: "alertdialog" },
    el("div", { class: "confirm-message" }, message),
    el("div", { class: "composer-actions" }, cancel, run),
  );
  const rect = anchor.getBoundingClientRect();
  popover.style.left = `${Math.min(rect.left, window.innerWidth - 320)}px`;
  popover.style.top = `${Math.min(rect.bottom + 6, window.innerHeight - 140)}px`;
  cancel.addEventListener("click", () => popover.remove());
  run.addEventListener("click", () => {
    popover.remove();
    onConfirm();
  });
  document.body.append(popover);
}

function buildSessionMenu(session: SessionItem): HTMLElement {
  const button = el(
    "button",
    { class: "item-menu", type: "button", title: "このセッションの操作" },
    "···",
  );
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    document.getElementById("session-menu")?.remove();
    const menu = el("div", { id: "session-menu", class: "popup-menu" });
    const addAction = (text: string, run: () => void): void => {
      const action = el("button", { class: "popup-menu-item", type: "button" }, text);
      action.addEventListener("click", (inner) => {
        inner.stopPropagation();
        menu.remove();
        run();
      });
      menu.append(action);
    };

    addAction("名前を変更", () => startSessionRename(session));
    if (session.status === "active") {
      addAction("アーカイブ", () => {
        void postJson(`/api/sessions/${session.id}/archive`).then(() => loadSessions());
      });
    }
    addAction("完全に削除", () => {
      confirmDestructive(
        button,
        `「${session.label ?? session.id}」の文書・コメント・質問をすべて削除します。元に戻せません。`,
        () => {
          void postJson(`/api/sessions/${session.id}/delete`).then(() => {
            if (state.currentSessionId === session.id) void selectSession(null);
            return loadSessions();
          });
        },
      );
    });

    const rect = button.getBoundingClientRect();
    menu.style.left = `${Math.min(rect.left, window.innerWidth - 180)}px`;
    menu.style.top = `${rect.bottom + 4}px`;
    document.body.append(menu);
  });
  return button;
}

/** 行をその場で入力欄に差し替える（別画面へ飛ばさずに直せるように） */
function startSessionRename(session: SessionItem): void {
  const row = document.querySelector<HTMLElement>(`.item[data-session-id="${session.id}"]`);
  const nameRow = row?.querySelector<HTMLElement>(".item-name");
  if (nameRow == null) return;
  const input = el("input", { class: "rename-input", type: "text", "aria-label": "セッション名" });
  input.value = session.label ?? "";
  input.placeholder = session.id;
  let cancelled = false;
  const commit = (): void => {
    if (cancelled) return;
    const label = input.value;
    void postJson(`/api/sessions/${session.id}/label`, { label }).then(() => loadSessions());
  };
  input.addEventListener("click", (event) => event.stopPropagation());
  input.addEventListener("keydown", (event) => {
    event.stopPropagation();
    // 日本語入力の変換中は Enter が「変換の確定」、Escape が「変換の取消」なので、
    // 名前の確定・編集の中止として扱わない
    if (event.isComposing) return;
    if (event.key === "Enter") commit();
    if (event.key === "Escape") {
      // blur ハンドラが後から保存してしまわないよう、取消を先に確定させる
      cancelled = true;
      void loadSessions();
    }
  });
  input.addEventListener("blur", commit);
  nameRow.replaceChildren(input);
  input.focus();
  input.select();
}

function buildSessionItem(session: SessionItem): HTMLElement {
  const label = session.label ?? session.id;
  const nameRow = el("span", { class: "item-name" }, label);
  if (session.status === "archived") {
    nameRow.append(el("span", { class: "badge" }, "archived"));
  }
  if (session.reviewWaiting) {
    nameRow.append(el("span", { class: "badge badge-attention" }, "レビュー待ち"));
  }
  if (session.openAskCount > 0) {
    nameRow.append(el("span", { class: "badge badge-attention" }, `質問${session.openAskCount}`));
  }
  const item = el(
    "li",
    {
      class: [
        "item",
        session.id === state.currentSessionId ? "selected" : "",
        session.status === "archived" ? "archived" : "",
      ].join(" "),
    },
    nameRow,
    el("span", { class: "item-meta" }, formatTime(session.lastActiveAt)),
    buildSessionMenu(session),
  );
  item.dataset.sessionId = session.id;
  item.addEventListener("click", () => {
    void selectSession(session.id);
  });
  return item;
}

function renderSessions(): void {
  const container = document.getElementById("sessions");
  if (container == null) return;
  if (state.sessions.length === 0) {
    container.replaceChildren(el("div", { class: "placeholder" }, "セッションはまだありません"));
    return;
  }

  // プロジェクトパス（cwd）でグループ化。グループは直近活動順、グループ内は API の順序を維持
  const groups = new Map<string, SessionItem[]>();
  for (const session of state.sessions) {
    const key = session.cwd ?? "";
    const bucket = groups.get(key);
    if (bucket == null) groups.set(key, [session]);
    else bucket.push(session);
  }
  const ordered = [...groups.entries()].sort(
    (a, b) =>
      Math.max(...b[1].map((s) => s.lastActiveAt)) - Math.max(...a[1].map((s) => s.lastActiveAt)),
  );

  const fragment = document.createDocumentFragment();
  for (const [cwd, sessions] of ordered) {
    const labelText = cwd === "" ? "場所不明" : shortenPath(cwd);
    // 外側 rtl（末尾省略）+ 内側 ltr isolate（文字順の維持）の組み合わせ
    const groupLabel = el(
      "div",
      { class: "session-group-label", title: cwd || "" },
      el("bdi", { dir: "ltr" }, labelText),
    );
    const list = el("ul", { class: "item-list" });
    for (const session of sessions) list.append(buildSessionItem(session));
    fragment.append(groupLabel, list);
  }
  container.replaceChildren(fragment);
  setRailAttention(
    "pane-sessions",
    state.sessions.some((s) => s.reviewWaiting || s.openAskCount > 0),
  );
}

/** rail に畳まれていてもバッジの存在が分かるよう、注意ドットを付ける */
function setRailAttention(paneClass: string, attention: boolean): void {
  const rail = document.querySelector(`.${paneClass} .pane-rail`);
  rail?.classList.toggle("attention", attention);
}

// --- 描画: ファイルリスト --------------------------------------------------

function renderFiles(): void {
  const container = document.getElementById("files");
  if (container == null) return;
  if (state.currentSessionId == null) {
    container.replaceChildren(el("div", { class: "placeholder" }, "セッションを選択"));
    return;
  }
  if (state.files.length === 0) {
    container.replaceChildren(el("div", { class: "placeholder" }, "ファイルはまだありません"));
    return;
  }
  const list = el("ul", { class: "item-list" });
  for (const file of state.files) {
    const nameRow = el("span", { class: "item-name" }, file.title ?? file.name);
    nameRow.append(el("span", { class: "badge badge-rev" }, `rev ${file.latestRev}`));
    if (file.hasOpenAsk) {
      nameRow.append(el("span", { class: "badge badge-attention" }, "質問"));
    }
    if (file.openCommentCount > 0) {
      nameRow.append(
        el("span", { class: "badge badge-comment" }, `コメント${file.openCommentCount}`),
      );
    }
    if (file.draftCommentCount > 0) {
      nameRow.append(el("span", { class: "badge" }, `下書き${file.draftCommentCount}`));
    }
    const item = el(
      "li",
      { class: `item ${file.name === state.currentFileName ? "selected" : ""}` },
      nameRow,
      el("span", { class: "item-meta" }, `${file.name} · ${formatTime(file.updatedAt)}`),
    );
    item.addEventListener("click", () => {
      void selectFile(file.name);
    });
    list.append(item);
  }
  container.replaceChildren(list);
  setRailAttention(
    "pane-files",
    state.files.some((f) => f.hasOpenAsk || f.openCommentCount > 0),
  );
}

// --- 描画: ファイル操作（Finder / エディタ / ダウンロード）---------------------

const LOOPBACK_HOSTNAMES = ["localhost", "127.0.0.1", "::1", "[::1]"];

/** このタブがローカルから見ているか。tunnel 越しではローカルアプリを開く導線を出さない */
function isLocalView(): boolean {
  return LOOPBACK_HOSTNAMES.includes(location.hostname);
}

async function revealFile(fileId: number, target: "finder" | "editor"): Promise<void> {
  const res = await fetch(`/api/files/${fileId}/reveal`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ target }),
  });
  if (res.ok) return;
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  throw new Error(body?.error ?? `開けませんでした (${res.status})`);
}

function buildFileActions(file: FileEntry): HTMLElement {
  const wrap = el("div", { class: "file-actions" });
  const status = el("span", { class: "file-action-status", role: "status" });

  if (isLocalView() && file.hasLocalFile) {
    const targets: Array<["finder" | "editor", string, string]> = [
      ["finder", "Finder", "publish 元のファイルを Finder で表示"],
      ["editor", "エディタ", "publish 元のファイルをエディタで開く"],
    ];
    for (const [target, label, hint] of targets) {
      if (target === "editor" && !state.editorEnabled) continue;
      const button = el("button", { class: "seg", type: "button", title: hint }, label);
      button.addEventListener("click", () => {
        status.textContent = "";
        button.disabled = true;
        revealFile(file.id, target)
          .catch((err: unknown) => {
            status.textContent = err instanceof Error ? err.message : String(err);
          })
          .finally(() => {
            button.disabled = false;
          });
      });
      wrap.append(button);
    }
  }

  const rev = state.currentRev ?? file.latestRev;
  const remove = el(
    "button",
    { class: "seg", type: "button", title: "このファイルを全リビジョンごと削除" },
    "削除",
  );
  remove.addEventListener("click", () => {
    confirmDestructive(
      remove,
      `「${file.title ?? file.name}」を全リビジョン・コメントごと削除します。元に戻せません。`,
      () => {
        void postJson(`/api/files/${file.id}/delete`).then(() => {
          state.currentFileName = null;
          pushUrl();
          return Promise.all([loadFiles(), loadView()]);
        });
      },
    );
  });
  wrap.append(
    el(
      "a",
      {
        class: "seg",
        href: `/api/files/${file.id}/download?rev=${rev}`,
        title: "表示中のリビジョンを原本のまま保存",
      },
      "ダウンロード",
    ),
    remove,
    status,
  );
  return wrap;
}

// --- 描画: ファイルビュー --------------------------------------------------

function renderViewChrome(file: FileEntry): void {
  const chrome = document.getElementById("view-chrome");
  if (chrome == null) return;

  const revSelect = el("select", { class: "rev-select" });
  const latest = file.latestRev;
  for (const revision of [...state.revisions].reverse()) {
    const isLatest = revision.rev === latest;
    const option = el(
      "option",
      { value: String(revision.rev) },
      `rev ${revision.rev}${isLatest ? " (latest)" : ""} · ${formatTime(revision.createdAt)}`,
    );
    revSelect.append(option);
  }
  revSelect.value = String(state.currentRev ?? latest);
  revSelect.addEventListener("change", () => {
    const rev = Number(revSelect.value);
    state.currentRev = rev === latest ? null : rev;
    pushUrl();
    void loadView();
  });

  const modes: Array<[ViewMode, string]> = [
    ["rendered", "表示"],
    ["source", "ソース"],
    ["diff", "差分"],
  ];
  const modeGroup = el("div", { class: "seg-group" });
  for (const [mode, label] of modes) {
    const button = el(
      "button",
      { class: `seg ${state.viewMode === mode ? "active" : ""}`, type: "button" },
      label,
    );
    if (mode === "diff" && state.revisions.length < 2) button.setAttribute("disabled", "");
    button.addEventListener("click", () => {
      state.viewMode = mode;
      if (mode === "diff") {
        const shownRev = state.currentRev ?? file.latestRev;
        state.diffTo = shownRev > 1 ? shownRev : file.latestRev;
        state.diffFrom = Math.max(1, state.diffTo - 1);
      }
      void loadView();
    });
    modeGroup.append(button);
  }

  const commentToggle = el(
    "button",
    {
      id: "comment-toggle",
      class: `seg ${state.commentsOpen ? "active" : ""}`,
      type: "button",
      title: "コメントパネルを開閉",
    },
    commentToggleLabel(),
  );
  commentToggle.addEventListener("click", () => {
    setCommentsOpen(!state.commentsOpen);
    commentToggle.classList.toggle("active", state.commentsOpen);
  });

  const title = el("div", { class: "view-title" }, file.title ?? file.name);
  chrome.replaceChildren(title, buildFileActions(file), revSelect, modeGroup, commentToggle);

  if (state.viewMode === "diff") {
    if (state.diffTo > latest || state.diffTo < 1) state.diffTo = latest;
    if (state.diffFrom >= state.diffTo) state.diffFrom = Math.max(1, state.diffTo - 1);

    const from = el("select", {});
    const to = el("select", {});
    for (const revision of state.revisions) {
      from.append(el("option", { value: String(revision.rev) }, `rev ${revision.rev}`));
      to.append(el("option", { value: String(revision.rev) }, `rev ${revision.rev}`));
    }
    from.value = String(state.diffFrom);
    to.value = String(state.diffTo);
    from.addEventListener("change", () => {
      state.diffFrom = Number(from.value);
      void loadView();
    });
    to.addEventListener("change", () => {
      state.diffTo = Number(to.value);
      void loadView();
    });

    const styleButton = el(
      "button",
      { class: "seg", type: "button" },
      state.diffStyle === "line-by-line" ? "side-by-side表示" : "unified表示",
    );
    styleButton.addEventListener("click", () => {
      state.diffStyle = state.diffStyle === "line-by-line" ? "side-by-side" : "line-by-line";
      void loadView();
    });

    chrome.append(
      el("div", { class: "diff-controls" }, from, el("span", {}, "→"), to, styleButton),
    );
  }
}

async function renderViewBody(file: FileEntry, generation: number): Promise<void> {
  const main = document.getElementById("view");
  if (main == null) return;

  if (state.viewMode === "diff") {
    const diffText = await (
      await fetch(`/api/files/${file.id}/diff?from=${state.diffFrom}&to=${state.diffTo}`)
    ).text();
    if (generation !== viewGeneration) return;
    const container = el("div", { class: "diff-container" });
    container.innerHTML = renderDiffHtml(diffText, {
      drawFileList: false,
      matching: "lines",
      outputFormat: state.diffStyle,
    });
    main.replaceChildren(container);
    return;
  }

  const revQuery = state.currentRev == null ? "" : `?rev=${state.currentRev}`;
  const data = await fetchJson<ContentResponse>(`/api/files/${file.id}/content${revQuery}`);
  if (generation !== viewGeneration) return;

  if (state.viewMode === "source") {
    const pre = el("pre", { class: "source-view" });
    pre.textContent = data.content;
    main.replaceChildren(pre);
    return;
  }

  if (file.format === "html") {
    const iframe = el("iframe", {
      class: "html-frame",
      src: `/raw/${file.sessionId}/${encodeURIComponent(file.name)}${revQuery}`,
    });
    main.replaceChildren(iframe);
    return;
  }

  const article = el("article", { class: "markdown-body" });
  article.innerHTML = data.html ?? "";
  const layout = el(
    "div",
    { class: "doc-layout" },
    el("div", { class: "doc-main" }, el("div", { id: "inline-file-comments" }), article),
    el("div", { id: "margin-comments", class: "doc-margin" }),
  );
  main.replaceChildren(layout);
  // 画像・mermaid の遅延レイアウトで本文の高さが変わったら余白カードを並べ直す
  articleObserver.disconnect();
  articleObserver.observe(article);
  const mermaidNodes = article.querySelectorAll<HTMLElement>("pre.mermaid");
  if (mermaidNodes.length > 0) {
    try {
      await mermaid.run({ nodes: mermaidNodes });
    } catch {
      // 不正な mermaid 記法はソースのまま表示される
    }
  }
}

// --- コメント: パネル・ハイライト・選択コメント -------------------------------

/** 開閉はリロードを跨いで維持する（固定ペインとしての表示状態） */
function setCommentsOpen(open: boolean): void {
  state.commentsOpen = open;
  localStorage.setItem("kairan:commentsOpen", String(open));
  renderCommentsPanel();
}

function commentToggleLabel(): string {
  return state.comments.length > 0 ? `コメント ${state.comments.length}` : "コメント";
}

function renderCommentToggle(): void {
  const button = document.getElementById("comment-toggle");
  if (button == null) return;
  button.textContent = commentToggleLabel();
  button.classList.toggle("active", state.commentsOpen);
}

async function refreshFeedbackViews(): Promise<void> {
  await Promise.all([loadComments(), loadFiles(), loadReviewDraft()]);
}

function renderCommentsPanel(): void {
  const panel = document.getElementById("comments-panel");
  if (panel == null) return;
  panel.classList.toggle("hidden", !state.commentsOpen);
  renderCommentToggle();
  if (!state.commentsOpen) return;

  const close = el("button", { class: "pane-collapse", type: "button", title: "閉じる" }, "×");
  close.addEventListener("click", () => {
    setCommentsOpen(false);
  });
  const header = el("div", { class: "comments-header" }, el("span", {}, "コメント"), close);
  const body = el("div", { class: "comments-body" });

  const file = currentFile();
  if (file == null) {
    body.append(el("div", { class: "placeholder" }, "ファイルを選択してください"));
  } else {
    body.append(buildWholeFileComposer(file));
    if (state.comments.length === 0) {
      body.append(
        el(
          "div",
          { class: "placeholder" },
          "コメントはまだありません。本文を選択するとコメントできます",
        ),
      );
    }
    for (const comment of state.comments) {
      body.append(buildCommentCard(file, comment));
    }
  }
  panel.replaceChildren(header, body);
}

function buildWholeFileComposer(file: FileItem): HTMLElement {
  const wrap = el("div", { class: "whole-composer" });
  const toggle = el("button", { class: "btn-ghost", type: "button" }, "＋ ファイル全体にコメント");
  toggle.addEventListener("click", () => {
    toggle.classList.add("hidden");
    const textarea = el("textarea", {
      class: "composer-input",
      rows: "3",
      placeholder: "ファイル全体へのコメント",
    });
    const submit = el("button", { class: "btn-primary", type: "button" }, "下書きに追加");
    const cancel = el("button", { class: "btn-ghost", type: "button" }, "取消");
    const editor = el(
      "div",
      { class: "composer" },
      textarea,
      el("div", { class: "composer-actions" }, cancel, submit),
    );
    cancel.addEventListener("click", () => {
      editor.remove();
      toggle.classList.remove("hidden");
    });
    submit.addEventListener("click", () => {
      const body = textarea.value.trim();
      if (body === "") return;
      void postJson(`/api/files/${file.id}/comments`, {
        rev: state.currentRev ?? file.latestRev,
        anchor: null,
        body,
      }).then(() => refreshFeedbackViews());
    });
    submitOnCmdEnter(textarea, () => submit.click());
    wrap.append(editor);
    textarea.focus();
  });
  wrap.append(toggle);
  return wrap;
}

function buildCommentCard(file: FileItem, comment: FileComment): HTMLElement {
  const card = el("div", { class: `comment-card state-${comment.state}` });
  card.dataset.commentId = String(comment.id);

  const stateLabel =
    comment.state === "draft" ? "下書き" : comment.state === "resolved" ? "解決済" : "オープン";
  const head = el(
    "div",
    { class: "comment-head" },
    el("span", { class: `badge comment-state-${comment.state}` }, stateLabel),
    el("span", { class: "badge badge-rev" }, `rev ${comment.rev}`),
  );
  if (comment.rev < file.latestRev && comment.state === "open") {
    head.append(el("span", { class: "badge" }, "旧rev"));
  }
  card.append(head);

  if (comment.anchor != null) {
    card.append(el("blockquote", { class: "comment-quote" }, comment.anchor.exact));
  }
  const bodyText = el("div", { class: "comment-text" }, comment.body);
  card.append(bodyText);

  for (const reply of comment.replies) {
    const author = reply.author === "agent" ? "agent" : "あなた";
    const replyBox = el(
      "div",
      { class: `comment-reply from-${reply.author}` },
      el("span", { class: "reply-author" }, author),
      el("span", { class: "reply-body" }, reply.body),
    );
    if (reply.state === "draft") replyBox.append(el("span", { class: "badge" }, "下書き"));
    card.append(replyBox);
  }

  const actions = el("div", { class: "comment-actions" });
  const refresh = (): Promise<unknown> => refreshFeedbackViews();

  if (comment.state === "draft") {
    const editButton = el("button", { class: "btn-ghost", type: "button" }, "編集");
    editButton.addEventListener("click", () => {
      const textarea = el("textarea", { class: "composer-input", rows: "3" });
      textarea.value = comment.body;
      const save = el("button", { class: "btn-primary", type: "button" }, "保存");
      save.addEventListener("click", () => {
        const body = textarea.value.trim();
        if (body === "") return;
        void postJson(`/api/comments/${comment.id}/update`, { body }).then(refresh);
      });
      submitOnCmdEnter(textarea, () => save.click());
      bodyText.replaceChildren(textarea, el("div", { class: "composer-actions" }, save));
      textarea.focus();
    });
    const deleteButton = el("button", { class: "btn-ghost", type: "button" }, "削除");
    deleteButton.addEventListener("click", () => {
      void postJson(`/api/comments/${comment.id}/delete`).then(refresh);
    });
    actions.append(editButton, deleteButton);
  } else if (comment.state === "open") {
    const replyButton = el("button", { class: "btn-ghost", type: "button" }, "返信");
    replyButton.addEventListener("click", () => {
      replyButton.classList.add("hidden");
      const textarea = el("textarea", {
        class: "composer-input",
        rows: "2",
        placeholder: "返信（レビュー送信時に届きます）",
      });
      const send = el("button", { class: "btn-primary", type: "button" }, "返信を下書き");
      send.addEventListener("click", () => {
        const body = textarea.value.trim();
        if (body === "") return;
        void postJson(`/api/comments/${comment.id}/reply`, { author: "human", body }).then(refresh);
      });
      submitOnCmdEnter(textarea, () => send.click());
      actions.before(
        el("div", { class: "composer" }, textarea, el("div", { class: "composer-actions" }, send)),
      );
      textarea.focus();
    });
    const resolveButton = el("button", { class: "btn-ghost", type: "button" }, "解決");
    resolveButton.addEventListener("click", () => {
      void postJson(`/api/comments/${comment.id}/resolve`).then(refresh);
    });
    actions.append(replyButton, resolveButton);
  } else {
    const reopenButton = el("button", { class: "btn-ghost", type: "button" }, "再オープン");
    reopenButton.addEventListener("click", () => {
      void postJson(`/api/comments/${comment.id}/reopen`).then(refresh);
    });
    actions.append(reopenButton);
  }
  card.append(actions);
  return card;
}

function applyCommentHighlights(): void {
  const article = document.querySelector<HTMLElement>(".markdown-body");
  if (article == null) return;
  // 既存のハイライトを剥がしてから貼り直す（削除・解決・再取得の反映）
  for (const mark of [...article.querySelectorAll("mark.comment-hl")]) {
    const parent = mark.parentNode;
    if (parent == null) continue;
    while (mark.firstChild != null) parent.insertBefore(mark.firstChild, mark);
    mark.remove();
    parent.normalize();
  }
  for (const comment of state.comments) {
    if (comment.anchor == null || comment.state === "resolved") continue;
    highlightQuote(article, comment);
  }
}

function highlightQuote(article: HTMLElement, comment: FileComment): void {
  const anchor = comment.anchor;
  if (anchor == null) return;
  const full = article.textContent ?? "";
  // 前後文脈つきで探し、無ければ引用単体で探す（リビジョン更新後の位置ずれ対策）
  let start = full.indexOf(anchor.prefix + anchor.exact);
  if (start >= 0) start += anchor.prefix.length;
  else start = full.indexOf(anchor.exact);
  if (start < 0) return;
  const end = start + anchor.exact.length;

  const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT);
  const targets: Array<{ node: Text; from: number; to: number }> = [];
  let pos = 0;
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    const nodeStart = pos;
    const nodeEnd = pos + node.data.length;
    if (nodeEnd > start && nodeStart < end) {
      targets.push({
        node,
        from: Math.max(0, start - nodeStart),
        to: Math.min(node.data.length, end - nodeStart),
      });
    }
    pos = nodeEnd;
    if (pos >= end) break;
  }
  for (const target of targets) {
    const range = document.createRange();
    range.setStart(target.node, target.from);
    range.setEnd(target.node, target.to);
    const mark = document.createElement("mark");
    mark.className = "comment-hl";
    mark.dataset.commentId = String(comment.id);
    mark.addEventListener("mouseenter", () => {
      // 余白カラムが無い幅ではハイライトの hover でカードを出す
      if (marginCardFor(comment.id) == null) {
        cancelPopoverHide();
        showMarginPopover(comment, mark);
      } else {
        setCardEmphasis(comment.id, true);
      }
    });
    mark.addEventListener("mouseleave", () => {
      scheduleHidePopover();
      setCardEmphasis(comment.id, false);
    });
    mark.addEventListener("click", () => {
      const marginCard = marginCardFor(comment.id);
      if (marginCard != null) {
        marginCard.scrollIntoView({ block: "nearest", behavior: "smooth" });
        marginCard.classList.add("flash");
        setTimeout(() => marginCard.classList.remove("flash"), 900);
        return;
      }
      showMarginPopover(comment, mark);
    });
    try {
      range.surroundContents(mark);
    } catch {
      // 要素境界を跨ぐ場合は諦める（コメント自体はパネルに表示される）
    }
  }
}

// --- 余白コメント（未 resolve を当該箇所の横に常時表示） ----------------------

/** これ未満のビュー幅では余白カラムを畳み、ハイライトの hover 表示に切り替える */
const MARGIN_MIN_VIEW_WIDTH = 900;

let marginRelayoutScheduled = false;

function scheduleMarginRelayout(): void {
  if (marginRelayoutScheduled) return;
  marginRelayoutScheduled = true;
  requestAnimationFrame(() => {
    marginRelayoutScheduled = false;
    renderMarginComments();
  });
}

const articleObserver = new ResizeObserver(scheduleMarginRelayout);

function marginCardFor(commentId: number): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    `#margin-comments .comment-card[data-comment-id="${commentId}"]`,
  );
}

function setCardEmphasis(commentId: number, on: boolean): void {
  marginCardFor(commentId)?.classList.toggle("emphasis", on);
}

function setMarkEmphasis(commentId: number, on: boolean): void {
  for (const mark of document.querySelectorAll(`mark.comment-hl[data-comment-id="${commentId}"]`)) {
    mark.classList.toggle("emphasis", on);
  }
}

function renderMarginComments(): void {
  const layout = document.querySelector<HTMLElement>(".doc-layout");
  const margin = document.getElementById("margin-comments");
  const inline = document.getElementById("inline-file-comments");
  const view = document.getElementById("view");
  hideMarginPopover();
  if (layout == null || margin == null || inline == null || view == null) return;
  const file = currentFile();
  if (file == null) {
    margin.replaceChildren();
    inline.replaceChildren();
    return;
  }

  const unresolved = state.comments.filter((c) => c.state !== "resolved");

  // ファイル全体コメント（アンカーなし）は本文の先頭に出す
  inline.replaceChildren(
    ...unresolved
      .filter((c) => c.anchor == null)
      .map((comment) => {
        const card = buildCommentCard(file, comment);
        card.classList.add("margin-card", "inline-file-card");
        return card;
      }),
  );

  const anchored = unresolved.filter((c) => c.anchor != null);
  const narrow = view.clientWidth < MARGIN_MIN_VIEW_WIDTH;
  layout.classList.toggle("no-margin", narrow || anchored.length === 0);
  margin.replaceChildren();
  if (narrow || anchored.length === 0) return;

  // ハイライト位置に合わせて縦位置を決め、重なる場合は下に押し出す
  const layoutTop = layout.getBoundingClientRect().top;
  const entries: Array<{ card: HTMLElement; top: number }> = [];
  for (const comment of anchored) {
    const mark = document.querySelector<HTMLElement>(
      `mark.comment-hl[data-comment-id="${comment.id}"]`,
    );
    const card = buildCommentCard(file, comment);
    card.classList.add("margin-card");
    card.addEventListener("mouseenter", () => setMarkEmphasis(comment.id, true));
    card.addEventListener("mouseleave", () => setMarkEmphasis(comment.id, false));
    entries.push({
      card,
      top: mark == null ? 0 : mark.getBoundingClientRect().top - layoutTop,
    });
  }
  entries.sort((a, b) => a.top - b.top);
  margin.append(...entries.map((entry) => entry.card));
  let prevBottom = Number.NEGATIVE_INFINITY;
  for (const entry of entries) {
    const top = Math.max(entry.top, prevBottom + 8, 0);
    entry.card.style.top = `${top}px`;
    prevBottom = top + entry.card.offsetHeight;
  }
  margin.style.minHeight = `${prevBottom + 24}px`;
}

let popoverHideTimer: ReturnType<typeof setTimeout> | null = null;

function cancelPopoverHide(): void {
  if (popoverHideTimer != null) {
    clearTimeout(popoverHideTimer);
    popoverHideTimer = null;
  }
}

function scheduleHidePopover(): void {
  cancelPopoverHide();
  popoverHideTimer = setTimeout(() => hideMarginPopover(), 250);
}

function hideMarginPopover(): void {
  document.getElementById("margin-popover")?.remove();
}

function showMarginPopover(comment: FileComment, mark: HTMLElement): void {
  const file = currentFile();
  if (file == null) return;
  hideMarginPopover();
  const card = buildCommentCard(file, comment);
  card.classList.add("margin-card");
  const popover = el("div", { id: "margin-popover", class: "margin-popover" }, card);
  const rect = mark.getBoundingClientRect();
  popover.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 340))}px`;
  popover.style.top = `${Math.min(rect.bottom + 6, window.innerHeight - 220)}px`;
  popover.addEventListener("mouseenter", cancelPopoverHide);
  popover.addEventListener("mouseleave", scheduleHidePopover);
  document.body.append(popover);
}

let pendingAnchor: CommentAnchor | null = null;

function computeAnchor(article: HTMLElement, range: Range): CommentAnchor {
  const before = range.cloneRange();
  before.selectNodeContents(article);
  before.setEnd(range.startContainer, range.startOffset);
  const after = range.cloneRange();
  after.selectNodeContents(article);
  after.setStart(range.endContainer, range.endOffset);
  return {
    exact: range.toString(),
    prefix: before.toString().slice(-30),
    suffix: after.toString().slice(0, 30),
  };
}

function hideCommentFab(): void {
  document.getElementById("comment-fab")?.classList.add("hidden");
}

function handleSelectionEnd(): void {
  const fab = document.getElementById("comment-fab");
  if (fab == null) return;
  const selection = window.getSelection();
  const article = document.querySelector<HTMLElement>(".markdown-body");
  if (selection == null || selection.isCollapsed || selection.rangeCount === 0 || article == null) {
    return;
  }
  const range = selection.getRangeAt(0);
  if (!article.contains(range.commonAncestorContainer)) return;
  if (range.toString().trim() === "") return;

  pendingAnchor = computeAnchor(article, range);
  const rect = range.getBoundingClientRect();
  fab.style.left = `${Math.min(rect.left + rect.width / 2 - 40, window.innerWidth - 140)}px`;
  fab.style.top = `${Math.min(rect.bottom + 6, window.innerHeight - 48)}px`;
  fab.classList.remove("hidden");
}

function openSelectionComposer(): void {
  const fab = document.getElementById("comment-fab");
  const anchor = pendingAnchor;
  const file = currentFile();
  if (fab == null || anchor == null || file == null) return;
  const left = fab.style.left;
  const top = fab.style.top;
  hideCommentFab();

  document.getElementById("selection-composer")?.remove();
  const textarea = el("textarea", { class: "composer-input", rows: "3", placeholder: "コメント" });
  const submit = el("button", { class: "btn-primary", type: "button" }, "下書きに追加");
  const cancel = el("button", { class: "btn-ghost", type: "button" }, "取消");
  const composer = el(
    "div",
    { id: "selection-composer", class: "selection-composer" },
    el("blockquote", { class: "comment-quote" }, anchor.exact),
    textarea,
    el("div", { class: "composer-actions" }, cancel, submit),
  );
  composer.style.left = left;
  composer.style.top = top;
  cancel.addEventListener("click", () => composer.remove());
  submit.addEventListener("click", () => {
    const body = textarea.value.trim();
    if (body === "") return;
    void postJson(`/api/files/${file.id}/comments`, {
      rev: state.currentRev ?? file.latestRev,
      anchor,
      body,
    }).then(() => {
      composer.remove();
      return refreshFeedbackViews();
    });
  });
  submitOnCmdEnter(textarea, () => submit.click());
  document.body.append(composer);
  textarea.focus();
}

// --- 質問カード -------------------------------------------------------------

function renderAsks(): void {
  const container = document.getElementById("asks");
  if (container == null) return;
  container.replaceChildren();
  if (state.currentSessionId == null) return;
  for (const ask of state.openAsks) {
    container.append(buildAskCard(ask));
  }
}

function buildAskCard(ask: Ask): HTMLElement {
  const card = el("section", { class: "ask-card" });
  const title = el("div", { class: "ask-title" }, el("span", {}, "agent からの質問"));
  if (ask.fileId != null) {
    const file = state.files.find((f) => f.id === ask.fileId);
    if (file != null) {
      const chip = el(
        "button",
        { class: "ask-file-chip", type: "button" },
        file.title ?? file.name,
      );
      chip.addEventListener("click", () => {
        void selectFile(file.name);
      });
      title.append(chip);
    }
  }
  card.append(title);

  const answers = new Map<string, { selected: Set<string>; freeText: string }>();
  for (const question of ask.questions) {
    answers.set(question.id, { selected: new Set(), freeText: "" });
  }
  const submit = el("button", { class: "btn-primary", type: "button" }, "回答を送信");
  const updateSubmit = (): void => {
    const complete = ask.questions.every((question) => {
      const answer = answers.get(question.id);
      return answer != null && (answer.selected.size > 0 || answer.freeText.trim() !== "");
    });
    submit.disabled = !complete;
  };

  for (const question of ask.questions) {
    const box = el("div", { class: "ask-question" });
    const heading = el("div", { class: "ask-question-text" });
    if (question.header != null) heading.append(el("span", { class: "badge" }, question.header));
    heading.append(question.question);
    box.append(heading);

    const options = el("div", { class: "ask-options" });
    for (const option of question.options) {
      const input = el("input", {
        type: question.multiSelect ? "checkbox" : "radio",
        name: `ask${ask.id}-${question.id}`,
      });
      input.addEventListener("change", () => {
        const answer = answers.get(question.id);
        if (answer == null) return;
        if (!question.multiSelect) answer.selected.clear();
        if (input.checked) answer.selected.add(option.label);
        else answer.selected.delete(option.label);
        updateSubmit();
      });
      const label = el(
        "label",
        { class: "ask-option" },
        input,
        el("span", { class: "ask-option-main" }, option.label),
      );
      if (option.description != null) {
        label.append(el("span", { class: "ask-option-desc" }, option.description));
      }
      options.append(label);
    }
    box.append(options);

    const free = el("textarea", {
      class: "ask-free",
      rows: "1",
      placeholder: "自由記述（選択の補足、または別案）",
    });
    free.addEventListener("input", () => {
      const answer = answers.get(question.id);
      if (answer == null) return;
      answer.freeText = free.value;
      updateSubmit();
    });
    submitOnCmdEnter(free, () => {
      if (!submit.disabled) submit.click();
    });
    box.append(free);
    card.append(box);
  }
  updateSubmit();

  submit.addEventListener("click", () => {
    submit.disabled = true;
    const payload = ask.questions.map((question) => {
      const answer = answers.get(question.id);
      const freeText = answer?.freeText.trim() ?? "";
      return {
        questionId: question.id,
        selected: [...(answer?.selected ?? [])],
        freeText: freeText === "" ? null : freeText,
      };
    });
    void postJson(`/api/asks/${ask.id}/answer`, { answers: payload })
      .then(() => Promise.all([loadAsks(), loadSessions(), loadFiles()]))
      .catch(() => {
        submit.disabled = false;
      });
  });
  card.append(el("div", { class: "ask-actions" }, submit));
  return card;
}

// --- レビューバー -----------------------------------------------------------

let summaryFlushTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleSummaryFlush(sessionId: string, summary: string): void {
  state.reviewSummary = summary;
  if (summaryFlushTimer != null) clearTimeout(summaryFlushTimer);
  summaryFlushTimer = setTimeout(() => {
    summaryFlushTimer = null;
    void postJson(`/api/sessions/${sessionId}/review/summary`, { summary }).catch(() => {});
  }, 600);
}

function renderReviewBar(): void {
  const bar = document.getElementById("review-bar");
  if (bar == null) return;
  const sessionId = state.currentSessionId;
  if (sessionId == null) {
    bar.classList.add("hidden");
    bar.replaceChildren();
    return;
  }
  bar.classList.remove("hidden");

  const session = state.sessions.find((s) => s.id === sessionId);
  const waiting = session?.reviewWaiting === true;
  const submitLabel =
    state.reviewDraftCount === 0 && state.reviewSummary.trim() === ""
      ? "コメントなしで返す"
      : `送信（${state.reviewDraftCount}件）`;

  // 入力中の再構築はカーソルを失うため、テキスト部分だけ更新する
  const existing = bar.querySelector<HTMLTextAreaElement>(".review-summary");
  if (existing != null && document.activeElement === existing) {
    const count = bar.querySelector(".review-count");
    if (count != null) count.textContent = `下書き${state.reviewDraftCount}件`;
    const submit = bar.querySelector(".review-submit");
    if (submit != null) submit.textContent = submitLabel;
    bar.querySelector(".review-waiting")?.classList.toggle("hidden", !waiting);
    return;
  }

  const textarea = el("textarea", {
    class: "review-summary",
    rows: "1",
    placeholder: "総評（任意）",
  });
  textarea.value = state.reviewSummary;
  textarea.addEventListener("input", () => {
    scheduleSummaryFlush(sessionId, textarea.value);
    renderReviewBarLabels();
  });
  const submit = el("button", { class: "btn-primary review-submit", type: "button" }, submitLabel);
  submitOnCmdEnter(textarea, () => submit.click());
  submit.addEventListener("click", () => {
    submit.disabled = true;
    if (summaryFlushTimer != null) {
      clearTimeout(summaryFlushTimer);
      summaryFlushTimer = null;
    }
    void postJson(`/api/sessions/${sessionId}/review/summary`, { summary: textarea.value })
      .then(() => postJson(`/api/sessions/${sessionId}/review/submit`))
      .then(() => refreshFeedbackViews())
      .catch(() => {})
      .finally(() => {
        submit.disabled = false;
      });
  });

  const waitingBadge = el(
    "span",
    { class: `badge badge-attention review-waiting ${waiting ? "" : "hidden"}` },
    "agent 待機中",
  );
  bar.replaceChildren(
    el("span", { class: "review-label" }, "レビュー"),
    el("span", { class: "badge review-count" }, `下書き${state.reviewDraftCount}件`),
    waitingBadge,
    textarea,
    submit,
  );
}

function renderReviewBarLabels(): void {
  const bar = document.getElementById("review-bar");
  const submit = bar?.querySelector(".review-submit");
  if (bar == null || submit == null) return;
  const textarea = bar.querySelector<HTMLTextAreaElement>(".review-summary");
  const summary = textarea?.value ?? "";
  submit.textContent =
    state.reviewDraftCount === 0 && summary.trim() === ""
      ? "コメントなしで返す"
      : `送信（${state.reviewDraftCount}件）`;
}

// --- 選択・遷移 -----------------------------------------------------------

async function selectSession(sessionId: string | null): Promise<void> {
  const changed = state.currentSessionId !== sessionId;
  state.currentSessionId = sessionId;
  state.currentFileName = null;
  state.currentRev = null;
  pushUrl();
  renderSessions();
  await loadFiles();
  await loadView();
  await Promise.all([loadAsks(), loadReviewDraft()]);
  if (changed) connectEvents();
}

async function selectFile(fileName: string | null, rev: number | null = null): Promise<void> {
  state.currentFileName = fileName;
  state.currentRev = rev;
  state.viewMode = "rendered";
  pushUrl();
  renderFiles();
  await loadView();
}

// --- SSE -----------------------------------------------------------------

let eventSource: EventSource | null = null;
let publishEventGeneration = 0;

/**
 * 切断中の変化を取り込む。デーモンが止まっている間の削除・アーカイブはイベントが
 * 届かないため、張り直したときに一覧ごと取り直す
 */
async function resyncAfterReconnect(): Promise<void> {
  await loadSessions();
  const sessionId = state.currentSessionId;
  if (sessionId == null) return;
  // 畳まれただけのセッションを閉じてしまわないよう、archived 込みの一覧で確かめる
  const all = await fetchJson<SessionItem[]>("/api/sessions?include_archived=true");
  if (all.some((session) => session.id === sessionId)) return;
  await selectSession(null);
}

function connectEvents(): void {
  eventSource?.close();
  const query = state.currentSessionId == null ? "" : `?session=${state.currentSessionId}`;
  eventSource = new EventSource(`/api/events${query}`);

  // 初回接続の直前に取得済みなので、張り直したときだけ取り直す
  let connectedBefore = false;
  eventSource.addEventListener("open", () => {
    if (!connectedBefore) {
      connectedBefore = true;
      return;
    }
    void resyncAfterReconnect();
  });

  const sessionEvents = [
    "session:created",
    "session:archived",
    "session:activated",
    "session:updated",
  ];
  for (const type of sessionEvents) {
    eventSource.addEventListener(type, () => {
      void loadSessions();
    });
  }

  // 別タブでの削除に追従する。表示中のものが消えたら一覧へ戻す
  eventSource.addEventListener("session:deleted", (event) => {
    const data = JSON.parse((event as MessageEvent).data) as Extract<
      KairanEvent,
      { type: "session:deleted" }
    >;
    forgetUnreadOfSession(data.sessionId);
    if (data.sessionId === state.currentSessionId) {
      void selectSession(null);
    }
    void loadSessions();
    refreshTabIndicator();
  });

  eventSource.addEventListener("file:deleted", (event) => {
    const data = JSON.parse((event as MessageEvent).data) as Extract<
      KairanEvent,
      { type: "file:deleted" }
    >;
    state.unreadFiles.delete(data.fileId);
    if (data.sessionId !== state.currentSessionId) return;
    if (currentFile()?.id === data.fileId) {
      state.currentFileName = null;
      pushUrl();
    }
    void loadFiles().then(() => loadView());
  });

  eventSource.addEventListener("feedback:changed", (event) => {
    const data = JSON.parse((event as MessageEvent).data) as Extract<
      KairanEvent,
      { type: "feedback:changed" }
    >;
    if (data.sessionId !== state.currentSessionId) return;
    void loadFiles();
    void loadReviewDraft();
    const file = currentFile();
    if (file != null && (data.fileId == null || data.fileId === file.id)) {
      void loadComments();
    }
  });

  eventSource.addEventListener("review:waiting", () => {
    void loadSessions();
  });

  eventSource.addEventListener("ask:changed", (event) => {
    const data = JSON.parse((event as MessageEvent).data) as Extract<
      KairanEvent,
      { type: "ask:changed" }
    >;
    void loadSessions();
    if (data.sessionId !== state.currentSessionId) return;
    void loadAsks();
    void loadFiles();
  });

  eventSource.addEventListener("file:published", (event) => {
    const data = JSON.parse((event as MessageEvent).data) as Extract<
      KairanEvent,
      { type: "file:published" }
    >;
    void loadSessions();
    if (data.sessionId !== state.currentSessionId) {
      markUnread(data.fileId, data.sessionId);
      return;
    }
    const generation = ++publishEventGeneration;
    void loadFiles().then(async () => {
      if (data.sessionId !== state.currentSessionId) return;
      // follow の切替先は「最新のイベント」だけ。古いイベントが追い越された場合は切り替えない
      if (state.follow && generation === publishEventGeneration) {
        state.currentFileName = data.fileName;
        state.currentRev = null;
        state.viewMode = "rendered";
        pushUrl();
        renderFiles();
        await loadView();
      } else if (state.currentFileName === data.fileName && state.currentRev == null) {
        // 表示中ファイルの更新はイベントの新旧に関係なく反映する（loadView 自体が世代保護済み）
        await loadView();
      } else {
        markUnread(data.fileId, data.sessionId);
      }
    });
  });
}

// --- サイドバーの開閉・リサイズ --------------------------------------------

interface PaneUi {
  collapsed: boolean;
  width: number;
}

const PANE_DEFAULTS: Record<"sessions" | "files", PaneUi> = {
  sessions: { collapsed: false, width: 216 },
  files: { collapsed: false, width: 264 },
};

function loadPaneUi(): Record<"sessions" | "files", PaneUi> {
  try {
    const raw = localStorage.getItem("kairan:panes");
    if (raw != null) {
      const parsed = JSON.parse(raw) as Partial<Record<"sessions" | "files", Partial<PaneUi>>>;
      return {
        sessions: { ...PANE_DEFAULTS.sessions, ...parsed.sessions },
        files: { ...PANE_DEFAULTS.files, ...parsed.files },
      };
    }
  } catch {
    // 壊れた保存値はデフォルトに戻す
  }
  return structuredClone(PANE_DEFAULTS);
}

const paneUi = loadPaneUi();

function savePaneUi(): void {
  localStorage.setItem("kairan:panes", JSON.stringify(paneUi));
}

const PANE_MIN_WIDTH = 150;
const PANE_MAX_WIDTH = 480;

function buildSidebarPane(
  key: "sessions" | "files",
  title: string,
  bodyId: string,
  className: string,
  headerExtra: HTMLElement[],
): HTMLElement {
  const ui = paneUi[key];
  const pane = el("aside", { class: `pane ${className}` });
  const rail = el(
    "div",
    { class: "pane-rail", title: `${title}を開く` },
    el("span", { class: "pane-rail-label" }, title),
  );
  const collapseButton = el(
    "button",
    { class: "pane-collapse", type: "button", title: `${title}を閉じる` },
    "«",
  );
  const inner = el(
    "div",
    { class: "pane-inner" },
    el(
      "div",
      { class: "pane-header" },
      el("span", {}, title),
      el("div", { class: "pane-header-controls" }, ...headerExtra, collapseButton),
    ),
    el("div", { id: bodyId, class: "pane-body" }),
  );
  const resizer = el("div", { class: "pane-resizer" });
  pane.append(rail, inner, resizer);

  const apply = (): void => {
    pane.classList.toggle("collapsed", ui.collapsed);
    pane.classList.remove("peeking");
    inner.style.left = "";
    inner.style.width = "";
    pane.style.width = ui.collapsed ? "" : `${ui.width}px`;
  };
  apply();

  collapseButton.addEventListener("click", () => {
    ui.collapsed = true;
    savePaneUi();
    apply();
  });
  rail.addEventListener("click", () => {
    ui.collapsed = false;
    savePaneUi();
    apply();
  });
  rail.addEventListener("mouseenter", () => {
    if (!ui.collapsed) return;
    // 閉じたまま一時的に覗く: レールの右に保存幅でオーバーレイ表示する
    const rect = pane.getBoundingClientRect();
    inner.style.left = `${rect.right}px`;
    inner.style.width = `${ui.width}px`;
    pane.classList.add("peeking");
  });
  pane.addEventListener("mouseleave", () => {
    if (ui.collapsed) pane.classList.remove("peeking");
  });

  resizer.addEventListener("mousedown", (event) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = ui.width;
    document.body.classList.add("resizing");
    const onMove = (moveEvent: MouseEvent): void => {
      ui.width = Math.min(
        PANE_MAX_WIDTH,
        Math.max(PANE_MIN_WIDTH, startWidth + moveEvent.clientX - startX),
      );
      pane.style.width = `${ui.width}px`;
    };
    const onUp = (): void => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.classList.remove("resizing");
      savePaneUi();
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });

  return pane;
}

// --- 初期化 ---------------------------------------------------------------

function buildLayout(): void {
  const root = document.getElementById("app");
  if (root == null) return;

  const followLabel = el("label", { class: "toggle" });
  const followInput = el("input", { type: "checkbox" });
  followInput.checked = state.follow;
  followInput.addEventListener("change", () => {
    state.follow = followInput.checked;
    localStorage.setItem("kairan:follow", String(state.follow));
  });
  followLabel.append(followInput, "新着に追従");

  const archivedLabel = el("label", { class: "toggle" });
  const archivedInput = el("input", { type: "checkbox" });
  archivedInput.checked = state.includeArchived;
  archivedInput.addEventListener("change", () => {
    state.includeArchived = archivedInput.checked;
    void loadSessions();
  });
  archivedLabel.append(archivedInput, "archived");

  root.replaceChildren(
    el(
      "header",
      { class: "topbar" },
      el("a", { class: "brand", href: "/" }, "KAIRAN"),
      el("div", { class: "topbar-controls" }, followLabel),
    ),
    el(
      "div",
      { class: "panes" },
      buildSidebarPane("sessions", "セッション", "sessions", "pane-sessions", [archivedLabel]),
      buildSidebarPane("files", "ファイル", "files", "pane-files", []),
      el(
        "main",
        { class: "pane pane-view" },
        el(
          "div",
          { class: "view-col" },
          el("div", { id: "asks", class: "asks" }),
          el("div", { id: "view-chrome", class: "view-chrome" }),
          el("div", { id: "view", class: "pane-body" }),
          el("div", { id: "review-bar", class: "review-bar hidden" }),
        ),
        el("aside", { id: "comments-panel", class: "comments-panel hidden" }),
      ),
    ),
  );

  const fab = el(
    "button",
    { id: "comment-fab", class: "comment-fab hidden", type: "button" },
    "コメント",
  );
  // mousedown で選択が消える前に composer を開く
  fab.addEventListener("mousedown", (event) => {
    event.preventDefault();
    openSelectionComposer();
  });
  document.body.append(fab);

  document.addEventListener("mouseup", (event) => {
    const target = event.target;
    if (target instanceof Node) {
      const inUi =
        target instanceof Element &&
        target.closest("#comment-fab, #selection-composer, #comments-panel") != null;
      if (inUi) return;
    }
    hideCommentFab();
    // click 直後は selection がまだ確定していないことがあるため1フレーム待つ
    setTimeout(handleSelectionEnd, 0);
  });

  const brand = root.querySelector(".brand");
  brand?.addEventListener("click", (event) => {
    event.preventDefault();
    void selectSession(null);
  });

  // ビュー幅の変化（ウィンドウ・ペインのリサイズ）で余白カードを再配置する
  const viewElement = document.getElementById("view");
  if (viewElement != null) {
    new ResizeObserver(scheduleMarginRelayout).observe(viewElement);
  }
}

async function applyUrl(): Promise<void> {
  const { sessionId, fileName, rev } = parsePath();
  state.currentSessionId = sessionId;
  state.currentFileName = fileName;
  state.currentRev = rev;
  renderSessions();
  await loadFiles();
  await loadView();
  await Promise.all([loadAsks(), loadReviewDraft()]);
  connectEvents();
}

async function main(): Promise<void> {
  const stored = localStorage.getItem("kairan:follow");
  if (stored != null) state.follow = stored === "true";
  state.commentsOpen = localStorage.getItem("kairan:commentsOpen") === "true";
  try {
    const config = await fetchJson<{
      followDefault: boolean;
      homeDir: string | null;
      editorEnabled: boolean;
    }>("/api/config");
    state.homeDir = config.homeDir ?? null;
    state.editorEnabled = config.editorEnabled;
    if (stored == null) state.follow = config.followDefault;
  } catch {
    // follow はデフォルト true のまま、パスは短縮なしで表示される
  }

  buildLayout();
  window.addEventListener("popstate", () => {
    void applyUrl();
  });
  await loadSessions();
  await applyUrl();
}

void main();
