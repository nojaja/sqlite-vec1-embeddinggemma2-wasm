import { mkdir, rename, rm, writeFile } from "node:fs/promises";

/** 処理名: E2E stage計測。処理概要: stage名とelapsed msを保持する。実装理由: シナリオ内処理時間を機械可読化するため。 */
interface E2eStageTiming {
  /** 処理名: stage名。処理概要: 非機密の処理区間名を保持する。実装理由: 時間を操作へ対応付けるため。 */
  name: string;
  /** 処理名: 経過時間。処理概要: monotonic elapsed msを保持する。実装理由: clock変更の影響を避けるため。 */
  elapsedMs: number;
}

/**
 * 処理名: E2E timing recorder
 * 処理概要: シナリオ全体と各stageの経過時間を記録してJSONへ保存する。
 * 実装理由: Jest全体時間だけでなくDB/inference処理別の実測を残すため。
 */
export class E2eTimingRecorder {
  private readonly scenario: string;
  private readonly started = performance.now();
  private readonly stages: E2eStageTiming[] = [];

  /**
   * 処理名: recorder生成
   * 処理概要: scenario名と開始時刻を固定する。
   * 実装理由: reportをtest fileへ対応付けるため。
   * @param scenario - report名。
   */
  constructor(scenario: string) { this.scenario = scenario; }

  /**
   * 処理名: stage計測
   * 処理概要: 非同期処理の成功・失敗にかかわらずelapsedを記録する。
   * 実装理由: 失敗区間も含めて遅延箇所を特定できるようにするため。
   * @param name - stage名。
   * @param operation - 計測対象。
   * @returns operation結果。
   */
  async measure<T>(name: string, operation: () => Promise<T>): Promise<T> {
    const started = performance.now();
    try { return await operation(); }
    finally { this.stages.push({ name, elapsedMs: performance.now() - started }); }
  }

  /**
   * 処理名: timing report保存
   * 処理概要: stage一覧とtotalをstage fileから原子的に置換する。
   * 実装理由: 中断時に過去の完全reportを部分JSONで破壊しないため。
   * @param status - test結果。
   * @param details - scenario固有の非機密集計。
   * @returns report保存完了。
   */
  async write(status: "passed" | "failed", details: Record<string, unknown> = {}): Promise<void> {
    const directory = "artifacts/e2e-timings";
    const target = `${directory}/${this.scenario}.json`;
    const stage = `${target}.stage`;
    const report = { schemaVersion: 1, scenario: this.scenario, status, totalMs: performance.now() - this.started, stages: this.stages, ...details };
    await mkdir(directory, { recursive: true });
    await rm(stage, { force: true });
    await writeFile(stage, JSON.stringify(report, null, 2) + "\n", "utf8");
    await rename(stage, target);
    console.log(JSON.stringify({ stage: "e2e-timing", scenario: this.scenario, status, totalMs: report.totalMs, stages: this.stages }));
  }
}