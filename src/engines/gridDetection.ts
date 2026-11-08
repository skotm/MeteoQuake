/**
 * gridDetection.ts
 * ------------------------------------------------------------
 * グリッド(セル)方式の揺れ検知。既存の ShakeDetectionEngine(観測点の近傍・BFS拡張・
 * イベント統合による検知)とは独立に、領域(セル)単位で検知する。併用して比較できる。
 *
 * 考え方
 *  - 緯度経度のグリッドで、観測点を重ならないセルに分ける(1つの観測点は必ず1つのセルに属する)。
 *  - 観測点ごとに「反応開始時刻・反応の大きさ」を追う(既存と同じごく緩い基準)。
 *  - セルごとに、反応中の観測点の数・割合、反応開始時刻が距離に沿って並んでいるか(伝播の整合性)を
 *    見て、基準を満たしたセルを「発火セル」とする。発火は一定時間保持する。
 *  - 隣り合う(8近傍)発火セルを連結して1つの地震(イベント)とする。離れた発火セルは別の地震。
 *    観測点が1つのセルにしか属さないので、同時期に離れた場所で起きた地震が混ざらない。
 *  - イベントごとに、反応した観測点を検知点(detections)として持つ。震源推定
 *    (EpicenterEstimator)へは、既存のイベントと同じ形式で渡せる。探索の中心は、最初の観測点ではなく、
 *    最初に反応したセルの、早く反応した数点の重心(searchCenter)にする。
 *
 * 出力のイベントは、既存のイベントと区別できるよう、idをGRID_EVENT_ID_BASE以上にしている。
 */

import {
  DEFAULT_SHAKE_DETECTION_PARAMS, independentSourceFit, intensityToShakeLevel, looksIndependent, pAndSTravelSec,
} from "./shakeDetection";

export const GRID_EVENT_ID_BASE = 1_000_000;

