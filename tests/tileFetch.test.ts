import test from "node:test";
import assert from "node:assert/strict";
// @ts-ignore
import * as TF from "../src/app/weather/tileFetch.js";

const realFetch = globalThis.fetch;
const blobOf = () => new Blob(["x"]);
function mock(fn: (url: string) => any) { globalThis.fetch = (async (u: any) => fn(String(u))) as any; }
test.afterEach(() => { globalThis.fetch = realFetch; TF.retryAllTiles(); });

test("通信失敗は再試行して成功する", async () => {
  let n = 0;
  mock(() => { n++; if (n < 3) throw new TypeError("net"); return { ok: true, blob: async () => blobOf() }; });
  const b = await TF.fetchTileBlob("https://x/retry.png");
  assert.ok(b);
  assert.equal(n, 3);
});

test("404は1回再確認し、短期だけ記憶(永久除外しない)", async () => {
  let n = 0;
  mock(() => { n++; return { ok: false, status: 404 }; });
  assert.equal(await TF.fetchTileBlob("https://x/404.png"), null);
  assert.equal(n, 2);
  assert.equal(await TF.fetchTileBlob("https://x/404.png"), null);
  assert.equal(n, 2, "記憶中は再リクエストしない");
  assert.equal(TF.getTileStatus().failed, 0, "404は失敗表示に数えない");
  TF.retryAllTiles(); // 手動再読み込みで記憶が消える
  mock(() => ({ ok: true, blob: async () => blobOf() }));
  assert.ok(await TF.fetchTileBlob("https://x/404.png"));
});

test("5xxが続くと失敗として数えられ、再読み込みで消える", async () => {
  mock(() => ({ ok: false, status: 503 }));
  assert.equal(await TF.fetchTileBlob("https://x/503.png"), null);
  assert.equal(TF.getTileStatus().failed, 1);
  TF.retryAllTiles();
  assert.equal(TF.getTileStatus().failed, 0);
});

test("同時取得数は上限を超えない", async () => {
  let cur = 0, max = 0;
  mock(async () => { cur++; max = Math.max(max, cur); await new Promise(r => setTimeout(r, 20)); cur--; return { ok: true, blob: async () => blobOf() }; });
  await Promise.all(Array.from({ length: 30 }, (_, i) => TF.fetchTileBlob(`https://x/c${i}.png`)));
  assert.ok(max <= TF.MAX_CONCURRENT, `max=${max}`);
  assert.ok(max > 1);
});

test("待機中の要求は中断でき、中断された要求は他を止めない", async () => {
  mock(async () => { await new Promise(r => setTimeout(r, 30)); return { ok: true, blob: async () => blobOf() }; });
  const ctrl = new AbortController();
  const ps = Array.from({ length: 12 }, (_, i) => TF.fetchTileBlob(`https://x/a${i}.png`, i >= 9 ? ctrl.signal : undefined));
  ctrl.abort();
  const rs = await Promise.allSettled(ps);
  assert.ok(rs.some(r => r.status === "rejected" && (r.reason as Error).name === "AbortError"));
  assert.equal(rs.filter(r => r.status === "fulfilled").length >= 8, true);
  assert.equal(TF.getTileStatus().pending, 0);
});

test("範囲外判定は安全側(不明・一部重なりは取得する)", () => {
  const cols = 24, rows = 28;
  const mask = new Uint8Array(cols * rows);
  // z7 セル (110,50) だけデータあり
  mask[(50 - 38) * cols + (110 - 100)] = 1;
  assert.equal(TF.tileOutsideCoverage(mask, 7, 110, 50), false);
  assert.equal(TF.tileOutsideCoverage(mask, 7, 111, 50), true);
  assert.equal(TF.tileOutsideCoverage(mask, 8, 221, 101), false); // 子タイル
  assert.equal(TF.tileOutsideCoverage(mask, 8, 224, 100), true);
  assert.equal(TF.tileOutsideCoverage(mask, 6, 55, 25), false);   // 親(セルを含む)
  assert.equal(TF.tileOutsideCoverage(mask, 4, 0, 0), false);     // グリッド外=不明
  assert.equal(TF.tileOutsideCoverage(null, 7, 111, 50), false);  // マスク無し
});

test("範囲geojsonのURL導出", () => {
  const i = TF.coverageInfoFromTileUrl("https://www.jma.go.jp/bosai/jmatile/data/nowc/20261121125500/none/20261121125500/surf/hrpns/6/56/25.png");
  assert.equal(i.url, "https://www.jma.go.jp/bosai/jmatile/data/nowc/20261121125500/none/20261121125500/surf/hrpns_nd/data.geojson?id=hrpns_nd");
  assert.equal(i.key, "nowc/hrpns");
  const j = TF.coverageInfoFromTileUrl("https://www.jma.go.jp/bosai/jmatile/data/rasrf/20261121125000/immed/20261121125000/surf/rasrf03h/6/56/25.png");
  assert.equal(j.url.endsWith("/surf/rasrf03h_nd/data.geojson?id=rasrf03h_nd"), true);
});

test("buildCoverageMask: 全球の枠は除き、くり抜き部分を『あり』にする", () => {
  const W = 24 * 8, H = 28 * 8;
  const fakeCanvas = () => ({
    getContext: () => ({
      beginPath() {}, moveTo() {}, lineTo() {}, closePath() {}, fill() {}, stroke() {},
      getImageData: () => {
        const d = new Uint8ClampedArray(W * H * 4);
        for (let y = 100; y < 120; y++) for (let x = 80; x < 100; x++) d[(y * W + x) * 4 + 3] = 255;
        return { data: d };
      },
    }),
  });
  const gj = { features: [{ geometry: { type: "Polygon", coordinates: [[[-45,85],[315,85],[315,-85],[-45,-85]], [[140,40],[141,40],[141,41]]] } }] };
  const m = TF.buildCoverageMask(gj, fakeCanvas);
  assert.ok(m && m.some((v: number) => v === 1));
  assert.equal(TF.buildCoverageMask({ features: [{ geometry: { type: "Polygon", coordinates: [[[0,0],[1,0],[1,1]]] } }] }, fakeCanvas), null);
});
