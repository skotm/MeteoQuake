/* ─────────────────────────────────────────────────────
   Wolfx 津波情報(jma_tsunami)の実データ形式のサンプル。
   「津波警報テスト配信」画面から選ぶと、実際のWolfx経路(parseWolfxTsunami → 津波タブ・地図・通知)に
   本物の取得データの代わりとして流し込み、表示を確認できる。JSONは選んだ時にだけ読み込む(コード分割)。
   ───────────────────────────────────────────────────── */
export const WOLFX_TSUNAMI_SAMPLES = [
  { key: "major_warning", label: "大津波警報" },
  { key: "warning", label: "津波警報" },
  { key: "advisory", label: "津波注意報" },
  { key: "forecast_only", label: "津波予報のみ(若干の海面変動)" },
  { key: "with_observations", label: "大津波警報+津波観測報(観測・沖合・推定)" },
  { key: "cleared", label: "解除" },
  { key: "expired", label: "有効期限切れ(状態を確認できない)" },
  { key: "cancelled", label: "報の取消(状態を確認できない)" },
];

const LOADERS = {
  major_warning: () => import("./wolfxTsunamiSamples/major_warning.json"),
  warning: () => import("./wolfxTsunamiSamples/warning.json"),
  advisory: () => import("./wolfxTsunamiSamples/advisory.json"),
  forecast_only: () => import("./wolfxTsunamiSamples/forecast_only.json"),
  with_observations: () => import("./wolfxTsunamiSamples/with_observations.json"),
  cleared: () => import("./wolfxTsunamiSamples/cleared.json"),
  expired: () => import("./wolfxTsunamiSamples/expired.json"),
  cancelled: () => import("./wolfxTsunamiSamples/cancelled.json"),
};

/**
 * サンプルを読み込み、「その時点を現在とみなす時刻(nowMs)」と一緒に返す。
 * サンプルのvalidUntil(信頼期限)は過去の日付なので、そのまま判定すると全て期限切れになってしまう。
 * そのため、期限の1分前(期限が無い時は報の発表時刻)を現在とする。
 * 期限切れ・取消のサンプルは、元々 trusted=false(または status=expired)なので、この時刻でも
 * 「状態を確認できない」扱いになる。
 */
export async function loadWolfxTsunamiSample(key) {
  const loader = LOADERS[key];
  if (!loader) return null;
  const mod = await loader();
  const raw = mod.default ?? mod;
  const until = Date.parse(raw?.validUntil);
  const issued = Date.parse(raw?.report?.time);
  const nowMs = Number.isFinite(until) ? until - 60 * 1000 : Number.isFinite(issued) ? issued : Date.now();
  return { key, raw, nowMs };
}
