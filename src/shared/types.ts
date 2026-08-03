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
  | { type: "session:activated"; sessionId: string };

export interface HealthzResponse {
  app: "kairan";
  pid: number;
  version: string;
}
