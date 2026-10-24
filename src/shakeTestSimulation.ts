/**
 * shakeTestSimulation.ts
 * ------------------------------------------------------------
 * 「地震検知テスト」(実験的機能)用の、簡易的な地震動シミュレーター。
 * ユーザー提供の地震シミュレーターアプリ(index.html)のPGV距離減衰式・
 * P波/S波到達時刻モデルを参考にした簡略版。
 *
 * 要件により、AVS30地盤増幅・断層破壊伝播・指向性は含めない(全国一律の
 * 地盤・点震源として扱う、シンプル版)。
 *
 * 実際のリアルタイム観測点データ(realtimeValues)と全く同じ形
 * (Map<観測点id, 震度相当値>)で値を生成することで、揺れ検知エンジン
 * (shakeDetection.ts)や地図描画から見て、本物のデータと区別なく扱える
 * ようにしている。
 */

// 参考アプリのV_MODEL(浅い深さでの代表速度)に相当する、簡易版の固定P波/S波速度(km/s)。
// epicenterEstimation.tsの走時計算でもこの値を流用し、テスト用シミュレーターと
// 震源推定ロジックの物理モデルを一致させている(そちらで変更する場合はこちらも
// 見直すこと)。
export const P_WAVE_SPEED_KM_S = 6.8;
export const S_WAVE_SPEED_KM_S = 3.9;

