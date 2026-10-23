/* ─────────────────────────────────────────────────────
   配列(アレイ)型の微弱検知。

   【目的】震度0未満〜0付近の、ごく弱い揺れ(無感地震)を検知する。
   shakeDetection.ts の既存の検知ルールは、観測点の値(震度の絶対値)や、
   近傍の連結・広さ(広域拡大検知)を条件にしている。しかし、沖合の弱い地震では、
   観測点の最大値が−0.2〜−1.0程度で、震度0.1以上を条件とするルールの対象に
   ならず、上昇した観測点も、少数が離れて散らばるだけで、広域拡大検知の条件
   (半径50km以上の連結)にもならない。かといって、1点の上昇量だけで拾うと、
   ノイズだけで上昇量0.5以上になる観測点が多数あるため、誤検知だらけになる。

   【方法】観測点ごとの「立ち上がり」(自分の静穏時の値から十分上がった時刻)を
   記録し、それらが、ある震源(格子点・深さ)から出たP波の到達時刻と合っている
   組み合わせを、投票で探す。ノイズの立ち上がりは時刻がばらばらで、特定の震源の
   P波の伝播順序には、まとまって合わない。一方、本物の揺れは、P波の伝播順序に
   合う多数の立ち上がりとして現れる。
   - 各トリガーが、各震源候補で「発震時刻はいつか」を逆算して投票する
   - 発震時刻が近い(binSec刻みで±1ビン)トリガーが集まった震源候補について、
     「P波がすでに届いているはずの観測点(K点)のうち、何点が反応したか(N点)」の
     有意性(偶然にN点以上が反応する確率の、二項分布による上側確率)をスコアにする
   - スコアがscoreThreshold以上の震源候補を、検知とする

   【一致数だけでなく、有意性で判定する理由】最初の版は、一致数(N)が16点以上で
   検知としていたが、ノイズに紛れる弱い地震は、一致数が少ないうちは区別できず、
   検知が遅い。到達しているはずの観測点のうち、何割が反応したか(N/K)を使えば、
   少ない一致数でも、偶然の一致と区別できる。

   【実データでの検証(リプレイ)】スコアの値は、ノイズの最大が約9、本物が11〜35。
   - 福島県沖の無感地震(EEW推定M4.5): 既存の検知ではイベント0個。この方法で、
     86秒時点でスコア17.6(発震は約64秒)。ノイズだけの区間の最大は8.1。
   - 熊本県天草・芦北地方 M2.2・水俣市で震度2(2026-10-10 07:43、記録replay_2):
     既存の検知・一致数方式では検知できなかった。この方法で、発震の約7秒後に
     スコア11.5(気象庁の震央32.2°N,130.4°Eの位置)、約11秒後に17.7。
   - 同じ記録のうち、この地震の前後を除いた約23分間(静穏)の、スコアの最大は9.4。
   しきい値(scoreThreshold=13)は、ノイズの最大(9.4)と、本物(11.5〜17.7以上)の
   間に置いた仮の値。静穏時のデータがさらに集まったら見直すこと。
   ───────────────────────────────────────────────────── */

import { getJmaTravelTimeTable, lookupJmaTravelTime } from "./jmaTravelTime";

