/**
 * 処理名: ブラウザサンプルスーパーバイザー
 * 処理概要: owner Workerを起動し、online/offlineのwalkthroughを実行・監視する。
 */

export async function runBrowserSampleSupervisor(): Promise<void> {
  const statusEl = document.getElementById("status");
  function setStatus(msg: string) {
    if (statusEl) statusEl.textContent = msg;
    console.log("[supervisor]", msg);
  }

  setStatus("Starting browser sample...");

  const worker = new Worker(new URL("./owner.mjs", import.meta.url), { type: "module" });

  try {
    setStatus("Executing online walkthrough...");
    if (typeof (globalThis as any).__SVW_WALKTHROUGH_ONLINE__ === "function") {
      await (globalThis as any).__SVW_WALKTHROUGH_ONLINE__();
    }

    setStatus("Executing offline walkthrough...");
    if (typeof (globalThis as any).__SVW_WALKTHROUGH_OFFLINE__ === "function") {
      await (globalThis as any).__SVW_WALKTHROUGH_OFFLINE__();
    }

    setStatus("Browser sample completed successfully.");
  } catch (err: any) {
    setStatus("Browser sample failed: " + (err?.message ?? String(err)));
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
