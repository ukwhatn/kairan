# KAIRAN

Claude Code / Codex などの agent が生成した markdown / HTML を、tool call ひとつでブラウザに表示するローカル MCP サーバー。

![3ペインUI（セッション / ファイル / ビュー）](docs/screenshot-main.png)

| リビジョン差分（unified / side-by-side） | ダークモード |
|---|---|
| ![差分表示](docs/screenshot-diff.png) | ![ダークモード](docs/screenshot-dark.png) |

- 何個の agent から接続されても、表示サーバーは 1 つ・port は 1 つ（初回 tool call で自動起動、全員がいなくなると自動停止）
- URL は `http://localhost:5766/<セッションID>/<ファイル名>`。全 URL が deep link
- 同じ名前で再 publish すると新リビジョンとして積まれ、リビジョン間の差分（unified / side-by-side）が見られる
- 3 ペイン UI（セッション / ファイル / ビュー）+ SSE live update。新着 publish への自動追従は「新着に追従」トグルで制御
- agent が終了したセッションは自動で archive され、サイドバーの「archived」トグルで表示できる
- markdown は GFM + shiki シンタックスハイライト + mermaid 図に対応。HTML は iframe でそのまま実行（ローカル用途のため制限なし）
- publish 時に macOS 通知センターへ通知（設定で off 可）

## セットアップ

```bash
bun install
bun link   # `kairan` コマンドをグローバルに登録
```

### Claude Code

```bash
claude mcp add --scope user kairan -- kairan mcp
```

### Codex CLI

```toml
# ~/.codex/config.toml
[mcp_servers.kairan]
command = "kairan"
args = ["mcp"]
```

## tool

### `publish`

markdown / HTML をブラウザに表示する。`path`（ファイルパス）か `content`（文字列）のどちらかを渡す。

| 引数 | 説明 |
|---|---|
| `path` | 表示するファイルのパス（`content` と排他） |
| `content` | 本文の直接渡し（`name` 必須） |
| `name` | セッション内のファイル ID（URL セグメント）。省略時は `path` の basename。**同名で再 publish = 上書き = 新リビジョン** |
| `format` | `markdown` / `html`。省略時は拡張子から推定 |
| `session` | 名前付きセッションへの publish（固定 URL 化・別プロセスからの継続に使う）。省略時はこのプロセス専用の自動採番セッション |
| `title` | ファイルリストに表示するタイトル |
| `open` | `true` で強制オープン / `false` でオープン抑制 |

戻り値: `{ url, sessionId, fileId, revision }`

### `list_files`

自セッション（または `session` で指定した名前付きセッション）の publish 済みファイル一覧。

## CLI

```bash
kairan status    # デーモンの稼働確認
kairan restart   # デーモンの再起動（コード・設定変更の反映用）
kairan stop      # デーモンの停止（通常は不要: 全接続が消えると自動停止する）
kairan daemon    # デーモンをフォアグラウンド起動（通常は自動起動されるため不要）
```

### コード変更の反映

- **デーモン側**（Web UI・API・レンダリング・通知など大半のロジック）: `kairan restart` で反映される
- **stdio ランチャー側**（tool 定義・入力解決）: ランチャープロセスは agent が起動・保持しているため kairan 側からは再起動できない。agent の MCP 再接続で反映される（Claude Code は `/mcp` → Reconnect、または新しいセッションを開始）

## 設定

`~/.kairan/config.json`（すべて任意）と環境変数で上書きできる。優先度: 環境変数 > config.json > デフォルト。

| キー | 環境変数 | デフォルト | 説明 |
|---|---|---|---|
| `port` | `KAIRAN_PORT` | `5766` | デーモンの listen port |
| `host` | `KAIRAN_HOST` | `127.0.0.1` | bind アドレス（`127.0.0.1` / `localhost` / `::1` のみ。認証なしのため loopback 限定） |
| `dataDir` | `KAIRAN_DATA_DIR` | `~/.kairan` | SQLite / lock の置き場所 |
| `autoOpen` | `KAIRAN_AUTO_OPEN` | `session-first` | `session-first`（セッション初回のみ自動オープン）/ `always` / `never` |
| `reopenWhenNoTab` | `KAIRAN_REOPEN_WHEN_NO_TAB` | `true` | publish 時にそのセッションを見ているタブが無ければ開き直す |
| `notifications` | `KAIRAN_NOTIFICATIONS` | `true` | macOS 通知センターへの通知 |
| `notifyOn` | `KAIRAN_NOTIFY_ON` | `all` | `all`（上書きも通知）/ `new-file`（新規ファイルのみ） |
| `openCommand` | `KAIRAN_OPEN_COMMAND` | `open` | ブラウザを開くコマンド |
| `followDefault` | `KAIRAN_FOLLOW_DEFAULT` | `true` | UI「新着に追従」トグルの初期値 |
| `shutdownGraceMs` | `KAIRAN_SHUTDOWN_GRACE_MS` | `5000` | 全接続 0 になってから自動停止するまでの猶予 |

設定ファイルのパス自体は `KAIRAN_CONFIG_PATH` で変更できる。

## アーキテクチャ

```
agent (Claude Code / Codex)
  │ stdio MCP
  ▼
kairan mcp（agent ごとに 1 プロセス。port は使わない）
  │ HTTP（初回 tool call 時にデーモンを自動 spawn・生存申告の SSE を維持）
  ▼
kairan daemon（全体で 1 つ・port 1 つ）── SQLite (~/.kairan/kairan.db)
  │ HTTP + SSE
  ▼
browser（3ペイン UI）
```

- stdio プロセス = 1 セッション。プロセス終了（= agent 終了）で TCP が切れ、デーモンがセッションを archive する
- デーモンは「active セッション 0 かつ 閲覧タブ 0」になると自動停止する。データは SQLite に永続化されているため、次回起動時も過去セッションを閲覧できる
- 設計判断の経緯: `.local/docs/adr/0001-stdio-launcher-shared-daemon.md`

## 開発

```bash
bun test            # テスト
bun run typecheck   # tsc
bun run lint        # biome
bun run dev         # デーモンをフォアグラウンド起動
```
