/* ─────────────────────────────────────────────────────
   発震機構解(CMT解)の取得先。気象庁(jma)・USGS(usgs)を、それぞれ取得するかを選ぶ(両方オンが既定)。
   オフにした取得先には通信しない。両方オフなら、発震機構解は取得せず、ボタンも出さない。
   (cmtSourcePrefは、両方取得できた地震で、どちらを表示するかの選択。別の設定)
   ───────────────────────────────────────────────────── */
const CMT_FETCH_SOURCES_STORAGE_KEY = "cmtFetchSources";
export const DEFAULT_CMT_FETCH_SOURCES = Object.freeze({ jma: true, usgs: true });

export function loadStoredCmtFetchSources() {
  try {
    const saved = JSON.parse(localStorage.getItem(CMT_FETCH_SOURCES_STORAGE_KEY));
    if (saved && typeof saved === "object") {
      return {
        jma: typeof saved.jma === "boolean" ? saved.jma : true,
        usgs: typeof saved.usgs === "boolean" ? saved.usgs : true,
      };
    }
  } catch (err) {
    console.warn("発震機構解の取得先の設定を読み込めませんでした:", err);
  }
  return { ...DEFAULT_CMT_FETCH_SOURCES };
}

export function saveCmtFetchSources(sources) {
  try {
    localStorage.setItem(CMT_FETCH_SOURCES_STORAGE_KEY, JSON.stringify({ jma: sources.jma === true, usgs: sources.usgs === true }));
  } catch (err) {
    console.warn("発震機構解の取得先の設定を保存できませんでした:", err);
  }
}
