// 気象タブ(雨雲レーダー/降水量/天気分布/キキクル)共通のタイル取得部品。
//
// - 同時取得数の制限(新しい要求を優先=LIFO。パン/ズーム直後の見えているタイルを先に取る)
// - 1回ごとのタイムアウトと、通信失敗・5xx・429 の再試行(バックオフ付き)
// - 404 は「永久除外」ではなく短期(NEG_TTL_MS)だけ記憶する。配信遅延による一時的な
//   404 が、セッション中ずっと空白になる不具合を避けるため。
// - 取得状況(読み込み中/失敗)を購読でき、手動再読み込み(retryAllTiles)に対応する。

export const MAX_CONCURRENT = 8;
export const ATTEMPT_TIMEOUT_MS = 10000;
export const NEG_TTL_MS = 90 * 1000;
const RETRY_DELAYS_MS = [600, 1500]; // 通信失敗・5xx時(最大3回試行)
const NOT_FOUND_RETRY_MS = 1000;     // 404は1回だけ再確認
const FAIL_WINDOW_MS = 60 * 1000;    // 「失敗」として表示に数える期間

const negCache = new Map(); // url -> expiresAt
const failedAt = new Map(); // url -> 失敗した時刻(表示用)
let active = 0;
const queue = []; // { run, signal, resolve, reject, onAbort }
let pending = 0;  // 待機中+取得中
const listeners = new Set();
const retryHandlers = new Set();

function abortError() {
  const e = new Error("Aborted");
  e.name = "AbortError";
  return e;
}

function pruneFailed(now = Date.now()) {
  for (const [u, t] of failedAt) if (now - t > FAIL_WINDOW_MS) failedAt.delete(u);
}

let lastSnapshot = { pending: 0, failed: 0 };
function emit() {
  pruneFailed();
  const next = { pending, failed: failedAt.size };
  if (next.pending === lastSnapshot.pending && next.failed === lastSnapshot.failed) return;
  lastSnapshot = next;
  listeners.forEach(fn => { try { fn(next); } catch { /* ignore */ } });
}

export function getTileStatus() {
  pruneFailed();
  return { pending, failed: failedAt.size };
}

