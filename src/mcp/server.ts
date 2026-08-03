import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import packageJson from "../../package.json" with { type: "json" };
import { loadConfig } from "../config.ts";
import { DaemonClient } from "./daemon-client.ts";
import { resolvePublishSource } from "./input.ts";

// 戻り値は SDK の CallToolResult（index signature を持つ weak type）に
// 構造的に適合させる必要があるため、interface で固めず literal 推論に任せる
function textResult(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
      },
    ],
  };
}

function errorResult(err: unknown) {
  return {
    content: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }],
    isError: true,
  };
}

const publishInputSchema = z.object({
  path: z
    .string()
    .optional()
    .describe("Path to a markdown/html file to publish (relative to cwd or absolute)"),
  content: z.string().optional().describe("Document body to publish directly instead of a file"),
  name: z
    .string()
    .optional()
    .describe(
      "File ID within the session (URL segment). Defaults to the basename of path. Required with content. Re-publishing the same name creates a new revision",
    ),
  format: z
    .enum(["markdown", "html"])
    .optional()
    .describe("Defaults to inference from the file extension of name/path"),
  session: z
    .string()
    .optional()
    .describe(
      "Named session to publish into (creates or resumes it). Defaults to this process's own session",
    ),
  title: z.string().optional().describe("Human-readable title shown in the file list"),
  open: z
    .boolean()
    .optional()
    .describe("Force-open (true) or suppress opening (false) the browser for this publish"),
});

const listFilesInputSchema = z.object({
  session: z
    .string()
    .optional()
    .describe("Named session to list. Defaults to this process's own session"),
});

export async function runMcpServer(): Promise<void> {
  const config = loadConfig();
  const client = new DaemonClient(config);

  // このプロセス（= agentセッション）のデフォルトセッションと attach 済みセッション
  let defaultSessionId: string | null = null;
  const attached = new Set<string>();

  const ensureAttached = (sessionId: string): void => {
    if (attached.has(sessionId)) return;
    attached.add(sessionId);
    client.attachSession(sessionId, () => {
      attached.delete(sessionId);
    });
  };

  const resolveSessionId = async (sessionName?: string): Promise<string> => {
    await client.ensureDaemon();
    if (sessionName != null) {
      const session = await client.createSession(sessionName);
      ensureAttached(session.id);
      return session.id;
    }
    if (defaultSessionId == null) {
      const session = await client.createSession();
      defaultSessionId = session.id;
    }
    // デーモン再起動で attach が切れていた場合もここで張り直す
    // （archived になったセッションは attach 時にデーモン側で active に復帰する）
    ensureAttached(defaultSessionId);
    return defaultSessionId;
  };

  const server = new McpServer({ name: "kairan", version: packageJson.version });

  server.registerTool(
    "publish",
    {
      title: "Publish a document to the browser",
      description:
        "Publish a markdown or HTML document (file path or inline content) to the kairan browser viewer. " +
        "Publishing the same name again creates a new revision with a viewable diff. Returns the URL",
      inputSchema: publishInputSchema,
    },
    async (input) => {
      try {
        const source = resolvePublishSource(input, process.cwd());
        let body: string;
        if (source.kind === "path") {
          const file = Bun.file(source.path);
          if (!(await file.exists())) {
            return errorResult(`file not found: ${source.path}`);
          }
          body = await file.text();
        } else {
          body = source.content;
        }

        const sessionId = await resolveSessionId(input.session);
        try {
          const result = await client.publish({
            sessionId,
            name: source.name,
            format: source.format,
            content: body,
            title: input.title,
            open: input.open,
          });
          return textResult(result);
        } catch (err) {
          // デーモンのDBが作り直された等でセッションが消えていたら一度だけ作り直す
          if (!String(err).includes("unknown session")) throw err;
          attached.delete(sessionId);
          if (input.session == null) defaultSessionId = null;
          const retrySessionId = await resolveSessionId(input.session);
          const result = await client.publish({
            sessionId: retrySessionId,
            name: source.name,
            format: source.format,
            content: body,
            title: input.title,
            open: input.open,
          });
          return textResult(result);
        }
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "list_files",
    {
      title: "List published files",
      description:
        "List files this session has published to kairan (name, format, title, latest revision)",
      inputSchema: listFilesInputSchema,
    },
    async (input) => {
      try {
        if (input.session == null && defaultSessionId == null) {
          return textResult("no files published yet in this session");
        }
        const sessionId = await resolveSessionId(input.session);
        const files = await client.listFiles(sessionId);
        return textResult({ sessionId, files });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  await server.connect(new StdioServerTransport());
}
