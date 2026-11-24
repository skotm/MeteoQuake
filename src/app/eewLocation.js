import { useEffect, useState, useSyncExternalStore } from "react";
import { findAreaNameByPoint } from "./geo";
import { loadGeoData } from "./mapDataLoaders";

/* ─────────────────────────────────────────────────────
   緊急地震速報 × 現在地: 主要動の到達予測カウントダウンと、現在地の予測震度。

   ・予測震度・到達時刻は、緊急地震速報が配信する「細分区域ごと」の値
     (Wolfx: WarnArea[].Shindo1/Shindo2/Time/Arrive)をそのまま使う。
     現在地が属する細分区域(細分区域.json)を引き当て、同名の対象地域を探す。
     距離減衰などによる独自推定はしない。
   ・現在地が対象地域に含まれない時は、予測震度も到達時刻も出さない。
   ・位置情報は、この機能をオンにした利用者の端末の中だけで使う(保存・送信しない)。
   ───────────────────────────────────────────────────── */

const ENABLED_KEY = "meteoquake_eew_location_enabled_v1";

function readEnabled() {
  try { return localStorage.getItem(ENABLED_KEY) === "1"; } catch { return false; }
}
let enabledValue = readEnabled();
const listeners = new Set();
function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// 設定画面のトグルと、緊急地震速報カードの両方から使える共有の設定(propsを持ち回さない)。
export function setEewLocationEnabled(next) {
  enabledValue = !!next;
  try {
    if (enabledValue) localStorage.setItem(ENABLED_KEY, "1");
    else localStorage.removeItem(ENABLED_KEY);
  } catch { /* 保存できなくても、このセッション内では有効 */ }
  listeners.forEach((fn) => fn());
}
export function useEewLocationEnabled() {
  return useSyncExternalStore(subscribe, () => enabledValue, () => false);
}

// Wolfxの時刻文字列("2026-11-24 23:09:09" / "2026/11/24 23:09:09")は日本時間。
// 端末のタイムゾーンに左右されないよう、+09:00を明示してエポックmsにする。
export function parseJstTimeToMs(raw) {
  if (typeof raw !== "string") return null;
  const m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(raw.trim());
  if (!m) return null;
  const p = (v) => String(v).padStart(2, "0");
  const iso = `${m[1]}-${p(m[2])}-${p(m[3])}T${p(m[4])}:${m[5]}:${p(m[6] ?? "0")}+09:00`;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

// 全角数字("東京都２３区")などの表記ゆれを吸収して地域名を比べる。
const normName = (s) => String(s || "").normalize("NFKC");

/**
 * 現在地が属する細分区域名から、この速報の対象地域のうち該当する1件を返す。
 * @returns {{ areaName, inWarnArea, intensityKey, arrivalMs, arrived } | null}
 *   速報が取消済み、または現在地の細分区域が分からない時はnull。
 */
export function resolveMyEewForecast(eew, areaName) {
  if (!eew || eew.cancelled || !areaName) return null;
  const target = normName(areaName);
  const hit = (eew.areas || []).find((a) => normName(a.name) === target);
  if (!hit) return { areaName, inWarnArea: false, intensityKey: null, arrivalMs: null, arrived: false };
  const key = hit.maxIntensityKey && hit.maxIntensityKey !== "?" ? hit.maxIntensityKey : null;
  return {
    areaName,
    inWarnArea: true,
    intensityKey: key,
    arrivalMs: Number.isFinite(hit.arrivalMs) ? hit.arrivalMs : null,
    arrived: !!hit.arrived,
  };
}

// 到達時刻として使える値か。発生時刻より前、または現在から10分以上先は、
// データ不良・端末時計のずれとみなして使わない。
export function sanitizeArrivalMs(arrivalMs, originMs, nowMs) {
  if (!Number.isFinite(arrivalMs)) return null;
  if (Number.isFinite(originMs) && arrivalMs < originMs) return null;
  if (arrivalMs - nowMs > 10 * 60 * 1000) return null;
  return arrivalMs;
}

/**
 * 有効な間だけ、現在地を1回取得する(追跡はしない)。
 * ブラウザが持っている10分以内の位置があれば、それを使うので速報の発表時でも待たされにくい。
 * status: "idle" | "loading" | "ready" | "denied" | "error" | "unsupported"
 */
export function useEewPosition(active) {
  const [state, setState] = useState({ status: "idle", coords: null });
  useEffect(() => {
    if (!active) {
      setState((s) => (s.status === "idle" ? s : { status: "idle", coords: null }));
      return undefined;
    }
    if (typeof navigator === "undefined" || !("geolocation" in navigator)) {
      setState({ status: "unsupported", coords: null });
      return undefined;
    }
    let cancelled = false;
    setState((s) => (s.status === "ready" ? s : { status: "loading", coords: null }));
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        if (!cancelled) setState({ status: "ready", coords: { lat: pos.coords.latitude, lon: pos.coords.longitude } });
      },
      (err) => {
        if (!cancelled) setState({ status: err?.code === 1 ? "denied" : "error", coords: null });
      },
      { enableHighAccuracy: false, maximumAge: 10 * 60 * 1000, timeout: 8000 }
    );
    return () => { cancelled = true; };
  }, [active]);
  return state;
}

// 現在地(lat, lon)が属する細分区域名。細分区域.jsonの読み込み後に求める。
export function useMyAreaName(coords) {
  const [areaName, setAreaName] = useState(null);
  const lat = coords?.lat;
  const lon = coords?.lon;
  useEffect(() => {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) { setAreaName(null); return undefined; }
    let cancelled = false;
    loadGeoData()
      .then(({ areas }) => { if (!cancelled) setAreaName(findAreaNameByPoint(areas, lat, lon)); })
      .catch((err) => { console.error("現在地の細分区域の判定に失敗:", err); if (!cancelled) setAreaName(null); });
    return () => { cancelled = true; };
  }, [lat, lon]);
  return areaName;
}
