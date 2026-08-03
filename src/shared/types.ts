export type DocFormat = "markdown" | "html";

export type SessionStatus = "active" | "archived";

export interface Session {
  id: string;
  name: string | null;
  status: SessionStatus;
  createdAt: number;
  lastActiveAt: number;
}

export interface FileEntry {
  id: number;
  sessionId: string;
  name: string;
  format: DocFormat;
  title: string | null;
  createdAt: number;
  updatedAt: number;
  latestRev: number;
}

export interface RevisionMeta {
  rev: number;
  createdAt: number;
}

export interface PublishRequest {
  sessionId?: string;
  sessionName?: string;
  name: string;
  format: DocFormat;
  content: string;
  title?: string;
  open?: boolean;
}

export interface PublishResponse {
  url: string;
  sessionId: string;
  fileId: number;
  revision: number;
}

/** 選択テキストの引用アンカー。null 相当（アンカーなし）はファイル全体コメント */
export interface CommentAnchor {
  exact: string;
  prefix: string;
  suffix: string;
}

export type CommentState = "draft" | "open" | "resolved";

export interface CommentReply {
  id: number;
  commentId: number;
  author: "agent" | "human";
  body: string;
  state: "draft" | "submitted";
  createdAt: number;
}

export interface FileComment {
  id: number;
  fileId: number;
  rev: number;
  anchor: CommentAnchor | null;
  body: string;
  state: CommentState;
  createdAt: number;
  submittedAt: number | null;
  resolvedAt: number | null;
  replies: CommentReply[];
}

export interface Review {
  id: number;
  sessionId: string;
  summary: string;
  state: "draft" | "submitted";
  createdAt: number;
  submittedAt: number | null;
}

export interface AskOption {
  label: string;
  description?: string;
}

export interface AskQuestion {
  id: string;
  question: string;
  header?: string;
  options: AskOption[];
  multiSelect: boolean;
}

export interface AskAnswer {
  questionId: string;
  selected: string[];
  freeText: string | null;
}

export type AskStatus = "open" | "answered" | "cancelled";

export interface Ask {
  id: number;
  sessionId: string;
  fileId: number | null;
  status: AskStatus;
  questions: AskQuestion[];
  answers: AskAnswer[] | null;
  createdAt: number;
  answeredAt: number | null;
}

/** 送信済みで agent 未受領のフィードバック一式（request_review / list_feedback の戻り） */
export interface FeedbackBundle {
  reviews: Array<{
    review: Review;
    comments: Array<FileComment & { fileName: string }>;
    replies: Array<CommentReply & { fileName: string; commentBody: string }>;
  }>;
  answeredAsks: Ask[];
}

export type KairanEvent =
  | {
      type: "file:published";
      sessionId: string;
      fileName: string;
      fileId: number;
      revision: number;
      isNew: boolean;
      title: string | null;
    }
  | { type: "session:created"; session: Session }
  | { type: "session:archived"; sessionId: string }
  | { type: "session:activated"; sessionId: string }
  // コメント・draft・resolve・返信の粒度は追わず、受信側が再取得する
  | { type: "feedback:changed"; sessionId: string; fileId: number | null }
  | { type: "review:waiting"; sessionId: string; waiting: boolean }
  | { type: "ask:changed"; sessionId: string };

export interface HealthzResponse {
  app: "kairan";
  pid: number;
  version: string;
}
