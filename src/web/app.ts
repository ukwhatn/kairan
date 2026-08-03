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

async function loadSessions(): Promise<void> {
  state.sessions = await fetchJson<SessionItem[]>(
    `/api/sessions?include_archived=${state.includeArchived}`,
  );
  renderSessions();
  renderReviewBar();
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
    return;
  }
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

function buildSessionItem(session: SessionItem): HTMLElement {
  const label = session.name ?? session.id;
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
  );
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
    state.commentsOpen = !state.commentsOpen;
    commentToggle.classList.toggle("active", state.commentsOpen);
    renderCommentsPanel();
  });

  const title = el("div", { class: "view-title" }, file.title ?? file.name);
  chrome.replaceChildren(title, revSelect, modeGroup, commentToggle);

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
  main.replaceChildren(article);
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
    state.commentsOpen = false;
    renderCommentsPanel();
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
    mark.addEventListener("click", () => {
      state.commentsOpen = true;
      renderCommentsPanel();
      document
        .querySelector(`.comment-card[data-comment-id="${comment.id}"]`)
        ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
    try {
      range.surroundContents(mark);
    } catch {
      // 要素境界を跨ぐ場合は諦める（コメント自体はパネルに表示される）
    }
  }
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

function connectEvents(): void {
  eventSource?.close();
  const query = state.currentSessionId == null ? "" : `?session=${state.currentSessionId}`;
  eventSource = new EventSource(`/api/events${query}`);

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
    if (data.sessionId !== state.currentSessionId) return;
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
        el("div", { id: "asks", class: "asks" }),
        el("div", { id: "view-chrome", class: "view-chrome" }),
        el("div", { id: "view", class: "pane-body" }),
        el("div", { id: "review-bar", class: "review-bar hidden" }),
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
  try {
    const config = await fetchJson<{ followDefault: boolean; homeDir: string | null }>(
      "/api/config",
    );
    state.homeDir = config.homeDir ?? null;
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
