/**
 * shakeTestWaveform.ts
 * ------------------------------------------------------------
 * 「地震検知テスト」用の、より現実的な地震動(最終震度・地盤増幅・走時・時間波形)のモデル。
 *
 * 【出典】
 *  - 最終震度の式・地盤増幅・P波/S波速度・有限断層の考え方は、WE-Simulator
 *    (https://github.com/itachi-kun-itc/WE-Simulator)の計算を参考にした。コードは転記せず、式と考え方を
 *    このリポジトリ用に書き直している(WE-Simulatorにライセンス表記が無いため)。
 *  - 揺れが収まる過程(減衰)と、平常時の揺らぎは、WE-Simulatorにはない部分で、MeteoQuake独自の暫定モデル。
 *
 * 【震源推定側のモデルとは別】
 * 震源推定(epicenterEstimation.ts)が使う距離減衰式・走時(shakeTestSimulation.tsのcalcPeakIntensity、
 * P_WAVE_SPEED_KM_S/S_WAVE_SPEED_KM_S)は変更しない。テスト波形だけを現実的にすることで、推定が
 * 「実際とは少し違うモデル」で解くことになり、実際の運用に近い誤差が出る(これが狙い)。
 */

// ── WE-Simulatorに合わせた定数 ──
export const WAVE_P_KM_S = 6.5;
export const WAVE_S_KM_S = 3.8;
const MAGNITUDE_SLOPE = 1.43;          // M 1あたりの計測震度
const DISTANCE_LOG_ATTENUATION = 2.12; // log10(R + 20) の係数
const DISTANCE_LINEAR_ATTENUATION = 0.0042;
const BASELINE_DAMPING = 0.95;
const SATURATION_START_M = 7.4;        // これを超えるMは震度が飽和する
const SATURATION_FACTOR = 0.32;
const FINITE_FAULT_MIN_M = 6.6;        // このM以上は有限断層(小震源に分割)で扱う
const FAULT_SAMPLE_MAX_INTERVALS = 16;
const FAULT_SAMPLE_MIN_SPACING_KM = 12;
export const DEFAULT_RUPTURE_SPEED_KM_S = 2.8;
const SITE_SEARCH_MAX_KM = 40; // 観測点から、これより遠い気象庁観測点の地盤値は使わない

// 揺れが届く前の平常値(shindoColorScale.tsの配色スケール下限に合わせる)
export const WAVE_BASELINE_INTENSITY = -3.0;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const smooth = (x: number) => { const t = clamp(x, 0, 1); return t * t * (3 - 2 * t); };

// 文字列から安定した[0,1)の値を作る(FNV-1a)。同じ観測点なら、毎回同じ揺らぎになる。
export function stableUnit(key: string): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) / 4294967296;
}

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function destinationPoint(lat: number, lon: number, bearingDeg: number, distKm: number) {
  const d = distKm / 6371;
  const br = bearingDeg * Math.PI / 180;
  const la1 = lat * Math.PI / 180;
  const lo1 = lon * Math.PI / 180;
  const la2 = Math.asin(Math.sin(la1) * Math.cos(d) + Math.cos(la1) * Math.sin(d) * Math.cos(br));
  const lo2 = lo1 + Math.atan2(Math.sin(br) * Math.sin(d) * Math.cos(la1), Math.cos(d) - Math.sin(la1) * Math.sin(la2));
  return { lat: la2 * 180 / Math.PI, lon: ((lo2 * 180 / Math.PI + 540) % 360) - 180 };
}

/* ───────── 地盤増幅 ───────── */

// ARV(最大速度の増幅度)とAVS30(地表から30mまでの平均S波速度)から、計測震度への補正値(-0.45〜+0.75)を求める。
// ARVは対数で効かせ(控えめに)、AVS30が小さい(柔らかい)ほど上乗せする。深部の厚さのデータは無いため含めない。
export function siteAmplification(site: { arv?: number; avs?: number } | null | undefined): number {
  if (!site) return 0;
  const arv = site.arv;
  const avs = site.avs;
  const velocity = Number.isFinite(arv) && (arv as number) > 0 ? clamp(1.05 * Math.log10(arv as number), -0.35, 0.62) : 0;
  const soft = Number.isFinite(avs) && (avs as number) > 0 ? clamp((420 - (avs as number)) / 360, -0.28, 0.45) : 0;
  return clamp(velocity + soft * 0.45, -0.45, 0.75);
}

export interface SiteValue { arv: number; avs: number; distKm: number }