export const DEFAULT_GRID_PARAMS = {
  cellDeg: 1.0,                 // セルの一辺(度)。緯度・経度とも同じ。経度0度の倍数に揃える
  historyLength: 5,             // 直近の値の平均(秒)
  reactionRiseThreshold: 0.08,  // 前tickからの上昇量がこれ以上で「反応」(既存と同じ)
  reactionAvgRiseThreshold: 0.05,
  reonsetGapSec: 20,            // 反応が止まってからこの秒数以内の再開は、同じ地震の続き(P波→S波)として、反応開始を更新しない
  activeWindowSec: 20,          // 反応開始からこの秒数の間、その観測点を「反応中」として数える
  stationMinRise: 0.3,          // 反応中として数える、反応前の値からの上昇量の下限
  minActiveCount: 3,            // 発火に必要な、反応中の観測点数
  minActiveRatio: 0.2,          // データのある観測点に対する、反応中の観測点の割合
  minPeakIntensity: -0.5,       // 発火に必要な、反応中の観測点のピーク震度の下限(微弱検知ON: -0.5 / OFF: 0.5 に連動して設定する)
  minPeakCount: 2,              // 上の水準を超える反応中の観測点の必要数
  cellAvgSec: 10,               // セルの平均震度をとる秒数(起動から足りない間は、あるだけで平均する)
  cellBaselineSec: 30,          // 上昇量の基準にする、平均より前の平静時の秒数
  earlyDropSec: 8,              // セル内の反応開始の中央付近より、これだけ早く反応した観測点(ノイズ反応)は、イベントの検知点に入れない(0で無効)
  outlierRejectSec: 5,          // 推定に使う検知から、点震源のフィットに対しP波到達との差がこの秒数を超える点を除く(0で無効)
  outlierMinKeep: 12,           // 除いたあとに残すべき点数の下限(下回る場合は除かない)
  undetectedByData: false,      // 着未着法の未検知観測点を、「データがあり、反応していない」点に限る
  undetectedNoTimeLimit: false, // 着未着法を、検知初期(3秒・30点)に限らず使い続ける
  cellRiseMin: 0.1,             // セルの10秒平均が、平静時の平均より上昇している量の下限(0で無効)
  smallCellMembers: 5,          // 観測点がこれ未満のセル(離島・海域など)は、比率で判定する
  smallCellMinActive: 2,
  smallCellMinRatio: 0.6,
  coherenceMinSamples: 5,       // 伝播の整合性(距離と反応開始時刻の相関)を見る最小点数
  coherenceMinCorrelation: 0.2,
  holdSec: 90,                  // 発火したセルを、この秒数の間「発火中」として保持する
  linkMinSpeedKmS: 3.0,         // 隣のセルとの発火時刻の差の上限 = 距離 / この速度 + linkMarginSec
  linkMarginSec: 8,
  neighborRadius: 2,            // 隣接とみなすセル数(セルが小さいので、1セルの空きは橋渡しする)
  minEventPoints: 12,            // 出力するイベントの、検知点数の下限
  searchCenterPoints: 5,        // 探索中心に使う、最初のセルの早く反応した点の数
  maxStationId: 5000,           // これ以上のid(海底観測点)は対象外
  levelThresholds: [0.5, 2.0, 3.5, 5.0],
  // 隣り合うセル・イベントを、同じ地震とみなしてよいかの判定(点震源のP波走時との整合)
  earlyVetoSec: 20,             // 相手の震源から伝わるP波の到達より、これだけ早い反応は「別の地震」の根拠
  earlyVetoRatio: 0.7,          // 反応した観測点のうち、これ以上の割合が早ければ、別の地震とみなす
  maxFitCost: 8,                // 相手の震源のフィットの誤差がこれ以下のときだけ、上の判定をする
  explainCapSec: 20,            // 説明できる度合い(P波到達との差の平均)の頭打ち
  // 大きな地震の後続動(遠方の、ごく小さな検知)の統合。隣り合わない小さなイベントは、点が少なすぎて
  // 独立した地震かを判定できないので、大きなイベントの検知範囲の内側で、大きなイベントの波より早くなければ統合する。
  codaMainMinPoints: 150,       // 主イベントの検知点数の下限
  codaSmallMaxPoints: 11,       // これ以下の小さなイベントだけが対象(12点以上は、独立かどうかを判定できる)
  codaMarginKm: 60,             // 主イベントの検知範囲(震源から最も遠い検知点)に足す余裕
  // 独立した別の地震の判定(shakeDetection.tsのlooksIndependentと同じ基準)。主イベントのP波〜S波の窓に収まらない
  // 新しいセルは、すぐには主イベントに入れず、別イベントとして様子を見る。12点以上になって、独立と判定されれば別の
  // 地震のまま、そうでなければ(または、pendingSecのあいだ小さいままなら)主イベントへ統合する。
  pendingMainMinPoints: 20,     // 主イベントがこの点数以上のときだけ、上の判定をする
  pendingSec: 30,               // 様子を見る秒数
  windowLateSec: 8,             // P波〜S波の窓の、S波より遅れてよい秒数
  windowEarlySec: 4,
  windowRatio: 0.7,
};

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function pearson(xs, ys) {
  const n = xs.length;
  if (n < 2) return null;
  let mx = 0, my = 0;
  for (let i = 0; i < n; i++) { mx += xs[i]; my += ys[i]; }
  mx /= n; my /= n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
  }
  if (sxx <= 0 || syy <= 0) return null;
  return sxy / Math.sqrt(sxx * syy);
}

export class GridDetector {
  params;
  stations = new Map();   // id -> 観測点の状態
  cells = new Map();      // key -> セル
  events = new Map();     // id -> イベント(内部状態)
  nextId = GRID_EVENT_ID_BASE;
  externalEstimates = new Map();
  suppressUntil = 0;
  initialized = false;

  constructor(params = {}) {
    this.params = { ...DEFAULT_GRID_PARAMS, ...params };
  }

  cellKeyOf(lat, lon) {
    const d = this.params.cellDeg;
    return `${Math.floor(lat / d)}_${Math.floor(lon / d)}`;
  }

