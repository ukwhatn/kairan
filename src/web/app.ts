import { html as renderDiffHtml } from "diff2html";
import mermaid from "mermaid";
import type { FileEntry, KairanEvent, RevisionMeta, Session } from "../shared/types.ts";

type ViewMode = "rendered" | "source" | "diff";
type DiffStyle = "line-by-line" | "side-by-side";

interface ContentResponse {
  file: FileEntry;
  rev: number;
  content: string;
  html: string | null;
}

interface State {
  sessions: Session[];
  includeArchived: boolean;
  currentSessionId: string | null;
  files: FileEntry[];
  currentFileName: string | null;
  currentRev: number | null; // null = 最新
  revisions: RevisionMeta[];
  viewMode: ViewMode;
  diffFrom: number;
  diffTo: number;
  diffStyle: DiffStyle;
  follow: boolean;
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
};

mermaid.initialize({ startOnLoad: false });

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
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
  state.sessions = await fetchJson<Session[]>(
    `/api/sessions?include_archived=${state.includeArchived}`,
  );
  renderSessions();
}

async function loadFiles(): Promise<void> {
  if (state.currentSessionId == null) {
    state.files = [];
    renderFiles();
    return;
  }
  try {
    state.files = await fetchJson<FileEntry[]>(`/api/sessions/${state.currentSessionId}/files`);
  } catch {
    state.files = [];
  }
  renderFiles();
}

function currentFile(): FileEntry | null {
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
}

// --- 描画: セッションリスト ------------------------------------------------

function renderSessions(): void {
  const container = document.getElementById("sessions");
  if (container == null) return;
  const list = el("ul", { class: "item-list" });
  for (const session of state.sessions) {
    const label = session.name ?? session.id;
    const item = el(
      "li",
      {
        class: [
          "item",
          session.id === state.currentSessionId ? "selected" : "",
          session.status === "archived" ? "archived" : "",
        ].join(" "),
      },
      el("span", { class: "item-name" }, label),
      el(
        "span",
        { class: "item-meta" },
        `${session.status === "archived" ? "archived · " : ""}${formatTime(session.lastActiveAt)}`,
      ),
    );
    item.addEventListener("click", () => {
      void selectSession(session.id);
    });
    list.append(item);
  }
  container.replaceChildren(list);
}

// --- 描画: ファイルリスト --------------------------------------------------

function renderFiles(): void {
  const container = document.getElementById("files");
  if (container == null) return;
  if (state.currentSessionId == null) {
    container.replaceChildren(el("div", { class: "placeholder" }, "セッションを選択"));
    return;
  }
  const list = el("ul", { class: "item-list" });
  for (const file of state.files) {
    const item = el(
      "li",
      { class: `item ${file.name === state.currentFileName ? "selected" : ""}` },
      el("span", { class: "item-name" }, file.title ?? file.name),
      el("span", { class: "item-meta" }, `${file.name} · rev ${file.latestRev}`),
    );
    item.addEventListener("click", () => {
      void selectFile(file.name);
    });
    list.append(item);
  }
  container.replaceChildren(list);
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

  const title = el("div", { class: "view-title" }, file.title ?? file.name);
  chrome.replaceChildren(title, revSelect, modeGroup);

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

function connectEvents(): void {
  eventSource?.close();
  const query = state.currentSessionId == null ? "" : `?session=${state.currentSessionId}`;
  eventSource = new EventSource(`/api/events${query}`);

  const sessionEvents = ["session:created", "session:archived", "session:activated"];
  for (const type of sessionEvents) {
    eventSource.addEventListener(type, () => {
      void loadSessions();
    });
  }

  eventSource.addEventListener("file:published", (event) => {
    const data = JSON.parse((event as MessageEvent).data) as Extract<
      KairanEvent,
      { type: "file:published" }
    >;
    void loadSessions();
    if (data.sessionId !== state.currentSessionId) return;
    void loadFiles().then(async () => {
      if (state.follow) {
        // 新着に追従: 最新リビジョン表示に切り替える
        state.currentFileName = data.fileName;
        state.currentRev = null;
        state.viewMode = "rendered";
        pushUrl();
        renderFiles();
        await loadView();
      } else if (state.currentFileName === data.fileName && state.currentRev == null) {
        await loadView();
      }
    });
  });
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
      el("a", { class: "brand", href: "/" }, "回覧 kairan"),
      el("div", { class: "topbar-controls" }, followLabel),
    ),
    el(
      "div",
      { class: "panes" },
      el(
        "aside",
        { class: "pane pane-sessions" },
        el("div", { class: "pane-header" }, "セッション", archivedLabel),
        el("div", { id: "sessions", class: "pane-body" }),
      ),
      el(
        "aside",
        { class: "pane pane-files" },
        el("div", { class: "pane-header" }, "ファイル"),
        el("div", { id: "files", class: "pane-body" }),
      ),
      el(
        "main",
        { class: "pane pane-view" },
        el("div", { id: "view-chrome", class: "view-chrome" }),
        el("div", { id: "view", class: "pane-body" }),
      ),
    ),
  );

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
  connectEvents();
}

async function main(): Promise<void> {
  const stored = localStorage.getItem("kairan:follow");
  if (stored != null) {
    state.follow = stored === "true";
  } else {
    try {
      const config = await fetchJson<{ followDefault: boolean }>("/api/config");
      state.follow = config.followDefault;
    } catch {
      // デフォルト true のまま
    }
  }

  buildLayout();
  window.addEventListener("popstate", () => {
    void applyUrl();
  });
  await loadSessions();
  await applyUrl();
}

void main();
