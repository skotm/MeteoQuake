import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ShakeDetectionEngine } from "../src/engines/shakeDetection";
import { buildGridIndex, type GeoPoint } from "../src/engines/spatialIndex";
import { haversineKm } from "./helpers";

function rng(seed: number) { let s = seed; return () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; }; }

// 総当たりの基準: 半径内の添字(昇順)
function bruteWithin(points: GeoPoint[], lat: number, lon: number, radiusKm: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < points.length; i++) if (!(haversineKm(lat, lon, points[i].lat, points[i].lon) > radiusKm)) out.push(i);
  return out;
}
// インデックスの候補を、実際の距離で絞り込んだもの
function viaIndex(points: GeoPoint[], idx: ReturnType<typeof buildGridIndex>, lat: number, lon: number, radiusKm: number): number[] {
  return idx.query(lat, lon, radiusKm).filter((i) => !(haversineKm(lat, lon, points[i].lat, points[i].lon) > radiusKm));
}

// 実際に使われている観測点マスタ(リポジトリ内のpublic/map)
const master: GeoPoint[] = JSON.parse(readFileSync(new URL("../public/map/stations_with_amp_revised.json", import.meta.url), "utf8"))
  .map((s: { lat: string | number; lon: string | number }) => ({ lat: +s.lat, lon: +s.lon }));

test("格子インデックス+距離での絞り込みは、総当たりと完全に同じ集合・同じ順序になる(実際の観測点マスタ)", () => {
  assert.ok(master.length > 1000);
  for (const [cellKm, radiusKm] of [[25, 25], [25, 100], [30, 30], [10, 80], [50, 5]] as const) {
    const idx = buildGridIndex(master, cellKm);
    for (let i = 0; i < master.length; i += 7) {
      const { lat, lon } = master[i];
      assert.deepEqual(viaIndex(master, idx, lat, lon, radiusKm), bruteWithin(master, lat, lon, radiusKm), `cell${cellKm} R${radiusKm} #${i}`);
    }
  }
});

test("検索点が観測点と一致しない任意の位置(日本周辺の乱数)でも、総当たりと一致する", () => {
  const idx = buildGridIndex(master, 25);
  const r = rng(3);
  for (let i = 0; i < 400; i++) {
    const lat = 20 + r() * 30, lon = 120 + r() * 35, radius = r() * 150;
    assert.deepEqual(viaIndex(master, idx, lat, lon, radius), bruteWithin(master, lat, lon, radius));
  }
});

test("格子で安全に扱えない場合(極・日付変更線・不正な座標)でも、総当たりと一致する", () => {
  const r = rng(4);
  const pts: GeoPoint[] = [];
  for (let i = 0; i < 300; i++) pts.push({ lat: (r() - 0.5) * 178, lon: (r() - 0.5) * 360 });
  pts.push({ lat: NaN, lon: 10 }, { lat: 10, lon: Infinity });   // 不正な座標: 総当たりでは距離NaN=除外されない
  const idx = buildGridIndex(pts, 25);
  for (let i = 0; i < 300; i++) {
    const lat = (r() - 0.5) * 178, lon = (r() - 0.5) * 360, radius = r() * 3000;
    assert.deepEqual(viaIndex(pts, idx, lat, lon, radius), bruteWithin(pts, lat, lon, radius), `#${i} (${lat},${lon}) R${radius}`);
  }
  for (const [lat, lon] of [[89, 0], [-89.5, 100], [10, 179.9], [10, -179.9], [0, 180]] as const) {
    assert.deepEqual(viaIndex(pts, idx, lat, lon, 500), bruteWithin(pts, lat, lon, 500), `edge (${lat},${lon})`);
  }
});

// 基準: ShakeDetectionEngine.initializeの、近傍探索の元の実装(総当たり)をそのまま写したもの。
// 距離の式も、エンジン内のhaversineKm(shakeDetection.ts)と同じ書き方にする(式の書き方が違うと、最後の桁がずれる)。
function engineHaversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
function referenceNeighbors(stations: { id: number; lat: number; lon: number }[], neighborRadiusKm: number, maxNeighbors: number, sparseMin: number, sparseRadiusKm: number, sparseEnabled: boolean) {
  const out = new Map<number, { nearPoints: { id: number; distanceKm: number }[]; extPoints: { id: number; distanceKm: number }[] }>();
  for (const s of stations) {
    const candidates = [];
    for (const other of stations) {
      if (other.id === s.id) continue;
      const dist = engineHaversineKm(s.lat, s.lon, other.lat, other.lon);
      if (dist > neighborRadiusKm) continue;
      candidates.push({ id: other.id, distanceKm: dist });
    }
    candidates.sort((a, b) => a.distanceKm - b.distanceKm);
    const nearPoints = candidates.slice(0, maxNeighbors);
    let extPoints: { id: number; distanceKm: number }[] = [];
    if (sparseEnabled && nearPoints.length < sparseMin) {
      const ext = [];
      for (const other of stations) {
        if (other.id === s.id) continue;
        const dist = engineHaversineKm(s.lat, s.lon, other.lat, other.lon);
        if (dist > sparseRadiusKm) continue;
        ext.push({ id: other.id, distanceKm: dist });
      }
      ext.sort((a, b) => a.distanceKm - b.distanceKm);
      extPoints = ext.slice(0, maxNeighbors);
    }
    out.set(s.id, { nearPoints, extPoints });
  }
  return out;
}

test("ShakeDetectionEngine.initializeの近傍リスト(近傍・疎な観測点の拡張近傍)が、元の総当たりの実装と完全に一致する", () => {
  // 実際のマスタに、わざと同じ座標の観測点(距離が同じ=並び順が結果に影響する)も混ぜる
  const stations = master.slice(0, 1500).map((p, i) => ({ id: i + 1, lat: p.lat, lon: p.lon }));
  for (let i = 0; i < 40; i++) stations.push({ id: 2000 + i, lat: stations[i * 3].lat, lon: stations[i * 3].lon });
  const engine = new ShakeDetectionEngine();
  engine.initialize(stations);
  const p = engine.params;
  const expected = referenceNeighbors(stations, p.neighborRadiusKm, p.maxNeighbors, p.sparseNeighborMin, p.sparseNeighborRadiusKm, p.sparseNeighborEnabled);
  let withExt = 0;
  for (const s of stations) {
    const point = engine.points.get(s.id);
    const e = expected.get(s.id)!;
    assert.deepEqual(point.nearPoints, e.nearPoints, `nearPoints #${s.id}`);
    assert.deepEqual(point.extPoints, e.extPoints, `extPoints #${s.id}`);
    if (e.extPoints.length) withExt++;
  }
  assert.ok(withExt > 0, "前提: 疎な観測点の拡張近傍が実際に使われていること");
});
