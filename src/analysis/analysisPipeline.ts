/**
 * analysisPipeline.ts
 * ------------------------------------------------------------
 * 地震検知・震源推定の解析処理(検知エンジン・震源推定・グリッド検知)を、地図の描画から切り離して
 * まとめたもの。以前はapp/MapCanvas.jsxのeffectの中に、描画と混ざって直接書かれていた。
 *
 * DOM・React・MapLibreには依存しない(Node・Web Workerでも動く)。MapCanvas.jsxは、tick()が返した
 * 結果を描画に使うだけにする。Web Workerへ移す場合も、この処理をそのまま動かす(workers/earthquakeWorker.ts)。
 *
 * tick()の中の処理の順序と条件は、移す前のMapCanvas.jsxのeffectと同じにしてある(検知は「1回の呼び出し=1tick」
 * 前提の履歴を持つので、呼び出し回数・順序を変えると検知が変わる)。変える時は、tests/analysisPipeline.test.ts
 * (移す前の処理を写した参照実装との一致確認)を通すこと。
 */
import { ShakeDetectionEngine } from "../engines/shakeDetection";
import { EpicenterEstimator } from "../engines/epicenterEstimation";
import { GridDetector } from "../engines/gridDetection";

// リアルタイム⇔リプレイ・検知テストの切り替え直後に、検知を無効にする時間(ms)。
export const SOURCE_CHANGE_DETECTION_SUPPRESS_MS = 2000;
// リプレイのシーク・巻き戻し・大きく先へ飛んだ時(データ時刻が戻る、またはこの時間を超えて進む)は、
// それまでの検知を持ち越さずリセットする(ms)。通常再生では1tickあたり数秒しか進まない。
export const REPLAY_TIME_JUMP_RESET_MS = 5000;
// グリッド検知の「震源推定の表示」がOFFの間、独立した地震かどうかの判定用に推定する、イベントの最小点数と間隔。
export const GRID_INTERNAL_ESTIMATE_MIN_POINTS = 20;
export const GRID_INTERNAL_ESTIMATE_INTERVAL_MS = 3000;

export interface Station {
  id: number;
  lat: number;
  lon: number;
  [key: string]: unknown;
}

export type ShakeEvents = ReturnType<ShakeDetectionEngine["processTick"]>;
export type EstimateMap = ReturnType<EpicenterEstimator["updateAll"]>;
export type GridResult = ReturnType<GridDetector["processTick"]>;

export interface AnalysisTickInput {
  /** 観測点ごとの震度値。新しいデータが届くたびに新しいMapを渡す(同じMapのままの再呼び出しは、エンジンを進めない)。 */
  values: Map<number, number>;
  /** エンジン時刻(ms)。リプレイ中はデータ時刻、それ以外はDate.now()。 */
  now: number;
  /** データ源("live" | "replay" | "test")。変わったtickで、検知・推定をリセットする。 */
  sourceMode: string;
  /** nowがリプレイのデータ時刻か(時刻の不連続=シーク・巻き戻しの検出に使う)。 */
  replayClock: boolean;
  shakeDetectionEnabled: boolean;
  gridDetectionEnabled: boolean;
  epicenterEstimationEnabled: boolean;
}

export interface AnalysisTickOptions {
  /**
   * 震源推定(重い処理)を行わず、検知だけ進める。Web Workerで、推定が追いつかずにtickが溜まった時、
   * 最後の1tick以外に使う。省略したtickの推定結果は、直前に計算したもの(なければ空)を返す。
   * エンジンへの推定のフィードバック(setExternalEstimates)も、省略したtickでは更新しない。
   */
  skipEstimation?: boolean;
}

export interface AnalysisTickOutput {
  /** このtickで、検知・推定の状態をリセットしたか(描画側が持つ前回の推定結果などを捨てるために使う)。 */
  didReset: boolean;
  shakeEvents: ShakeEvents;
  /** 通常の震源推定の結果(表示用の絞り込み前)。推定を実行しなかった(機能OFF・グリッド方式)時はnull。 */
  estimates: EstimateMap | null;
  /** グリッド検知がONの間の結果。OFFの間はnull。 */
  grid: { result: GridResult; estimates: EstimateMap } | null;
  /** このtickで、グリッド検知がONからOFFに変わったか(描画側がグリッドの表示を片付けるために使う)。 */
  gridJustDisabled: boolean;
}

export class AnalysisPipeline {
  shakeEngine: ShakeDetectionEngine;
  estimator = new EpicenterEstimator();
  gridEngine = new GridDetector();
  gridEstimator = new EpicenterEstimator();