export const DEFAULT_WEAK_ARRAY_PARAMS = {
  // 観測点ごとの立ち上がり(トリガー)の判定
  historyLength: 45,       // 観測点ごとに保持する直近のtick数(1Hz想定で45秒分)
  baselineFromTicksAgo: 40, // 静穏時の基準値(中央値)に使う範囲: 40tick前〜
  baselineToTicksAgo: 10,   //                                  10tick前
  minRise: 0.45,           // 基準値からの上昇量の下限(0.6→0.45。無感地震のP波の立ち上がりを1秒早く拾う。検証: replay 5秒→4秒)
  sigmaK: 5,               // 基準値の揺らぎ(MAD)のこの倍数も超えること
  madFloor: 0.1,           // 揺らぎ(MAD)の下限(値が張り付いている観測点では0になるため)
  cooldownSec: 30,         // 一度トリガーした観測点が、再びトリガーできるまでの時間
  onsetBackTicks: 8,       // 立ち上がり時刻を、さかのぼって探す最大tick数
  onsetRise: 0.3,          // 立ち上がり時刻とみなす上昇量(基準値から)

  // 組み合わせ探索
  poolWindowSec: 60,       // トリガーを保持する時間
  radiusKm: 150,           // 震源候補から、この距離以内の観測点だけを投票に使う
  gridStepDeg: 0.2,        // 震源候補の格子間隔
  latMin: 30, latMax: 46, lonMin: 128, lonMax: 146, // 探索範囲(日本周辺)
  depthsKm: [10, 40],      // 震源候補の深さ
  binSec: 1,               // 発震時刻をまとめる幅(±1ビンを同じとみなす=3秒幅)
  minStations: 5,          // 候補にする、一致する観測点数の下限(判定は、下のスコアで行う)
  topCandidates: 30,       // 一致数の多い順に、スコアを計算する震源候補の数
  arriveDelaySec: 2,       // P波の予測到達から、この秒数が過ぎた観測点を「届いているはず」とみなす
  scoreThreshold: 15,      // 検知とみなすスコア(−log10(偶然の確率))の下限(13→15。minRiseを下げた分の誤検知(静穏時の最大13.2)を抑える)
  baseRateFloor: 2e-4,     // 偶然に反応する確率(1観測点・3秒の幅あたり)の下限
};

export type WeakArrayParams = typeof DEFAULT_WEAK_ARRAY_PARAMS;

export interface WeakArrayStation { id: number | string; lat: number; lon: number }

export interface WeakArrayMember {
  id: number | string;
  onsetSec: number; // 立ち上がり時刻(秒)
  amp: number;      // 基準値からの上昇量
}

export interface WeakArrayMatch {
  n: number;          // 一致した観測点数
  eligible: number;   // P波がすでに届いているはずの観測点数(半径内)
  score: number;      // 有意性。−log10(偶然にn点以上が一致する確率)
  lat: number;        // 震源候補(格子点)の位置
  lon: number;
  depthKm: number;
  originSec: number;  // 逆算した発震時刻(秒)
  rmsSec: number;     // 発震時刻のばらつき(標準偏差、秒)
  members: WeakArrayMember[];
}

interface Trigger { idx: number; sec: number; amp: number }

const RAD = Math.PI / 180;
function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = (lat2 - lat1) * RAD;
  const dLon = (lon2 - lon1) * RAD;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(a));
}

// log10(階乗) 用の対数ガンマ(Lanczos近似)
const LANCZOS = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
function lgamma(x: number): number {
  let y = x;
  let t = x + 5.5;
  t -= (x + 0.5) * Math.log(t);
  let ser = 1.000000000190015;
  for (const c of LANCZOS) ser += c / ++y;
  return -t + Math.log(2.5066282746310005 * ser / x);
}
function log10Choose(n: number, k: number): number {
  return (lgamma(n + 1) - lgamma(k + 1) - lgamma(n - k + 1)) / Math.LN10;
}
// P(X >= n)のlog10。X ~ Binomial(K, p)。nが大きいほど小さくなるので、n〜n+12の項で十分。
function log10BinomialTail(K: number, n: number, p: number): number {
  if (n <= 0) return 0;
  if (n > K) return -99;
  let max = -Infinity;
  const terms: number[] = [];
  for (let k = n; k <= Math.min(K, n + 12); k++) {
    const t = log10Choose(K, k) + k * Math.log10(p) + (K - k) * Math.log10(1 - p);
    terms.push(t);
    if (t > max) max = t;
  }
  let sum = 0;
  for (const t of terms) sum += 10 ** (t - max);
  return max + Math.log10(sum);
}

const TT_MAX_KM = 300;
const BIN_OFFSET = 512;
const BIN_RANGE = 2048;

export class WeakArrayDetector {
  params: WeakArrayParams;
  private stations: WeakArrayStation[];
  private idToIdx: Map<number | string, number>;
  // 観測点ごとの履歴(リングバッファ)
  private ringVal: Float32Array[];
  private ringSec: Float64Array[];
  private ringHead: Int32Array; // 次に書く位置
  private ringCount: Int32Array;
  private lastTriggerSec: Float64Array;
  private lastSeenSec: Float64Array; // 観測点が最後にデータを送ってきた時刻(「データがある観測点」の判定用)
  // 観測点 → 近くの震源候補(格子点)の番号と距離
  private nearCell: Int32Array[] = [];
  private nearDist: Float32Array[] = [];
  // 走時表(深さごと、距離1km刻み)。走時表の読み込み前はnull
  private tt: Float32Array[] | null = null;
  private nLon = 0;
  private triggers: Trigger[] = [];
  private scratch: Float32Array;

