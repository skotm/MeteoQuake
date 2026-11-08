// テスト用の合成データ。走時テーブルは設定せず、推定側のフォールバック(震源距離/6.8km/s)を使う。
export interface Station { id: number; lat: number; lon: number }
export interface Detection extends Station {
  detectedAt: number;
  level: number;
  intensity: number | null;
  sWaveDetectedAt: number | null;
}

export const T0 = 1_800_000_000_000;

export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const r = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2
    + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
  return 2 * 6371 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// 中心(lat, lon)の周りに、間隔spacingDegで(2*half+1)^2点の観測点を並べる。
export function stationGrid(lat: number, lon: number, half: number, spacingDeg: number): Station[] {
  const out: Station[] = [];
  for (let i = -half; i <= half; i++) {
    for (let j = -half; j <= half; j++) {
      out.push({ id: out.length + 1, lat: lat + i * spacingDeg, lon: lon + j * spacingDeg });
    }
  }
  return out;
}

// 震源(ep)から各観測点へのP波到達時刻で検知を作る。ノイズは決定的な擬似乱数。
export function makeDetections(
  stations: Station[],
  ep: { lat: number; lon: number; depth: number },
  count: number,
  noiseMs = 0,
): Detection[] {
  let seed = 7;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296 - 0.5; };
  return stations
    .map((s) => {
      const hyp = Math.hypot(haversineKm(ep.lat, ep.lon, s.lat, s.lon), ep.depth);
      return {
        ...s,
        detectedAt: Math.round(T0 + (hyp / 6.8) * 1000 + rnd() * 2 * noiseMs),
        level: 1,
        intensity: 1.0,
        sWaveDetectedAt: null,
      };
    })
    .sort((a, b) => a.detectedAt - b.detectedAt)
    .slice(0, count);
}
