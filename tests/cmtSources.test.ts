import { test } from "node:test";
import assert from "node:assert/strict";
import { loadStoredCmtFetchSources, saveCmtFetchSources } from "../src/app/cmtFetchSources.js";
import { shouldShowMechanismButton } from "../src/app/cmt.js";

// localStorageの代わり(Node上のテスト用)
function installStorage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  (globalThis as any).localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, String(v)); },
    removeItem: (k: string) => { store.delete(k); },
  };
  return store;
}

test("発震機構解の取得先: 何も保存されていなければ、気象庁・USGSの両方がオン(初期設定)", () => {
  installStorage();
  assert.deepEqual(loadStoredCmtFetchSources(), { jma: true, usgs: true });
});

test("発震機構解の取得先: 保存した選択が、そのまま読み込める(片方だけ・どちらもオフを含む)", () => {
  installStorage();
  for (const sel of [{ jma: true, usgs: false }, { jma: false, usgs: true }, { jma: false, usgs: false }, { jma: true, usgs: true }]) {
    saveCmtFetchSources(sel);
    assert.deepEqual(loadStoredCmtFetchSources(), sel);
  }
});

test("発震機構解の取得先: 壊れた保存値や、足りない項目は、オン(既定)として扱う", () => {
  installStorage({ cmtFetchSources: "not json" });
  assert.deepEqual(loadStoredCmtFetchSources(), { jma: true, usgs: true });
  installStorage({ cmtFetchSources: JSON.stringify({ jma: false }) });
  assert.deepEqual(loadStoredCmtFetchSources(), { jma: false, usgs: true });
  installStorage({ cmtFetchSources: JSON.stringify({ jma: "yes", usgs: 0 }) });
  assert.deepEqual(loadStoredCmtFetchSources(), { jma: true, usgs: true });
});

test("発震機構解のボタン: どちらの取得先もオフなら出さない。どちらかがオンなら、従来の条件(M・震央)で決まる", () => {
  const land = { place: "千葉県南部", magnitude: 4.0 };
  const smallSea = { place: "三陸沖", magnitude: 3.0 };
  const bigSea = { place: "三陸沖", magnitude: 5.5 };
  assert.equal(shouldShowMechanismButton(land), true); // 省略時は両方オン
  assert.equal(shouldShowMechanismButton(land, { jma: false, usgs: false }), false);
  assert.equal(shouldShowMechanismButton(land, { jma: true, usgs: false }), true);
  assert.equal(shouldShowMechanismButton(land, { jma: false, usgs: true }), true);
  assert.equal(shouldShowMechanismButton(smallSea, { jma: true, usgs: true }), false);
  assert.equal(shouldShowMechanismButton(bigSea, { jma: true, usgs: true }), true);
  assert.equal(shouldShowMechanismButton(bigSea, { jma: false, usgs: false }), false);
  assert.equal(shouldShowMechanismButton(null, { jma: true, usgs: true }), false);
});
