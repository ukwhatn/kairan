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
  let files: FileEntry[];
  try {
    files = await fetchJson<FileEntry[]>(`/api/sessions/${sessionId}/files`);
  } catch {
    files = [];
  }
  if (generation !== filesGeneration) return;
  if (sessionId !== state.currentSessionId) return;
  state.files = files;
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
  if (state.sessions.length === 0) {
    container.replaceChildren(el("div", { class: "placeholder" }, "セッションはまだありません"));
    return;
  }
  const list = el("ul", { class: "item-list" });
  for (const session of state.sessions) {
    const label = session.name ?? session.id;
    const nameRow = el("span", { class: "item-name" }, label);
    if (session.status === "archived") {
      nameRow.append(el("span", { class: "badge" }, "archived"));
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
  if (state.files.length === 0) {
    container.replaceChildren(el("div", { class: "placeholder" }, "ファイルはまだありません"));
    return;
  }
  const list = el("ul", { class: "item-list" });
  for (const file of state.files) {
    const nameRow = el("span", { class: "item-name" }, file.title ?? file.name);
    nameRow.append(el("span", { class: "badge badge-rev" }, `rev ${file.latestRev}`));
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
let publishEventGeneration = 0;

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
