/**
 * key ごとの待機者にシグナルを届ける。レビュー送信待ち・ask 回答待ちの
 * 長時間ポーリング（HTTP ハンドラが await する）の中核。
 */
export class SignalHub {
  private readonly waiters = new Map<string, Set<() => void>>();

  /** 待機者数の増減通知（review:waiting バッジの SSE 配信用） */
  onWaitersChanged?: (key: string, count: number) => void;

  notify(key: string): void {
    const set = this.waiters.get(key);
    if (set == null) return;
    for (const wake of [...set]) wake();
  }

  waiterCount(key: string): number {
    return this.waiters.get(key)?.size ?? 0;
  }

  /** シグナル受信で true、timeout / abort で false */
  wait(key: string, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
    return new Promise((resolve) => {
      const set = this.waiters.get(key) ?? new Set<() => void>();
      this.waiters.set(key, set);
      let done = false;
      const finish = (value: boolean): void => {
        if (done) return;
        done = true;
        set.delete(wake);
        if (set.size === 0) this.waiters.delete(key);
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.onWaitersChanged?.(key, this.waiterCount(key));
        resolve(value);
      };
      const wake = (): void => finish(true);
      const onAbort = (): void => finish(false);
      set.add(wake);
      const timer = setTimeout(() => finish(false), timeoutMs);
      signal?.addEventListener("abort", onAbort);
      this.onWaitersChanged?.(key, this.waiterCount(key));
      if (signal?.aborted) onAbort();
    });
  }
}

export const reviewKey = (sessionId: string): string => `review:${sessionId}`;
export const askKey = (askId: number): string => `ask:${askId}`;
