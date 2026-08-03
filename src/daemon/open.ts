import type { KairanConfig } from "../config.ts";

export type Opener = (url: string) => void;

export function createOpener(config: KairanConfig): Opener {
  return (url) => {
    try {
      Bun.spawn([config.openCommand, url], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      });
    } catch {
      // ブラウザを開けなくても publish 自体は成功させる
    }
  };
}
