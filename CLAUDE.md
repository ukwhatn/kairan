# kairan

agent が生成した markdown / HTML を tool call ひとつでブラウザに表示し、人間からのフィードバックを agent へ戻すローカル MCP サーバー。全体像・tool・設定は `README.md` を参照。

## 構成

| ディレクトリ | 役割 |
|---|---|
| `src/mcp/` | stdio MCP ランチャー（agent が起動するプロセス）。tool 定義とデーモンへの操作窓口 |
| `src/daemon/` | 表示サーバー（全 agent で 1 プロセス・1 port）。HTTP / SSE / SQLite / レンダリング / 通知 |
| `src/web/` | ブラウザ側のクライアント。`src/daemon/bundle.ts` が実行時にバンドルする |
| `src/shared/` | ランチャー・デーモン・クライアントで共有する型と定数 |

## 品質チェック

コミット前に実行する。

```bash
bun run lint        # biome check .
bun run typecheck   # tsc --noEmit
bun test
bun run lint:fix    # 自動修正
```

## コード変更の反映

- **デーモン側**（`src/daemon/` / `src/web/`）: `kairan restart`
- **stdio ランチャー側**（`src/mcp/` / `src/cli.ts`）: agent の MCP 再接続が必要（Claude Code は `/mcp` → Reconnect）

worktree のコードを試すときは、元 repo のデーモンを壊さないよう port とデータディレクトリを分ける。

```bash
KAIRAN_PORT=5799 KAIRAN_DATA_DIR=/tmp/kairan-wt bun run src/cli.ts daemon --foreground
```

## コミット運用

BASE_BRANCH: `main`

個人リポジトリで、書き手は自分だけ（branch protection も PR も無い）。main への直コミットを許容する。
