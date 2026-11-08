// リプレイ(.bin)を、アプリと同じ手順で検知エンジン→震源推定へ流し、実際の震源と比べる評価ツール。
//
// 使い方:
//   npx tsx tools/replay-eval.mts --replay <リプレイ.bin> --stations <観測点.json> \
//     --truth "40.9667,142.2867,54,7.5,2025-12-08T23:15:10.1+09:00" [--noise] [--max-frames 120]
//
//   --stations  {"stations":[{"id":1,"lat":..,"lon":..}, ...]} 形式のJSON(アプリが使う観測点データ)
//   --truth     緯度,経度,深さkm,マグニチュード,発震時刻(ISO 8601)
//   --noise     観測点別ノイズ補正(stationNoise.enabled)を有効にして流す(--workerとは併用不可)
//   --worker    解析を別スレッド(worker_threads。ブラウザのWeb Workerと同じ処理)で実行して流す。
//               メインスレッドの停止時間(重い処理がUIを止める時間の目安)を、通常実行と比べられる
//   --json      毎tickの結果を、このパスへJSONで書き出す(複数の版を比べる時に使う)
//
// 版を比べたい時は、ソースを入れ替えて(git stashなど)同じ引数でもう一度実行し、--jsonの出力を比べる。
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { Worker } from "node:worker_threads";
import { AnalysisPipeline, type AnalysisTickInput } from "../src/analysis/analysisPipeline";
import { AnalysisClient } from "../src/analysis/analysisClient";
import { setJmaTravelTimeTable, tableFromJSON } from "../src/engines/jmaTravelTime";

const args = process.argv.slice(2);
const arg = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const replayPath = arg("replay"), stationsPath = arg("stations"), truthArg = arg("truth");
if (!replayPath || !stationsPath || !truthArg) {
  console.error("使い方: npx tsx tools/replay-eval.mts --replay <.bin> --stations <.json> --truth \"緯度,経度,深さ,M,発震時刻ISO\" [--noise] [--max-frames N] [--json 出力.json]");
  process.exit(1);
}
const [tLat, tLon, tDepth, tMag, tTime] = truthArg.split(",");
const TRUTH = { lat: +tLat, lon: +tLon, depth: +tDepth, mag: +tMag, originMs: Date.parse(tTime) };
if ([TRUTH.lat, TRUTH.lon, TRUTH.depth, TRUTH.mag, TRUTH.originMs].some(Number.isNaN)) { console.error("--truth の形式が不正です"); process.exit(1); }
const maxFrames = +(arg("max-frames") ?? Infinity);

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const travelTableJson = JSON.parse(readFileSync(`${root}/public/jma-travel-time.json`, "utf8"));
setJmaTravelTimeTable(tableFromJSON(travelTableJson));
const stations = JSON.parse(readFileSync(stationsPath, "utf8")).stations;

