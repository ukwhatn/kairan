/** IPv6 ホストは角括弧で包まないと URL として不正になる */
export function daemonBaseUrl(host: string, port: number): string {
  const bracketed = host.includes(":") ? `[${host}]` : host;
  return `http://${bracketed}:${port}`;
}
