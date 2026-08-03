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
  private readonly attachCounts = new Map<string, number>();
  private readonly browserListeners = new Set<BrowserListener>();

  /** あるセッションの attach が全て切れた時（= agent 全終了） */
  onSessionDetached?: (sessionId: string) => void;
  /** attach もブラウザも 0 になった時（= デーモン停止候補） */
  onEmpty?: () => void;

  attach(sessionId: string): () => void {
    this.attachCounts.set(sessionId, (this.attachCounts.get(sessionId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (this.attachCounts.get(sessionId) ?? 1) - 1;
      if (remaining <= 0) {
        this.attachCounts.delete(sessionId);
        this.onSessionDetached?.(sessionId);
      } else {
        this.attachCounts.set(sessionId, remaining);
      }
      this.notifyIfEmpty();
    };
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
    if (sessionId != null) return this.attachCounts.get(sessionId) ?? 0;
    let total = 0;
    for (const count of this.attachCounts.values()) total += count;
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