  initialize(stations) {
    const d = this.params.cellDeg;
    const prev = this.stations;
    this.stations = new Map();
    this.cells = new Map();
    for (const s of stations) {
      if (s.id >= this.params.maxStationId) continue;
      const key = this.cellKeyOf(s.lat, s.lon);
      const old = prev.get(s.id);
      this.stations.set(s.id, {
        id: s.id, lat: s.lat, lon: s.lon, key,
        latest: old ? old.latest : null,
        history: old ? old.history : [],
        reacting: false,
        lastReactingAt: old ? old.lastReactingAt : null,
        onsetAt: old ? old.onsetAt : null,
        baseAtOnset: old ? old.baseAtOnset : null,
        peak: old ? old.peak : null,
      });
      let cell = this.cells.get(key);
      if (!cell) {
        const [iy, ix] = key.split("_").map(Number);
        cell = {
          key, minLat: iy * d, maxLat: (iy + 1) * d, minLon: ix * d, maxLon: (ix + 1) * d,
          centerLat: (iy + 0.5) * d, centerLon: (ix + 0.5) * d,
          iy, ix, members: [], meanHist: [], avg10: null, avgRise: null, firedAt: null, firstOnset: null,
          maxIntensity: null, activeCount: 0, dataCount: 0, fired: false, eventId: null,
        };
        this.cells.set(key, cell);
      }
      cell.members.push(s.id);
    }
    this.events = new Map();
    this.initialized = true;
  }

  resetForSourceChange(now, suppressMs = 0) {
    for (const st of this.stations.values()) {
      st.latest = null; st.history = []; st.reacting = false;
      st.lastReactingAt = null; st.onsetAt = null; st.baseAtOnset = null; st.peak = null;
    }
    for (const c of this.cells.values()) {
      c.firedAt = null; c.firstOnset = null; c.fired = false; c.eventId = null;
      c.maxIntensity = null; c.activeCount = 0; c.dataCount = 0; c.meanHist = []; c.avg10 = null; c.avgRise = null;
    }
    this.events = new Map();
    this.externalEstimates = new Map();
    this.suppressUntil = now + suppressMs;
  }

  // 震源推定(EpicenterEstimator)の結果を、次のtickの判定(独立した地震かどうか等)に使うために受け取る。
  // 「微弱な揺れの検知」の設定に連動して、発火に必要なピーク震度の水準を切り替える。
  setWeakEnabled(enabled) {
    this.params.minPeakIntensity = enabled ? -0.5 : 0.5;
  }

  setExternalEstimates(estimates) {
    this.externalEstimates = estimates || new Map();
  }

