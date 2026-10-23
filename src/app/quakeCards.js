import { useContext } from "react";
import { ThemeContext } from "./theme";
import { QUAKE_FETCH_LIMIT_DEFAULT, clampQuakeFetchLimit } from "./settingsStorage";


/* ─────────────────────────────────────────────────────
   P2P地震情報 JSON API (v2)
   https://api.p2pquake.net/v2/history?codes=551
   地震情報(code:551)を取得し、アプリ内で使う形に変換する。
   maxScale は 10刻みの震度コード(10=震度1 ... 70=震度7)で返ってくるため、
   INTENSITY_STYLE のキー("1"〜"7","5-","5+","6-","6+")に変換する。
   ───────────────────────────────────────────────────── */
const P2PQUAKE_HISTORY_URL_BASE = "https://api.p2pquake.net/v2/history?codes=551";

export function maxScaleToIntensityKey(maxScale) {
  const map = {
    "-1": "0", "0": "0",
    "10": "1", "20": "2", "30": "3", "40": "4",
    "44": "5", "45": "5-", "50": "5+",
    "46": "5u", // 震度5弱以上未入電(観測点で震度計は検知したが、確定した震度をまだ入電できていない状態)
    "54": "6", "55": "6-", "60": "6+",
    "70": "7",
  };
  return map[String(maxScale)] ?? "?";
}

/* ─────────────────────────────────────────────────────
   地震情報の発表段階(issue.type)
   最大震度3以上等の地震では、気象庁の電文が段階的に発表される:
     ① ScalePrompt(震度速報)   … 震源はまだ不明。細分区域単位(isArea:true)の
                                   揺れの分布と最大震度だけが先に分かる。
     ② Destination(震源に関する情報) … 震源(位置・M・深さ)は判明したが、
                                   震度分布(points)はまだ無い(maxScale=-1)。
     ③ DetailScale(震度に関する情報) … 震源・市町村単位(isArea:false)の
                                   震度分布のどちらも確定。
   同じ地震について複数の段階の電文が別々に届くため、アプリ内では
   「これまでに届いた電文のうち最も進んだ段階」をstageとして保持し、
   一覧・詳細画面に「震度速報」「震源情報」等のバッジを出す。
   ③まで届けば全情報が揃うため、バッジは表示しない。
   ───────────────────────────────────────────────────── */
const QUAKE_STAGE_RANK = { prompt: 1, destination: 2, detail: 3 };
export const QUAKE_STAGE_LABEL = {
  prompt: "震度速報",
  destination: "震源情報",
  // detail(確定)はバッジ無し
};
function quakeStageFromIssueType(issueType) {
  if (issueType === "ScalePrompt") return "prompt";
  if (issueType === "Destination") return "destination";
  return "detail"; // DetailScale・Foreign・その他は確定扱い
}

// API由来のISO風文字列("2024/01/01 12:34:56.789")を "YYYY/MM/DD HH:mm:ss" 表示用に整える
export function formatQuakeTime(raw) {
  if (!raw) return "";
  return raw.split(".")[0]; // ミリ秒以下を切り捨てるだけで日本時間表記のまま使える
}

// 発生時刻を「YYYY/MM/DD HH:mm頃」の表示用に整形する(QuakeDetailCard用)。
// formatQuakeTime()済みの "YYYY/MM/DD HH:mm:ss" (または元のISO風文字列)どちらを渡しても動くよう、
// 空白で日付部分と時刻部分に分け、時刻はHH:mmだけ取り出して秒は切り捨てる。
export function formatQuakeTimeShort(raw) {
  if (!raw) return "";
  const [datePart, timePart] = raw.split(" ");
  if (!timePart) return raw;
  const [hh, mm] = timePart.split(":");
  if (hh == null || mm == null) return raw;
  return `${datePart} ${hh}:${mm}頃`;
}