// 揺れが到達する前の平常時の値(shindoColorScale.tsの配色スケール下限に合わせる)
const BASELINE_INTENSITY = -3.0;
// P波到達時点で立ち上がる、最終震度(ピーク値)に対する割合(初期微動用)
const P_WAVE_RATIO = 0.25;
// S波到達後、ピークまで立ち上がる時間(ms)
const RISE_DURATION_MS = 1500;
// ピーク(その地点の最高震度)を保つ時間(ms)
const HOLD_DURATION_MS = 30000;
// 保持後、平常値まで指数的に減衰していく時間の目安(ms)
const DECAY_DURATION_MS = 18000;
// 震度が大きい観測点ほど減衰を遅くするための倍率。震度0で等倍、震度が
// 上がるほど緩やかに引き延ばす(震度6相当で約2.1倍、震度7相当で約2.45倍)。
function decayDurationScale(peakIntensity) {
  return 1 + Math.max(0, peakIntensity) * 0.2;
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// 震源からの震源距離・M・深さから、その観測点の最終的な震度相当値(ピーク値)を
// 求める。参考アプリのcalculateIntensityから、AVS30地盤増幅・断層破壊伝播・
// 指向性を除いたシンプル版(地盤は全国平均相当で一律とみなす)。
// epicenterEstimation.tsでも、震度の絶対的な減衰カーブ(非弾性減衰項を含む
// ため、単純な相対比較では区別できない「震源までの絶対距離」を制約する
// 材料になる)を使った震源推定の補正に流用している。
//
// 【対策: 距離減衰式の誤差が大きい問題】以前の実装は司・翠川(1999)の式を
// 簡略化しすぎており、以下の点で正式な式と乖離していた
// (参考: https://qiita.com/soshi1822/items/f5fd9ccf6830d834abc4 、
// 気象庁の緊急地震速報で使われている式の解説記事)。
//   - マグニチュード(Mjma)→モーメントマグニチュード(Mw)の変換
//     (宇津, 1982の経験式)を行っていなかった
//   - 断層の広がりを考慮した最短距離への補正(宇津, 1977の式で断層長を
//     求め、震源距離から半分を差し引く。3km下限)を行っておらず、
//     震源距離をそのまま使っていた
//   - 距離減衰項の係数が0.003になっていた(正しくは0.002。旧コメントに
//     「要望により0.0024→0.003に上げた」とあったが、正式な式の係数
//     0.002からもさらに離れてしまっていた)
//   - log10内の補正項の係数が0.0025になっていた(正しくは0.0028)うえ、
//     震源距離そのものに加算していた(正しくはlog10の引数の中だけに
//     現れる項で、距離減衰項(-0.002*X)側には影響しない)
//   - 工学的基盤(Vs=600m/s)から工学的基盤(Vs=400m/s)への変換係数
//     (松岡・翠川, 1994による概算値1.31)を掛けていなかった
// これらの誤差が積み重なり、特に遠方での減衰の効き方(shakeDetection.ts
// 側のイベント統合判定の到達距離推定等に直結)にずれが生じていたと
// 考えられる。
//
// eventTypeCoeff: 地震タイプ別の係数(内陸地殻地震: 0、プレート間地震:
// -0.02、プレート内地震: 0.12)。地震タイプを判別する手段が無いため、
// 既定値0(内陸地殻地震)を使う。
//
// 【既知の限界】地盤増幅度(ARV、NIEDの表層地盤情報等が必要)は、観測点
// ごとの地盤データを持っていないため1.0(無補正)としている。正式な運用
// ではここに観測点ごとの増幅率を掛けることで、さらに精度を上げられる。
export function calcPeakIntensity(magnitudeJma, depthKm, distHypoKm, eventTypeCoeff = 0) {
  // 宇津(1982): Mjma → Mw
  const mw = magnitudeJma - 0.171;
  // 宇津(1977): 断層長(km、マグニチュードから相似則により推定)
  const faultLengthKm = Math.pow(10, 0.5 * mw - 1.85);
  // 断層面からの最短距離(震源距離から断層長の半分を差し引く、3km下限)
  const shortestDistKm = Math.max(distHypoKm - faultLengthKm * 0.5, 3);
  // 司・翠川(1999): 工学的基盤(Vs=600m/s)でのPGV
  const logPgv600 =
    0.58 * mw +
    0.0038 * depthKm +
    eventTypeCoeff -
    Math.log10(shortestDistKm + 0.0028 * Math.pow(10, 0.5 * mw)) -
    0.002 * shortestDistKm -
    1.29;
  const pgv600 = Math.pow(10, logPgv600);
  // 工学的基盤(Vs=600m/s)から工学的基盤(Vs=400m/s)への変換
  // (松岡・翠川, 1994による概算値)。ARV(地盤増幅度)は観測点ごとの
  // データが無いため1.0(無補正)とする。
  const ARV = 1.0;
  const pgvSurface = pgv600 * 1.31 * ARV;
  let intensity = 2.68 + 1.72 * Math.log10(pgvSurface);
  if (intensity > 7.5) intensity = 7.5 + (intensity - 7.5) * 0.1;
  return intensity;
}

function travelTimeMs(distKm, depthKm, speedKmS) {
  const distHypo = Math.sqrt(distKm * distKm + depthKm * depthKm);
  return (distHypo / speedKmS) * 1000;
}

/**
 * テスト用の震源情報(lat, lon, magnitude, depthKm)と観測点一覧から、
 * 各観測点の到達時刻・ピーク震度を事前計算する。シミュレーション開始時に
 * 1回だけ呼べばよい(重い処理ではないが、毎tick呼ぶ必要はない)。
 */
export function prepareShakeTest(quake, stations) {
  const { lat, lon, magnitude, depth } = quake;
  const perStation = new Map();
  for (const s of stations) {
    const distKm = haversineKm(lat, lon, s.lat, s.lon);
    const distHypoKm = Math.sqrt(distKm * distKm + depth * depth);
    const peak = calcPeakIntensity(magnitude, depth, distHypoKm);
    // 【弱い地震の不具合の修正】最終的な震度(peak)が平常値(BASELINE_INTENSITY)以下の
    // 観測点は、実際には揺れが届いても観測値は変わらない。以前は、この観測点にも
    // 「P波到達で peak*0.25 まで上げる」処理を掛けていたため、peakが負の遠方の観測点が、
    // 平常値(-3.0)より高い値(例: peak=-6 → -1.5)まで上がってしまい、弱い地震
    // (M2.5以下)のテストで、全国の観測点が同時に「上昇」して、全国規模の検知になっていた。
    // 揺れが届かない観測点は、データなし(観測値が変わらない)として扱う。
    if (peak <= BASELINE_INTENSITY) continue;
    const pArrivalMs = travelTimeMs(distKm, depth, P_WAVE_SPEED_KM_S);
    const sArrivalMs = travelTimeMs(distKm, depth, S_WAVE_SPEED_KM_S);
    perStation.set(s.id, { peak, pArrivalMs, sArrivalMs });
  }
  return perStation;
}

/**
 * 経過時間(ms)から、その時点での観測点ごとの震度相当値を計算する。
 * 戻り値はrealtimeValuesと同じ形のMap(P波がまだ届いていない観測点は
 * キー自体を含めない = 「データなし」として扱われる)。
 */
export function computeShakeTestValues(perStation, elapsedMs) {
  const values = new Map();
  for (const [id, st] of perStation) {
    if (elapsedMs < st.pArrivalMs) continue;
    // P波の段階で到達するレベル。peakが0以上なら従来どおりpeakの25%。peakが負(平常値より
    // わずかに高い程度の弱い揺れ)の場合は、peak*0.25ではpeakを上回ってしまうので、
    // peakそのものにする(P波の段階でpeakを超えない)。
    const pLevel = st.peak >= 0 ? st.peak * P_WAVE_RATIO : st.peak;
    let value;
    if (elapsedMs < st.sArrivalMs) {
      // P波到達後・S波到達前 — 弱い初期微動
      const t = (elapsedMs - st.pArrivalMs) / Math.max(1, st.sArrivalMs - st.pArrivalMs);
      value = BASELINE_INTENSITY + (pLevel - BASELINE_INTENSITY) * t;
    } else {
      const sinceS = elapsedMs - st.sArrivalMs;
      if (sinceS < RISE_DURATION_MS) {
        // S波到達後、ピークまで立ち上がる
        const t = sinceS / RISE_DURATION_MS;
        value = pLevel + (st.peak - pLevel) * t;
      } else if (sinceS < RISE_DURATION_MS + HOLD_DURATION_MS) {
        // その地点の最高震度を一定時間そのまま保つ
        value = st.peak;
      } else {
        // 保持後、平常値まで指数的に減衰。震度が大きい観測点ほど減衰に時間が
        // かかるようにする(減衰が始まるタイミング自体は変えない。減衰の
        // 進み方=速さだけを、震度に応じて引き延ばす)。
        const decayScale = decayDurationScale(st.peak);
        const t = (sinceS - RISE_DURATION_MS - HOLD_DURATION_MS) / (DECAY_DURATION_MS * decayScale);
        const decay = Math.exp(-3 * Math.min(1, t));
        value = BASELINE_INTENSITY + (st.peak - BASELINE_INTENSITY) * decay;
      }
    }
    values.set(id, value);
  }
  return values;
}

// このテストが「終わった」とみなせるか(全観測点が平常値近くまで減衰し終えたか)の目安。
// 経過時間がこれを超えたら、呼び出し側で自動的にテストを終了してよい。
// 震度に応じて減衰時間が観測点ごとに異なるため、「S波到達+保持+減衰」の
// 合計が一番長くかかる観測点を基準にする。
export function isShakeTestFinished(perStation, elapsedMs) {
  let latestFinishMs = 0;
  for (const st of perStation.values()) {
    const finishMs = st.sArrivalMs + RISE_DURATION_MS + HOLD_DURATION_MS + DECAY_DURATION_MS * decayDurationScale(st.peak);
    latestFinishMs = Math.max(latestFinishMs, finishMs);
  }
  return elapsedMs > latestFinishMs + 3000;
}