// 気象庁観測点マスタ(stations_with_amp_revised.json)から、最寄りの観測点の地盤値を引く関数を作る。
// 40km以内に観測点が無ければnull(補正なし)。
export function buildSiteLookup(master: any[] | null | undefined): (lat: number, lon: number) => SiteValue | null {
  const CELL = 0.25; // 度
  const grid = new Map<string, { lat: number; lon: number; arv: number; avs: number }[]>();
  for (const s of master || []) {
    const lat = Number(s.lat), lon = Number(s.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const key = `${Math.floor(lat / CELL)},${Math.floor(lon / CELL)}`;
    const arr = grid.get(key) || [];
    arr.push({ lat, lon, arv: Number(s.ARV), avs: Number(s.AVS30) });
    grid.set(key, arr);
  }
  return (lat, lon) => {
    const ci = Math.floor(lat / CELL), cj = Math.floor(lon / CELL);
    let best: { arv: number; avs: number; distKm: number } | null = null;
    for (let di = -2; di <= 2; di++) {
      for (let dj = -2; dj <= 2; dj++) {
        for (const s of grid.get(`${ci + di},${cj + dj}`) || []) {
          const km = haversineKm(lat, lon, s.lat, s.lon);
          if (km <= SITE_SEARCH_MAX_KM && (!best || km < best.distKm)) best = { arv: s.arv, avs: s.avs, distKm: km };
        }
      }
    }
    return best;
  };
}

/* ───────── 最終震度(ピーク値) ───────── */

// 断層長(km)。M6.6未満は点震源として扱う(0)。
export function ruptureLengthKm(magnitude: number): number {
  if (magnitude < FINITE_FAULT_MIN_M) return 0;
  return clamp(Math.pow(10, -2.44 + 0.59 * magnitude), 0, 520);
}

// 震源距離(km)・M・地盤補正から、その観測点の最終的な計測震度(ピーク値)。
// 下限は0に丸めない(遠方で平常値を下回る観測点を、「揺れが届かない」として除くため)。上限は7。
export function peakIntensityAt(magnitude: number, hypoKm: number, siteAmp: number): number {
  const distance = Math.max(hypoKm, 1);
  const saturation = SATURATION_FACTOR * Math.max(magnitude - SATURATION_START_M, 0) ** 2;
  const v = MAGNITUDE_SLOPE * magnitude - saturation
    - DISTANCE_LOG_ATTENUATION * Math.log10(distance + 20)
    - DISTANCE_LINEAR_ATTENUATION * distance
    + siteAmp - BASELINE_DAMPING;
  return Math.min(v, 7);
}

/* ───────── 有限断層 ───────── */

export interface FaultSpec {
  strikeDeg: number;                            // 断層の走向(北から時計回り、度)
  direction: "forward" | "backward" | "both";  // 破壊の進む向き(震源=破壊開始点)
  ruptureSpeedKmS: number;                      // 破壊伝播速度
}
export const DEFAULT_FAULT: FaultSpec = { strikeDeg: 0, direction: "both", ruptureSpeedKmS: DEFAULT_RUPTURE_SPEED_KM_S };

export interface SourceSample { lat: number; lon: number; delaySec: number }

// 震源(破壊開始点)を通る走向の線上に、小震源を並べる。破壊の遅れ = 開始点からの距離 ÷ 破壊速度。
// M6.6未満、または断層指定なしの場合は、震源1点(遅れ0)。
export function faultSamples(quake: { lat: number; lon: number; magnitude: number }, fault?: FaultSpec | null): SourceSample[] {
  const origin: SourceSample = { lat: quake.lat, lon: quake.lon, delaySec: 0 };
  const length = ruptureLengthKm(quake.magnitude);
  if (!fault || length <= 0) return [origin];
  const speed = clamp(fault.ruptureSpeedKmS || DEFAULT_RUPTURE_SPEED_KM_S, 0.5, 4);
  let intervals = clamp(Math.round(length / FAULT_SAMPLE_MIN_SPACING_KM), 1, FAULT_SAMPLE_MAX_INTERVALS);
  let from = 0, to = length;
  if (fault.direction === "backward") { from = -length; to = 0; }
  if (fault.direction === "both") { from = -length / 2; to = length / 2; if (intervals % 2 === 1) intervals += 1; }
  const out: SourceSample[] = [];
  for (let i = 0; i <= intervals; i++) {
    const along = from + ((to - from) * i) / intervals;
    const p = along === 0 ? { lat: quake.lat, lon: quake.lon } : destinationPoint(quake.lat, quake.lon, along > 0 ? fault.strikeDeg : fault.strikeDeg + 180, Math.abs(along));
    out.push({ lat: p.lat, lon: p.lon, delaySec: Math.abs(along) / speed });
  }
  return out;
}

/* ───────── 観測点ごとの時間波形 ───────── */

export interface WaveProfile {
  model: "realistic";
  peak: number;          // 最終震度(その観測点の最高値)
  pLevel: number;        // P波の段階(初期微動)で到達する震度
  pArrivalMs: number;
  sArrivalMs: number;
  riseMs: number;        // S波到達から、ピークまでの立ち上がり時間
  strongMs: number;      // ピーク付近(強い揺れ)が続く時間
  tailMs: number;        // 強い揺れの後、減衰の時間スケール
  endMs: number;         // ほぼ平常値に戻る時刻(テスト開始からの経過)
  surge: number;         // 主動の急な立ち上がりで、先に届く割合(0.84〜0.97)
  fluctAmp: number;      // ピーク後の揺れの強弱(複数ピーク)の深さ
  fluctPeriodMs: number;
  noiseAmp: number;      // 観測点ごとの小さな揺らぎ
  noisePhase1: number; noisePhase2: number; noisePeriod1Ms: number; noisePeriod2Ms: number;
}

export interface WaveInput {
  stationId: number | string;
  magnitude: number;
  hypoKm: number;          // 最も近い小震源までの震源距離
  pSec: number;            // P波到達(最も早い小震源から)
  sSec: number;            // S波到達(最も早い小震源から)
  sLastSec: number;        // 最も遅い小震源のS波到達(有限断層の継続時間の延長に使う)
  site: { arv?: number; avs?: number } | null;
  offshore: boolean;
}

// 観測点1つ分の波形パラメータを作る。揺れが届かない観測点(最終震度が平常値以下)はnull。
export function buildWaveProfile(input: WaveInput): WaveProfile | null {
  const { stationId, magnitude: M, hypoKm, site } = input;
  const u = (k: string) => stableUnit(`${stationId}:${k}`);
  const siteAmp = siteAmplification(site);
  // 観測点ごとの、式では説明できない揺れのばらつき(±0.2程度)。同じ観測点なら毎回同じ。
  const scatter = (u("peak") - 0.5) * 0.4;
  const peak = Math.min(peakIntensityAt(M, hypoKm, siteAmp) + scatter, 7);
  if (peak <= WAVE_BASELINE_INTENSITY) return null;

  const avs = site?.avs;
  const soft = Number.isFinite(avs) && (avs as number) > 0 ? clamp((420 - (avs as number)) / 360, -0.28, 0.45) : 0;
  const soft01 = clamp(soft / 0.45, 0, 1);

  // P波の段階: 最終震度に対する割合(大きいM・柔らかい地盤ほど大きい)。上限は約2.4(震源が近いと約3.0)。
  // 最低でも0.5(記録に残る程度)。ただし、最終震度を超えない。
  const share = clamp(0.30 + 0.035 * (M - 5) + 0.08 * soft, 0.22, 0.52);
  const cap = 2.4 + 0.6 * clamp(1 - hypoKm / 60, 0, 1);
  const pLevel = peak < 0 ? peak : Math.max(Math.min(peak * share, cap), Math.min(peak, 0.5));

  // 到達時刻(観測点ごとの小さなずれを加える)
  let pArrivalMs = input.pSec * 1000 + (u("p") - 0.5) * 300;
  let sArrivalMs = input.sSec * 1000 + (u("s") - 0.5) * 400;
  pArrivalMs = Math.max(0, pArrivalMs);
  sArrivalMs = Math.max(pArrivalMs + 200, sArrivalMs);

  // S波の立ち上がり: 遠いほど・柔らかいほど・大きなMほど長い。
  const riseMs = clamp(1100 + 13 * hypoKm + 500 * soft01 + 150 * Math.max(M - 6, 0), 1000, 5500);
  // 揺れの継続時間(秒): Mが大きく、遠いほど長い。有限断層では、小震源のS波が着く時間差の分だけ延びる。沖合は長め。
  const spreadSec = clamp((input.sLastSec - input.sSec) * 0.5, 0, 60);
  const durationSec = (clamp(10 + 13 * (M - 5), 6, 70) + clamp(0.1 * hypoKm, 0, 30) + spreadSec) * (input.offshore ? 1.2 : 1);
  const strongMs = durationSec * 1000 * 0.2;
  const tailMs = (durationSec * 1000) / 4;
  // 減衰が0.01を下回るまで(2成分のうち遅い成分で見積もる)
  const endMs = sArrivalMs + riseMs + strongMs + tailMs * 3 * Math.log(30);

  return {
    model: "realistic",
    peak, pLevel, pArrivalMs, sArrivalMs, riseMs, strongMs, tailMs, endMs,
    surge: 0.84 + 0.13 * u("surge"),
    fluctAmp: 0.10 + 0.02 * clamp(M - 5, 0, 3) + (input.offshore ? 0.03 : 0),
    fluctPeriodMs: 2500 + 3500 * u("fp"),
    noiseAmp: 0.06,
    noisePhase1: u("n1") * 2 * Math.PI, noisePhase2: u("n2") * 2 * Math.PI,
    noisePeriod1Ms: 3000 + 4000 * u("np1"), noisePeriod2Ms: 900 + 1400 * u("np2"),
  };
}

// 経過時間(ms)での観測点の値。P波がまだ届いていなければundefined(=データなし)。
export function waveValueAt(st: WaveProfile, elapsedMs: number): number | undefined {
  if (elapsedMs < st.pArrivalMs) return undefined;
  const base = WAVE_BASELINE_INTENSITY;
  const noise = st.noiseAmp * (
    0.6 * Math.sin((2 * Math.PI * elapsedMs) / st.noisePeriod1Ms + st.noisePhase1) +
    0.4 * Math.sin((2 * Math.PI * elapsedMs) / st.noisePeriod2Ms + st.noisePhase2)
  );
  let level: number; // 平常値からの絶対値(ノイズを加える前)
  if (elapsedMs < st.sArrivalMs) {
    // P波〜S波: 素早い立ち上がり(約0.7秒)と、S波前の緩やかな上昇の合成
    const gap = Math.max(1, st.sArrivalMs - st.pArrivalMs);
    const u = (elapsedMs - st.pArrivalMs) / gap;
    const onset = clamp(700 / gap, 0.03, 0.3);
    const frac = 0.6 * smooth(u / onset) + 0.4 * Math.pow(u, 1.6);
    level = base + (st.pLevel - base) * frac;
  } else {
    const tau = elapsedMs - st.sArrivalMs;
    if (tau < st.riseMs) {
      // S波の立ち上がり: 主動の急な立ち上がり(surgeまで)のあと、ゆるやかにピークへ
      const r = tau / st.riseMs;
      const shape = r < 0.4 ? st.surge * Math.sin((Math.PI / 2) * (r / 0.4)) : st.surge + (1 - st.surge) * smooth((r - 0.4) / 0.6);
      level = st.pLevel + (st.peak - st.pLevel) * shape;
    } else {
      const tc = tau - st.riseMs;
      // 強い揺れの間は包絡が1。その後、2成分(速い・遅い)で減衰して平常値へ。
      let env = 1;
      if (tc > st.strongMs) {
        const x = (tc - st.strongMs) / st.tailMs;
        env = 0.7 * Math.exp(-x) + 0.3 * Math.exp(-x / 3);
      }
      // 複数のピーク(揺れの強弱)。ピークの瞬間(tc=0)は強弱の谷でなく、最大。
      // 周期の異なる2つの強弱を重ねて、規則的になりすぎないようにする(tc=0では両方0 → ピークの瞬間は最大)
      const w = 0.5 - 0.5 * (0.6 * Math.cos((2 * Math.PI * tc) / st.fluctPeriodMs) + 0.4 * Math.cos((2 * Math.PI * tc) / (st.fluctPeriodMs * 0.62)));
      level = base + (st.peak - base) * env * (1 - st.fluctAmp * w);
    }
  }
  return level + noise;
}

/* ───────── 観測点一覧への適用 ───────── */

export interface RealisticOptions {
  fault?: FaultSpec | null;                                         // M6.6以上で有効
  siteLookup?: ((lat: number, lon: number) => SiteValue | null) | null; // 観測点の地盤値
  offshore?: boolean;                                               // 震央が海域か(継続時間を延ばす)
}

export function prepareRealisticWaves(
  quake: { lat: number; lon: number; magnitude: number; depth: number },
  stations: { id: number | string; lat: number; lon: number }[],
  options: RealisticOptions = {},
): Map<number | string, WaveProfile> {
  const samples = faultSamples(quake, options.fault ?? null);
  const out = new Map<number | string, WaveProfile>();
  for (const s of stations) {
    let hypoMin = Infinity, pMin = Infinity, sMin = Infinity, sMax = -Infinity;
    for (const src of samples) {
      const d = haversineKm(src.lat, src.lon, s.lat, s.lon);
      const hypo = Math.sqrt(d * d + quake.depth * quake.depth);
      hypoMin = Math.min(hypoMin, hypo);
      pMin = Math.min(pMin, src.delaySec + hypo / WAVE_P_KM_S);
      const tS = src.delaySec + hypo / WAVE_S_KM_S;
      sMin = Math.min(sMin, tS);
      sMax = Math.max(sMax, tS);
    }
    const site = options.siteLookup ? options.siteLookup(s.lat, s.lon) : null;
    const profile = buildWaveProfile({
      stationId: s.id, magnitude: quake.magnitude, hypoKm: hypoMin,
      pSec: pMin, sSec: sMin, sLastSec: sMax, site, offshore: options.offshore === true,
    });
    if (profile) out.set(s.id, profile);
  }
  return out;
}