export function subscribeTileStatus(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// MapCanvas等が「ソースを再読み込みする処理」を登録する。
export function onTileRetry(fn) {
  retryHandlers.add(fn);
  return () => retryHandlers.delete(fn);
}

// 手動の再読み込み。短期の404記憶と失敗表示を消し、登録された再読み込み処理を呼ぶ。
export function retryAllTiles() {
  negCache.clear();
  failedAt.clear();
  jsonCache.clear();
  emit();
  retryHandlers.forEach(fn => { try { fn(); } catch { /* ignore */ } });
}

function pump() {
  while (active < MAX_CONCURRENT && queue.length > 0) {
    const job = queue.pop(); // LIFO
    if (job.signal) job.signal.removeEventListener("abort", job.onAbort);
    if (job.signal?.aborted) { pending--; job.reject(abortError()); continue; }
    active++;
    job.run().then(job.resolve, job.reject).finally(() => {
      active--; pending--; emit(); pump();
    });
  }
  emit();
}

function schedule(run, signal) {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const job = { run, signal, resolve, reject, onAbort: null };
    job.onAbort = () => {
      const i = queue.indexOf(job);
      if (i >= 0) { queue.splice(i, 1); pending--; emit(); reject(abortError()); }
    };
    if (signal) signal.addEventListener("abort", job.onAbort, { once: true });
    pending++;
    queue.push(job);
    pump();
  });
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const t = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(abortError()); };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// 1回の試行。戻り値: { blob } | { status } | { error: "timeout"|"network" }
async function attempt(url, signal) {
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, ATTEMPT_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return { status: res.status };
    return { blob: await res.blob() };
  } catch (err) {
    if (signal?.aborted) throw abortError();
    return { error: timedOut ? "timeout" : "network" };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

// タイルを取得して Blob を返す。取得できなければ null(例外は中断時のAbortErrorのみ)。
export async function fetchTileBlob(url, signal) {
  const now = Date.now();
  const neg = negCache.get(url);
  if (neg && neg > now) return null;
  if (neg) negCache.delete(url);

  return schedule(async () => {
    let lastFail = "network";
    for (let i = 0; i <= RETRY_DELAYS_MS.length; i++) {
      const r = await attempt(url, signal);
      if (r.blob) { failedAt.delete(url); return r.blob; }
      if (r.status === 404) {
        // 配信遅延の可能性があるので1回だけ再確認し、それでも404なら短期だけ記憶する
        if (i === 0) { await sleep(NOT_FOUND_RETRY_MS, signal); continue; }
        negCache.set(url, Date.now() + NEG_TTL_MS);
        return null; // 404は「データなし」の正常系もあるので失敗表示には数えない
      }
      lastFail = r.status ? `HTTP ${r.status}` : r.error;
      // 4xx(404以外、429除く)は再試行しても無駄
      if (r.status && r.status < 500 && r.status !== 429) break;
      if (i < RETRY_DELAYS_MS.length) await sleep(RETRY_DELAYS_MS[i], signal);
    }
    failedAt.set(url, Date.now());
    negCache.set(url, Date.now() + 5000); // 失敗直後の連打だけ避ける
    console.warn(`[タイル] 取得失敗(${lastFail}): ${url}`);
    return null;
  }, signal);
}


/* ─────────────────────────────────────────────────────
   データ範囲マスク
   気象庁が配信する「データなし範囲」のポリゴン(.../surf/{element}_nd/data.geojson)から、
   範囲外タイルの取得を省くための粗いグリッドを作る。
   - 全球の枠 + くり抜き(=データのある範囲) の形式。枠(巨大なリング)以外のリングを
     「データあり」として塗る。
   - 判定は安全側: 1ピクセルでも塗られていれば「あり」。グリッド外・未取得・想定外の形式は
     すべて「あり(取得する)」として扱う。
   - 範囲は最新フレームの1回だけ取得し、同じ要素の全フレームに流用する(TTL 10分)。
   ───────────────────────────────────────────────────── */
const GRID_Z = 7;                 // 1セル = z7タイル
const GRID_X0 = 100, GRID_X1 = 124; // 経度およそ100〜170
const GRID_Y0 = 38, GRID_Y1 = 66;   // 緯度およそ58〜-5(日本周辺を十分に含む)
const CELL_PX = 8;
const COVERAGE_TTL_MS = 10 * 60 * 1000;

const coverage = new Map(); // key -> { mask:Uint8Array|null, at, loading }

function lonLatToCell(lon, lat) {
  const n = 2 ** GRID_Z;
  const fx = ((lon + 180) / 360) * n;
  const rad = (lat * Math.PI) / 180;
  const fy = ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n;
  return [fx, fy];
}

// geojson → セル単位の Uint8Array(1=データあり)。作れなければ null。
export function buildCoverageMask(geojson, makeCanvas) {
  const W = (GRID_X1 - GRID_X0) * CELL_PX;
  const H = (GRID_Y1 - GRID_Y0) * CELL_PX;
  const canvas = makeCanvas(W, H);
  const ctx = canvas?.getContext?.("2d");
  if (!ctx) return null;
  ctx.fillStyle = "#000";
  ctx.strokeStyle = "#000";
  ctx.lineWidth = CELL_PX; // 1セル分ふくらませ、境界のタイルを取りこぼさない
  ctx.lineJoin = "round";
  let drawn = 0;
  const polys = [];
  for (const f of geojson?.features ?? []) {
    const g = f?.geometry;
    if (g?.type === "Polygon") polys.push(g.coordinates);
    else if (g?.type === "MultiPolygon") polys.push(...g.coordinates);
  }
  for (const rings of polys) {
    for (let r = 1; r < rings.length; r++) { // r=0 は全球の枠
      const ring = rings[r];
      if (!Array.isArray(ring) || ring.length < 3) continue;
      ctx.beginPath();
      ring.forEach(([lon, lat], i) => {
        const [fx, fy] = lonLatToCell(lon, lat);
        const px = (fx - GRID_X0) * CELL_PX, py = (fy - GRID_Y0) * CELL_PX;
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      });
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      drawn++;
    }
  }
  if (drawn === 0) return null; // 想定外の形式 → マスクを使わない
  const data = ctx.getImageData(0, 0, W, H).data;
  const cols = GRID_X1 - GRID_X0, rows = GRID_Y1 - GRID_Y0;
  const mask = new Uint8Array(cols * rows);
  let covered = 0;
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      let any = 0;
      for (let py = 0; py < CELL_PX && !any; py++) {
        for (let px = 0; px < CELL_PX; px++) {
          if (data[(((cy * CELL_PX + py) * W) + cx * CELL_PX + px) * 4 + 3] > 0) { any = 1; break; }
        }
      }
      mask[cy * cols + cx] = any;
      covered += any;
    }
  }
  // 範囲がほぼゼロ/全面は形式の取り違えの疑いがあるので使わない
  if (covered < 4 || covered === mask.length) return null;
  return mask;
}

// タイル(z,x,y)がデータ範囲に全く含まれないと確実に言える時だけ true。
export function tileOutsideCoverage(mask, z, x, y) {
  if (!mask) return false;
  let x0, x1, y0, y1; // z7セル座標の範囲(半開区間)
  if (z >= GRID_Z) {
    const s = 2 ** (z - GRID_Z);
    x0 = Math.floor(x / s); x1 = x0 + 1;
    y0 = Math.floor(y / s); y1 = y0 + 1;
  } else {
    const s = 2 ** (GRID_Z - z);
    x0 = x * s; x1 = x0 + s;
    y0 = y * s; y1 = y0 + s;
  }
  // グリッド外にはみ出す部分は「不明=あり」
  if (x0 < GRID_X0 || x1 > GRID_X1 || y0 < GRID_Y0 || y1 > GRID_Y1) return false;
  const cols = GRID_X1 - GRID_X0;
  for (let cy = y0; cy < y1; cy++) {
    for (let cx = x0; cx < x1; cx++) {
      if (mask[(cy - GRID_Y0) * cols + (cx - GRID_X0)]) return false;
    }
  }
  return true;
}

