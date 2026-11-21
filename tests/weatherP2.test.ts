import test from "node:test";
import assert from "node:assert/strict";
// @ts-ignore
import * as TF from "../src/app/weather/tileFetch.js";
// @ts-ignore
import { startVisiblePolling } from "../src/app/visiblePolling.js";

const realFetch = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = realFetch; TF.clearSharedJson(); });

test("fetchJsonShared: 同時要求は1本にまとまり、TTL内は使い回す", async () => {
  let n = 0;
  globalThis.fetch = (async () => { n++; await new Promise(r => setTimeout(r, 10)); return { ok: true, json: async () => [1] }; }) as any;
  const [a, b] = await Promise.all([TF.fetchJsonShared("https://x/t.json"), TF.fetchJsonShared("https://x/t.json")]);
  assert.deepEqual(a, [1]); assert.equal(a, b);
  await TF.fetchJsonShared("https://x/t.json");
  assert.equal(n, 1);
  TF.clearSharedJson();
  await TF.fetchJsonShared("https://x/t.json");
  assert.equal(n, 2);
});

test("fetchJsonShared: 失敗はキャッシュしない", async () => {
  let n = 0;
  globalThis.fetch = (async () => { n++; return n === 1 ? { ok: false, status: 503 } : { ok: true, json: async () => ({ ok: 1 }) }; }) as any;
  await assert.rejects(TF.fetchJsonShared("https://x/f.json"));
  await new Promise(r => setTimeout(r, 0));
  assert.deepEqual(await TF.fetchJsonShared("https://x/f.json"), { ok: 1 });
});

test("startVisiblePolling: 非表示中は止まり、復帰時に間隔超過なら即実行", async () => {
  const listeners: Record<string, Function> = {};
  const doc: any = { visibilityState: "visible", addEventListener: (e: string, f: Function) => { listeners[e] = f; }, removeEventListener: () => {} };
  (globalThis as any).document = doc;
  let n = 0;
  const stop = startVisiblePolling(() => { n++; }, 40);
  await new Promise(r => setTimeout(r, 90));
  assert.ok(n >= 1);
  doc.visibilityState = "hidden";
  const before = n;
  await new Promise(r => setTimeout(r, 100));
  assert.equal(n, before, "非表示中は実行しない");
  doc.visibilityState = "visible";
  listeners["visibilitychange"]();
  assert.equal(n, before + 1, "復帰時に即実行");
  stop();
  delete (globalThis as any).document;
});
