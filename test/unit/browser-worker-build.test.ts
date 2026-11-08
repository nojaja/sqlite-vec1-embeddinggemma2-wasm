import { build } from "esbuild";

/**
 * 処理名: browser Worker bundle検証
 * 処理概要: 推論entryをbrowser ESMへbundleしNode/native参照不在を確認する。
 * 実装理由: browser成果物をNode Workerの名前変更だけで代用しないため。
 * @returns 検証完了。
 */
async function verifyBrowserWorkerBuild(): Promise<void> {
  const result = await build({
    entryPoints: ["src/workers/inference-browser.ts"],
    bundle: true,
    platform: "browser",
    format: "esm",
    target: "es2022",
    write: false
  });
  expect(result.outputFiles).toHaveLength(1);
  const output = result.outputFiles[0]!.text;
  expect(output).toContain("inference-browser");
  expect(output).not.toMatch(/node:(?:fs|path|url|worker_threads)|onnxruntime-node|\.node\b|\brequire\s*\(/);
}

test("G02: browser inference Worker bundles without Node dependencies", verifyBrowserWorkerBuild, 30000);

/**
 * 処理名: browser SQL Worker bundle検証
 * 処理概要: SQL entryとbrowser Database entryをNode builtinなしでbundleする。
 * 実装理由: 公式所有Workerと公開entryへNode polyfillやfallbackを導入しないため。
 * @returns 検証完了。
 */
async function verifyBrowserDatabaseBuild(): Promise<void> {
  const results = await Promise.all(["samples/browser/owner.ts", "src/index-browser.ts"].map(buildBrowserEntry));
  for (const result of results) {
    const output = result.outputFiles?.[0]?.text;
    expect(output).toBeDefined();
    const imports = Object.values(result.metafile?.inputs ?? {}).flatMap((input) => input.imports.map((dependency) => dependency.path));
    expect(imports).not.toEqual(expect.arrayContaining([expect.stringMatching(/^(?:node:|fs$|path$|url$|wasi$|worker_threads$)|onnxruntime-node|\.(?:node|dll)$/u)]));
    expect(Object.keys(result.metafile?.inputs ?? {})).not.toEqual(expect.arrayContaining([expect.stringMatching(/onnxruntime-node|\.(?:node|dll)$/u)]));
  }
}

/**
 * 処理名: browser entry bundle
 * 処理概要: 指定entryをbrowser ESMへmemory上でbundleする。
 * 実装理由: SQL Workerと公開entryへ同じbuild条件を適用するため。
 * @param entry - TypeScript entry path。
 * @returns esbuild結果。
 */
async function buildBrowserEntry(entry: string): Promise<Awaited<ReturnType<typeof build>>> {
  return build({ entryPoints: [entry], bundle: true, platform: "browser", format: "esm", target: "es2022", write: false, metafile: true, minifySyntax: true, define: { "globalThis.process": "undefined" } });
}

test("browser Database and SQL Worker bundle without Node dependencies", verifyBrowserDatabaseBuild, 30000);

/**
 * 処理名: Node DirectML Worker bundle検証
 * 処理概要: ORT Nodeをexternalに保ちnative binaryをbundleしないことを確認する。
 * 実装理由: optional dependencyのbindingを製品tarballへ複製しないため。
 * @returns 検証完了。
 */
async function verifyNodeDirectMlWorkerBuild(): Promise<void> {
  const result = await build({ entryPoints: ["src/workers/inference-node.ts"], bundle: true, platform: "node", format: "cjs", target: "node24", external: ["onnxruntime-node"], metafile: true, write: false });
  const output = result.outputFiles?.[0]?.text;
  expect(output).toBeDefined();
  expect(output as string).toContain("onnxruntime-node");
  expect(Object.keys(result.metafile?.inputs ?? {})).not.toEqual(expect.arrayContaining([expect.stringMatching(/\.node$|\.dll$/)]));
}

test("G00-DML: Node inference Worker keeps native runtime external", verifyNodeDirectMlWorkerBuild, 30000);