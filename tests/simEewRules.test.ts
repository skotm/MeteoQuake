import { test } from "node:test";
import assert from "node:assert/strict";
import { EEW_RULES, buildForecast, endMinElapsedMs, evaluateReport, publishedDepthKm, publishedMagnitude } from "../src/app/simEewRules.js";

// 報の評価に渡す最新の解析結果を作るヘルパー。areas: [地域名, 予測計測震度]。
type Raw = { lat: number; lon: number; depthKm: number; magnitude: number };
const BASE: Raw = { lat: 35.0, lon: 139.0, depthKm: 20, magnitude: 5.0 };
function latest(over: Partial<Raw> = {}, areas: [string, number][] = [["A", 3.6]], extra: { stationCount?: number; inland?: boolean } = {}) {
  return {
    raw: { ...BASE, ...over },
    stationCount: extra.stationCount ?? 5,
    inland: extra.inland ?? true,
    forecast: buildForecast({ areaValues: new Map(areas) }, new Map()),
  };
}
const first = (over: Partial<Raw> = {}, areas?: [string, number][], extra?: { stationCount?: number; inland?: boolean }) =>
  evaluateReport(null, latest(over, areas, extra))!;
const next = (prev: any, over: Partial<Raw> = {}, areas?: [string, number][], extra?: { stationCount?: number; inland?: boolean }) =>
  evaluateReport(prev, latest(over, areas, extra));

test("発表値: Mは0.1刻み、深さは10km刻み(最小10km)", () => {
  assert.equal(publishedMagnitude(4.04), 4.0);
  assert.equal(publishedMagnitude(4.06), 4.1);
  assert.equal(publishedDepthKm(4), 10);
  assert.equal(publishedDepthKm(14), 10);
  assert.equal(publishedDepthKm(15), 20);
  assert.equal(publishedDepthKm(31), 30);
});

test("発表条件(予報): M3.5未満かつ最大予測震度3未満は出さない。M3.5以上、または最大予測震度3以上なら出す", () => {
  assert.equal(evaluateReport(null, latest({ magnitude: 3.0 }, [["A", 1.0]])), null);
  assert.deepEqual(first({ magnitude: 3.5 }, [["A", 1.0]]).reasons, ["発表"]);
  assert.deepEqual(first({ magnitude: 3.0 }, [["A", 2.5]]).reasons, ["発表"]);
  assert.equal(evaluateReport(null, latest({ magnitude: 3.0 }, [["A", 2.4]])), null);
});

test("発表条件(警報): 2観測点以上かつ最大予測震度5弱以上が必要。1観測点では予報のまま", () => {
  const one = first({}, [["A", 5.0]], { stationCount: 1 });
  assert.equal(one.state.warn, false);
  assert.deepEqual(one.reasons, ["発表"]);
  const two = first({}, [["A", 5.0]], { stationCount: 2 });
  assert.equal(two.state.warn, true);
  assert.deepEqual(two.reasons, ["発表", "警報の発表"]);
  // 後から2観測点になった時に、警報の発表として更新する
  const upgraded = next(one.state, {}, [["A", 5.0]], { stationCount: 2 })!;
  assert.ok(upgraded.reasons.includes("警報の発表"));
  assert.equal(upgraded.display.isWarnLevel, true);
});

test("更新(M): 内部値が±0.05以上変われば更新。0.05未満は更新しない(境界を含む)。上昇・低下とも", () => {
  const f = first();
  assert.equal(next(f.state, { magnitude: 5.04 }), null);
  assert.ok(next(f.state, { magnitude: 5.05 })!.reasons.includes("マグニチュードの変化"));
  assert.ok(next(f.state, { magnitude: 4.95 })!.reasons.includes("マグニチュードの変化"));
  assert.ok(next(f.state, { magnitude: 6.0 })!.reasons.includes("マグニチュードの変化"));
});

test("更新(M): 前回の「報」の内部値と比べる。小さな変化が積み重なっても、基準は前回の報", () => {
  const f = first();
  assert.equal(next(f.state, { magnitude: 5.03 }), null);
  assert.equal(next(f.state, { magnitude: 5.04 }), null); // 直前の解析との差は小さいが、前回の報からの差で判定
  assert.ok(next(f.state, { magnitude: 5.06 }) !== null);
});

test("更新(深さ): 内部値が±5km以上変われば更新。5km未満は更新しない。深くなる・浅くなるとも", () => {
  const f = first();
  assert.equal(next(f.state, { depthKm: 24.9 }), null);
  assert.ok(next(f.state, { depthKm: 25 })!.reasons.includes("震源の深さの変化"));
  assert.ok(next(f.state, { depthKm: 15 })!.reasons.includes("震源の深さの変化"));
});

test("更新(位置): 緯度・経度を独立に判定。内陸は0.2度以上、海域は0.4度以上", () => {
  const f = first();
  assert.equal(next(f.state, { lat: 35.19 }, undefined, { inland: true }), null);
  assert.ok(next(f.state, { lat: 35.2 }, undefined, { inland: true })!.reasons.includes("震源位置の変化"));
  assert.ok(next(f.state, { lon: 138.8 }, undefined, { inland: true })!.reasons.includes("震源位置の変化"));
  assert.equal(next(f.state, { lat: 35.3, lon: 139.3 }, undefined, { inland: false }), null);
  assert.ok(next(f.state, { lat: 35.4 }, undefined, { inland: false })!.reasons.includes("震源位置の変化"));
});

