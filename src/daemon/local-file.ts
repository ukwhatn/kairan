import type { KairanConfig } from "../config.ts";

export type LocalFileTarget = "finder" | "editor";

export type LocalFileOpener = (target: LocalFileTarget, path: string) => Promise<void>;

interface CommandResult {
  exitCode: number;
  stderr: string;
}

interface LocalFileOpenerDeps {
  runCommand?: (command: string[]) => Promise<CommandResult>;
}

/**
 * エディタ起動 URL を組み立てる。パス区切りは保ったままセグメントを percent-encode する
 * （`#` や `?` を含むパスをそのまま埋めると、URL parser が fragment / query と解釈して
 * 別のファイルを開いてしまうため）
 */
export function editorUrlFor(template: string, path: string): string {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  return template.replaceAll("{path}", encoded);
}

const COMMAND_TIMEOUT_MS = 8000;

async function defaultRunCommand(command: string[]): Promise<CommandResult> {
  const proc = Bun.spawn(command, {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
    timeout: COMMAND_TIMEOUT_MS,
  });
  const stderr = await new Response(proc.stderr).text();
  return { exitCode: await proc.exited, stderr: stderr.trim() };
}

/**
 * publish 元のローカルファイルを Finder / エディタで開く。macOS の `open` に依存する
 * （通知・タブ再利用と同じ前提）。呼び出し側にエラーを返せるよう、コマンドの終了コードまで待つ
 */
export function createLocalFileOpener(
  config: KairanConfig,
  deps: LocalFileOpenerDeps = {},
): LocalFileOpener {
  const runCommand = deps.runCommand ?? defaultRunCommand;
  return async (target, path) => {
    let command: string[];
    if (target === "finder") {
      command = ["open", "-R", path];
    } else {
      if (config.editorUrl === "") throw new Error("editorUrl is not configured");
      command = ["open", editorUrlFor(config.editorUrl, path)];
    }
    const { exitCode, stderr } = await runCommand(command);
    if (exitCode !== 0) {
      throw new Error(stderr === "" ? `${command[0]} exited with ${exitCode}` : stderr);
    }
  };
}
