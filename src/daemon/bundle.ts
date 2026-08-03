import { fileURLToPath } from "node:url";

export interface ClientAssets {
  js: string;
  css: string;
}

/**
 * クライアント UI をデーモン起動時にオンメモリでバンドルする。
 * ビルド成果物をリポジトリに置かず、ソース(src/web)だけを配布物にするための構成。
 */
export async function buildClientAssets(): Promise<ClientAssets> {
  const entrypoint = fileURLToPath(new URL("../web/app.ts", import.meta.url));
  const result = await Bun.build({
    entrypoints: [entrypoint],
    target: "browser",
    minify: true,
  });
  if (!result.success) {
    throw new Error(`client bundle failed: ${result.logs.map(String).join("\n")}`);
  }
  const output = result.outputs[0];
  if (output == null) throw new Error("client bundle produced no output");
  const css = await Bun.file(fileURLToPath(new URL("../web/style.css", import.meta.url))).text();
  return { js: await output.text(), css };
}
