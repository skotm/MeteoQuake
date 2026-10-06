import { useContext } from "react";
import { ThemeContext } from "../settings/prefs.js";

/* ─────────────────────────────────────────────────────
   P2P地震情報 JSON API (v2)
   https://api.p2pquake.net/v2/history?codes=551
   地震情報(code:551)を取得し、アプリ内で使う形に変換する。
   maxScale は 10刻みの震度コード(10=震度1 ... 70=震度7)で返ってくるため、
   INTENSITY_STYLE のキー("1"〜"7","5-","5+","6-","6+")に変換する。
   ───────────────────────────────────────────────────── */
export const P2PQUAKE_HISTORY_URL_BASE = "https://api.p2pquake.net/v2/history?codes=551";


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
function formatQuakeTime(raw) {
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



/* ─────────────────────────────────────────────────────
   津波情報(P2P地震情報 JMATsunami, code:552)
   https://api.p2pquake.net/v2/history?codes=552
   気象庁が発表する津波予報区ごとの津波予報・警報を取得する。
   区分(grade)は MajorWarning(大津波警報) > Warning(津波警報) >
   Watch(津波注意報) > NonEffective(津波予報・若干の海面変動) > Unknown(調査中)
   の順に危険度が高い。1件のレコードに複数の予報区(areas)が含まれるため、
   一覧には「その時点で最も危険度が高いgrade」を代表として表示する。
   ───────────────────────────────────────────────────── */
const P2PQUAKE_TSUNAMI_HISTORY_URL_BASE = "https://api.p2pquake.net/v2/history?codes=552";

export const TSUNAMI_FETCH_LIMIT = 50;
 // 地震に比べて発表頻度が低いため、地震ほど多くの件数は要らない

export const TSUNAMI_GRADE_INFO = {
  MajorWarning: { label: "大津波警報", weight: 4, color: "#BF5AF2" },
  Warning:      { label: "津波警報",   weight: 3, color: "#FF453A" },
  Watch:        { label: "津波注意報", weight: 2, color: "#FFD60A" },
  NonEffective: { label: "津波予報",   weight: 1, color: "#64D2FF" },
  Unknown:      { label: "調査中",     weight: 0, color: "#8E8E93" },
};

export const TSUNAMI_GRADE_FALLBACK = { label: "情報", weight: 0, color: "#8E8E93" };


export function tsunamiGradeInfo(grade) {
  return TSUNAMI_GRADE_INFO[grade] || TSUNAMI_GRADE_FALLBACK;
}


// 観測点の丸・観測された津波の高さバーの色は、予報区の公式なグレード(警報等の
// 種類)ではなく、実際に観測された高さの大小そのものに応じて塗り分ける
// (0.2〜1m=注意報色、1〜3m=警報色、3m以上=大津波警報色、それ未満・未観測は薄グレー)。
// 「観測点」欄の丸は今どれくらいの実況かが一目で分かるように、という考え方。
const TSUNAMI_DOT_DEFAULT_COLOR = "#B9B9C0";
 // 観測なし・微弱の間の薄グレー
// 観測された津波の高さ(m)から、相当する警報グレードのキーを求める
// (0.2m未満はnull=グレード相当なし)。地図の観測点の丸・バーの色分けと、
// 右上の凡例のラダー表示(TsunamiGradeLegend)の両方で、しきい値を1箇所に
// まとめておくために使う。
export function tsunamiHeightBandGrade(heightM) {
  if (heightM == null) return null;
  const abs = Math.abs(heightM);
  if (abs >= 3) return "MajorWarning";
  if (abs >= 1) return "Warning";
  if (abs >= 0.2) return "Watch";
  return null;
}

export function tsunamiHeightBandColor(heightM) {
  const grade = tsunamiHeightBandGrade(heightM);
  return grade ? tsunamiGradeInfo(grade).color : TSUNAMI_DOT_DEFAULT_COLOR;
}


// tsunami-areas.json(津波予報区の海岸線)の各featureは properties.name に
// 予報区名を持つ。表示中の津波情報のareas(name+grade)を突き合わせて、
// 該当する予報区だけをgradeの色で塗り、それ以外は透明にするmatch式を作る。
export function buildTsunamiAreaColorExpr(areas) {
  if (!areas || areas.length === 0) return "rgba(0,0,0,0)";
  const expr = ["match", ["get", "name"]];
  const seen = new Set();
  for (const a of areas) {
    if (!a.name || seen.has(a.name)) continue; // 同名予報区が重複していたら最初の1件を優先
    seen.add(a.name);
    expr.push(a.name, tsunamiGradeInfo(a.grade).color);
  }
  if (seen.size === 0) return "rgba(0,0,0,0)";
  expr.push("rgba(0,0,0,0)"); // 対象外の予報区は透明(=非表示)
  return expr;
}


// P2P地震情報APIの1レコード(JMATsunami)を、アプリ内で使う形に変換する
export function toTsunamiCard(item) {
  const areas = Array.isArray(item.areas) ? item.areas.map(a => ({
    name: a.name || "不明な予報区",
    grade: a.grade || "Unknown",
    immediate: !!a.immediate,
    firstHeightCondition: a.firstHeight?.condition || null,
    firstHeightTime: a.firstHeight?.arrivalTime || null,
    maxHeightDescription: a.maxHeight?.description || null,
  })) : [];

  // 全予報区の中で最も危険度が高いgradeを、一覧表示・バッジ色の代表として使う。
  let maxGrade = null;
  let maxWeight = -1;
  areas.forEach(a => {
    const w = tsunamiGradeInfo(a.grade).weight;
    if (w > maxWeight) { maxWeight = w; maxGrade = a.grade; }
  });

  return {
    id: item.id,
    time: formatQuakeTime(item.time),
    cancelled: !!item.cancelled,
    areas,
    maxGrade: item.cancelled ? null : maxGrade,
  };
}


// 同一idの重複を除いて、新しい順に並べ直す
export function dedupeTsunamiList(list) {
  const byId = new Map();
  for (const t of list) byId.set(t.id, t);
  return Array.from(byId.values()).sort((a, b) => (a.time < b.time ? 1 : a.time > b.time ? -1 : 0));
}


// 直近の津波情報一覧を取得する。取得失敗時はエラーを投げる(呼び出し側でハンドリング)。
export async function fetchRecentTsunamis(limit) {
  const res = await fetch(`${P2PQUAKE_TSUNAMI_HISTORY_URL_BASE}&limit=${limit}`);
  if (!res.ok) throw new Error(`P2P地震情報 津波情報の取得に失敗(HTTP ${res.status})`);
  const data = await res.json();
  if (!Array.isArray(data)) return [];
  return dedupeTsunamiList(data.map(toTsunamiCard));
}


/* ─────────────────────────────────────────────────────
   過去の津波情報(津波タブ「過去」モード)

   【重要】直近一覧(fetchRecentTsunamis)や当初の実装では、地震・EEW等すべての
   コードを1つの領域(capped collection)で共有する/history?codes=552 を使っていたが、
   これは発表頻度の低い津波情報がすぐ押し出されてしまい、offsetで遡っても
   「過去の津波が見つかりません」になりやすい。
   → 津波予報だけを独立して保持している専用API /v2/jma/tsunami に切り替える
     (地震情報の/v2/jma/quakeに相当する、津波版のエンドポイント)。
   さらに気象庁自身が公開している一覧(list.json)も合わせて取得し、両方を
   統合することで、より確実に過去分を取得できるようにする。
     (以前作ったindex.html版アプリのfetchJMATsunamiHistory()と同じ考え方)。
   ───────────────────────────────────────────────────── */
const JMA_TSUNAMI_LIST_URL = "https://www.jma.go.jp/bosai/tsunami/data/list.json";

const JMA_TSUNAMI_HISTORY_LIMIT = 40;
 // list.json自体は新しい順に並んでいるため、先頭から取得する件数

// 気象庁のReportDateTime("2024-08-08T20:30:00+09:00"のようなISO風文字列、常にJST)を、
// アプリ内で使っている"YYYY/MM/DD HH:mm:ss"形式(P2P地震情報側と揃える。ソート・
// 表示(TsunamiListRowのslice(5,16)等)の両方でこの形式を前提にしているため)に変換する。
function jmaIsoToSlash(iso) {
  if (!iso) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(iso);
  if (!m) return iso;
  const [, y, mo, d, h, mi, s] = m;
  return `${y}/${mo}/${d} ${h}:${mi}:${s}`;
}


// 気象庁の個別報(Head/Body形式のJSON)を、アプリ内の津波カード形式(toTsunamiCardと同じ形)に変換する。
function jmaTsunamiReportToCard(report, reportDatetime) {
  const head = report?.Head;
  const issueTime = head?.ReportDateTime || reportDatetime;
  const isCancel = head?.InfoType === "取消";
  const areas = [];
  const forecast = report?.Body?.Tsunami?.Forecast;
  if (forecast?.Item) {
    const items = Array.isArray(forecast.Item) ? forecast.Item : [forecast.Item];
    items.forEach(item => {
      const areaName = item?.Area?.Name || "";
      const kindName = item?.Category?.Kind?.Name || "";
      if (!areaName || kindName.includes("解除")) return;
      let grade = "Unknown";
      if (kindName.includes("大津波")) grade = "MajorWarning";
      else if (kindName.includes("警報")) grade = "Warning";
      else if (kindName.includes("注意報")) grade = "Watch";
      else if (kindName.includes("海面変動") || kindName.includes("予報")) grade = "NonEffective";
      if (grade === "Unknown") return;
      areas.push({
        name: areaName,
        grade,
        immediate: !!item?.FirstHeight?.Condition && item.FirstHeight.Condition.includes("ただちに"),
        firstHeightCondition: item?.FirstHeight?.Condition || null,
        firstHeightTime: item?.FirstHeight?.ArrivalTime || null,
        maxHeightDescription: item?.MaxHeight?.TsunamiHeight?.Description || null,
      });
    });
  }
  let maxGrade = null, maxWeight = -1;
  areas.forEach(a => {
    const w = tsunamiGradeInfo(a.grade).weight;
    if (w > maxWeight) { maxWeight = w; maxGrade = a.grade; }
  });
  return {
    id: `jma_${reportDatetime}`,
    time: jmaIsoToSlash(issueTime),
    cancelled: isCancel,
    areas,
    maxGrade: isCancel ? null : maxGrade,
  };
}


// 気象庁 津波情報一覧(list.json)を取得し、先頭(新しい順)からJMA_TSUNAMI_HISTORY_LIMIT件、
// 各個別報を取得して津波カードに変換する。1件でも取得に失敗した場合はその1件だけを
// null化して除外し、全体は継続する。
export async function fetchJmaTsunamiHistory(limit = JMA_TSUNAMI_HISTORY_LIMIT) {
  const listRes = await fetch(JMA_TSUNAMI_LIST_URL);
  if (!listRes.ok) throw new Error(`気象庁 津波情報一覧の取得に失敗(HTTP ${listRes.status})`);
  const list = await listRes.json();
  if (!Array.isArray(list)) return [];
  const targets = list.slice(0, limit);
  const cards = await Promise.all(targets.map(async item => {
    try {
      const res = await fetch(`https://www.jma.go.jp/bosai/tsunami/data/${item.json}`);
      if (!res.ok) return null;
      return jmaTsunamiReportToCard(await res.json(), item.reportDatetime);
    } catch {
      return null;
    }
  }));
  return dedupeTsunamiList(cards.filter(Boolean));
}


// 直近一覧(fetchRecentTsunamis, /v2/history?codes=552)とは別の、津波予報専用のJSON API。
// /historyは地震情報等すべてのコードと容量を共有するcapped collectionのため、
// 発表頻度の低い津波情報はすぐ押し出されて過去に遡りにくいが、こちらは津波予報だけを
// 独立して保持しているため、より確実に過去分を取得できる
// (レート制限は/historyの60リクエスト/分より厳しい10リクエスト/分なので、
// 呼びすぎないよう「もっと見る」を押した時だけ叩く)。
const P2PQUAKE_JMA_TSUNAMI_URL = "https://api.p2pquake.net/v2/jma/tsunami";

export const TSUNAMI_HISTORY_PAGE_SIZE = 100;
 // このAPIの1リクエストあたりの最大件数

export async function fetchTsunamiHistoryPage(offset, limit = TSUNAMI_HISTORY_PAGE_SIZE) {
  const res = await fetch(`${P2PQUAKE_JMA_TSUNAMI_URL}?limit=${limit}&offset=${offset}`);
  if (!res.ok) throw new Error(`過去の津波情報の取得に失敗(HTTP ${res.status})`);
  const data = await res.json();
  if (!Array.isArray(data)) return [];
  return dedupeTsunamiList(data.map(toTsunamiCard));
}


// 気象庁一覧(primary)とP2P地震情報一覧(supplementary)を統合する。同じ発表が
// 双方に出てくることがあるため、発表時刻が1時間以内に近い場合は重複とみなして
// supplementary側を捨てる(以前のindex.html版アプリと同じ判定基準)。
export function mergeTsunamiSources(primary, supplementary) {
  const merged = [...primary];
  supplementary.forEach(s => {
    const sTime = new Date(s.time).getTime();
    const isDup = merged.some(p => Math.abs(new Date(p.time).getTime() - sTime) < 60 * 60 * 1000);
    if (!isDup) merged.push(s);
  });
  return dedupeTsunamiList(merged);
}
