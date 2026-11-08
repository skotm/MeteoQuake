/**
 * analysisRunner.ts
 * ------------------------------------------------------------
 * MapCanvas.jsxが使う、解析の実行役。解析を「同じスレッドで同期的に」行うか、「Web Workerで非同期に」
 * 行うかを内部で切り替える。MapCanvas側は、どちらでも同じ呼び方(tick(input, onResult))で使える。
 *
 * ・同期モード(既定): AnalysisPipelineを直接呼ぶ。onResultは、tick()の中で、その場で呼ばれる
 *   (従来の、MapCanvasのeffect内での直接呼び出しと同じ動作・タイミング)。
 * ・Workerモード: AnalysisClient経由でWorkerへ送る。onResultは、結果が返った時に(1tick以上遅れて)呼ばれる。
 *   Worker処理中に次のtickが来たら、まとめられ、まとめられたtickのonResultは呼ばれない
 *   (最後のtickの結果だけが返る。analysisClient.ts参照)。
 * ・Workerの生成に失敗した、またはWorkerがエラー(スクリプトの読み込み失敗・未捕捉の例外)を起こした場合は、
 *   自動で同期モードに切り替える(それまでの検知の状態はWorkerとともに失われ、検知は同期側で最初からやり直しになる)。
 *
 * StrictModeの二重描画・二重effectでも壊れないよう、Workerは「最初に使われた時」に生成する
 * (コンストラクタ=描画中には、Workerを作らない)。終了処理(terminate)は、アプリの寿命と同じ
 * MapCanvasでは呼ばない(effectのクリーンアップで呼ぶと、開発時の二重実行で壊れる)。
 */
import { AnalysisClient, type AnalysisTransport } from "./analysisClient";
import {
  AnalysisPipeline,
  type AnalysisTickInput,
  type AnalysisTickOutput,
  type Station,
} from "./analysisPipeline";
import type { TravelTableJson } from "./analysisProtocol";

/** ブラウザのWorkerと、そのテスト用の代わりが共通して持つ口。 */
export interface WorkerLike extends AnalysisTransport {
  onerror: ((event: unknown) => void) | null;
}

export interface AnalysisRunnerOptions {
  /** trueでWorkerモード(createWorkerが無ければ同期モード)。 */
  useWorker: boolean;
  /** Workerを作る関数。最初に使われた時に1回だけ呼ばれる。 */
  createWorker?: () => WorkerLike;
  /** 同期モードへ切り替えた時(Workerの失敗)に呼ばれる。 */
  onFallback?: (reason: string) => void;
  /** Worker内の1tickの処理が例外になった時に呼ばれる(Workerは使い続ける)。 */
  onError?: (error: Error) => void;
  /** 揺れ検知エンジンの設定の上書き(同期モードのみ)。 */
  shakeParams?: object;
}

// Workerモードを既定にするか。ブラウザで一通り確認できたら、trueにする。
// URLの ?analysisWorker=1 / 0 、またはlocalStorageの "meteoquake.analysisWorker" ("1"/"0") で、実行時に上書きできる。
export const ANALYSIS_WORKER_DEFAULT = false;
export const ANALYSIS_WORKER_STORAGE_KEY = "meteoquake.analysisWorker";

/** Workerモードを使うか(URL > localStorage > 既定値。Workerが使えない環境ではfalse)。 */
export function shouldUseAnalysisWorker(): boolean {
  if (typeof Worker === "undefined") return false;
  const parse = (v: string | null | undefined): boolean | null => (v === "1" ? true : v === "0" ? false : null);
  try {
    if (typeof location !== "undefined") {
      const fromUrl = parse(new URLSearchParams(location.search).get("analysisWorker"));
      if (fromUrl !== null) return fromUrl;
    }
  } catch { /* URLが読めない環境では、次の判定へ */ }
  try {
    if (typeof localStorage !== "undefined") {
      const fromStorage = parse(localStorage.getItem(ANALYSIS_WORKER_STORAGE_KEY));
      if (fromStorage !== null) return fromStorage;
    }
  } catch { /* localStorageが使えない環境では、既定値 */ }
  return ANALYSIS_WORKER_DEFAULT;
}

export class AnalysisRunner {
  private options: AnalysisRunnerOptions;
  private mode: "sync" | "worker";
  private pipeline: AnalysisPipeline | null = null;
  private client: AnalysisClient | null = null;
  // 同期モードへ切り替える時に、引き継ぐ設定
  private stations: Station[] | null = null;
  private weakArrayEnabled = false;

  constructor(options: AnalysisRunnerOptions) {
    this.options = options;
    this.mode = options.useWorker && options.createWorker ? "worker" : "sync";
    if (this.mode === "sync") this.pipeline = new AnalysisPipeline({ shakeParams: options.shakeParams });
  }

  getMode(): "sync" | "worker" {
    return this.mode;
  }

  /** 観測点マスタを(再)設定する。 */
  setStations(stations: Station[], weakArrayEnabled: boolean): void {
    this.stations = stations;
    this.weakArrayEnabled = weakArrayEnabled;
    if (this.useWorkerNow()) this.client!.setStations(stations, weakArrayEnabled);
    else this.pipeline!.setStations(stations, weakArrayEnabled);
  }

  /** 微弱検知の設定の切り替え。 */
  setWeakArrayEnabled(enabled: boolean): void {
    this.weakArrayEnabled = enabled;
    if (this.useWorkerNow()) this.client!.setWeakArrayEnabled(enabled);
    else this.pipeline!.setWeakArrayEnabled(enabled);
  }

  /**
   * 走時表(public/jma-travel-time.json)をWorkerへ渡す。Workerは自分のモジュール空間を持つので、
   * メインスレッドで設定した走時表は見えない。同期モードでは何もしない(メインスレッドの設定がそのまま使われる)。
   */
  setTravelTable(json: TravelTableJson): void {
    if (this.useWorkerNow()) this.client!.setTravelTable(json);
  }

  /** 1tick分進める。結果はonResultへ渡す(同期モードはその場で、Workerモードは後で)。 */
  tick(input: AnalysisTickInput, onResult: (output: AnalysisTickOutput) => void): void {
    if (!this.useWorkerNow()) {
      onResult(this.pipeline!.tick(input));
      return;
    }
    const client = this.client!;
    client.tick(input).then(
      (output) => { if (output && this.client === client) onResult(output); },
      (error: Error) => { if (this.client === client) this.options.onError?.(error); },
    );
  }

  /** Workerモードで動いているか(必要ならWorkerを生成する。失敗したら同期モードへ切り替えて、falseを返す)。 */
  private useWorkerNow(): boolean {
    if (this.mode !== "worker") return false;
    if (this.client) return true;
    try {
      const worker = this.options.createWorker!();
      worker.onerror = (event) => this.fallbackToSync(`Workerのエラー: ${describeError(event)}`);
      this.client = new AnalysisClient(worker);
      return true;
    } catch (e) {
      this.fallbackToSync(`Workerを作れませんでした: ${describeError(e)}`);
      return false;
    }
  }

  private fallbackToSync(reason: string): void {
    if (this.mode === "sync") return;
    this.mode = "sync";
    this.client?.terminate();
    this.client = null;
    this.pipeline = new AnalysisPipeline({ shakeParams: this.options.shakeParams });
    if (this.stations) this.pipeline.setStations(this.stations, this.weakArrayEnabled);
    else this.pipeline.setWeakArrayEnabled(this.weakArrayEnabled);
    this.options.onFallback?.(reason);
  }
}

function describeError(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message);
  return String(e);
}
