/* ─────────────────────────────────────────────────────
   震源推定の信頼度(0.00〜1.00、0.01刻み)と、その表示の判定。

   要件: docs「信頼度による震源推定の表示制御 要件書」。
   - 信頼度は推定器(epicenterEstimation.ts の EpicenterEstimator.updateAll)の
     出力に付ける。画面側は値を読むだけ。
   - 推定が最初に出た時点から計算できる(経過時間は加点の材料にするだけで、
     表示の必須条件にはしない=初動を遅らせない)。
   - 表示は薄い3段階+濃い1段階の4段階(estimateDisplayLevel)。
   - 信頼度が下限未満の推定は、既定では表示しない。設定で表示を選べる。

   【決定した値】信頼度の下限(これ未満は、既定では表示しない)は 0.55
   (ESTIMATE_MIN_DISPLAY_CONFIDENCE)。ユーザーの判断。
   【4段階の見え方】下限(0.55)未満が、薄い3段階(下限を3等分した0.18・0.37で区切る。
   設定「信頼度の低い推定を表示」をオンにしたときだけ表示される)、下限以上が、濃い1段階。
   【未確定の値】各材料の係数は、実データでテストしてから決める。
   下の定数は仮の値で、このファイルの1か所だけを直せばよい。
   ───────────────────────────────────────────────────── */

// 各材料の係数(合計100)。計算した得点を100で割って、信頼度(0.00〜1.00)にする。
// 【実データのリプレイを踏まえた設計】
// - 最初の版は、点数・方位・Mの有無だけで55点まで取れてしまい、深さが探索上限に
//   張り付いていても、位置が毎秒動いていても、信頼度が高く出ていた。「時間とともに
//   安定したか」「解が探索範囲の端に張り付いていないか」に重みを移した。
// - 到達時刻の誤差(RMS)は、信頼度に使わない。位置が合っている実地震でも1〜2.5秒に
//   なり(点が多い大きな地震ほど大きい)、逆に2点しかない推定では誤差が自明に0に
//   なって満点になるため、良し悪しの指標にならなかった。
export const CONFIDENCE_WEIGHTS = {
  points: 12,      // 検知点数(20点で満点。実データでは100点超も普通なので、差が付きにくい材料)
  stability: 31,   // 位置・深さが動いていない時間
  uniqueness: 25,  // 解の一意性が○のまま続いている時間
  azimuth: 12,     // 観測点の方位の偏りの少なさ
  depth: 13,       // 深さが探索範囲の端(上限・0km)に張り付いていないか
  magnitude: 7,    // Mが算出でき、探索範囲の端に張り付いていないか
} as const;

// 検知点数がこれ以上で、点数の材料が満点になる(MIN_DETECTION_POINTS=2 が0点)。
export const CONFIDENCE_FULL_POINTS = 20;
// 位置・深さがこの時間動いていなければ、安定の材料が満点になる。
export const CONFIDENCE_FULL_STABLE_MS = 10000;
// 解の一意性が○のままこの時間続いたら、一意性の材料が満点になる。
// (深さが探索上限の手前と上限の間を行き来する推定では、一意性が○×を繰り返す。)
export const CONFIDENCE_FULL_UNIQUE_HOLD_MS = 3000;
// 方位ギャップ(観測点が一方向に偏っている度合い)。180度以下で満点、360度で0点。
const AZIMUTH_GAP_GOOD_DEG = 180;
// 深さが探索上限よりこの距離(km)以上手前なら満点、上限ちょうどで0点。
export const CONFIDENCE_DEPTH_FULL_MARGIN_KM = 40;
// 深さがこの値以下(探索範囲の浅い側の端=0km)なら、端に張り付いたとみなして0点。
export const CONFIDENCE_DEPTH_FLOOR_KM = 0.5;
// 【点数による上限】検知点数が少ないと、位置は少数の点で決まるだけで、一意性も
// 誤差も自明に良く見える(実データでは、2点だけの推定が安定時間とともに0.81まで
// 上がり、実際には1,500km離れていた)。点数がbelow未満の間は、信頼度をmax以下に
// 抑える。点数が少ない順に並べる。
export const CONFIDENCE_FEW_POINTS_CAPS: ReadonlyArray<readonly [number, number]> = [
  [4, 0.40], // 4点未満: 最大0.40
  [8, 0.60], // 8点未満: 最大0.60(MIN_CONFIRMED_POINTS=8)
];