  // 1回分(約1秒)のデータを処理する。valuesMap: Map<観測点id, 震度相当値>。
  // 戻り値: { events: 既存のイベントと同じ形式の配列, cells: 地図表示用のセル情報の配列 }
  processTick(valuesMap, now) {
    const p = this.params;
    if (!this.initialized) return { events: [], cells: [] };

    // 1) 観測点ごとの反応の追跡
    for (const st of this.stations.values()) {
      const value = valuesMap.has(st.id) ? valuesMap.get(st.id) : null;
      if (st.latest != null) {
        st.history.push(st.latest);
        if (st.history.length > p.historyLength) st.history.shift();
      }
      const prevValue = st.latest;
      st.latest = value;
      let diff = 0, avgDiff = null;
      if (value != null) {
        if (prevValue != null) diff = value - prevValue;
        if (st.history.length > 0) {
          let sum = 0; for (const h of st.history) sum += h;
          avgDiff = value - sum / st.history.length;
        }
      }
      const reacting = value != null && diff >= p.reactionRiseThreshold && (avgDiff == null || avgDiff >= p.reactionAvgRiseThreshold);
      st.reacting = reacting;
      if (reacting) {
        const gapSec = st.lastReactingAt == null ? Infinity : (now - st.lastReactingAt) / 1000;
        if (st.onsetAt == null || gapSec > p.reonsetGapSec) {
          st.onsetAt = now;
          st.baseAtOnset = prevValue ?? value;
          st.peak = value;
        }
        st.lastReactingAt = now;
      }
      if (st.onsetAt != null && value != null && (st.peak == null || value > st.peak)) st.peak = value;
    }

    // 2) セルごとの集計と発火判定
    const holdMs = p.holdSec * 1000;
    for (const cell of this.cells.values()) {
      let dataCount = 0, maxI = null;
      const active = [];
      for (const id of cell.members) {
        const st = this.stations.get(id);
        if (st.latest == null) continue;
        dataCount++;
        if (maxI == null || st.latest > maxI) maxI = st.latest;
        if (this.isActive(st, now)) active.push(st);
      }
      cell.dataCount = dataCount;
      cell.maxIntensity = maxI;
      cell.activeCount = active.length;
      // セル全体の平均震度(観測点の平均)を1秒ごとに記録し、直近の平均と、それ以前の平静時の平均との差を求める。
      if (dataCount > 0) {
        let sum = 0;
        for (const id of cell.members) { const v = this.stations.get(id).latest; if (v != null) sum += v; }
        cell.meanHist.push(sum / dataCount);
        const keep = p.cellAvgSec + p.cellBaselineSec;
        if (cell.meanHist.length > keep) cell.meanHist.shift();
      }
      const mh = cell.meanHist;
      const recentN = Math.min(p.cellAvgSec, mh.length);
      let recent = null, rise = null;
      if (recentN > 0) {
        recent = 0;
        for (let i = mh.length - recentN; i < mh.length; i++) recent += mh[i];
        recent /= recentN;
        const baseN = mh.length - recentN;
        if (baseN >= 5) {
          let b = 0; for (let i = 0; i < baseN; i++) b += mh[i];
          rise = recent - b / baseN;
        }
      }
      cell.avg10 = recent;
      cell.avgRise = rise;
      let fires = false;
      if (dataCount > 0 && now >= this.suppressUntil) {
        const small = cell.members.length < p.smallCellMembers;
        const minCount = small ? p.smallCellMinActive : p.minActiveCount;
        const minRatio = small ? p.smallCellMinRatio : p.minActiveRatio;
        if (active.length >= minCount && active.length / dataCount >= minRatio) {
          const strong = active.reduce((n, st) => n + ((st.peak ?? st.latest) >= p.minPeakIntensity ? 1 : 0), 0);
          // 基準となる平静時の平均がまだ無い間(起動直後)は、上昇量の条件を課さない。
          const riseOk = p.cellRiseMin <= 0 || rise == null || rise >= p.cellRiseMin;
          fires = riseOk && strong >= Math.min(p.minPeakCount, active.length) && this.isCoherent(active);
        }
      }
      if (fires) {
        cell.firedAt = now;
        let t0 = Infinity;
        for (const st of active) t0 = Math.min(t0, st.onsetAt);
        cell.firstOnset = cell.firstOnset == null ? t0 : Math.min(cell.firstOnset, t0);
      } else if (cell.firedAt != null && now - cell.firedAt > holdMs) {
        cell.firedAt = null;
        cell.firstOnset = null;
      }
      cell.fired = cell.firedAt != null;
    }

    // 3) 発火セルの連結成分 → イベントへの対応づけ
    this.updateEvents(now);

    // 4) 出力
    this.lastNow = now;
    return { events: this.buildEvents(), cells: this.buildCells() };
  }

  isActive(st, now) {
    const p = this.params;
    if (st.onsetAt == null || st.latest == null) return false;
    if ((now - st.onsetAt) / 1000 > p.activeWindowSec) return false;
    return (st.peak ?? st.latest) - (st.baseAtOnset ?? st.latest) >= p.stationMinRise;
  }

  // 反応開始時刻が、最初に反応した観測点からの距離に沿って遅れているか(同時多発的なノイズを除く)。
  isCoherent(active) {
    const p = this.params;
    if (active.length < p.coherenceMinSamples) return true;
    let first = active[0];
    for (const st of active) if (st.onsetAt < first.onsetAt) first = st;
    const xs = [], ys = [];
    for (const st of active) {
      xs.push(haversineKm(first.lat, first.lon, st.lat, st.lon));
      ys.push(st.onsetAt / 1000);
    }
    const r = pearson(xs, ys);
    return r != null && r >= p.coherenceMinCorrelation;
  }

  // dets が、主イベントの推定(est)から見て、P波〜S波の窓に収まる割合が基準以上か。
  inMainWindow(est, dets) {
    const p = this.params;
    if (dets.length === 0) return true;
    let inWin = 0;
    for (const d of dets) {
      const epi = haversineKm(est.lat, est.lon, d.lat, d.lon);
      const [tp, ts] = pAndSTravelSec(epi, est.depthKm ?? 10);
      const lag = (d.detectedAt - est.originTime) / 1000 - tp;
      if (lag >= -p.windowEarlySec && lag <= (ts - tp) + p.windowLateSec) inWin++;
    }
    return inWin / dets.length >= p.windowRatio;
  }