test("更新(最大予測震度): +0.5以上の上昇、または-1.0以上の低下(警報でない場合)", () => {
  const f = first({}, [["A", 3.6]]);
  assert.equal(next(f.state, {}, [["A", 4.0]]), null);
  const up = next(f.state, {}, [["A", 4.1]])!;
  assert.ok(up.reasons.includes("最大予測震度の上昇"));
  assert.ok(!next(f.state, {}, [["A", 2.7]])!.reasons.includes("最大予測震度の低下")); // -0.9は低下の条件に届かない(Aが震度4未満になる予報区の変化では更新される)
  assert.ok(next(f.state, {}, [["A", 2.6]])!.reasons.includes("最大予測震度の低下")); // -1.0
});

test("更新(予報区): 新たに震度4以上になった地域の追加、震度4以上の地域の階級変化、震度4未満への低下で更新", () => {
  const f = first({}, [["A", 3.6]]);
  assert.ok(next(f.state, {}, [["A", 3.6], ["B", 3.6]])!.reasons.includes("新しい予報区の追加"));
  assert.equal(next(f.state, {}, [["A", 3.6], ["B", 3.4]]), null); // Bは震度4未満なので対象外
  assert.ok(next(f.state, {}, [["A", 4.6]])!.reasons.includes("予報区ごとの予測値の変化")); // 震度4→5弱
  assert.equal(next(f.state, {}, [["A", 3.9]]), null); // 同じ階級(震度4)の中の変化は更新しない
  assert.ok(next(f.state, {}, [["A", 3.4]])!.reasons.includes("予報区ごとの予測値の変化")); // 震度4未満になった
});

test("警報の続報: 新たに震度5弱以上になった地域があった時だけ。警報地域の震度が上がるだけでは警報の続報にならない", () => {
  const f = first({}, [["A", 4.6]], { stationCount: 3 });
  assert.equal(f.state.warn, true);
  const addNew = next(f.state, {}, [["A", 4.6], ["B", 4.7]], { stationCount: 3 })!;
  assert.ok(addNew.reasons.includes("警報対象地域の追加"));
  const risesOnly = next(f.state, {}, [["A", 5.2]], { stationCount: 3 })!; // 5弱→5強: 予報区の変化では更新されるが警報の続報ではない
  assert.ok(!risesOnly.reasons.includes("警報対象地域の追加"));
  assert.ok(risesOnly.reasons.includes("予報区ごとの予測値の変化"));
});

test("警報地域は取り消さない: 予測震度が下がっても警報地域は残り、保持した最大値で表示される", () => {
  const f = first({}, [["A", 5.2]], { stationCount: 3 });
  const lower = next(f.state, {}, [["A", 3.0]], { stationCount: 3 });
  // 予測が下がっても、警報地域Aの保持値(5.2)のままなので、予報区の変化や最大震度の低下にならず更新されない
  assert.equal(lower, null);
  const withB = next(f.state, {}, [["A", 3.0], ["B", 3.7]], { stationCount: 3 })!;
  const a = withB.display.areas.find((x: any) => x.name === "A");
  assert.equal(a.maxIntensityKey, "5+");
  assert.equal(withB.display.isWarnLevel, true);
});

test("複数条件が同時に成立しても、報は1つ。更新理由は全て記録する", () => {
  const f = first();
  const r = next(f.state, { magnitude: 5.2, depthKm: 30 }, [["A", 3.6], ["B", 3.7]])!;
  assert.ok(r.reasons.includes("マグニチュードの変化"));
  assert.ok(r.reasons.includes("震源の深さの変化"));
  assert.ok(r.reasons.includes("新しい予報区の追加"));
  assert.ok(r.reasons.includes("複数条件の同時成立"));
});

test("同じ解析結果を重複して受け取っても、報は出さない(状態が更新されていれば変化なし)", () => {
  const f = first();
  const again = next(f.state, {}, [["A", 3.6]]);
  assert.equal(again, null);
  const m = next(f.state, { magnitude: 5.2 })!;
  assert.equal(next(m.state, { magnitude: 5.2 }), null);
});

test("発表値と内部値: 内部値が±0.05以上動いて発表値が同じでも更新する。報には発表値が載る", () => {
  const f = first({ magnitude: 4.04 });
  assert.equal(f.state.pub.magnitude, 4.0);
  const m = next(f.state, { magnitude: 4.09 })!;
  assert.ok(m.reasons.includes("マグニチュードの変化"));
  assert.equal(m.state.pub.magnitude, 4.1);
});

test("終了条件の定数: 検知から600秒。揺れが収まった場合の最低経過時間はMが大きいほど長い(仮置き)", () => {
  assert.equal(EEW_RULES.END_MAX_MS, 600000);
  assert.ok(endMinElapsedMs(7) > endMinElapsedMs(4));
  assert.ok(endMinElapsedMs(9) <= 120000);
});
