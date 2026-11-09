/**
 * 処理名: ブラウザサンプルスーパーバイザー
 * 処理概要: owner Workerを起動し、online/offlineのwalkthroughを実行・監視する。
 * 実装理由: ブラウザ上での推論およびSQLiteストレージライフサイクルをエンドツーエンドで実証するため。
 */
export async function runBrowserSampleSupervisor(): Promise<void> {
  const statusEl = document.getElementById("status");
  /**
   * 処理名: ステータスメッセージ設定
   * 処理概要: DOM要素およびコンソールに最新の進捗状況を出力する。
   * 実装理由: ブラウザ画面およびデバッグログに進捗を表示するため。
   * @param msg - 出力する進捗メッセージ。
   */
  function setStatus(msg: string): void {
    if (statusEl) statusEl.textContent = msg;
    console.log("[supervisor]", msg);
  }

  setStatus("Starting browser sample...");

  const worker = new Worker(new URL("./owner.mjs", location.href), { type: "module" });

  try {
    setStatus("Executing online walkthrough...");
    const g = globalThis as unknown as Record<string, unknown>;
    if (typeof g.__SVW_WALKTHROUGH_ONLINE__ === "function") {
      await (g.__SVW_WALKTHROUGH_ONLINE__ as () => Promise<void>)();
    }

    setStatus("Executing offline walkthrough...");
    if (typeof g.__SVW_WALKTHROUGH_OFFLINE__ === "function") {
      await (g.__SVW_WALKTHROUGH_OFFLINE__ as () => Promise<void>)();
    }

    setStatus("Browser sample completed successfully.");
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    setStatus("Browser sample failed: " + message);
    throw err;
  } finally {
    worker.terminate();
  }
}

if (typeof document !== "undefined") {
  window.addEventListener("DOMContentLoaded", () => {
    runBrowserSampleSupervisor().catch(console.error);
  });
}
