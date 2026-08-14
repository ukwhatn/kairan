import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import packageJson from "../../package.json" with { type: "json" };
import { loadConfig } from "../config.ts";
import type { AskQuestion, FeedbackBundle, PublishResponse } from "../shared/types.ts";
import { daemonBaseUrl } from "../shared/url.ts";
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
      "Session ID to publish into (creates or resumes it). Defaults to this process's own session",
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
    .describe("Session ID to list. Defaults to this process's own session"),
});

const requestReviewInputSchema = z.object({
  session: z
    .string()
    .optional()
    .describe("Session ID to collect feedback for. Defaults to this process's own session"),
  timeout_seconds: z
    .number()
    .int()
    .min(5)
    .max(1800)
    .optional()
    .describe("How long to wait before returning 'no feedback yet' (default: config value)"),
});

const askUserInputSchema = z.object({
  questions: z
    .array(
      z.object({
        question: z.string().min(1).describe("The full question to ask the human"),
        header: z.string().optional().describe("Short chip label shown above the question"),
        options: z
          .array(
            z.object({
              label: z.string().min(1).describe("Concise choice label"),
              description: z
                .string()
                .optional()
                .describe("What this option means, including trade-offs"),
            }),
          )
          .min(1)
          .max(8),
        multiSelect: z.boolean().optional().describe("Allow selecting multiple options"),
      }),
    )
    .min(1)
    .max(8)
    .describe("Questions shown together on one card; the human answers all before submitting"),
  file: z
    .string()
    .optional()
    .describe("Published file name this question is about (badges that file in the sidebar)"),
  session: z
    .string()
    .optional()
    .describe("Session ID to ask in. Defaults to this process's own session"),
  timeout_seconds: z
    .number()
    .int()
    .min(5)
    .max(1800)
    .optional()
    .describe("How long to wait before returning 'not answered yet' (default: config value)"),
});

const startSessionInputSchema = z.object({
  label: z
    .string()
    .max(200)
    .optional()
    .describe(
      "Human-readable name shown in the sidebar (e.g. the task you are working on). Does not have to be unique; the human can rename it in the browser",
    ),
  id: z
    .string()
    .optional()
    .describe(
      "Fixed session ID (URL segment). Pass this only to resume a specific session from another process; omit it to get a timestamp-based ID",
    ),
});

const replyCommentInputSchema = z.object({
  comment_id: z.number().int().describe("The commentId from request_review / list_feedback"),
  body: z.string().min(1).describe("Reply text shown in the comment thread in the browser"),
  resolve: z
    .boolean()
    .optional()
    .describe("Mark the comment as resolved (the human can re-open it)"),
});

/** agent が読む形に整える（内部IDや配信管理フィールドを外へ出さない） */
function describeBundle(bundle: FeedbackBundle) {
  return {
    reviews: bundle.reviews.map((entry) => ({
      summary: entry.review.summary === "" ? null : entry.review.summary,
      comments: entry.comments.map((comment) => ({
        commentId: comment.id,
        file: comment.fileName,
        rev: comment.rev,
        quote: comment.anchor?.exact ?? null,
        comment: comment.body,
      })),
      replies: entry.replies.map((reply) => ({
        commentId: reply.commentId,
        originalComment: reply.commentBody,
        reply: reply.body,
      })),
    })),
    answeredQuestions: bundle.answeredAsks.map((ask) => ({
      answers: ask.questions.map((question) => {
        const answer = ask.answers?.find((a) => a.questionId === question.id);
        return {
          question: question.question,
          selected: answer?.selected ?? [],
          freeText: answer?.freeText ?? null,
        };
      }),
    })),
  };
}

const FEEDBACK_GUIDANCE =
  "Human feedback received. Address each comment, then respond with reply_comment " +
  "(use commentId; set resolve=true once handled) and publish updated revisions as needed.\n";

