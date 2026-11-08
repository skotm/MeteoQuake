import { test } from "node:test";
import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { computeShakeTestValues, prepareShakeTest } from "../src/engines/shakeTestSimulation";
import { AnalysisPipeline, type AnalysisTickInput, type AnalysisTickOutput } from "../src/analysis/analysisPipeline";
import { AnalysisRunner, shouldUseAnalysisWorker, type WorkerLike } from "../src/analysis/analysisRunner";
import { attachWorkerHandler, type WorkerPort } from "../src/analysis/workerHandler";
import type { FromWorkerMessage, ToWorkerMessage } from "../src/analysis/analysisProtocol";
import { stationGrid, T0 } from "./helpers";

const stations = stationGrid(38, 142, 9, 0.12); // 361観測点
const per = prepareShakeTest({ lat: 38.0, lon: 142.0, magnitude: 6.3, depth: 20 }, stations);
function valuesAt(sec: number): Map<number, number> {
  const sim = computeShakeTestValues(per, sec * 1000);
  const m = new Map<number, number>();
  for (const s of stations) m.set(s.id, sim.has(s.id) ? sim.get(s.id) : -3);
  return m;
}
function inputAt(k: number): AnalysisTickInput {
  return {
    values: valuesAt(k), now: T0 + k * 1000, sourceMode: "live", replayClock: false,
    shakeDetectionEnabled: true, gridDetectionEnabled: false, epicenterEstimationEnabled: true,
  };
}
function ser(x: unknown): string {
  return JSON.stringify(x, (_k, v) => {
    if (v instanceof Map) return { __map: [...v] };
    if (v instanceof Set) return { __set: [...v] };
    if (typeof v === "number" && !Number.isFinite(v)) return `__${v}`;
    return v;
  });
}
/** Workerモードの結果が返るのを待つ(1tickずつ)。 */
function tickAsync(runner: AnalysisRunner, input: AnalysisTickInput): Promise<AnalysisTickOutput> {
  return new Promise((resolve) => runner.tick(input, resolve));
}

// 実際のスレッド(worker_threads)をWorkerLikeとして使う。
function threadWorker(): WorkerLike {
  const worker = new Worker(new URL("../tools/analysisNodeWorker.mts", import.meta.url));
  const like: WorkerLike = {
    postMessage: (m) => worker.postMessage(m),
    onmessage: null,
    onerror: null,
    terminate: () => { void worker.terminate(); },
  };
  worker.on("message", (data: FromWorkerMessage) => like.onmessage?.({ data }));
  worker.on("error", (e) => like.onerror?.(e));
  return like;
}

// 注意: イベントIDの連番はモジュール全体で共有される(shakeDetection.ts)ため、IDを比べるこのテストはファイルの最初に置く。
test("Workerモード: 結果は非同期で届き、メインスレッドで直接処理した結果と全tick一致する", async () => {
  let created = 0;
  const runner = new AnalysisRunner({ useWorker: true, createWorker: () => { created++; return threadWorker(); } });
  const direct = new AnalysisPipeline();
  assert.equal(created, 0, "コンストラクタ(描画中)ではWorkerを作らない");
  assert.equal(runner.getMode(), "worker");
  runner.setStations(stations, false);
  direct.setStations(stations, false);
  assert.equal(created, 1, "最初に使われた時にWorkerを作る");

  let sawEstimates = false;
  try {
    for (let k = 0; k < 20; k++) {
      let syncCalled = false;
      const resultPromise = new Promise<AnalysisTickOutput>((resolve) => runner.tick(inputAt(k), (o) => { syncCalled = true; resolve(o); }));
      assert.equal(syncCalled, false, "Workerモードでは、onResultがtick()の中で呼ばれない");
      const viaWorker = await resultPromise;
      assert.equal(ser(viaWorker), ser(direct.tick(inputAt(k))), `tick ${k}`);
      if (viaWorker.estimates?.size) sawEstimates = true;
    }
  } finally {
    // 後始末(テスト用): Workerを終了する
    (runner as unknown as { client: { terminate(): void } }).client.terminate();
  }
  assert.ok(sawEstimates, "前提: 推定が実際に動いていること");
  assert.equal(created, 1);
});

test("同期モード: onResultはtick()の中で、その場で呼ばれ、Workerは作られない", () => {
  let created = 0;
  const runner = new AnalysisRunner({ useWorker: false, createWorker: () => { created++; return threadWorker(); } });
  assert.equal(runner.getMode(), "sync");
  runner.setStations(stations, false);
  let called = 0;
  runner.tick(inputAt(0), () => { called++; });
  assert.equal(called, 1);
  assert.equal(created, 0);
});