  // 副イベントが、主イベントとは独立した別の地震とみなせるか(検知点が少なければfalse)。
  isIndependent(small, estMain) {
    small.pointCount = small.detections.size;
    small.detectionTimes = small.detections;
    return looksIndependent(small, estMain, DEFAULT_SHAKE_DETECTION_PARAMS);
  }

  // 点震源のフィットを返す(検知点が少ない・誤差が大きいときはnull)。
  usableFit(ev) {
    ev.pointCount = ev.detections.size;
    ev.detectionTimes = ev.detections;
    const fit = independentSourceFit(ev, DEFAULT_SHAKE_DETECTION_PARAMS);
    return fit && fit.cost <= this.params.maxFitCost ? fit : null;
  }

  // dets(相手のフィットの震源から見て)のうち、P波の到達より早く反応した割合と、P波到達との差の平均。
  waveFit(fit, dets) {
    const p = this.params;
    let early = 0, lagSum = 0;
    for (const d of dets) {
      const epi = haversineKm(fit.lat, fit.lon, d.lat, d.lon);
      const tp = pAndSTravelSec(epi, fit.depth)[0];
      const lag = (d.detectedAt - fit.originMs) / 1000 - tp;
      if (lag < -p.earlyVetoSec) early++;
      lagSum += Math.min(Math.abs(lag), p.explainCapSec);
    }
    return { earlyRatio: dets.length ? early / dets.length : 0, cost: dets.length ? lagSum / dets.length : 0 };
  }