  private stations: Station[] = [];
  private prevSourceMode: string | undefined;
  private prevEngineNow: number | null = null;
  private lastProcessedValues: Map<number, number> | null = null;
  private lastShakeEvents: ShakeEvents = [];
  private lastShakeGridMode = false;
  private lastEstimates: EstimateMap = new Map();
  private prevGridEnabled = false;
  private gridInternalEst: { at: number; map: EstimateMap } | null = null;
  private lastGridResult: GridResult | null = null;
  private lastGridValues: Map<number, number> | null = null;

  /** shakeParams: 揺れ検知エンジンの設定の上書き(省略時は既定値。例: { stationNoise: { enabled: true } })。 */
  constructor(options: { shakeParams?: object } = {}) {
    this.shakeEngine = new ShakeDetectionEngine(options.shakeParams);
  }

  /** 観測点マスタを(再)設定する。観測点が空の間は何もしない。weakArrayEnabledは、検知器を作る前に反映する。 */
  setStations(stations: Station[], weakArrayEnabled: boolean): void {
    if (stations.length === 0) return;
    this.stations = stations;
    this.gridEngine.initialize(stations);
    this.lastGridResult = null;
    this.lastGridValues = null;
    // initializeが微弱検知器を作るので、その前に、設定を反映しておく
    this.shakeEngine.setWeakArrayEnabled(weakArrayEnabled);
    this.shakeEngine.initialize(stations);
  }

  /** 微弱検知の設定の切り替えを、実行中のエンジンへ反映する(グリッド検知の発火水準も連動する)。 */
  setWeakArrayEnabled(enabled: boolean): void {
    this.shakeEngine.setWeakArrayEnabled(enabled);
    this.gridEngine.setWeakEnabled(enabled);
  }

  /** 前回の検知結果(MapCanvasが、描画のために1tick前の結果を参照する)。 */
  getLastShakeEvents(): ShakeEvents {
    return this.lastShakeEvents;
  }

  private resetAll(now: number): void {
    this.shakeEngine.resetForSourceChange(now, SOURCE_CHANGE_DETECTION_SUPPRESS_MS);
    this.estimator.reset();
    this.gridEngine.resetForSourceChange(now, SOURCE_CHANGE_DETECTION_SUPPRESS_MS);
    this.gridEstimator.reset();
    this.lastGridResult = null;
    this.lastGridValues = null;
    this.lastEstimates = new Map();
  }