test("Workerの生成に失敗したら、同期モードへ切り替わり、設定を引き継いで動く", async () => {
  const reasons: string[] = [];
  const runner = new AnalysisRunner({
    useWorker: true,
    createWorker: () => { throw new Error("no worker here"); },
    onFallback: (r) => reasons.push(r),
  });
  runner.setStations(stations, false);   // ここでWorker生成に失敗 → 同期モードで、観測点が設定される
  assert.equal(runner.getMode(), "sync");
  assert.equal(reasons.length, 1);
  assert.match(reasons[0], /no worker here/);
  let sawEvents = false;
  for (let k = 0; k < 14; k++) runner.tick(inputAt(k), (o) => { if (o.shakeEvents.length) sawEvents = true; });
  assert.ok(sawEvents, "切り替え後の同期モードで、観測点が設定済みで、検知が動く");
});

test("Workerがエラーを起こしたら、同期モードへ切り替わり、観測点・微弱検知の設定が引き継がれる", async () => {
  // 作った直後にエラーを起こすWorker(スクリプトの読み込み失敗を想定)
  let fake!: WorkerLike;
  const reasons: string[] = [];
  const runner = new AnalysisRunner({
    useWorker: true,
    createWorker: () => { fake = { postMessage: () => {}, onmessage: null, onerror: null, terminate: () => {} }; return fake; },
    onFallback: (r) => reasons.push(r),
  });
  runner.setStations(stations, true);
  runner.setWeakArrayEnabled(false);
  assert.equal(runner.getMode(), "worker");
  fake.onerror?.({ message: "script load failed" });
  assert.equal(runner.getMode(), "sync");
  assert.match(reasons[0], /script load failed/);
  let sawEvents = false;
  for (let k = 0; k < 14; k++) runner.tick(inputAt(k), (o) => { if (o.shakeEvents.length) sawEvents = true; });
  assert.ok(sawEvents);
});

test("Worker内のtickの例外はonErrorに渡され、Workerモードのまま次のtickが処理される", async () => {
  // 同じプロセス内の、構造化複製つきの代用Worker(解析のメッセージ処理は本物)
  let toWorker: WorkerPort["onmessage"] = null;
  const like: WorkerLike = { postMessage: (m: ToWorkerMessage) => { const c = structuredClone(m); setImmediate(() => toWorker?.({ data: c })); }, onmessage: null, onerror: null, terminate: () => {} };
  const port: WorkerPort = {
    postMessage: (m) => { const c = structuredClone(m); setImmediate(() => like.onmessage?.({ data: c })); },
    get onmessage() { return toWorker; },
    set onmessage(fn) { toWorker = fn; },
  };
  const pipeline = attachWorkerHandler(port);
  const errors: Error[] = [];
  const runner = new AnalysisRunner({ useWorker: true, createWorker: () => like, onError: (e) => errors.push(e) });
  runner.setStations(stations, false);
  const real = pipeline.tick.bind(pipeline);
  let failNext = true;
  pipeline.tick = (...args: Parameters<typeof real>) => { if (failNext) { failNext = false; throw new Error("tick failed"); } return real(...args); };

  runner.tick(inputAt(0), () => assert.fail("失敗したtickのonResultは呼ばれない"));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /tick failed/);
  assert.equal(runner.getMode(), "worker");
  const ok = await tickAsync(runner, inputAt(1));
  assert.ok(ok, "例外の後も、次のtickは処理される");
});

test("shouldUseAnalysisWorker: Workerが無い環境ではfalse。URL > localStorage > 既定値の順で決まる", () => {
  const g = globalThis as Record<string, unknown>;
  const saved = { Worker: g.Worker, location: g.location, localStorage: g.localStorage };
  try {
    delete g.Worker;
    assert.equal(shouldUseAnalysisWorker(), false, "Workerが無い");
    g.Worker = class {};
    delete g.location; delete g.localStorage;
    assert.equal(shouldUseAnalysisWorker(), false, "既定値はfalse(ブラウザで確認できるまで)");
    g.localStorage = { getItem: (k: string) => (k === "meteoquake.analysisWorker" ? "1" : null) };
    assert.equal(shouldUseAnalysisWorker(), true, "localStorageで有効化");
    g.location = { search: "?analysisWorker=0" };
    assert.equal(shouldUseAnalysisWorker(), false, "URLが優先");
    g.location = { search: "?x=1&analysisWorker=1" };
    g.localStorage = { getItem: () => "0" };
    assert.equal(shouldUseAnalysisWorker(), true, "URLが優先(localStorageが0でも)");
    g.localStorage = { getItem: () => { throw new Error("blocked"); } };
    g.location = { search: "" };
    assert.equal(shouldUseAnalysisWorker(), false, "localStorageが使えなくても例外にならない");
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete g[k]; else g[k] = v; }
  }
});
