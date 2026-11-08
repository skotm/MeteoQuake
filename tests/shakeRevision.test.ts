import { test } from "node:test";
import assert from "node:assert/strict";
import { ShakeDetectionEngine } from "../src/engines/shakeDetection";
import { computeShakeTestValues, prepareShakeTest } from "../src/engines/shakeTestSimulation";
import { stationGrid, T0 } from "./helpers";

// 検知エンジンのREVISION_INTENSITY_STEP(震度の反映幅)。
const INTENSITY_STEP = 0.2;

interface Snapshot { revision: number; pointCount: number; intensities: Map<number, number | null> }

// 模擬地震を流し、毎tickの最大イベントのスナップショットを返す。
function runSimulation(ticks: number): Snapshot[] {
  const stations = stationGrid(38, 142, 7, 0.12);
  const engine = new ShakeDetectionEngine();
  engine.initialize(stations);
  const per = prepareShakeTest({ lat: 38.0, lon: 142.0, magnitude: 6.5, depth: 20 }, stations);
  const out: Snapshot[] = [];
  for (let k = 0; k <= ticks; k++) {
    const events = engine.processTick(computeShakeTestValues(per, k * 1000), T0 + k * 1000);
    if (!events.length) continue;
    const main = events.reduce((a, b) => (b.pointCount > a.pointCount ? b : a));
    out.push({
      revision: main.revision,
      pointCount: main.pointCount,
      intensities: new Map(main.detections.map((d: { id: number; intensity: number | null }) => [d.id, d.intensity])),
    });
  }
  return out;
}

const snaps = runSimulation(40);

test("前提: 模擬地震でイベントが検知される", () => {
  assert.ok(snaps.length > 10, `イベントのあるtick数: ${snaps.length}`);
  assert.ok(snaps[snaps.length - 1].pointCount >= 20);
});

test("revisionは数値で、減らない", () => {
  for (let i = 0; i < snaps.length; i++) {
    assert.equal(typeof snaps[i].revision, "number");
    if (i > 0) assert.ok(snaps[i].revision >= snaps[i - 1].revision, `tick${i}でrevisionが減った`);
  }
});

test("観測点が増えたtickでは、revisionも増える", () => {
  for (let i = 1; i < snaps.length; i++) {
    if (snaps[i].pointCount > snaps[i - 1].pointCount) assert.ok(snaps[i].revision > snaps[i - 1].revision);
  }
});

test("観測点数が変わらなくても、震度が上がればrevisionが増える(キャッシュ停滞の再現条件)", () => {
  const found = snaps.some((s, i) => i > 0 && s.pointCount === snaps[i - 1].pointCount && s.revision > snaps[i - 1].revision);
  assert.ok(found, "観測点数が同じtickで、revisionだけ増えた場面があること");
});

test("revisionが変わらないtickでは、どの観測点の震度も反映済みの値から幅INTENSITY_STEP以上は上がっていない", () => {
  let base = snaps[0];
  for (let i = 1; i < snaps.length; i++) {
    const s = snaps[i];
    if (s.revision !== snaps[i - 1].revision) { base = s; continue; }
    for (const [id, v] of s.intensities) {
      const b = base.intensities.get(id);
      if (v == null || b == null) continue;
      assert.ok(v - b < INTENSITY_STEP + 1e-9, `観測点${id}: ${b} → ${v}(revision未更新のまま上昇)`);
    }
  }
});

test("震度が変わっていないtickでは、revisionは増えない(再計算の無駄打ちがない)", () => {
  for (let i = 1; i < snaps.length; i++) {
    const a = snaps[i - 1], b = snaps[i];
    if (b.revision === a.revision) continue;
    const changed = b.pointCount !== a.pointCount
      || [...b.intensities].some(([id, v]) => (a.intensities.get(id) ?? null) !== v);
    assert.ok(changed, `tick${i}: 入力が変わっていないのにrevisionが増えた`);
  }
});