const haversineKm = (a: number, b: number, c: number, d: number) => {
  const r = Math.PI / 180;
  const x = Math.sin(((c - a) * r) / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin(((d - b) * r) / 2) ** 2;
  return 2 * 6371 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
};

// リプレイ形式(realtimeProtocolClient.tsと同じ): [type(1) unixSec(u32) count(u16)] + count x [id(u16) intensity*100(i16)]
const buf = readFileSync(replayPath);
const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
const frames: { t: number; es: [number, number | null][] }[] = [];
for (let o = 0; o < buf.length;) {
  const t = dv.getUint32(o + 1, true) * 1000, n = dv.getUint16(o + 5, true);
  const es: [number, number | null][] = [];
  for (let i = 0; i < n; i++) { const v = dv.getInt16(o + 9 + 4 * i, true); es.push([dv.getUint16(o + 7 + 4 * i, true), v === -32768 ? null : v / 100]); }
  frames.push({ t, es }); o += 7 + 4 * n;
}

const useWorker = args.includes("--worker");
if (useWorker && args.includes("--noise")) { console.error("--worker と --noise は併用できません"); process.exit(1); }
const pipeline = useWorker ? null : new AnalysisPipeline(args.includes("--noise") ? { shakeParams: { stationNoise: { enabled: true } } } : {});
let worker: Worker | null = null;
let client: AnalysisClient | null = null;
if (useWorker) {
  worker = new Worker(new URL("./analysisNodeWorker.mts", import.meta.url));
  client = new AnalysisClient({
    postMessage: (m) => worker!.postMessage(m),
    onmessage: null,
  });
  const transport = (client as unknown as { transport: { onmessage: ((e: { data: unknown }) => void) | null } }).transport;
  worker.on("message", (data) => transport.onmessage?.({ data }));
  client.setTravelTable(travelTableJson);
  client.setStations(stations, false);
} else {
  pipeline!.setStations(stations, false);
}
const cur = new Map<number, number>();
const log: unknown[] = [];
const rows: string[] = [];
const tickMs: number[] = []; // メインスレッドが止まる時間(通常=解析のtick全体 / --worker=メッセージを送るまでの同期処理)
let estMs = 0, firstEstimate: number | null = null, firstConfirmed: number | null = null;
const n = Math.min(frames.length, maxFrames);
for (let k = 0; k < n; k++) {
  const f = frames[k];
  for (const [id, v] of f.es) { if (v === null) cur.delete(id); else cur.set(id, v); }
  const input: AnalysisTickInput = {
    values: new Map(cur), now: f.t, sourceMode: "replay", replayClock: true, // アプリと同じく、1フレーム=1tick、時刻はデータ時刻
    shakeDetectionEnabled: true, gridDetectionEnabled: false, epicenterEstimationEnabled: true,
  };
  const t0 = performance.now();
  let out;
  if (client) {
    const pending = client.tick(input);
    tickMs.push(performance.now() - t0);
    out = await pending;
  } else {
    out = pipeline!.tick(input);
    tickMs.push(performance.now() - t0);
  }
  estMs += performance.now() - t0;
  const events = out?.shakeEvents ?? [];
  const estimates = out?.estimates ?? new Map();
  const main = events.length ? events.reduce((a: { pointCount: number }, b: { pointCount: number }) => (b.pointCount > a.pointCount ? b : a)) : null;
  const r = main ? estimates.get(main.id) : null;
  const sec = Math.round((f.t - TRUTH.originMs) / 1000);
  log.push({ k, sec, events: events.length, points: main?.pointCount ?? 0, estimate: r ?? null });
  if (r && firstEstimate == null) firstEstimate = sec;
  if (r?.confirmed && firstConfirmed == null) firstConfirmed = sec;
  if (r && (k < 40 ? k % 5 === 0 : k % 30 === 0 || k === n - 1)) {
    const km = haversineKm(TRUTH.lat, TRUTH.lon, r.lat, r.lon);
    rows.push(`  発震後${String(sec).padStart(4)}秒  点数${String(main.pointCount).padStart(4)}  震央誤差${km.toFixed(0).padStart(4)}km  深さ${String(r.depthKm).padStart(3)}km(${r.depthKm - TRUTH.depth >= 0 ? "+" : ""}${(r.depthKm - TRUTH.depth).toFixed(0)})  M${r.magnitude?.toFixed(1)}(${r.magnitude - TRUTH.mag >= 0 ? "+" : ""}${(r.magnitude - TRUTH.mag).toFixed(1)})  信頼度${r.confidence}${r.confirmed ? " 確定" : ""}${r.globalPass ? " [Global]" : ""}${r.widePass ? " [広域]" : ""}`);
  }
}
console.log(`リプレイ: ${n}フレーム / 観測点${stations.length} / 真値 (${TRUTH.lat.toFixed(3)}, ${TRUTH.lon.toFixed(3)}) 深さ${TRUTH.depth}km M${TRUTH.mag}${args.includes("--noise") ? " / ノイズ補正ON" : ""}`);
const sorted = [...tickMs].sort((a, b) => a - b);
const pct = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
console.log(`最初の推定: 発震後${firstEstimate}秒 / 確定: 発震後${firstConfirmed}秒 / 解析の処理時間 合計${(estMs / 1000).toFixed(1)}秒`);
console.log(`メインスレッドの停止時間(1tickあたり, ${useWorker ? "Workerへ送るまで" : "解析をその場で実行"}): 中央値${pct(0.5).toFixed(1)}ms / 95%${pct(0.95).toFixed(1)}ms / 最大${sorted[sorted.length - 1].toFixed(1)}ms`);
console.log(rows.join("\n"));
const jsonPath = arg("json"); if (jsonPath) writeFileSync(jsonPath, JSON.stringify(log));
client?.terminate();
void worker?.terminate();