// 緊急地震速報の発生時刻用。通常の地震一覧(formatQuakeTimeShort)は分単位までだが、
// 緊急地震速報は速報性・精度が重要なため秒まで表示する。
export function formatEewTimeShort(raw) {
  if (!raw) return "";
  const [datePart, timePart] = raw.split(" ");
  if (!timePart) return raw;
  const [hh, mm, ss] = timePart.split(":");
  if (hh == null || mm == null) return raw;
  return `${datePart} ${hh}:${mm}:${ss ?? "00"}頃`;
}

// 「最大波を観測した時刻」の表示用(エポックms→「24日 15:30」のような形式)。
export function formatTsunamiMaxWaveTime(timeMs) {
  if (timeMs == null || !Number.isFinite(timeMs)) return "";
  const d = new Date(timeMs);
  const pad2 = n => String(n).padStart(2, "0");
  return `${d.getDate()}日 ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

// 津波情報の発表時刻は(地震の発生時刻と違って)推定ではなく確定した時刻なので、
// formatQuakeTimeShortの「頃」は付けない。
export function formatTsunamiTimeShort(raw) {
  if (!raw) return "";
  const [datePart, timePart] = raw.split(" ");
  if (!timePart) return raw;
  const [hh, mm] = timePart.split(":");
  if (hh == null || mm == null) return raw;
  return `${datePart} ${hh}:${mm}`;
}

// P2P地震情報APIの1レコードを、QuakeDetailCardが使う形に変換する
export function toQuakeCard(item) {
  const eq = item.earthquake;
  const hypo = eq?.hypocenter;
  const points = Array.isArray(item?.points) ? item.points : [];

  // 遠地地震(海外で発生し、国内で震度が観測されない地震)に関する情報かどうか。
  // issue.type === "Foreign" の場合、maxScaleは "-1"(観測なし)になる。
  // これを国内の「震度0(揺れなし)」と同じ扱いにしてしまうと紛らわしいため、区別する。
  const isForeign = item?.issue?.type === "Foreign";

  // earthquake.maxScaleが欠落/nullのレコードが稀に存在する
  // (震度速報→詳細への更新過程などで一時的に未設定のことがある)。
  // その場合はpoints[]の中の最大scaleから補完し、「震度0」の誤表示を防ぐ。
  // ただし遠地地震はそもそも国内観測点のpointsを持たないため、補完の対象外とする。
  let maxScale = eq?.maxScale;
  if (!isForeign && (maxScale == null || maxScale === -1) && points.length > 0) {
    maxScale = points.reduce((max, p) => (typeof p.scale === "number" && p.scale > max ? p.scale : max), -1);
  }
  // 震源に関する情報(issue.type: Destination)は、震源(位置・M・深さ)は判明した
  // ものの震度分布(points)がまだ無い段階のため、maxScaleは常に-1・pointsは
  // 常に空配列で届く。この-1は遠地地震の「国内で観測なし」とは意味が違い、
  // 「震度がまだ不明(調査中)」であって「震度0(揺れなし)」ではないため、
  // points補完もできない(=points.length===0のまま)場合は明示的に「不明」扱いにする。
  const maxScaleUnknown = !isForeign && maxScale === -1 && points.length === 0;

  // WebSocketのリアルタイム配信では、ごく最初の1通だけAPI上本来必須のはずの
  // idが未確定/欠落した状態で届くことがある(/historyで同じ地震を取得し直すと
  // idが付いている)。idがundefinedのままだと、selectedQuakeIdもundefinedに
  // なってしまい、UI側の「selectedQuakeId != null」のようなnullとの比較で
  // (undefined == nullがtrueになるため)「未選択」と区別が付かなくなる
  // ―― 具体的には、選択してもボタンバーが引っ込まず、戻るボタンも出ない
  // 不具合として現れる。そのため、idが無い場合はtime+placeから作った
  // 安定な代替idにフォールバックし、常にnull/undefinedにならないようにする。
  // (本物のidを持つレコードが後から届いた場合は、既存のtime+place一致による
  // 「後継への選択引き継ぎ」ロジックがそのまま機能する)
  const id = item.id || `noid_${eq?.time || "?"}_${hypo?.name || "?"}`;
  const stage = quakeStageFromIssueType(item?.issue?.type);

  return {
    id,
    time: formatQuakeTime(eq?.time),
    // 電文の発表時刻(issue.time)。同じ地震の複数電文をフィールド単位でマージする際、
    // どちらが新しい電文かを判定するのに使う(mergeQuakeCards参照)。
    issueTime: item?.issue?.time || null,
    // 発表段階(震度速報/震源に関する情報/確定)。バッジ表示・マージ時の情報量比較に使う。
    stage,
    // 震度速報(prompt)の段階では、震源はまだ「分からない」のではなく「調査中」
    // なので、他の段階と同じ「震源地不明」ではなく、より実態に合った文言にする。
    place: hypo?.name || (stage === "prompt" ? "震源調査中" : "震源地不明"),
    maxIntensity: isForeign ? "?" : (maxScaleUnknown ? "?" : maxScaleToIntensityKey(maxScale)),
    isForeign,
    magnitude: typeof hypo?.magnitude === "number" && hypo.magnitude > 0 ? hypo.magnitude : null,
    depth: typeof hypo?.depth === "number" && hypo.depth >= 0 ? hypo.depth : null,
    longPeriod: null, // P2P地震情報APIには長周期地震動階級は含まれないため常に非表示
    // -200は「震源がまだ確定していない」ことを示す番兵値(震度速報の段階で使われる)。
    // 数値ではあるが実在の座標ではないため、通常のnullチェックと同様に除外する
    // (これが無いと、震源不明のはずの地震が地図上のあり得ない位置に表示されてしまう)。
    latitude: typeof hypo?.latitude === "number" && hypo.latitude !== -200 ? hypo.latitude : null,
    longitude: typeof hypo?.longitude === "number" && hypo.longitude !== -200 ? hypo.longitude : null,
    // 観測点ごとの震度。{ pref, addr, scale, isArea }の配列(無ければ空配列)。
    // 注意: pointsは`earthquake`オブジェクトの中ではなく、レコード直下(item.points)にある。
    // scaleは10刻みのJMAコード(10=震度1 ... 70=震度7)のまま保持しておき、
    // 表示側(観測点マッチング後)でINTENSITY_STYLEのキーに変換する。
    points,
    // 国内津波の有無・程度。"None"(心配なし) / "Unknown" / "Checking"(調査中) /
    // "NonEffective"(若干の海面変動) / "Watch"(注意報) / "Warning"(警報) / "MajorWarning"(大津波警報)
    // フィールド自体が無い場合(震度速報・震源に関する情報など、津波の判定が
    // まだ行われていない段階のレコード)は、「心配なし」ではなく「調査中」を
    // 既定値にする。"None"を既定にしてしまうと、実際にはまだ判定されていない
    // だけなのに「津波の心配はありません」と誤って表示されてしまうため。
    domesticTsunami: eq?.domesticTsunami || "Unknown",
    // 気象庁が付加する自由記述コメント(あれば)
    freeFormComment: item?.comments?.freeFormComment || null,
  };
}

/* ─────────────────────────────────────────────────────
   電文(付加コメント)テキストの組み立て
   domesticTsunami(津波の有無)を基本の文言にし、freeFormComment(付加文)が
   あれば続けて表示する。津波の危険がある場合は色も変える。
   ───────────────────────────────────────────────────── */
const TSUNAMI_TEXT = {
  None:         { text: "この地震による津波の心配はありません。" },
  Unknown:      { text: "津波の有無について、現在調査中です。",                   color: "#FFD60A" },
  Checking:     { text: "津波の有無について、現在調査中です。",                   color: "#FFD60A" },
  NonEffective: { text: "若干の海面変動が予想されますが、被害の心配はありません。", color: "#FFD60A" },
  // 注意報・警報・大津波警報は、個別のグレードを言い切らず「等」でまとめた
  // 共通文言にする。同じ地震について、グレードが後から切り下げ/切り上げ
  // されることがあり、表示側が参照している電文のタイミングによっては
  // 実際のグレードと異なる文言を出してしまう恐れがあるため
  // (詳しい現在のグレードは津波タブ側の表示を確認してもらう)。
  Watch:        { text: "この地震により、津波警報・注意報等が発表されています。", color: "#FF453A" },
  Warning:      { text: "この地震により、津波警報・注意報等が発表されています。", color: "#FF453A" },
  MajorWarning: { text: "この地震により、津波警報・注意報等が発表されています。", color: "#FF453A" },
};

export function buildQuakeMessage(quake) {
  const { tokens } = useContext(ThemeContext);

  const tsunami = TSUNAMI_TEXT[quake.domesticTsunami] || TSUNAMI_TEXT.None;
  const lines = [{ label: "津波情報", text: tsunami.text, color: tsunami.color || tokens.textSecondary }];
  if (quake.freeFormComment) {
    lines.push({ label: "付加文", text: quake.freeFormComment, color: `rgba(${tokens.ink},0.75)` });
  }
  return lines;
}

// 直近の地震情報一覧を取得する。取得失敗時はエラーを投げる(呼び出し側でハンドリング)。
/* ─────────────────────────────────────────────────────
   重複レコードの除外・段階マージ
   同じ地震について、気象庁から複数の電文(①震度速報→②震源に関する情報→
   ③震度に関する情報)が段階的に配信される。①は震源不明・地域単位の震度分布、
   ②は震源確定・震度分布なし、③は震源・市町村単位の震度分布のどちらも確定、
   というように電文ごとに持っている情報が異なるため、単純に「1グループ1件を
   丸ごと選ぶ」のではなく、フィールドごとに「その時点で一番情報量が多いもの」を
   組み合わせてマージする(mergeQuakeCards参照)。
   グループ化のキーはearthquake.time(発生時刻)のみを使う。以前はplace(震源地)
   も条件に含めていたが、①→②③の間でplaceが「震源地不明」→実際の地名に
   変わるため、それだと同じ地震が2件に分かれてしまう。時刻は①②③を通じて
   変化しないため、キーとして安定している。
   ───────────────────────────────────────────────────── */

// 観測点(points)の「情報の詳しさ」を比較するためのランク。
// 市町村単位(isAreaがfalseの点を含む) > 地域単位(震度速報, isArea:trueのみ) > 無し(空配列)
function pointsRichness(card) {
  if (!Array.isArray(card.points) || card.points.length === 0) return 0;
  return card.points.some(p => p.isArea === false) ? 2 : 1;
}

// 震源(震源地名)が判明しているかどうか。"震源地不明"「震源調査中」はどちらも
// toQuakeCardが付ける既定値(震源がまだ判明していないことを示す)。
export function hasKnownHypocenter(card) {
  return card.place !== "震源地不明" && card.place !== "震源調査中";
}

// 同じ地震(同じ発生時刻)について、2件のカードをフィールド単位でマージする。
// a・bどちらが渡されても結果が変わらないよう、常にissueTime(電文の発表時刻)を
// 見てどちらが新しい電文かを判定してから、フィールドごとに採用元を決める。
export function mergeQuakeCards(a, b) {
  if (!a) return b;
  if (!b) return a;

  const bIsNewer = (b.issueTime || "") >= (a.issueTime || "");
  const newer = bIsNewer ? b : a;
  const older = bIsNewer ? a : b;

  // 震源(震源地名・緯度経度・M・深さ): 判明している方を優先。両方判明していれば新しい方。
  const hypoSrc = hasKnownHypocenter(newer) ? newer : (hasKnownHypocenter(older) ? older : newer);

  // 震度分布(points・maxIntensity): より詳しい方を優先。同格なら新しい方
  // (件数が増えている・確定値に更新されている可能性が高いため)。
  const newerRichness = pointsRichness(newer);
  const olderRichness = pointsRichness(older);
  const pointsSrc = newerRichness >= olderRichness ? newer : older;

  // 発表段階(バッジ表示用): これまでに届いた電文のうち最も進んだ段階を保持する
  // (震度速報だけ→震源情報が届いた後に、また震度速報の段階に戻ることはないため)。
  const stageRank = s => QUAKE_STAGE_RANK[s] || 0;
  const finalStage = stageRank(a.stage) >= stageRank(b.stage) ? a.stage : b.stage;

  // id: 本物のid(noid_で始まらないもの)を優先。新しい方の電文がまだidを
  // 確定できていない場合に備えて、古い方が本物のidを持っていればそちらを使う。
  const isRealId = id => typeof id === "string" && !id.startsWith("noid_");
  const id = isRealId(newer.id) ? newer.id : (isRealId(older.id) ? older.id : newer.id);

  return {
    id,
    time: a.time, // グループ化キーなので両者で同じ
    issueTime: newer.issueTime,
    stage: finalStage,
    place: hypoSrc.place,
    magnitude: hypoSrc.magnitude,
    depth: hypoSrc.depth,
    latitude: hypoSrc.latitude,
    longitude: hypoSrc.longitude,
    longPeriod: hypoSrc.longPeriod,
    maxIntensity: pointsSrc.maxIntensity,
    points: pointsSrc.points,
    isForeign: newer.isForeign,
    // 津波判定・付加文は、その時点で最新の電文の内容が常に正しい(後から
    // 警報→注意報に切り下がる、付加文が追記される、といった更新がありうるため)。
    domesticTsunami: newer.domesticTsunami,
    freeFormComment: newer.freeFormComment ?? older.freeFormComment ?? null,
    // テスト配信(地震情報テスト配信機能)由来かどうか。どちらか一方でもテストなら
    // テスト扱いにする(実運用でテストと実データが混ざることは無いが念のため)。
    isTest: !!(newer.isTest || older.isTest),
  };
}

export function dedupeQuakeList(list) {
  // listは常に新しい順(newest-first)で渡ってくるが、mergeQuakeCards自体は
  // 渡す順序に依存せず正しい結果になるようissueTimeで新旧を判定しているため、
  // ここでは単に同じグループのカードを順にマージしていくだけでよい。
  const order = []; // グループの初出順(=一覧の表示順)を保つ
  const merged = new Map(); // time -> マージ済みカード
  for (const q of list) {
    const key = q.time;
    if (!merged.has(key)) {
      order.push(key);
      merged.set(key, q);
    } else {
      merged.set(key, mergeQuakeCards(merged.get(key), q));
    }
  }
  return order.map(key => merged.get(key));
}

// 直近の地震情報一覧を取得する。取得失敗時はエラーを投げる(呼び出し側でハンドリング)。
// limit: 設定画面で指定された取得件数(1〜1000、デフォルト100)。
//
// 注意1: P2P地震情報APIの /history は1回のリクエストにつき limit を1〜100までしか
// 指定できない(仕様: https://www.p2pquake.net/develop/json_api_v2/ の /history 参照)。
// 100件を超える件数が設定されている場合、limit=100 のリクエストを offset をずらしながら
// 複数回叩いて必要件数を積み上げる(例: 300件なら3回)。
//
// 注意2: 同APIの offset は「1週間以上古い情報は取得できない場合がある」仕様のため、
// 直近1週間の地震が指定件数に満たない場合、それ以上ページを進めても同じ内容が
// 返ってくることがある。これを区別せずに積み上げると、後段の重複排除で結局同じ
// 件数に収束してしまい「件数を増やしても表示が変わらない」ように見えてしまう。
// → 各ページのidをseenIdsで追跡し、新規idが1件も無いページに当たった時点で
//   「これ以上遡れない」とみなして打ち切る。
const P2PQUAKE_API_PAGE_SIZE = 100;

export async function fetchRecentQuakes(limit = QUAKE_FETCH_LIMIT_DEFAULT) {
  const target = clampQuakeFetchLimit(limit);
  const results = [];
  const seenIds = new Set();
  let offset = 0;

  while (results.length < target) {
    const pageSize = Math.min(P2PQUAKE_API_PAGE_SIZE, target - results.length);
    const res = await fetch(`${P2PQUAKE_HISTORY_URL_BASE}&limit=${pageSize}&offset=${offset}`);
    if (!res.ok) throw new Error(`地震情報の取得に失敗しました (${res.status})`);
    const page = await res.json();
    if (!Array.isArray(page) || page.length === 0) break; // これ以上遡れる情報が無い

    const newItems = page.filter(item => item?.id != null && !seenIds.has(item.id));
    if (newItems.length === 0) break; // 新規レコードが無い = 同じ内容が返ってきている(offsetの限界に到達)
    for (const item of newItems) seenIds.add(item.id);
    results.push(...newItems);

    offset += page.length;

    // 返ってきた件数がリクエストしたページサイズより少なければ、これ以上古い情報は無い
    if (page.length < pageSize) break;
  }

  // 以前は「震源(hypocenter.name)が無いレコード」を丸ごと除外していたが、
  // これだと震度速報(ScalePrompt, 震源不明)や震源に関する情報(Destination,
  // 震度分布なし)がまるごと一覧から消えてしまい、確定報(DetailScale)が
  // 出るまでその地震自体が見えなくなってしまっていた。
  // → earthquakeオブジェクト自体が無いレコード(不完全なデータ)だけ除外し、
  //   段階ごとの情報の組み合わせはdedupeQuakeList(mergeQuakeCards)に任せる。
  const list = results
    .filter(item => item.earthquake)
    .map(toQuakeCard);
  return dedupeQuakeList(list);
}

// 「津波を引き起こした地震」検索のフォールバック用。気象庁 震度データベース(eqdb)は
// 直近の地震(発表から3日程度)がまだ反映されていないことがあるため、その場合の
// 代わりに、直近の地震情報一覧(P2P地震情報, /history?codes=551)を遡って同じ
// 時間窓[winStart, winEnd]の地震を探す。fetchRecentQuakesと同じoffsetページング
// 方式を使う(P2P地震情報のoffsetは「1週間以上古い情報は取得できない場合がある」
// 仕様のため、3日以内という前提の呼び出しと相性が良い)。
// 該当する中でМ(マグニチュード)が最大のものを1件返す(無ければnull)。
export async function findCausingQuakeFromP2p(winStart, winEnd) {
  const winStartMs = winStart.getTime();
  const winEndMs = winEnd.getTime();
  let offset = 0;
  const matches = [];
  const seenIds = new Set();

  for (let page = 0; page < 10; page++) { // 安全のため最大10ページ(1000件)までで打ち切る
    const res = await fetch(`${P2PQUAKE_HISTORY_URL_BASE}&limit=${P2PQUAKE_API_PAGE_SIZE}&offset=${offset}`);
    if (!res.ok) break;
    const items = await res.json();
    if (!Array.isArray(items) || items.length === 0) break;

    let sawAnyAtOrAfterWindowStart = false;
    for (const item of items) {
      if (item?.id == null || seenIds.has(item.id)) continue;
      seenIds.add(item.id);
      const eq = item.earthquake;
      if (!eq?.hypocenter?.name || !eq?.time) continue;
      const t = new Date(eq.time).getTime();
      if (!Number.isFinite(t)) continue;
      if (t >= winStartMs) sawAnyAtOrAfterWindowStart = true;
      if (t >= winStartMs && t <= winEndMs) matches.push(item);
    }

    offset += items.length;
    if (items.length < P2PQUAKE_API_PAGE_SIZE) break; // これ以上遡れる情報が無い
    // このページに窓の開始時刻以降のレコードが1件も無かった(=全部それより古かった)
    // なら、これ以上遡っても窓に入るものは無いので打ち切る。
    if (!sawAnyAtOrAfterWindowStart) break;
  }

  if (matches.length === 0) return null;
  const cards = matches
    .filter(item => item.earthquake && item.earthquake.hypocenter && item.earthquake.hypocenter.name)
    .map(toQuakeCard);
  if (cards.length === 0) return null;
  cards.sort((a, b) => (b.magnitude ?? -Infinity) - (a.magnitude ?? -Infinity));
  return cards[0];
}
