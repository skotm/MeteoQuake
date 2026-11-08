/**
 * analysisProtocol.ts
 * ------------------------------------------------------------
 * メインスレッド(analysisClient.ts)と、解析を行うWorker(workerHandler.ts)の間でやりとりするメッセージ。
 * 値はすべて構造化複製(postMessage)できるものだけにする(関数・クラスのインスタンス・DOMは含めない)。
 */
import type { AnalysisTickInput, AnalysisTickOutput, Station } from "./analysisPipeline";

/** 走時表のJSON(public/jma-travel-time.jsonの中身)。Workerは自分のモジュール空間に設定する必要がある。 */
export type TravelTableJson = Parameters<typeof import("../engines/jmaTravelTime").tableFromJSON>[0];

export interface TickItem {
  seq: number;
  input: Omit<AnalysisTickInput, "values"> & {
    /** 震度値([id, 値]の配列。Mapは構造化複製できるが、サイズ・互換性のため配列にする)。sameValuesがtrueなら省略。 */
    values?: [number, number][];
    /** 直前のtickと同じMapのままの再実行。Worker側が前回のMapをそのまま使う(同一性の判定を保つため)。 */
    sameValues?: boolean;
  };
}

export type ToWorkerMessage =
  | { type: "setTravelTable"; json: TravelTableJson }
  | { type: "setStations"; stations: Station[]; weakArrayEnabled: boolean }
  | { type: "setWeakArrayEnabled"; enabled: boolean }
  /** 溜まったtickをまとめて送る。最後の1つ以外は、推定を省略して検知だけ進める。 */
  | { type: "ticks"; items: TickItem[] };

export type FromWorkerMessage =
  | { type: "result"; seq: number; output: AnalysisTickOutput }
  | { type: "error"; seq: number | null; message: string };