  /** 1tick分、検知・震源推定・グリッド検知を進める。 */
  tick(input: AnalysisTickInput, options: AnalysisTickOptions = {}): AnalysisTickOutput {
    const skipEstimation = options.skipEstimation === true;
    const { values, now, sourceMode, replayClock, shakeDetectionEnabled, gridDetectionEnabled, epicenterEstimationEnabled } = input;
    const stations = this.stations;

    // 【データ源切り替え対策】リアルタイム⇔リプレイ・検知テストが切り替わった場合、それまでの検知
    // (観測点の履歴・進行中のイベント・震源推定のキャッシュ)を破棄し、直後2秒間は検知を無効化する。
    // 検知の有効/無効の設定に関わらず、切り替えは必ず記録する。
    const prevEngineNow = this.prevEngineNow;
    this.prevEngineNow = now;
    if (this.prevSourceMode === undefined) this.prevSourceMode = sourceMode;
    const sourceModeChanged = this.prevSourceMode !== sourceMode;
    let replayTimeJumped = false;
    let didReset = false;
    if (sourceModeChanged) {
      this.prevSourceMode = sourceMode;
      this.resetAll(now);
      didReset = true;
    } else if (replayClock && prevEngineNow != null) {
      // リプレイのシーク・巻き戻し・再生し直し(データ時刻が戻る、または5秒超飛ぶ)では、
      // それまでの検知を持ち越さずリセットする。
      const jumpMs = now - prevEngineNow;
      if (jumpMs < 0 || jumpMs > REPLAY_TIME_JUMP_RESET_MS) {
        replayTimeJumped = true;
        this.resetAll(now);
        didReset = true;
      }
    }

    // 前回processTickに渡したものと同じMapのままの再実行では、検知エンジンを進めず前回の結果を使う
    // (検知エンジンのprocessTickは「1回の呼び出し=1tick」前提で、履歴をtick数で数えているため)。
    // 切り替え・シークによるリセット直後は必ず進める。
    const valuesUnchanged = !sourceModeChanged && !replayTimeJumped && this.lastProcessedValues === values;
    if (sourceModeChanged || replayTimeJumped) this.lastProcessedValues = null;

    // 揺れ検知エンジンを1tick分進める(設定でOFFの間は呼ばない)。
    // グリッド検知がONの間は、通常の検知エンジンは動かさず(重いため)、グリッド検知のイベント(1tick前の結果)を使う。
    const gridModeNow = shakeDetectionEnabled && gridDetectionEnabled;
    if (this.lastShakeGridMode !== gridModeNow) {
      this.lastShakeGridMode = gridModeNow;
      this.lastProcessedValues = null; // 方式が切り替わったら、直前の結果を使い回さない
      // 通常の検知に戻る時は、止めていた間の古い状態を持ち越さないよう、エンジンをリセットする。
      if (!gridModeNow) this.shakeEngine.resetForSourceChange(now, 0);
    }
    let shakeEvents: ShakeEvents;
    if (!shakeDetectionEnabled) {
      shakeEvents = [];
    } else if (gridModeNow) {
      shakeEvents = this.lastGridResult?.events ?? [];
    } else if (valuesUnchanged && this.lastProcessedValues === values) {
      shakeEvents = this.lastShakeEvents;
    } else {
      this.lastProcessedValues = values;
      shakeEvents = this.shakeEngine.processTick(values, now);
    }
    this.lastShakeEvents = shakeEvents;

    // 震源推定(実験的機能)。機能自体がONの間だけ、かつ揺れ検知イベントが実際にある時だけ動かす。
    // EpicenterEstimator側で「検知点数・更新番号が変化したイベントだけ再計算する」キャッシュを持っているので、
    // 毎tick呼んでよい。グリッド方式の検知がONの間は、通常の震源推定は動かさない(重いため)。
    let estimates: EstimateMap | null = null;
    if (epicenterEstimationEnabled && !gridDetectionEnabled) {
      if (skipEstimation) {
        estimates = this.lastEstimates;
      } else {
        estimates = shakeEvents.length > 0
          ? this.estimator.updateAll(shakeEvents, stations, now)
          : new Map();
        this.lastEstimates = estimates;
        // 【対策C: 検知が分散してしまう問題】より精度の高い推定結果を、イベント統合判定(canEventsMerge)へ
        // フィードバックする(次tickから使われる)。
        this.shakeEngine.setExternalEstimates(estimates);
      }
    } else {
      // 機能自体がOFFの間は、イベント統合判定が古い推定を使い続けないよう、エンジン側の参照もクリアする。
      this.shakeEngine.setExternalEstimates(null);
    }

    // グリッド(セル)方式の検知(gridDetection.ts)。既存の検知とは独立に、同じ震度値を渡す。
    // 設定がONの間だけ動かす。ONにした直後は、古い状態を持ち越さないようリセットする。
    let grid: AnalysisTickOutput["grid"] = null;
    let gridJustDisabled = false;
    if (gridDetectionEnabled) {
      if (!this.prevGridEnabled) {
        this.gridEngine.resetForSourceChange(now, SOURCE_CHANGE_DETECTION_SUPPRESS_MS);
        this.gridEstimator.reset();
        this.lastGridResult = null;
        this.lastGridValues = null;
        this.gridInternalEst = null;
      }
      this.prevGridEnabled = true;
      const gridUnchanged = this.lastGridResult != null && this.lastGridValues === values;
      const gridResult = gridUnchanged ? (this.lastGridResult as GridResult) : this.gridEngine.processTick(values, now);
      this.lastGridResult = gridResult;
      this.lastGridValues = values;
      // 震源推定は、表示(「震源推定」ON)の有無にかかわらず、グリッド方式の検知がONの間は常に行う
      // (独立した別の地震かどうかの判定に、推定を使うため)。結果は、次のtickの判定へ返す。
      // 「震源推定」の表示がOFFの間は、判定に使う大きなイベントだけを、3秒おきに推定する(負荷を抑えるため)。
      let gridEstimates: EstimateMap;
      if (skipEstimation) {
        gridEstimates = this.gridInternalEst?.map ?? new Map();
      } else if (epicenterEstimationEnabled) {
        gridEstimates = gridResult.events.length > 0
          ? this.gridEstimator.updateAll(gridResult.events, stations, now)
          : new Map();
        this.gridInternalEst = { at: now, map: gridEstimates };
      } else {
        const cached = this.gridInternalEst;
        if (cached && now >= cached.at && now - cached.at < GRID_INTERNAL_ESTIMATE_INTERVAL_MS) {
          gridEstimates = cached.map;
        } else {
          const big = gridResult.events.filter((e: { pointCount: number }) => e.pointCount >= GRID_INTERNAL_ESTIMATE_MIN_POINTS);
          gridEstimates = big.length > 0 ? this.gridEstimator.updateAll(big, stations, now) : new Map();
          this.gridInternalEst = { at: now, map: gridEstimates };
        }
      }
      if (!skipEstimation) this.gridEngine.setExternalEstimates(gridEstimates);
      grid = { result: gridResult, estimates: gridEstimates };
    } else if (this.prevGridEnabled) {
      this.prevGridEnabled = false;
      this.lastGridResult = null;
      this.lastGridValues = null;
      this.gridEstimator.reset();
      gridJustDisabled = true;
    }

    return { didReset, shakeEvents, estimates, grid, gridJustDisabled };
  }
}
