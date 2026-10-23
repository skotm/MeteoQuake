import { readFileSync } from "node:fs";
import { estimateEpicenter as estNew } from "../MeteoQuake-KyoshinViewer/src/epicenterEstimation";
import { estimateEpicenter as estOld } from "../MeteoQuake-KyoshinViewer/src/epicenterEstimation.orig";
import { calcPeakIntensity, P_WAVE_SPEED_KM_S } from "../MeteoQuake-KyoshinViewer/src/shakeTestSimulation";

const load = (f: string, source: string) => readFileSync(f, "utf8").trim().split("\n").map(l => { const [id, lat, lon] = l.split(","); return { id: +id, source, lat: +lat, lon: +lon }; });
const land = load("/home/claude/work/test/data/kmoni_tohoku.csv", "kmoni");
const snet = load("/home/claude/work/test/data/snet_tohoku.csv", "snet");
const allStations = [...land, ...snet];

const hav = (a: number, b: number, c: number, d: number) => { const R = 6371, r = Math.PI / 180; const x = Math.sin((c - a) * r / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin((d - b) * r / 2) ** 2; return 2 * R * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x)); };
let seed = 777; const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;

function scenario(name: string, epLat: number, epLon: number, depth: number, mag: number, nDet: number, delayPerKm = 0, nSeeds = 12) {
  const nearest = Math.min(...land.map(s => hav(epLat, epLon, s.lat, s.lon)));
  const nearestSnet = Math.min(...snet.map(s => hav(epLat, epLon, s.lat, s.lon)));
  const e = { o: [] as number[], n: [] as number[] }, ew = { o: [] as number[], n: [] as number[] };
  // 最寄り陸上局の方位=陸側。真値から最寄り陸局へ向かう単位ベクトル方向への成分でずれを測る(正=陸側)
  const nl = land.reduce((b, s) => hav(epLat, epLon, s.lat, s.lon) < hav(epLat, epLon, b.lat, b.lon) ? s : b);
  const ux = (nl.lon - epLon) * Math.cos(epLat * Math.PI / 180), uy = nl.lat - epLat, un = Math.hypot(ux, uy);
  for (let k = 0; k < nSeeds; k++) {
    const t0 = 1_000_000;
    const c = land.map(s => { const d = hav(epLat, epLon, s.lat, s.lon), hyp = Math.hypot(d, depth);
      return { id: s.id, lat: s.lat, lon: s.lon, level: 0, intensity: calcPeakIntensity(mag, depth, hyp), sWaveDetectedAt: null, d,
        detectedAt: Math.round((t0 + hyp / P_WAVE_SPEED_KM_S * 1000 + delayPerKm * d * 1000 + gauss() * 700) / 1000) * 1000 }; })
      .filter(x => x.intensity > 0.5).sort((a, b) => a.detectedAt - b.detectedAt || a.d - b.d);
    const det = c.slice(0, nDet); if (det.length < nDet) continue;
    const ev = { id: 1, detections: det, pointCount: det.length }, now = det[det.length - 1].detectedAt + 500;
    const ro = estOld(ev, allStations, now), rn = estNew(ev, allStations, now);
    for (const [r, arr, arrw] of [[ro, e.o, ew.o], [rn, e.n, ew.n]] as any) {
      arr.push(hav(epLat, epLon, r.lat, r.lon));
      arrw.push(((r.lon - epLon) * Math.cos(epLat * Math.PI / 180) * 111 * ux + (r.lat - epLat) * 111 * uy) / un);
    }
  }
  const f = (x: number) => x.toFixed(0).padStart(4);
  console.log(`${name.padEnd(16)} 陸局${f(nearest)}km S-net${f(nearestSnet)}km n=${String(nDet).padStart(2)} | 誤差km 旧${f(avg(e.o))}→新${f(avg(e.n))} | 陸側ずれkm(+=陸寄り) 旧${f(avg(ew.o))}→新${f(avg(ew.n))}`);
}
const S: [string, number, number, number, number][] = [
  ["岩手沖(宮古東)", 39.65, 142.20, 20, 5.5],
  ["岩手沖(釜石東)", 39.27, 142.15, 30, 5.8],
  ["宮城沖(牡鹿東)", 38.30, 141.85, 40, 6.0],
  ["福島沖(浪江東)", 37.50, 141.35, 30, 5.8],
  ["青森東方沖", 40.55, 141.95, 30, 5.8],
];
for (const n of [6, 10, 20]) for (const s of S) scenario(s[0], s[1], s[2], s[3], s[4], n);
console.log("--- 遠方ほど検知遅延(0.02s/km) ---");
for (const n of [10, 20]) for (const s of S.slice(0, 3)) scenario(s[0], s[1], s[2], s[3], s[4], n, 0.02);
