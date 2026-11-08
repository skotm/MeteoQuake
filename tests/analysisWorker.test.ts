import { test } from "node:test";
import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { computeShakeTestValues, prepareShakeTest } from "../src/engines/shakeTestSimulation";
import { AnalysisPipeline, type AnalysisTickInput } from "../src/analysis/analysisPipeline";
import { AnalysisClient, type AnalysisTransport } from "../src/analysis/analysisClient";
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
function inputAt(k: number, values = valuesAt(k)): AnalysisTickInput {
  return {
    values, now: T0 + k * 1000, sourceMode: "live", replayClock: false,
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

// 実際のスレッド(worker_threads)で動かすトランスポート。
function spawnThread(): { transport: AnalysisTransport; worker: Worker } {
  const worker = new Worker(new URL("../tools/analysisNodeWorker.mts", import.meta.url));
  const transport: AnalysisTransport = {
    postMessage: (m) => worker.postMessage(m),
    onmessage: null,
    terminate: () => { void worker.terminate(); },
  };
  worker.on("message", (data: FromWorkerMessage) => transport.onmessage?.({ data }));
  return { transport, worker };
}

// 同じプロセス内で、構造化複製(postMessageと同じ)と非同期の配送だけを挟んだトランスポート。
function inProcess(): { transport: AnalysisTransport; pipeline: AnalysisPipeline; delivered: ToWorkerMessage[] } {
  const delivered: ToWorkerMessage[] = [];
  let toWorker: WorkerPort["onmessage"] = null;
  const workerPort: WorkerPort = {
    postMessage: (m) => { setImmediate(() => transport.onmessage?.({ data: structuredClone(m) })); },
    get onmessage() { return toWorker; },
    set onmessage(fn) { toWorker = fn; },
  };
  const pipeline = attachWorkerHandler(workerPort);
  const transport: AnalysisTransport = {
    postMessage: (m) => { delivered.push(m); const copy = structuredClone(m); setImmediate(() => toWorker?.({ data: copy })); },
    onmessage: null,
  };
  return { transport, pipeline, delivered };
}

// 注意: shakeDetection.tsのイベントIDの連番はモジュール全体で共有されるため、IDを比べるこのテストは、
// このファイルの最初に置く(メインスレッドの解析がまだ動いていない状態で、Worker側と同じ1から始める)。
test("Worker(別スレッド)経由の結果が、メインスレッドで直接処理した結果と、全tickで一致する", async () => {
  const { transport } = spawnThread();
  const client = new AnalysisClient(transport);
  const direct = new AnalysisPipeline();
  client.setStations(stations, false);
  direct.setStations(stations, false);
  let sawEvents = false, sawEstimates = false;
  try {
    for (let k = 0; k < 30; k++) {
      const input = inputAt(k);
      const viaWorker = await client.tick(input);          // 1tickずつ待つ(まとめられない)
      const viaDirect = direct.tick(input);
      assert.ok(viaWorker, `tick ${k}: 結果が返ること`);
      assert.equal(ser(viaWorker), ser(viaDirect), `tick ${k}`);
      if (viaWorker.shakeEvents.length) sawEvents = true;
      if (viaWorker.estimates && viaWorker.estimates.size) sawEstimates = true;
    }
    // 同じMapのままの再呼び出しでも一致する
    const same = valuesAt(30);
    for (let r = 0; r < 2; r++) {
      const input = inputAt(30, same);
      const a = await client.tick(input);
      const b = direct.tick(input);
      assert.equal(ser(a), ser(b), `同じMapの再呼び出し ${r}`);
    }
  } finally {
    client.terminate();
  }
  assert.ok(sawEvents && sawEstimates, "前提: 検知と推定が実際に動いていること");
});

test("Worker処理中に溜まったtickは、1回のメッセージにまとめられ、推定は最後の1回だけ行われる", async () => {
  const { transport, pipeline, delivered } = inProcess();
  const client = new AnalysisClient(transport);
  client.setStations(stations, false);
  let estimateCalls = 0;
  const original = pipeline.estimator.updateAll.bind(pipeline.estimator);
  pipeline.estimator.updateAll = (...args: Parameters<typeof original>) => { estimateCalls++; return original(...args); };

  // 検知イベントが出るところまで、1tickずつ進める
  for (let k = 0; k < 12; k++) await client.tick(inputAt(k));
  const callsBefore = estimateCalls;
  const sentBefore = delivered.filter((m) => m.type === "ticks").length;
  assert.ok(callsBefore > 0, "前提: 推定が実際に動いていること");

  // 処理中に4つ溜める: 1つ目は即送信、残り4つはまとめて次に送られる
  const promises = [12, 13, 14, 15, 16].map((k) => client.tick(inputAt(k)));
  const results = await Promise.all(promises);
  assert.ok(results[0], "先頭(送信済みだったtick)は結果が返る");
  assert.deepEqual(results.slice(1, 4), [null, null, null], "まとめられた途中のtickはnull");
  assert.ok(results[4], "まとめた最後のtickに結果が返る");

  const batches = delivered.filter((m): m is Extract<ToWorkerMessage, { type: "ticks" }> => m.type === "ticks").slice(sentBefore);
  assert.deepEqual(batches.map((b) => b.items.length), [1, 4], "送信は1回目が1tick、2回目が4tick");
  assert.equal(estimateCalls - callsBefore, 2, "推定は、1回目の1tick+2回目の最後の1tickの2回だけ(4tickまとめでも1回)");
  client.terminate();
});

test("同じMapのままの再呼び出しは、Mapを送り直さない", async () => {
  const { transport, delivered } = inProcess();
  const client = new AnalysisClient(transport);
  client.setStations(stations, false);
  const values = valuesAt(5);
  await client.tick(inputAt(5, values));
  await client.tick(inputAt(5, values));
  const ticks = delivered.filter((m) => m.type === "ticks").flatMap((m) => (m as Extract<ToWorkerMessage, { type: "ticks" }>).items);
  assert.equal(ticks.length, 2);
  assert.ok(ticks[0].input.values && !ticks[0].input.sameValues);
  assert.ok(ticks[1].input.sameValues && ticks[1].input.values === undefined);
  client.terminate();
});

test("Worker内で例外が起きたら、そのtickのPromiseがrejectされ、後続のtickは処理される", async () => {
  const { transport, pipeline } = inProcess();
  const client = new AnalysisClient(transport);
  client.setStations(stations, false);
  const realTick = pipeline.tick.bind(pipeline);
  let failNext = true;
  pipeline.tick = (...args: Parameters<typeof realTick>) => {
    if (failNext) { failNext = false; throw new Error("boom"); }
    return realTick(...args);
  };
  await assert.rejects(client.tick(inputAt(0)), /boom/);
  const ok = await client.tick(inputAt(1));
  assert.ok(ok, "例外の後も、次のtickは処理される");
  client.terminate();
});

test("terminate後は、処理待ちのtickがrejectされる", async () => {
  const { transport } = inProcess();
  const client = new AnalysisClient(transport);
  client.setStations(stations, false);
  const p1 = client.tick(inputAt(0));
  const p2 = client.tick(inputAt(1));
  client.terminate();
  await assert.rejects(p1, /terminated/);
  await assert.rejects(p2, /terminated/);
});

