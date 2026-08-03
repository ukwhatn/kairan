import { basename, isAbsolute, resolve } from "node:path";
import type { DocFormat } from "../shared/types.ts";

export function inferFormat(fileName: string): DocFormat | null {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "markdown";
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "html";
  return null;
}

export interface RawPublishArgs {
  path?: string;
  content?: string;
  name?: string;
  format?: DocFormat;
}

export type ResolvedPublishSource =
  | { kind: "path"; path: string; name: string; format: DocFormat }
  | { kind: "content"; content: string; name: string; format: DocFormat };

/**
 * publish tool の入力から「何をどの名前・形式で出すか」を確定する。
 * ファイル読み込みは行わない（呼び出し側の責務）。
 */
export function resolvePublishSource(args: RawPublishArgs, cwd: string): ResolvedPublishSource {
  if (args.path != null && args.content != null) {
    throw new Error("specify either path or content, not both");
  }

  if (args.path != null) {
    const absolutePath = isAbsolute(args.path) ? args.path : resolve(cwd, args.path);
    const name = args.name ?? basename(absolutePath);
    const format = args.format ?? inferFormat(name);
    if (format == null) {
      throw new Error(
        `cannot infer format from file name "${name}". Pass format: "markdown" or "html"`,
      );
    }
    return { kind: "path", path: absolutePath, name, format };
  }

  if (args.content != null) {
    if (args.name == null) {
      throw new Error('name is required when publishing content directly (e.g. "report.md")');
    }
    const format = args.format ?? inferFormat(args.name);
    if (format == null) {
      throw new Error(
        `cannot infer format from file name "${args.name}". Pass format: "markdown" or "html"`,
      );
    }
    return { kind: "content", content: args.content, name: args.name, format };
  }

  throw new Error("specify either path or content");
}