  neighborCells(cell) {
    const out = [];
    const r = this.params.neighborRadius;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dy === 0 && dx === 0) continue;
        const nb = this.cells.get(`${cell.iy + dy}_${cell.ix + dx}`);
        if (nb) out.push(nb);
      }
    }
    return out;
  }

  activeDetections(cells, now) {
    const dets = [];
    for (const c of cells) {
      for (const id of c.members) {
        const st = this.stations.get(id);
        if (this.isActive(st, now)) dets.push({ lat: st.lat, lon: st.lon, detectedAt: st.onsetAt });
      }
    }
    return dets;
  }

  // 発火セルを、イベントへ割り当てる。
  //  1) すでにイベントに属しているセルは、発火が続くかぎり、そのイベントのまま。
  //  2) 新しく発火したセル(の連結した塊)は、隣のイベントのうち、そのイベントの震源から伝わるP波より
  //     明らかに早く反応しておらず、P波到達との差が最も小さいものへ入れる。どれにも当てはまらなければ新しいイベント。
  //  3) 隣り合うイベント同士は、お互いの震源から見て、相手の反応がP波より早くなければ、統合する。
  updateEvents(now) {
    const p = this.params;
    // 発火が止まったセルはイベントから外す。セルが無くなったイベントは消す。
    for (const c of this.cells.values()) if (!c.fired) c.eventId = null;
    for (const ev of [...this.events.values()]) {
      let has = false;
      for (const c of this.cells.values()) if (c.eventId === ev.id) { has = true; break; }
      if (!has) this.events.delete(ev.id);
    }

    // 2) 新しく発火したセルの連結成分
    const fresh = [...this.cells.values()].filter((c) => c.fired && c.eventId == null);
    const seen = new Set();
    for (const c0 of fresh) {
      if (seen.has(c0.key)) continue;
      const comp = [];
      const stack = [c0];
      seen.add(c0.key);
      while (stack.length) {
        const cur = stack.pop();
        comp.push(cur);
        for (const nb of this.neighborCells(cur)) {
          if (!nb.fired || nb.eventId != null || seen.has(nb.key)) continue;
          const distKm = haversineKm(cur.centerLat, cur.centerLon, nb.centerLat, nb.centerLon);
          const dtSec = Math.abs((cur.firstOnset ?? 0) - (nb.firstOnset ?? 0)) / 1000;
          if (dtSec > distKm / p.linkMinSpeedKmS + p.linkMarginSec) continue;
          seen.add(nb.key);
          stack.push(nb);
        }
      }
      // 隣のイベントの候補
      const cand = new Map();
      for (const c of comp) for (const nb of this.neighborCells(c)) {
        if (nb.eventId != null && this.events.has(nb.eventId)) cand.set(nb.eventId, this.events.get(nb.eventId));
      }
      const dets = this.activeDetections(comp, now);
      let best = null, bestCost = Infinity, lateSkipped = false;
      for (const ev of cand.values()) {
        // 大きな主イベントの、P波〜S波の窓に収まらない新しいセルは、すぐには入れない(別イベントとして様子を見る)
        const estC = this.externalEstimates.get(ev.id);
        if (estC && estC.originTime != null && ev.detections.size >= p.pendingMainMinPoints && !this.inMainWindow(estC, dets)) { lateSkipped = true; continue; }
        const fit = this.usableFit(ev);
        let cost = 10; // フィットが無い(若いイベント)ときは中立
        if (fit) {
          const w = this.waveFit(fit, dets);
          if (w.earlyRatio >= p.earlyVetoRatio) continue; // 相手の波では起こせない反応 = 別の地震
          cost = w.cost;
        }
        if (cost < bestCost || (cost === bestCost && best && ev.detections.size > best.detections.size)) { best = ev; bestCost = cost; }
      }
      let ev = best;
      if (!ev) {
        // pending: 主イベントのP波〜S波の窓に収まらなかったため、別イベントとして様子を見ている間。独立した別の地震と
        // 判定されるまで、出力しない(主イベントの後続動の断片を、別の地震として見せないため)。
        ev = { id: this.nextId++, createdAt: now, detections: new Map(), pointCount: 0, pending: lateSkipped };
        this.events.set(ev.id, ev);
      }
      for (const c of comp) c.eventId = ev.id;
    }

    // 3) 隣り合うイベント同士の統合
    let merged = true;
    while (merged) {
      merged = false;
      const adj = new Map(); // key "a|b"(a<b) -> true
      for (const c of this.cells.values()) {
        if (c.eventId == null) continue;
        for (const nb of this.neighborCells(c)) {
          if (nb.eventId == null || nb.eventId === c.eventId) continue;
          const a = Math.min(c.eventId, nb.eventId), b = Math.max(c.eventId, nb.eventId);
          adj.set(`${a}|${b}`, [a, b]);
        }
      }
      for (const [a, b] of adj.values()) {
        const A = this.events.get(a), B = this.events.get(b);
        if (!A || !B) continue;
        {
          const [big, small] = A.detections.size >= B.detections.size ? [A, B] : [B, A];
          const estBig = this.externalEstimates.get(big.id);
          if (estBig && estBig.originTime != null && big.detections.size >= p.pendingMainMinPoints) {
            if (this.isIndependent(small, estBig)) continue;
            if (small.detections.size < DEFAULT_SHAKE_DETECTION_PARAMS.indepMinPoints && now - small.createdAt < p.pendingSec * 1000) continue;
          }
        }
        const detsA = [...A.detections.values()], detsB = [...B.detections.values()];
        const fitA = this.usableFit(A), fitB = this.usableFit(B);
        if (fitB && detsA.length && this.waveFit(fitB, detsA).earlyRatio >= p.earlyVetoRatio) continue;
        if (fitA && detsB.length && this.waveFit(fitA, detsB).earlyRatio >= p.earlyVetoRatio) continue;
        for (const [id, d] of B.detections) if (!A.detections.has(id)) A.detections.set(id, d);
        for (const c of this.cells.values()) if (c.eventId === B.id) c.eventId = A.id;
        this.events.delete(B.id);
        merged = true;
        break;
      }
    }

    // 様子見のイベントが、独立した別の地震と判定されたら、出力の対象にする。
    for (const ev of this.events.values()) {
      if (!ev.pending || ev.detections.size < DEFAULT_SHAKE_DETECTION_PARAMS.indepMinPoints) continue;
      let main = null;
      for (const e of this.events.values()) {
        if (e.id !== ev.id && !e.pending && e.detections.size >= p.pendingMainMinPoints && (!main || e.detections.size > main.detections.size)) main = e;
      }
      const est = main ? this.externalEstimates.get(main.id) : null;
      if (est && est.originTime != null && this.isIndependent(ev, est)) ev.pending = false;
    }

    // 大きなイベントの後続動の、小さなイベントを統合する。
    for (const small of [...this.events.values()]) {
      if (!this.events.has(small.id) || small.detections.size > p.codaSmallMaxPoints) continue;
      if (now - small.createdAt < p.pendingSec * 1000) continue; // 独立した地震かを判定できるまで、様子を見る
      let main = null;
      for (const e of this.events.values()) {
        if (e.id !== small.id && e.detections.size >= p.codaMainMinPoints && (!main || e.detections.size > main.detections.size)) main = e;
      }
      if (!main) continue;
      const fit = this.usableFit(main);
      if (!fit) continue;
      let radius = 0;
      for (const d of main.detections.values()) radius = Math.max(radius, haversineKm(fit.lat, fit.lon, d.lat, d.lon));
      const dets = [...small.detections.values()];
      if (dets.length === 0) continue;
      let inside = 0;
      for (const d of dets) if (haversineKm(fit.lat, fit.lon, d.lat, d.lon) <= radius + p.codaMarginKm) inside++;
      if (inside / dets.length < 0.7) continue;
      if (this.waveFit(fit, dets).earlyRatio >= p.earlyVetoRatio) continue;
      for (const [id, d] of small.detections) if (!main.detections.has(id)) main.detections.set(id, d);
      for (const c of this.cells.values()) if (c.eventId === small.id) c.eventId = main.id;
      this.events.delete(small.id);
    }

    // 検知点の追加・更新(イベントに属する、発火中のセルの、反応中の観測点)
    for (const c of this.cells.values()) {
      if (c.eventId == null) continue;
      const ev = this.events.get(c.eventId);
      if (!ev) continue;
      ev.updatedAt = now;
      // セル内の反応中の観測点の、反応開始の下位30%点。これより earlyDropSec 以上早いものはノイズ反応として入れない。
      let onsetFloor = -Infinity;
      if (p.earlyDropSec > 0) {
        const on = [];
        for (const id of c.members) { const st = this.stations.get(id); if (this.isActive(st, now)) on.push(st.onsetAt); }
        if (on.length >= 5) { on.sort((a, b) => a - b); onsetFloor = on[Math.floor((on.length - 1) * 0.3)] - p.earlyDropSec * 1000; }
      }
      for (const id of c.members) {
        const st = this.stations.get(id);
        const d = ev.detections.get(id);
        if (d) {
          if (st.latest != null && (d.intensity == null || st.latest > d.intensity)) d.intensity = st.latest;
          continue;
        }
        if (!this.isActive(st, now)) continue;
        if (st.onsetAt < onsetFloor) continue;
        ev.detections.set(id, { id, lat: st.lat, lon: st.lon, detectedAt: st.onsetAt, intensity: st.latest, cellKey: c.key });
      }
    }
  }

  // 探索の中心: 最初に反応したセルの、早く反応した数点の重心。
  computeSearchCenter(ev) {
    const p = this.params;
    const dets = [...ev.detections.values()];
    if (dets.length === 0) return null;
    let first = dets[0];
    for (const d of dets) if (d.detectedAt < first.detectedAt) first = d;
    const inCell = dets.filter((d) => d.cellKey === first.cellKey).sort((a, b) => a.detectedAt - b.detectedAt).slice(0, p.searchCenterPoints);
    let lat = 0, lon = 0;
    for (const d of inCell) { lat += d.lat; lon += d.lon; }
    return { lat: lat / inCell.length, lon: lon / inCell.length };
  }

  // 推定に使う検知点。outlierRejectSecが有効なら、点震源のフィットから見てP波の到達時刻と大きくずれた点(ノイズ反応など)を除く。
  estimationDetections(ev, dets) {
    const p = this.params;
    if (!(p.outlierRejectSec > 0)) return dets;
    const fit = this.usableFit(ev);
    if (!fit) return dets;
    const kept = dets.filter((d) => {
      const epi = haversineKm(fit.lat, fit.lon, d.lat, d.lon);
      const tp = pAndSTravelSec(epi, fit.depth)[0];
      return Math.abs((d.detectedAt - fit.originMs) / 1000 - tp) <= p.outlierRejectSec;
    });
    return kept.length >= p.outlierMinKeep ? kept : dets;
  }

  // イベントのうち、最初に発火したセルの中心(検知一覧に出す、検知したグリッドの震央地名の判定に使う)。
  // イベントに属するすべてのセル(検知一覧の震央地名のまとめ表示に使う)。
  cellsOf(ev) {
    const out = [];
    for (const c of this.cells.values()) {
      if (c.eventId === ev.id) out.push({ key: c.key, minLat: c.minLat, maxLat: c.maxLat, minLon: c.minLon, maxLon: c.maxLon });
    }
    return out;
  }

  originCellOf(ev) {
    let best = null;
    for (const c of this.cells.values()) {
      if (c.eventId !== ev.id) continue;
      if (!best || (c.firstOnset ?? Infinity) < (best.firstOnset ?? Infinity)) best = c;
    }
    return best ? { lat: (best.minLat + best.maxLat) / 2, lon: (best.minLon + best.maxLon) / 2, minLat: best.minLat, maxLat: best.maxLat, minLon: best.minLon, maxLon: best.maxLon, key: best.key } : null;
  }

  buildEvents() {
    const p = this.params;
    const out = [];
    // 着未着法用の未検知観測点: データがあり、反応していない観測点(全イベント共通。各イベントの検知点は推定側で除かれる)
    let undetected = null;
    if (p.undetectedByData) {
      undetected = [];
      for (const st of this.stations.values()) {
        if (st.latest != null && !st.reacting && !this.isActive(st, this.lastNow)) undetected.push({ id: st.id, lat: st.lat, lon: st.lon });
      }
    }
    for (const ev of this.events.values()) {
      const dets = [...ev.detections.values()];
      if (dets.length < p.minEventPoints || ev.pending) continue;
      let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity, peak = -Infinity;
      let first = dets[0];
      for (const d of dets) {
        minLat = Math.min(minLat, d.lat); maxLat = Math.max(maxLat, d.lat);
        minLon = Math.min(minLon, d.lon); maxLon = Math.max(maxLon, d.lon);
        if (d.intensity != null && d.intensity > peak) peak = d.intensity;
        if (d.detectedAt < first.detectedAt) first = d;
      }
      const searchCenter = this.computeSearchCenter(ev);
      out.push({
        id: ev.id, source: "grid",
        confirmed: true, // 出力するのは12点以上に育った、保留でないイベントだけ(検知一覧は confirmed のものだけを出す)
        ...(undetected ? { undetectedStations: undetected, undetectedNoTimeLimit: p.undetectedNoTimeLimit } : {}),
        pointIds: dets.map((d) => d.id), pointCount: dets.length,
        centerLat: (minLat + maxLat) / 2, centerLon: (minLon + maxLon) / 2,
        minLat, maxLat, minLon, maxLon,
        level: intensityToShakeLevel(Number.isFinite(peak) ? peak : 0, p.levelThresholds),
        peakIntensity: Number.isFinite(peak) ? peak : null,
        createdAt: ev.createdAt, updatedAt: ev.updatedAt,
        originLat: first.lat, originLon: first.lon, originDetectedAt: first.detectedAt,
        searchCenter,
        gridCell: this.originCellOf(ev),
        gridCells: this.cellsOf(ev),
        detections: this.estimationDetections(ev, dets).map((d) => ({
          id: d.id, lat: d.lat, lon: d.lon, detectedAt: d.detectedAt,
          level: intensityToShakeLevel(d.intensity ?? 0, p.levelThresholds), intensity: d.intensity,
          sWaveDetectedAt: null,
        })),
      });
    }
    out.sort((a, b) => b.updatedAt - a.updatedAt);
    return out;
  }

  buildCells() {
    const out = [];
    for (const c of this.cells.values()) {
      out.push({
        key: c.key, minLat: c.minLat, maxLat: c.maxLat, minLon: c.minLon, maxLon: c.maxLon,
        maxIntensity: c.maxIntensity, activeCount: c.activeCount, dataCount: c.dataCount,
        fired: c.fired, eventId: c.eventId, avg10: c.avg10, avgRise: c.avgRise,
      });
    }
    return out;
  }
}