// タイルURLから範囲geojsonのURLと要素キーを導く。
// 例 .../nowc/{b}/none/{v}/surf/hrpns/{z}/{x}/{y}.png → .../surf/hrpns_nd/data.geojson
export function coverageInfoFromTileUrl(tileUrl) {
  const m = tileUrl.match(/^(.*\/data\/([a-z]+)\/\d+\/[a-z0-9]+\/\d+\/surf\/([a-z0-9]+))\/\d+\/-?\d+\/-?\d+\.png$/i);
  if (!m) return null;
  const [, base, dataset, element] = m;
  return {
    key: `${dataset}/${element}`, // フレーム(時刻)に依らないキー
    url: `${base}_nd/data.geojson?id=${element}_nd`,
  };
}

function makeOffscreen(w, h) {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
  if (typeof document !== "undefined") {
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    return c;
  }
  return null;
}

// 取得を開始する(待たない)。完了後のタイルから判定に使われる。
function ensureCoverage(info) {
  const cur = coverage.get(info.key);
  const now = Date.now();
  if (cur && (cur.loading || now - cur.at < COVERAGE_TTL_MS)) return;
  const entry = { mask: cur?.mask ?? null, at: now, loading: true };
  coverage.set(info.key, entry);
  (async () => {
    try {
      const res = await fetch(info.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      entry.mask = buildCoverageMask(json, makeOffscreen);
    } catch (err) {
      console.warn("[タイル] データ範囲の取得に失敗(全タイルを取得します):", err?.message ?? err);
    } finally {
      entry.loading = false;
      entry.at = Date.now();
    }
  })();
}

// 範囲外と確実に言える時だけ true。初回は範囲取得を裏で始めるのみ(取得は止めない)。
export function shouldSkipTile(tileUrl, z, x, y) {
  const info = coverageInfoFromTileUrl(tileUrl);
  if (!info) return false;
  ensureCoverage(info);
  return tileOutsideCoverage(coverage.get(info.key)?.mask ?? null, z, x, y);
}


/* ─────────────────────────────────────────────────────
   時刻一覧(targetTimes)など小さなJSONの共有取得。
   同じURLへの同時要求を1本にまとめ、成功したものはTTLの間だけ使い回す
   (機能のON/OFF連打や、複数パネルからの同時取得で同じ一覧を何度も取らないため)。
   失敗した場合はキャッシュに残さない。タイムアウト付き。
   ───────────────────────────────────────────────────── */
const jsonCache = new Map(); // url -> { at, promise }
export const JSON_TTL_MS = 60 * 1000;

export function fetchJsonShared(url, { ttl = JSON_TTL_MS, timeoutMs = ATTEMPT_TIMEOUT_MS } = {}) {
  const cur = jsonCache.get(url);
  if (cur && Date.now() - cur.at < ttl) return cur.promise;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const promise = fetch(url, { cache: "no-store", signal: ctrl.signal })
    .then(res => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    })
    .finally(() => clearTimeout(timer));
  const entry = { at: Date.now(), promise };
  jsonCache.set(url, entry);
  promise.catch(() => { if (jsonCache.get(url) === entry) jsonCache.delete(url); });
  return promise;
}

export function clearSharedJson() { jsonCache.clear(); }


/* ─────────────────────────────────────────────────────
   キャッシュしない1回取得(タイムアウト+通信失敗/5xxの再試行付き)。
   404 は null を返す(「その時刻のデータは無い」を正常系として扱うため)。
   それ以外の失敗は例外。呼び出し側が自前のキャッシュを持つ用途(アメダス等)。
   ───────────────────────────────────────────────────── */
export async function fetchBodyOrNull(url, { text = false, timeoutMs = ATTEMPT_TIMEOUT_MS, retries = 1 } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { cache: "no-store", signal: ctrl.signal });
      if (res.status === 404) return null;
      if (!res.ok) {
        lastErr = new Error(`HTTP ${res.status}`);
        if (res.status < 500 && res.status !== 429) break;
      } else {
        return text ? await res.text() : await res.json();
      }
    } catch (err) {
      lastErr = err;
    } finally {
      clearTimeout(timer);
    }
    if (i < retries) await new Promise(r => setTimeout(r, 600));
  }
  throw lastErr ?? new Error("fetch failed");
}

// 先読みしてよい回線か。通信節約設定・モバイル回線・低速回線では先読みしない。
export function prefetchAllowed() {
  const conn = typeof navigator !== "undefined" ? navigator.connection : null;
  if (!conn) return true;
  return !(conn.saveData || conn.type === "cellular" || /^(slow-2g|2g|3g)$/.test(conn.effectiveType || ""));
}