  constructor(stations: WeakArrayStation[], params: Partial<WeakArrayParams> = {}) {
    this.params = { ...DEFAULT_WEAK_ARRAY_PARAMS, ...params };
    this.stations = stations;
    this.idToIdx = new Map(stations.map((s, i) => [s.id, i]));
    const n = stations.length;
    const len = this.params.historyLength;
    this.ringVal = stations.map(() => new Float32Array(len));
    this.ringSec = stations.map(() => new Float64Array(len));
    this.ringHead = new Int32Array(n);
    this.ringCount = new Int32Array(n);
    this.lastTriggerSec = new Float64Array(n).fill(-1e12);
    this.lastSeenSec = new Float64Array(n).fill(-1e12);
    this.scratch = new Float32Array(len);
    this.buildGrid();
  }

  /**
   * 履歴を、与えられた値で埋めて「静穏が続いていた」状態にする。起動・再接続・リプレイの頭出し・
   * データ源の切替の直後でも、45tickの履歴が溜まるのを待たずに検知できるようにする
   * (履歴が足りない間は検知できず、直後の無感地震が通常ルールの数秒後まで検知できなかった)。
   * 揺れの最中に呼ぶと基準値が高めになるが、検知が遅れる方向にしか働かない。
   */
  seed(nowSec: number, values: Map<number | string, number>) {
    const len = this.params.historyLength;
    for (const [id, v] of values) {
      if (v == null || !Number.isFinite(v)) continue;
      const i = this.idToIdx.get(id);
      if (i == null) continue;
      for (let k = 0; k < len; k++) {
        this.ringVal[i][k] = v;
        this.ringSec[i][k] = nowSec - (len - k);
      }
      this.ringHead[i] = 0;
      this.ringCount[i] = len;
    }
  }

  reset() {
    this.ringHead.fill(0);
    this.ringCount.fill(0);
    this.lastTriggerSec.fill(-1e12);
    this.lastSeenSec.fill(-1e12);
    this.triggers = [];
  }

  // 観測点ごとに、radiusKm以内の震源候補(格子点)を求めておく(初期化時に1度だけ)
  private buildGrid() {
    const p = this.params;
    const step = p.gridStepDeg;
    this.nLon = Math.round((p.lonMax - p.lonMin) / step) + 1;
    for (const st of this.stations) {
      const dLat = p.radiusKm / 111;
      const dLon = p.radiusKm / (111 * Math.max(0.2, Math.cos(st.lat * RAD)));
      const iLat0 = Math.max(0, Math.floor((st.lat - dLat - p.latMin) / step));
      const iLat1 = Math.min(Math.round((p.latMax - p.latMin) / step), Math.ceil((st.lat + dLat - p.latMin) / step));
      const iLon0 = Math.max(0, Math.floor((st.lon - dLon - p.lonMin) / step));
      const iLon1 = Math.min(this.nLon - 1, Math.ceil((st.lon + dLon - p.lonMin) / step));
      const cells: number[] = [];
      const dists: number[] = [];
      for (let iLat = iLat0; iLat <= iLat1; iLat++) {
        for (let iLon = iLon0; iLon <= iLon1; iLon++) {
          const d = haversineKm(st.lat, st.lon, p.latMin + iLat * step, p.lonMin + iLon * step);
          if (d <= p.radiusKm) { cells.push(iLat * this.nLon + iLon); dists.push(d); }
        }
      }
      this.nearCell.push(Int32Array.from(cells));
      this.nearDist.push(Float32Array.from(dists));
    }
  }

  // 走時表(気象庁走時表)が読み込まれていれば、深さごとの距離→P波走時の配列を作る
  private ensureTravelTimes(): boolean {
    if (this.tt) return true;
    const table = getJmaTravelTimeTable();
    if (!table) return false;
    this.tt = this.params.depthsKm.map(depth => {
      const a = new Float32Array(TT_MAX_KM + 1);
      for (let km = 0; km <= TT_MAX_KM; km++) {
        const r = lookupJmaTravelTime(table, km, depth);
        a[km] = r ? r.pTimeSec : 0;
      }
      return a;
    });
    return true;
  }

