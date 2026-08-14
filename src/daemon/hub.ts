import type { KairanEvent } from "../shared/types.ts";

interface BrowserListener {
  sessionId: string | null;
  send: (event: KairanEvent) => void;
}

/**
 * ランチャー(attach)とブラウザ(SSE)の接続を追跡する。
 * 接続の意味づけ(archive・デーモン停止)は呼び出し側がコールバックで結線する。
 */
export class Hub {
  // セッションごとの attach。値は「その接続を閉じる」関数で、セッション削除時に呼ぶ
  private readonly attachments = new Map<string, Set<() => void>>();
  private readonly browserListeners = new Set<BrowserListener>();

  /** あるセッションの attach が全て切れた時（= agent 全終了） */
  onSessionDetached?: (sessionId: string) => void;
  /** attach もブラウザも 0 になった時（= デーモン停止候補） */
  onEmpty?: () => void;

  attach(sessionId: string, close: () => void = () => {}): () => void {
    const handles = this.attachments.get(sessionId) ?? new Set<() => void>();
    handles.add(close);
    this.attachments.set(sessionId, handles);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const current = this.attachments.get(sessionId);
      current?.delete(close);
      if (current != null && current.size === 0) {
        this.attachments.delete(sessionId);
        this.onSessionDetached?.(sessionId);
      }
      this.notifyIfEmpty();
    };
  }

  /**
   * セッションの attach をサーバー側から閉じる。削除したセッションの生存申告が
   * 残り続けると、デーモンが停止しなくなり archive 判定も狂う
   */
  closeAttachments(sessionId: string): void {
    const handles = this.attachments.get(sessionId);
    if (handles == null) return;
    // ストリームが実際に閉じるのは非同期なので、勘定はここで先に外す。
    // onSessionDetached は呼ばない（消したセッションを archive しても意味がない）
    this.attachments.delete(sessionId);
    for (const close of handles) close();
    this.notifyIfEmpty();
  }

  addBrowser(sessionId: string | null, send: (event: KairanEvent) => void): () => void {
    const listener: BrowserListener = { sessionId, send };
    this.browserListeners.add(listener);
    return () => {
      if (!this.browserListeners.delete(listener)) return;
      this.notifyIfEmpty();
    };
  }

  broadcast(event: KairanEvent): void {
    for (const listener of this.browserListeners) {
      listener.send(event);
    }
  }

  attachCount(sessionId?: string): number {
    if (sessionId != null) return this.attachments.get(sessionId)?.size ?? 0;
    let total = 0;
    for (const handles of this.attachments.values()) total += handles.size;
    return total;
  }

  browserCount(sessionId?: string): number {
    if (sessionId == null) return this.browserListeners.size;
    let count = 0;
    for (const listener of this.browserListeners) {
      if (listener.sessionId === sessionId) count++;
    }
    return count;
  }

  isEmpty(): boolean {
    return this.attachCount() === 0 && this.browserCount() === 0;
  }

  private notifyIfEmpty(): void {
    if (this.isEmpty()) this.onEmpty?.();
  }
}
