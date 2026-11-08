import { test } from "node:test";
import assert from "node:assert/strict";
import type { ShakeDetectionEngine } from "../src/engines/shakeDetection";
import type { EpicenterEstimator } from "../src/engines/epicenterEstimation";
import type { GridDetector } from "../src/engines/gridDetection";
import { computeShakeTestValues, prepareShakeTest } from "../src/engines/shakeTestSimulation";
import {
  AnalysisPipeline, GRID_INTERNAL_ESTIMATE_MIN_POINTS, REPLAY_TIME_JUMP_RESET_MS, SOURCE_CHANGE_DETECTION_SUPPRESS_MS,
  type AnalysisTickInput,
} from "../src/analysis/analysisPipeline";
import { stationGrid, T0 } from "./helpers";

// 参照実装: 移す前のapp/MapCanvas.jsxのeffectにあった解析部分の処理を、そのまま写したもの
// (描画・視点移動・表示用の絞り込みを除く)。AnalysisPipelineがこれと同じ結果を返すことを確かめる。
//
// shakeDetection.tsのイベントIDの連番はモジュール全体で共有されるため、AnalysisPipeline(通常のimport)と
// ID の振られ方を揃えるよう、参照実装は別のモジュールインスタンス(クエリ付きのimport)を使う。
async function loadReferenceEngines() {
  const tag = `?ref=${Math.random().toString(36).slice(2)}`;
  const sd = await import(`../src/engines/shakeDetection.ts${tag}`);
  const ee = await import(`../src/engines/epicenterEstimation.ts${tag}`);
  const gd = await import(`../src/engines/gridDetection.ts${tag}`);
  return { ShakeDetectionEngine: sd.ShakeDetectionEngine as typeof ShakeDetectionEngine, EpicenterEstimator: ee.EpicenterEstimator as typeof EpicenterEstimator, GridDetector: gd.GridDetector as typeof GridDetector };
}

class ReferenceEffect {
  shakeEngine: ShakeDetectionEngine;
  estimator: EpicenterEstimator;
  gridEngine: GridDetector;
  gridEstimator: EpicenterEstimator;
  constructor(E: Awaited<ReturnType<typeof loadReferenceEngines>>) {
    this.shakeEngine = new E.ShakeDetectionEngine();
    this.estimator = new E.EpicenterEstimator();
    this.gridEngine = new E.GridDetector();
    this.gridEstimator = new E.EpicenterEstimator();
  }
  stations: unknown[] = [];
  prevSourceMode: string | undefined;
  lastEngineNow: number | null = null;
  lastProcessedValues: Map<number, number> | null = null;
  lastShakeEvents: unknown[] = [];
  lastShakeGridMode = false;
  prevGridEnabled = false;
  gridInternalEst: { at: number; map: Map<number, unknown> } | null = null;
  lastGridResult: { events: { pointCount: number }[] } | null = null;
  lastGridValues: Map<number, number> | null = null;

  setStations(stations: { id: number }[], weak: boolean) {
    this.stations = stations;
    this.gridEngine.initialize(stations);
    this.lastGridResult = null;
    this.lastGridValues = null;
    this.shakeEngine.setWeakArrayEnabled(weak);
    this.shakeEngine.initialize(stations);
  }

  tick(i: AnalysisTickInput) {
    const engineNow = i.now;
    const prevEngineNow = this.lastEngineNow;
    this.lastEngineNow = engineNow;
    if (this.prevSourceMode === undefined) this.prevSourceMode = i.sourceMode;
    const sourceModeChanged = this.prevSourceMode !== i.sourceMode;
    let replayTimeJumped = false;
    const reset = () => {
      this.shakeEngine.resetForSourceChange(engineNow, SOURCE_CHANGE_DETECTION_SUPPRESS_MS);
      this.estimator.reset();
      this.gridEngine.resetForSourceChange(engineNow, SOURCE_CHANGE_DETECTION_SUPPRESS_MS);
      this.gridEstimator.reset();
      this.lastGridResult = null;
      this.lastGridValues = null;
    };
    if (sourceModeChanged) { this.prevSourceMode = i.sourceMode; reset(); }
    else if (i.replayClock && prevEngineNow != null) {
      const jumpMs = engineNow - prevEngineNow;
      if (jumpMs < 0 || jumpMs > REPLAY_TIME_JUMP_RESET_MS) { replayTimeJumped = true; reset(); }
    }
    const valuesUnchanged = !sourceModeChanged && !replayTimeJumped && this.lastProcessedValues === i.values;
    if (sourceModeChanged || replayTimeJumped) this.lastProcessedValues = null;
    const gridModeNow = i.shakeDetectionEnabled && i.gridDetectionEnabled;
    if (this.lastShakeGridMode !== gridModeNow) {
      this.lastShakeGridMode = gridModeNow;
      this.lastProcessedValues = null;
      if (!gridModeNow) this.shakeEngine.resetForSourceChange(engineNow, 0);
    }
    const shakeEvents = !i.shakeDetectionEnabled
      ? []
      : gridModeNow
        ? (this.lastGridResult?.events ?? [])
        : (valuesUnchanged && this.lastProcessedValues === i.values
          ? this.lastShakeEvents
          : (this.lastProcessedValues = i.values, this.shakeEngine.processTick(i.values, engineNow)));
    this.lastShakeEvents = shakeEvents;
    let estimates: Map<number, unknown> | null = null;
    if (i.epicenterEstimationEnabled && !i.gridDetectionEnabled) {
      estimates = shakeEvents.length > 0 ? this.estimator.updateAll(shakeEvents, this.stations, engineNow) : new Map();
      this.shakeEngine.setExternalEstimates(estimates);
    } else {
      this.shakeEngine.setExternalEstimates(null);
    }
    let grid: unknown = null;
    if (i.gridDetectionEnabled) {
      if (!this.prevGridEnabled) {
        this.gridEngine.resetForSourceChange(engineNow, SOURCE_CHANGE_DETECTION_SUPPRESS_MS);
        this.gridEstimator.reset();
        this.lastGridResult = null;
        this.lastGridValues = null;
        this.gridInternalEst = null;
      }
      this.prevGridEnabled = true;
      const gridUnchanged = this.lastGridResult != null && this.lastGridValues === i.values;
      const gridResult = gridUnchanged ? this.lastGridResult! : this.gridEngine.processTick(i.values, engineNow);
      this.lastGridResult = gridResult;
      this.lastGridValues = i.values;
      let gridEstimates: Map<number, unknown>;
      if (i.epicenterEstimationEnabled) {
        gridEstimates = gridResult.events.length > 0 ? this.gridEstimator.updateAll(gridResult.events, this.stations, engineNow) : new Map();
        this.gridInternalEst = { at: engineNow, map: gridEstimates };
      } else {
        const cached = this.gridInternalEst;
        if (cached && engineNow >= cached.at && engineNow - cached.at < 3000) {
          gridEstimates = cached.map;
        } else {
          const big = gridResult.events.filter((e) => e.pointCount >= GRID_INTERNAL_ESTIMATE_MIN_POINTS);
          gridEstimates = big.length > 0 ? this.gridEstimator.updateAll(big, this.stations, engineNow) : new Map();
          this.gridInternalEst = { at: engineNow, map: gridEstimates };
        }
      }
      this.gridEngine.setExternalEstimates(gridEstimates);
      grid = { result: gridResult, estimates: gridEstimates };
    } else if (this.prevGridEnabled) {
      this.prevGridEnabled = false;
      this.lastGridResult = null;
      this.lastGridValues = null;
      this.gridEstimator.reset();
    }
    return { shakeEvents, estimates, grid };
  }
}