  /**
   * 1tickぶんの値を取り込み、P波の伝播順序に合う立ち上がりの組み合わせを探す。
   * @param nowSec    このtickの時刻(秒)
   * @param values    観測点id → 値(震度相当値)
   * @param excludeIds 探索から除く観測点(既に、別の通常のイベントに属している点など)
   * @returns         minStations点以上が一致した、最も多い震源候補。無ければnull。
   */
  update(nowSec: number, values: Map<number | string, number>, excludeIds: Set<number | string> | null = null): WeakArrayMatch | null {
    const p = this.params;
    const len = p.historyLength;
    let newTriggers = 0;

    // 1) 履歴の更新と、観測点ごとの立ち上がり判定
    for (const [id, v] of values) {
      if (v == null || !Number.isFinite(v)) continue;
      const i = this.idToIdx.get(id);
      if (i == null) continue;
      this.lastSeenSec[i] = nowSec;
      const head = this.ringHead[i];
      this.ringVal[i][head] = v;
      this.ringSec[i][head] = nowSec;
      this.ringHead[i] = (head + 1) % len;
      if (this.ringCount[i] < len) this.ringCount[i]++;
      if (this.ringCount[i] < len) continue;
      if (nowSec - this.lastTriggerSec[i] < p.cooldownSec) continue;

      const val = this.ringVal[i];
      const at = (ago: number) => val[((this.ringHead[i] - 1 - ago) % len + len) % len];
      const cur = (at(0) + at(1)) / 2;
      // 基準値の範囲(baselineFromTicksAgo〜baselineToTicksAgo tick前)の最小値で、素早く足切りする
      let minV = Infinity;
      let cnt = 0;
      for (let a = p.baselineToTicksAgo; a <= p.baselineFromTicksAgo; a++) {
        const x = at(a);
        if (x < minV) minV = x;
        this.scratch[cnt++] = x;
      }
      if (cur - minV < p.minRise) continue; // 中央値は最小値以上なので、ここで足りなければ必ず条件を満たさない
      const base = medianOf(this.scratch, cnt);
      for (let k = 0; k < cnt; k++) this.scratch[k] = Math.abs(this.scratch[k] - base);
      const mad = medianOf(this.scratch, cnt) * 1.4826;
      const need = Math.max(p.minRise, p.sigmaK * Math.max(mad, p.madFloor));
      if (cur - base < need) continue;

      // 立ち上がり時刻: 直近で、基準値+onsetRiseを連続して超えている最初のtick
      let onsetSec = nowSec;
      for (let k = 0; k <= p.onsetBackTicks; k++) {
        const idx = ((this.ringHead[i] - 1 - k) % len + len) % len;
        if (val[idx] >= base + p.onsetRise) onsetSec = this.ringSec[i][idx]; else break;
      }
      this.triggers.push({ idx: i, sec: onsetSec, amp: cur - base });
      this.lastTriggerSec[i] = nowSec;
      newTriggers++;
    }
    this.triggers = this.triggers.filter(t => nowSec - t.sec <= p.poolWindowSec);
    void newTriggers;

    // 2) 探索に使うトリガー(既に別のイベントに属している観測点は除く)
    const pool = excludeIds
      ? this.triggers.filter(t => !excludeIds.has(this.stations[t.idx].id))
      : this.triggers;
    if (pool.length < p.minStations) return null;
    if (!this.ensureTravelTimes() || !this.tt) return null;
    const tt = this.tt;

    // 3) 投票: 各トリガーが、各震源候補(格子点・深さ)で「発震時刻はいつか」を逆算する
    const refSec = Math.round(nowSec);
    const nDepth = p.depthsKm.length;
    const votes = new Map<number, number>();
    for (const t of pool) {
      const cells = this.nearCell[t.idx];
      const dists = this.nearDist[t.idx];
      for (let c = 0; c < cells.length; c++) {
        const km = Math.min(TT_MAX_KM, Math.round(dists[c]));
        for (let di = 0; di < nDepth; di++) {
          const bin = Math.floor((t.sec - tt[di][km] - refSec) / p.binSec) + BIN_OFFSET;
          if (bin < 1 || bin >= BIN_RANGE - 1) continue;
          const key = (cells[c] * nDepth + di) * BIN_RANGE + bin;
          votes.set(key, (votes.get(key) ?? 0) + 1);
        }
      }
    }

    // 4) 隣のビン(±1)を足した一致数が多い順に、震源候補を選ぶ
    const cands: Array<[number, number]> = [];
    for (const [key, c] of votes) {
      if (c * 3 < p.minStations) continue; // 隣の2ビンを足しても、minStationsに届かない
      const n = c + (votes.get(key - 1) ?? 0) + (votes.get(key + 1) ?? 0);
      if (n >= p.minStations) cands.push([key, n]);
    }
    if (cands.length === 0) return null;
    cands.sort((a, b) => b[1] - a[1]);

    // 偶然に反応する確率(1観測点・binSecの3倍の幅あたり)。全体のトリガー頻度から求める
    let nActive = 0;
    for (let i = 0; i < this.stations.length; i++) if (nowSec - this.lastSeenSec[i] <= 5) nActive++;
    const p0 = Math.min(0.5, Math.max(p.baseRateFloor, (this.triggers.length / Math.max(1, nActive) / p.poolWindowSec) * (3 * p.binSec)));

    // 5) 上位の候補について、有意性のスコアを求め、最も高い候補を選ぶ
    let best: WeakArrayMatch | null = null;
    for (const [key, nVote] of cands.slice(0, p.topCandidates)) {
      const bin = key % BIN_RANGE;
      const cd = Math.floor(key / BIN_RANGE);
      const cell = Math.floor(cd / nDepth);
      const di = cd % nDepth;
      const lat = p.latMin + Math.floor(cell / this.nLon) * p.gridStepDeg;
      const lon = p.lonMin + (cell % this.nLon) * p.gridStepDeg;
      const members: WeakArrayMember[] = [];
      const origins: number[] = [];
      for (const t of pool) {
        const st = this.stations[t.idx];
        const d = haversineKm(st.lat, st.lon, lat, lon);
        if (d > p.radiusKm) continue;
        const origin = t.sec - tt[di][Math.min(TT_MAX_KM, Math.round(d))];
        const b2 = Math.floor((origin - refSec) / p.binSec) + BIN_OFFSET;
        if (Math.abs(b2 - bin) <= 1) { members.push({ id: st.id, onsetSec: t.sec, amp: t.amp }); origins.push(origin); }
      }
      if (members.length < p.minStations) continue;
      const mean = origins.reduce((a, b) => a + b, 0) / origins.length;
      // 「P波がすでに届いているはず」の観測点数K: 半径内で、データがあり、予測到達時刻+遅れ
      // (arriveDelaySec)が現在より前で、別のイベントに属していない観測点
      const dLat = p.radiusKm / 111;
      const dLon = p.radiusKm / (111 * Math.max(0.2, Math.cos(lat * RAD)));
      let eligible = 0;
      for (let i = 0; i < this.stations.length; i++) {
        const st = this.stations[i];
        if (Math.abs(st.lat - lat) > dLat || Math.abs(st.lon - lon) > dLon) continue;
        if (nowSec - this.lastSeenSec[i] > 5) continue;
        if (excludeIds && excludeIds.has(st.id)) continue;
        const d = haversineKm(st.lat, st.lon, lat, lon);
        if (d > p.radiusKm) continue;
        if (mean + tt[di][Math.min(TT_MAX_KM, Math.round(d))] + p.arriveDelaySec <= nowSec) eligible++;
      }
      eligible = Math.max(eligible, members.length);
      const score = -log10BinomialTail(eligible, members.length, p0);
      if (!best || score > best.score) {
        const rms = Math.sqrt(origins.reduce((a, b) => a + (b - mean) ** 2, 0) / origins.length);
        best = { n: members.length, eligible, score, lat, lon, depthKm: p.depthsKm[di], originSec: mean, rmsSec: rms, members };
      }
      void nVote;
    }
    return best && best.score >= p.scoreThreshold ? best : null;
  }
}

// 先頭cnt個の中央値(scratchを破壊的に並べ替える。cntは小さいので挿入ソートで足りる)
function medianOf(a: Float32Array, cnt: number): number {
  for (let i = 1; i < cnt; i++) {
    const x = a[i];
    let j = i - 1;
    while (j >= 0 && a[j] > x) { a[j + 1] = a[j]; j--; }
    a[j + 1] = x;
  }
  return a[Math.floor(cnt / 2)];
}
