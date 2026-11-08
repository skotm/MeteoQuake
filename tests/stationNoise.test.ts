import { test } from "node:test";
import assert from "node:assert/strict";
import { ShakeDetectionEngine } from "../src/engines/shakeDetection";
import { stationGrid, T0 } from "./helpers";

// 64観測点(minStations=50以上)。観測値は実データと同じ0.1刻み。NOISY_ID(1点)だけが、平常時に0.1ずつ揺れ続ける。
const stations = stationGrid(36, 138, 4, 0.4).slice(0, 64);
const NOISY_ID = stations[10].id;
const WARMUP = 180;
// ノイズの多い観測点は1tickおきに「反応中」になり、その間は統計から除外される(標本が半分になる)ので、
// 標本がWARMUPに届くまで十分長く流す。
const RUN = WARMUP * 3;

function makeEngine(noise: Record<string, unknown>) {
  const engine = new ShakeDetectionEngine({ stationNoise: noise });
  engine.initialize(stations);
  return engine;
}
function quietTick(engine: ShakeDetectionEngine, k: number) {
  const values = new Map<number, number>();
  for (const s of stations) values.set(s.id, s.id === NOISY_ID ? (k % 2 ? -2.9 : -3.0) : -3.0);
  return engine.processTick(values, T0 + k * 1000);
}
function stat(engine: ShakeDetectionEngine, id: number) {
  return engine.getStationNoiseStats().stations.find((s: { id: number }) => s.id === id);
}

test("既定では無効で、統計は集めるが倍率は常に1", () => {
  const engine = new ShakeDetectionEngine();
  engine.initialize(stations);
  for (let k = 0; k < RUN; k++) quietTick(engine, k);
  const stats = engine.getStationNoiseStats();
  assert.equal(stats.enabled, false);
  assert.ok(stats.stations.every((s: { scale: number }) => s.scale === 1));
  assert.ok(stat(engine, NOISY_ID).meanAbsDiff > 0.05, "ノイズ統計は収集されている");
});

test("有効にすると、常にノイズの多い観測点だけ倍率が上がり、上限を超えない", () => {
  const engine = makeEngine({ enabled: true });
  for (let k = 0; k < RUN; k++) quietTick(engine, k);
  const noisy = stat(engine, NOISY_ID);
  assert.ok(noisy.scale > 1 && noisy.scale <= 2, `noisy scale=${noisy.scale}`);
  const quiet = stations.filter((s) => s.id !== NOISY_ID).map((s) => stat(engine, s.id));
  assert.ok(quiet.every((s: { scale: number }) => s.scale === 1), "静かな観測点は倍率1のまま(下限minScale=1)");
});

test("標本がwarmupSamples未満の間は、倍率は1のまま", () => {
  const engine = makeEngine({ enabled: true });
  for (let k = 0; k < WARMUP - 20; k++) quietTick(engine, k);
  assert.equal(stat(engine, NOISY_ID).scale, 1);
});

test("観測点の数がminStations未満なら、倍率は1のまま(中央値が信用できない)", () => {
  const engine = new ShakeDetectionEngine({ stationNoise: { enabled: true } });
  engine.initialize(stations.slice(0, 20));
  for (let k = 0; k < RUN; k++) {
    const values = new Map<number, number>();
    for (const s of stations.slice(0, 20)) values.set(s.id, s.id === NOISY_ID ? (k % 2 ? -2.9 : -3.0) : -3.0);
    engine.processTick(values, T0 + k * 1000);
  }
  assert.ok(engine.getStationNoiseStats().stations.every((s: { scale: number }) => s.scale === 1));
});

test("倍率は上昇量を割る形で、しきい値判定に反映される", () => {
  const engine = makeEngine({ enabled: true });
  for (let k = 0; k < RUN; k++) quietTick(engine, k);
  const scale = stat(engine, NOISY_ID).scale;
  assert.ok(scale > 1, "前提: この観測点の倍率が1より大きいこと");
  const point = engine.points.get(NOISY_ID);
  const before = point.latestIntensity;
  const values = new Map<number, number>();
  for (const s of stations) values.set(s.id, s.id === NOISY_ID ? before + 0.6 : -3.0);
  engine.processTick(values, T0 + 1_000_000);
  assert.ok(Math.abs(point.intensityDiff - 0.6 / scale) < 1e-9, `intensityDiff=${point.intensityDiff}`);
});

test("データ源の切り替え(resetForSourceChange)で、ノイズ統計が破棄される", () => {
  const engine = makeEngine({ enabled: true });
  for (let k = 0; k < RUN; k++) quietTick(engine, k);
  assert.ok(stat(engine, NOISY_ID).scale > 1, "前提: リセット前は倍率が上がっている");
  engine.resetForSourceChange(T0, 0);
  const s = stat(engine, NOISY_ID);
  assert.equal(s.samples, 0);
  assert.equal(s.scale, 1);
  assert.equal(engine.getStationNoiseStats().median, null);
});

test("stationNoiseの一部の項目だけ渡しても、残りは既定値で補われる", () => {
  const engine = makeEngine({ enabled: true });
  assert.equal(engine.params.stationNoise.maxScale, 2);
  assert.equal(engine.params.stationNoise.warmupSamples, WARMUP);
});