export async function runMcpServer(): Promise<void> {
  const config = loadConfig();
  const client = new DaemonClient(config);

  // このプロセス（= agentセッション）のデフォルトセッションと attach 済みセッション。
  // tool call は並行で届きうるため、ID ではなく作成 Promise を保持して二重作成を防ぐ
  let defaultSessionPromise: Promise<string> | null = null;
  const attached = new Set<string>();

  // attach は session ごとに1本だけ持つ。デーモン再起動での切断は client 側が張り直すため、
  // ここから消すのはセッション自体が消えたとき（張り直しが無意味になったとき）だけ
  const ensureAttached = (sessionId: string): void => {
    if (attached.has(sessionId)) return;
    attached.add(sessionId);
    client.attachSession(sessionId, () => {
      attached.delete(sessionId);
    });
  };

  const hasDefaultSession = (): boolean => defaultSessionPromise != null;
  const resetDefaultSession = (): void => {
    defaultSessionPromise = null;
  };

  // agent のセッションを跨いで不変な識別子。これを渡すと、agent を閉じて
  // resume / continue で開き直しても同じ kairan セッションに戻れる
  // （持たない agent では従来どおり毎回新しいセッションになる）
  const agentSessionKey =
    process.env.CLAUDE_CODE_SESSION_ID == null
      ? undefined
      : `claude:${process.env.CLAUDE_CODE_SESSION_ID}`;

  const resolveSessionId = async (requestedId?: string): Promise<string> => {
    await client.ensureDaemon();
    if (requestedId != null) {
      const session = await client.createSession({ id: requestedId, cwd: process.cwd() });
      ensureAttached(session.id);
      return session.id;
    }
    defaultSessionPromise ??= client
      .createSession({ cwd: process.cwd(), agentSessionKey })
      .then((session) => session.id);
    const promise = defaultSessionPromise;
    let sessionId: string;
    try {
      sessionId = await promise;
    } catch (err) {
      // 失敗した Promise をキャッシュしたままだと以後の全 tool call が同じ失敗を再生するため、
      // 自分が張った Promise のままである場合のみ破棄して次回に作り直させる
      if (defaultSessionPromise === promise) defaultSessionPromise = null;
      throw err;
    }
    // デーモン再起動で attach が切れていた場合もここで張り直す
    // （archived になったセッションは attach 時にデーモン側で active に復帰する）
    ensureAttached(sessionId);
    return sessionId;
  };

  /**
   * 明示的にセッションを始める。以後 session を省略した tool call がここで決めた
   * セッションに載るよう、既定セッションとして据える（据えないと直後の publish が
   * 別セッションを暗黙作成してしまう）
   */
  const startSession = async (id?: string, label?: string) => {
    await client.ensureDaemon();
    const session = await client.createSession({ id, label, cwd: process.cwd(), agentSessionKey });
    ensureAttached(session.id);
    defaultSessionPromise = Promise.resolve(session.id);
    return session;
  };

  const server = new McpServer({ name: "kairan", version: packageJson.version });

  server.registerTool(
    "start_session",
    {
      title: "Start a kairan session",
      description:
        "Start this process's kairan session and give it a human-readable name. " +
        "Call this once before the first publish so the human can tell your session apart in the sidebar. " +
        "Subsequent tool calls without an explicit session use the session started here",
      inputSchema: startSessionInputSchema,
    },
    async (input) => {
      try {
        const session = await startSession(input.id, input.label);
        return textResult({
          sessionId: session.id,
          label: session.label,
          url: `${daemonBaseUrl(config.host, config.port)}/${session.id}`,
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

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

        const describePublish = (result: PublishResponse) =>
          textResult(
            result.pendingFeedback > 0
              ? {
                  ...result,
                  note: `${result.pendingFeedback} feedback item(s) from the human are waiting — call list_feedback to read them`,
                }
              : result,
          );

        const publishInto = (sessionId: string) =>
          client.publish({
            sessionId,
            name: source.name,
            format: source.format,
            content: body,
            title: input.title,
            open: input.open,
            sourcePath: source.kind === "path" ? source.path : undefined,
          });

        const sessionId = await resolveSessionId(input.session);
        try {
          return describePublish(await publishInto(sessionId));
        } catch (err) {
          // デーモンのDBが作り直された等でセッションが消えていたら一度だけ作り直す
          if (!String(err).includes("unknown session")) throw err;
          attached.delete(sessionId);
          if (input.session == null) resetDefaultSession();
          return describePublish(await publishInto(await resolveSessionId(input.session)));
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
        if (input.session == null && !hasDefaultSession()) {
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

  server.registerTool(
    "request_review",
    {
      title: "Request a review from the human",
      description:
        "Ask the human to review the published documents in the browser, then BLOCK until they submit " +
        "feedback (inline comments + an overall summary). Returns 'no feedback yet' on timeout — " +
        "call request_review again to keep waiting; that is the normal pattern for long reviews",
      inputSchema: requestReviewInputSchema,
    },
    async (input, ctx) => {
      try {
        const sessionId = await resolveSessionId(input.session);
        const timeoutMs =
          input.timeout_seconds != null ? input.timeout_seconds * 1000 : config.feedbackWaitMs;
        const result = await client.waitFeedback(sessionId, timeoutMs, ctx.mcpReq.signal);
        if (result.status === "feedback" && result.bundle != null) {
          return textResult(
            FEEDBACK_GUIDANCE + JSON.stringify(describeBundle(result.bundle), null, 2),
          );
        }
        if (result.status === "deleted") {
          resetDefaultSession();
          return textResult(
            "The human deleted this session in the browser. Nothing is left to review — " +
              "start a new session with start_session if you still need one.",
          );
        }
        return textResult(
          "No feedback yet — the human is still reviewing. Call request_review again to continue waiting, " +
            "or proceed without feedback if appropriate.",
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "ask_user",
    {
      title: "Ask the human to choose between options",
      description:
        "Show a question card with selectable options (plus a free-text field) in the kairan browser " +
        "viewer and BLOCK until the human answers. Use this instead of guessing when a decision is " +
        "the human's to make. On timeout it returns 'not answered yet' — call ask_user again with " +
        "the SAME questions to keep waiting; the existing card is reused, not duplicated",
      inputSchema: askUserInputSchema,
    },
    async (input, ctx) => {
      try {
        const sessionId = await resolveSessionId(input.session);
        // 質問IDは並び順から決定的に振る。timeout 後に同じ入力で再呼び出しした際、
        // 同一JSONになりデーモン側で既存カードが再利用される
        const questions: AskQuestion[] = input.questions.map((question, index) => ({
          id: `q${index + 1}`,
          question: question.question,
          ...(question.header == null ? {} : { header: question.header }),
          options: question.options,
          multiSelect: question.multiSelect ?? false,
        }));
        const ask = await client.createAsk(sessionId, input.file ?? null, questions);
        try {
          const timeoutMs =
            input.timeout_seconds != null ? input.timeout_seconds * 1000 : config.feedbackWaitMs;
          const result = await client.waitAsk(ask.id, timeoutMs, ctx.mcpReq.signal);
          if (result.status === "answered" && result.ask != null) {
            return textResult(
              describeBundle({ reviews: [], answeredAsks: [result.ask] }).answeredQuestions[0],
            );
          }
          if (result.status === "cancelled") {
            return textResult("The question was dismissed in the browser without an answer.");
          }
          if (result.status === "deleted") {
            return textResult(
              "The human deleted the question (or the whole session) in the browser. " +
                "Proceed without an answer, or ask again if you still need the decision.",
            );
          }
          return textResult(
            "Not answered yet. Call ask_user again with the same questions to keep waiting " +
              "(the existing card is reused), or proceed if the decision can wait.",
          );
        } catch (err) {
          // agent 側の中断（ユーザーの esc 等）では回答不能になったカードを片付ける
          if (ctx.mcpReq.signal.aborted) {
            void client.cancelAsk(ask.id).catch(() => {});
          }
          throw err;
        }
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "reply_comment",
    {
      title: "Reply to a review comment",
      description:
        "Reply to a human's review comment in its thread, optionally marking it resolved. " +
        "Use the commentId returned by request_review / list_feedback",
      inputSchema: replyCommentInputSchema,
    },
    async (input) => {
      try {
        await client.ensureDaemon();
        const reply = await client.replyComment(
          input.comment_id,
          input.body,
          input.resolve ?? false,
        );
        return textResult({
          ok: true,
          commentId: reply.commentId,
          resolved: input.resolve ?? false,
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "list_feedback",
    {
      title: "Collect feedback without waiting",
      description:
        "Fetch feedback the human already submitted (review comments, summaries, question answers) " +
        "without blocking. Each item is returned only once",
      inputSchema: listFilesInputSchema,
    },
    async (input) => {
      try {
        if (input.session == null && !hasDefaultSession()) {
          return textResult("no session yet — nothing published, so no feedback");
        }
        const sessionId = await resolveSessionId(input.session);
        const { bundle } = await client.takeFeedback(sessionId);
        if (bundle.reviews.length === 0 && bundle.answeredAsks.length === 0) {
          return textResult("no new feedback");
        }
        return textResult(FEEDBACK_GUIDANCE + JSON.stringify(describeBundle(bundle), null, 2));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // attach ストリームを張っている間はイベントループが生き続けるため、
  // クライアント(agent)が去って stdin が閉じたら明示的に終了する。
  // このプロセス終了で attach の TCP が切れ、デーモン側がセッションを archive する
  process.stdin.on("close", () => process.exit(0));
  process.stdin.on("end", () => process.exit(0));

  await server.connect(new StdioServerTransport());
}