// 表示する信頼度の下限(これ未満は、既定では表示しない)。0=下限なし。
// 0.55(ユーザーの判断)。設定「信頼度の低い推定を表示」をオンにすると、これ未満も表示する。
export const ESTIMATE_MIN_DISPLAY_CONFIDENCE = 0.55;
// 見え方の4段階の境界。信頼度がこの値未満の間は、順に最も薄い段階、2番目、3番目、
// これ以上(=下限以上)は濃い段階。下限未満を3等分して、薄い3段階にしている。
// (下限を変えても、3段階の区切りが、下限に追従する)
export const ESTIMATE_LEVEL_BOUNDARIES = [
  Math.round(ESTIMATE_MIN_DISPLAY_CONFIDENCE / 3 * 100) / 100,     // 0.18
  Math.round(ESTIMATE_MIN_DISPLAY_CONFIDENCE * 2 / 3 * 100) / 100, // 0.37
  ESTIMATE_MIN_DISPLAY_CONFIDENCE,                                 // 0.55
] as const;
// 一度表示した推定は、下限よりこの値だけ低くなるまで消さない(ちらつき防止)。
export const ESTIMATE_HIDE_HYSTERESIS = 0.05;

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

export interface ConfidenceInput {
  pointCount: number;
  stableForMs: number;
  uniquenessConfirmed: boolean;
  uniqueHoldMs: number;
  azimuthalGapDeg: number | null | undefined;
  depthKm: number;
  depthLimitKm: number | null | undefined;
  magnitude: number | null | undefined;
  magnitudeAtBound: boolean;
}

export interface ConfidenceParts {
  points: number;      // 各材料の得点率(0〜1)
  stability: number;
  uniqueness: number;
  azimuth: number;
  depth: number;
  magnitude: number;
  cap: number | null;  // 点数による上限が掛かっているとき、その値
  // 同時にある最大のイベントとの点数比による割り引き(1=割り引きなし)。
  // computeEstimateConfidenceでは付かず、EpicenterEstimator.updateAllが付ける。
  relativeFactor?: number;
}

export interface ConfidenceResult {
  confidence: number; // 0.00〜1.00(0.01刻み)
  parts: ConfidenceParts;
}

const round2 = (v: number) => Math.round(v * 100) / 100;

// 点数による上限(掛からなければnull)
export function confidenceCapForPoints(pointCount: number): number | null {
  for (const [below, max] of CONFIDENCE_FEW_POINTS_CAPS) {
    if (pointCount < below) return max;
  }
  return null;
}

// 【同時にある最大のイベントとの比較】大きな地震では、その後の揺れ(後続波や
  // 表面波)を、別の地震として検知してしまう(別の場所に小さなイベントが何個も
  // 出る)ことが、実データのリプレイで見つかった。それらは、遠く離れた場所に
  // 位置が決まり、安定時間とともに信頼度が高く出てしまう。同時に存在する最大の
  // イベントより点数が少ないイベントは、点数の比のこの乗数で割り引く
  // (最大のイベント自身は割り引かない)。
  // 注意: 本当に同時に別々の地震が起きた場合も、小さい方は割り引かれる。
  // 乗数は仮の値(小さいほど、小さなイベントを強く割り引く)。
export const CONFIDENCE_RELATIVE_SIZE_EXPONENT = 0.25;

export function relativeSizeFactor(pointCount: number, maxConcurrentPoints: number): number {
  if (!(maxConcurrentPoints > 0) || pointCount >= maxConcurrentPoints) return 1;
  return Math.pow(Math.max(0, pointCount) / maxConcurrentPoints, CONFIDENCE_RELATIVE_SIZE_EXPONENT);
}

export function computeEstimateConfidence(input: ConfidenceInput): ConfidenceResult {
  const points = clamp01((input.pointCount - 2) / (CONFIDENCE_FULL_POINTS - 2));
  const stability = clamp01(input.stableForMs / CONFIDENCE_FULL_STABLE_MS);
  const uniqueness = input.uniquenessConfirmed ? clamp01(input.uniqueHoldMs / CONFIDENCE_FULL_UNIQUE_HOLD_MS) : 0;
  const gap = input.azimuthalGapDeg;
  const azimuth = gap == null ? 0 : clamp01(1 - (gap - AZIMUTH_GAP_GOOD_DEG) / (360 - AZIMUTH_GAP_GOOD_DEG));
  const depth = input.depthKm <= CONFIDENCE_DEPTH_FLOOR_KM
    ? 0 // 浅い側の端(0km)に張り付いている
    : input.depthLimitKm == null
      ? 1 // 探索上限が無い(点数が少なく深さを固定している)間は、上限への張り付きは無い
      : clamp01((input.depthLimitKm - input.depthKm) / CONFIDENCE_DEPTH_FULL_MARGIN_KM);
  const magnitude = input.magnitude != null && !input.magnitudeAtBound ? 1 : 0;

  const w = CONFIDENCE_WEIGHTS;
  const total = w.points * points + w.stability * stability + w.uniqueness * uniqueness
    + w.azimuth * azimuth + w.depth * depth + w.magnitude * magnitude;
  const cap = confidenceCapForPoints(input.pointCount);
  const raw = total / 100;
  const capped = cap == null ? raw : Math.min(raw, cap);
  return {
    confidence: round2(clamp01(capped)),
    parts: {
      points: round2(points),
      stability: round2(stability),
      uniqueness: round2(uniqueness),
      azimuth: round2(azimuth),
      depth: round2(depth),
      magnitude,
      cap,
    },
  };
}