// Map・Set・非有限数も含めて、比較用の文字列にする。
function ser(x: unknown): string {
  return JSON.stringify(x, (_k, v) => {
    if (v instanceof Map) return { __map: [...v] };
    if (v instanceof Set) return { __set: [...v] };
    if (typeof v === "number" && !Number.isFinite(v)) return `__${v}`;
    return v;
  });
}

const stations = stationGrid(38, 142, 9, 0.12); // 361観測点
const per = prepareShakeTest({ lat: 38.0, lon: 142.0, magnitude: 6.3, depth: 20 }, stations);
function valuesAt(sec: number): Map<number, number> {
  const sim = computeShakeTestValues(per, sec * 1000);
  const m = new Map<number, number>();
  for (const s of stations) m.set(s.id, sim.has(s.id) ? sim.get(s.id) : -3);
  return m;
}

test("AnalysisPipelineは、移す前のeffectの処理(参照実装)と、全tickで同じ結果を返す", async () => {
  const pipe = new AnalysisPipeline();
  const ref = new ReferenceEffect(await loadReferenceEngines());
  pipe.setStations(stations, false);
  ref.setStations(stations, false);

  let now = T0;
  let values = valuesAt(0);
  let sawEvents = false, sawEstimates = false, sawGrid = false, sawReset = 0, sawGridOff = 0;
  const plan = (k: number): Partial<AnalysisTickInput> => ({
    sourceMode: k < 34 ? "live" : "replay",
    replayClock: k >= 34,
    shakeDetectionEnabled: k < 66,
    gridDetectionEnabled: k >= 46 && k < 58,
    epicenterEstimationEnabled: !(k >= 22 && k < 28),
  });
  for (let k = 0; k < 70; k++) {
    now = T0 + k * 1000 - (k >= 44 ? 20_000 : 0); // k=44で、リプレイのシーク(データ時刻が20秒戻る)
    // k=44のシーク(データ時刻が戻る)で、模擬地震も発震直後から再生し直す(グリッド検知がONの間に検知が起きるように)
    values = valuesAt(k < 44 ? k : k - 42);
    const input = { values, now, ...plan(k) } as AnalysisTickInput;
    const a = pipe.tick(input);
    const b = ref.tick(input);
    assert.equal(ser({ shakeEvents: a.shakeEvents, estimates: a.estimates, grid: a.grid }), ser(b), `tick ${k}`);
    // 同じMapのままの再呼び出し(effectの依存配列に含まれる設定操作での再実行)でも、一致する
    if (k % 7 === 3) {
      const a2 = pipe.tick(input);
      const b2 = ref.tick(input);
      assert.equal(ser({ shakeEvents: a2.shakeEvents, estimates: a2.estimates, grid: a2.grid }), ser(b2), `tick ${k} (同じMapでの再呼び出し)`);
    }
    if (a.shakeEvents.length) sawEvents = true;
    if (a.estimates && a.estimates.size) sawEstimates = true;
    if (a.grid && a.grid.result.events.length) sawGrid = true;
    if (a.didReset) sawReset++;
    if (a.gridJustDisabled) sawGridOff++;
  }
  assert.ok(sawEvents && sawEstimates, "前提: 検知と推定が実際に動いていること");
  assert.ok(sawGrid, "前提: グリッド検知が実際にイベントを出していること");
  assert.equal(sawReset, 2, "データ源の切り替え1回とリプレイのシーク1回でリセットされる");
  assert.equal(sawGridOff, 1, "グリッド検知のON→OFFが1回");
});
