/** IPv6 ホストは角括弧で包まないと URL として不正になる */
export function daemonBaseUrl(host: string, port: number): string {
  const bracketed = host.includes(":") ? `[${host}]` : host;
  return `http://${bracketed}:${port}`;
}

/**
 * このデーモンを指しうる URL プレフィックス群。bind ホストが 127.0.0.1 でも
 * ユーザーは localhost で開いていることがあるため、表記ゆれを全て列挙する
 */
export function localBaseUrls(port: number): string[] {
  return [`http://127.0.0.1:${port}/`, `http://localhost:${port}/`, `http://[::1]:${port}/`];
}