// 見え方の段階(0=最も薄い 〜 3=濃い)。下限未満の推定(設定で表示を選んだ場合)は、
// 信頼度に応じた薄い3段階(0〜2)、下限以上は濃い段階(3)。
export function estimateDisplayLevel(confidence: number | null | undefined): 0 | 1 | 2 | 3 {
  if (confidence == null || !Number.isFinite(confidence)) return 3; // 信頼度が付いていない推定は従来どおり
  const [b1, b2, b3] = ESTIMATE_LEVEL_BOUNDARIES;
  if (confidence < b1) return 0;
  if (confidence < b2) return 1;
  if (confidence < b3) return 2;
  return 3;
}

// 信頼度が下限未満の推定を取り除く(showLow=trueなら何も取り除かない)。
// shownIds: 前回までに表示したeventIdの集合(ヒステリシス用。呼び出し側が持ち続ける)。
export function filterEstimatesByConfidence(
  estimates: Map<string | number, any>,
  showLow: boolean,
  shownIds: Set<string | number>,
): Map<string | number, any> {
  if (showLow || ESTIMATE_MIN_DISPLAY_CONFIDENCE <= 0 || !estimates || estimates.size === 0) {
    shownIds.clear();
    return estimates;
  }
  const filtered = new Map<string | number, any>();
  for (const [eventId, est] of estimates) {
    if (!est || est.confidence == null) { filtered.set(eventId, est); continue; }
    // 0.55-0.05が、浮動小数点の誤差で0.5000000000000001にならないよう、0.01刻みに丸める
    const threshold = shownIds.has(eventId)
      ? round2(ESTIMATE_MIN_DISPLAY_CONFIDENCE - ESTIMATE_HIDE_HYSTERESIS)
      : ESTIMATE_MIN_DISPLAY_CONFIDENCE;
    if (est.confidence >= threshold) {
      filtered.set(eventId, est);
      shownIds.add(eventId);
    } else {
      shownIds.delete(eventId);
    }
  }
  for (const id of [...shownIds]) if (!estimates.has(id)) shownIds.delete(id);
  return filtered;
}

// テスト用: 信頼度が0.05以上変わるたびに、内訳つきでログに出す(設定タブの「ログ」で
// 見られる)。下限を決めるため、非表示になる推定も含めて全部記録する。
// lastLogged: eventId -> 最後にログへ出した信頼度(呼び出し側が持ち続ける)。
export function logEstimateConfidenceChanges(
  estimates: Map<string | number, any>,
  lastLogged: Map<string | number, number>,
): void {
  for (const [eventId, est] of estimates) {
    if (!est || est.confidence == null) continue;
    const prev = lastLogged.get(eventId);
    if (prev != null && Math.abs(est.confidence - prev) < 0.05 - 1e-9) continue;
    lastLogged.set(eventId, est.confidence);
    const p = est.confidenceParts;
    console.info(
      `[信頼度] イベント${eventId} 信頼度${est.confidence.toFixed(2)}${p?.cap != null ? `(点数で上限${p.cap.toFixed(2)})` : ""}`
      + `${p?.relativeFactor != null && p.relativeFactor < 1 ? `(最大のイベントとの点数比で×${p.relativeFactor.toFixed(2)})` : ""} 点数${est.pointCount}`
      + ` 安定${Math.round((est.stableForMs ?? 0) / 1000)}秒 一意性${est.uniquenessConfirmed ? "○" : "×"}(得点${p?.uniqueness ?? "--"})`
      + ` 方位ギャップ${est.azimuthalGapDeg != null ? Math.round(est.azimuthalGapDeg) : "--"}度`
      + ` 深さ${Math.round(est.depthKm)}km/上限${est.depthLimitKm ?? "なし"}km`
      + ` M${est.magnitude != null ? est.magnitude.toFixed(1) : "--"}${est.magnitudeBound === "low" ? "(M3.0以下)" : est.magnitudeBound === "high" ? "(M8.0以上)" : ""}`
      + ` 到達時刻RMS${est.timeRmsMs != null ? Math.round(est.timeRmsMs) : "--"}ms(信頼度には使わない参考値)`
      + ` 位置${est.lat},${est.lon}`,
    );
  }
  for (const id of [...lastLogged.keys()]) if (!estimates.has(id)) lastLogged.delete(id);
}
