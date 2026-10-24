/**
 * shakeDetection.ts
 * ------------------------------------------------------------
 * 揺れ検知エンジン(新方式・ゼロから再設計)。
 *
 * 旧実装(KyoshinEewViewerのShakeDetectionEngine.cs移植版)は、近傍点の
 * 重み付きスコアと複数tick分の履歴平均でスパイクを除外してから検知して
 * いたため、実際に揺れ始めてからイベントとして確定するまでに数tick分の
 * タイムラグがあった。
 *
 * 新実装は「検知の速さ」を最優先に、考え方から作り直している。
 *
 *   ある観測点の値が急上昇した(前tickからの上昇量がしきい値以上)とき、
 *   それが本物の揺れなら、地理的に近い別の観測点でも"ほぼ同時に"同じ
 *   ような急上昇が起きているはず(P波・S波は面的に伝播するため)。逆に、
 *   単独観測点だけが跳ねているなら機器ノイズ・瞬間的なスパイクの可能性
 *   が高い。
 *
 * → 履歴平均やスコアの積み上げを待たず、「近傍2点がほぼ同時期に急上昇
 *   した瞬間」を捉えた、その場でイベントを確定させる(2点同時多発検知)。
 *   これにより、旧実装にあった「履歴が貯まるまで待つ」「多数の観測点が
 *   揃うまで確定しない」という遅延要因を取り除いている。
 *
 * 震度0以上の通常検知については、その後さらに精度を上げるため、「近傍の
 * うち任意の1点が時間窓内に一致すればOK」という判定から、「近い順にN点中
 * K点以上が条件を満たす」という統計的に頑健な方式に置き換えた。さらに、
 * 1つの万能な式に頼らず、自点の現在値・自点の直近10秒間の上昇速度最大値・
 * 近傍の現在値・近傍の直近10秒間の上昇速度最大値、を組み合わせた複数の
 * ルール(detectionRules)を用意し、そのいずれか1つでも満たせば検知とする
 * (ごり押し型のアンサンブル。1つの型の地震だけでなく、急激/緩やか・
 * 局所/広域など複数のパターンを別々のルールで拾う狙い)。
 *
 * ただし瞬時diffだけでは、観測点固有の単発センサーノイズ(1tickだけ跳ねて
 * すぐ戻る揺らぎ)を拾って誤検知することがあったため、直近5秒平均(1Hz
 * 更新想定でhistoryLength=5tick)を「その観測点の落ち着いた基準値」として
 * 追加で参照し、そこから見ても十分上回っている場合のみ「急上昇」と認める
 * ようにしている。平均を待つと言っても直近5秒分の軽い参照でしかないため、
 * 検知の速さへの影響は最小限に抑えている。
 *
 * さらに、震度weakIntensityCeiling(既定0.5、震度0=無感地震相当の
 * 上限と揃えている)未満のごく微小な変化については、上記の「近傍が同時期に
 * 急上昇」判定の代わりに、ステップ3b(広域拡大検知、要件E参照)を使う。
 * 【旧実装からの変更】以前はP波の伝播速度に基づく3点連鎖検知(通称
 * microChain)も並行して使っていたが、観測点が密集する地域では観測点間隔が
 * 狭いため、偶然の速度一致(相関ノイズ由来)が成立しやすく、誤検知の主因の
 * 一つと判断して削除した。震度0未満〜weakIntensityCeiling未満の弱い揺れの
 * 検知は、広域拡大検知(要件E)に一本化している。
 *
 * パラメータ(DEFAULT_SHAKE_DETECTION_PARAMS)は仮の値。実データを見ながら
 * 調整すること。
 *
 * 入出力の形は旧実装を踏襲している(App.tsx側の変更を不要にするため):
 *   - initialize(stations): 観測点マスタが変わった時だけ呼ぶ
 *   - processTick(valuesMap, now): Map<観測点id, 震度相当値> を渡すたびに
 *     呼ぶ → 現在のイベント一覧(確定/未確定含む)を返す
 *
 * イベントの形(App.tsx側が参照する主要フィールド):
 *   id, level(0〜4), pointCount, centerLat, centerLon, confirmed
 *
 * 【23節: detectedAtの遅延対策】
 * event.detectionTimesに記録するdetectedAtは、以前は「判定ルール(近傍の
 * 裏付けを含む)が確定した時刻」をそのまま使っており、震源推定
 * (epicenterEstimation.ts)がこれを到達時刻として逆算するP波/S波到達円が、
 * 実際の揺れの広がりより遅れて表示される原因になっていた。判定ルール自体は
 * 誤検知防止のためそのまま維持しつつ、各観測点ごとに「今の上昇に反応し
 * 始めた時刻」をごく緩い基準(reactionRiseThreshold等)で常時追跡しておき、
 * 実際にイベントへ追加される際はその時刻をdetectedAtとして使うように
 * 変更した(addPointToEvent参照)。
 *
 * 【誤検知対策A・B・C】観測点が密集する陸域で、地理的相関ノイズ(天候・交通振動等)
 * によりdetectionRulesの緩い条件(ルール4)が誤発火し、quick retractionでも
 * 取り消されず数十秒残る不具合への対策。
 *   A) ステップ4のゲートをweakIntensityCeilingからdetectionRules専用の
 *      detectionRulesMinIntensity(0.1)に変更し、ルール4/5のminOwnIntensityが
 *      本来の設計通り機能するようにした。ルール4のminOwnIntensityは0.2→0.3へ
 *      引き上げ、ルール5との重複範囲も縮小した(2.2節)。
 *   B) quick retraction(ステップ9)に、検知時刻から見た伝播速度・タイミング
 *      相関の整合性チェックを追加。観測点数が増えていても、または反応が
 *      持続していても、伝播が地震として物理的に妥当でなければ取り消し対象
 *      にする(computeEventSpeedConsistencyRatio・computeEventTimingCorrelation)。
 *   C) BFS面的拡張(ステップ6)に、伝播元からの距離・時刻差に基づく伝播速度
 *      チェックを追加し、ノイズが速度を無視して際限なく面的に広がる(=Bの
 *      判定を誤魔化す)ことを防ぐ。
 *
 * 【要件E: 広域継続拡大による微小地震検知】
 * 震度上昇中の観測点の連結クラスタ(近傍25km以内で連結)を毎tick追跡し、
 * クラスタが「広く」かつ「継続的に拡大している(停滞は許容し、縮小した
 * 場合のみ実績をリセット)」場合に検知として採用する(processTickのステップ
 * 3b、broadRiseClustersを参照)。候補判定はUIの「震度上昇中」表示とほぼ
 * 同等の緩さ(broadRiseCandidateThreshold、瞬時diffベース)、初回から十分
 * 広いクラスタは継続拡大を待たず即検知するパス(broadRiseImmediateRadiusKm)
 * も備える。密集地域での相関ノイズ対策として、クラスタ内の「起点からの
 * 距離」と「出現の遅れ」の相関係数によるタイミング判別も行う
 * (computeBroadRiseTimingCorrelation)。
 *
 * 【旧microChainの削除】P波伝播速度に基づく3点連鎖検知は、密集地域での
 * 偶然の速度一致(相関ノイズ由来)による誤検知の主因の一つと判断し削除した。
 * 弱い揺れ(震度0未満〜weakIntensityCeiling未満)の検知は、上記の広域拡大
 * 検知(要件E)に一本化している。
 */

import { getJmaTravelTimeTable, lookupJmaTravelTime } from "./jmaTravelTime";
import { WeakArrayDetector } from "./weakArrayDetection";
import { calcPeakIntensity } from "./shakeTestSimulation";

export const DEFAULT_SHAKE_DETECTION_PARAMS = {
  // 近傍点探索(initialize時に1度だけ計算。SetupNearPoints相当)
  neighborRadiusKm: 25,        // これより近い観測点同士を「近傍」とみなす
  maxNeighbors: 8,             // 近傍点として保持する最大数(detectionRulesで
                                // 最大8点まで参照するルールがあるため)

  // 【23節】detectedAtの遅延対策: 「反応開始時刻」の追跡用の緩い基準。
  // detectionRules(近傍の裏付けを含む)が確定するまで待つと、記録される
  // detectedAtが実際にP波が到達した瞬間より数秒〜十数秒遅れてしまう
  // (震源推定・PS円描画のズレの原因になっていた)。判定ルール自体は誤検知
  // 防止のためそのまま維持しつつ、「いつのことにするか」の打刻だけを、
  // この緩い基準で常時追跡した「反応開始時刻」に差し替える(検知の確定は
  // 従来通り近傍裏付けを待つが、記録される時刻は実際の揺れ始めに近づく)。
  // microRiseThreshold/microAvgRiseThresholdよりもさらに緩い値にしている
  // (震度0以上の通常の地震でも、S波本震より前のごく初期の反応を捉えたい
  // ため)。
  reactionRiseThreshold: 0.08,     // 前tickからの上昇量がこれ以上で「反応開始」候補
  reactionAvgRiseThreshold: 0.05,  // 直近5秒平均からの上昇量がこれ以上必要(緩い版)

  // トリガー条件(1tickごとの即時判定+短期平均によるノイズ除去)
  riseThreshold: 0.5,          // 前tickからの上昇量がこれ以上で「急上昇」とみなす
  isolatedRiseThreshold: 1.2,  // 近傍が無い孤立点が単独トリガーするための上昇量(離島等)

  // 【対策: 離島・岬など孤立点の未検知】isolatedRiseThresholdは「1tickでの
  // 瞬間的な急上昇」しか見ていないため、実際の地震波のようにP波→S波と
  // 数秒かけて緩やかに震度が立ち上がるケースでは、最終的に震度2〜3まで
  // 達していても一度も瞬間diffの閾値を超えず、震度自体は高いのに永遠に
  // 未検知のままになることがあった。孤立点は近傍による裏付けが原理的に
  // 得られないため、瞬間diffベースの条件に加えて「震度そのものが十分高い
  // (=絶対値として明らかに強い揺れ)なら、上昇の仕方によらず検知する」
  // というOR条件を追加する。detectionRulesのルール2(中程度・広域型、
  // minOwnIntensity: 0.5)より厳しめの値にして、孤立点=裏付けなしで
  // 確定する分、慎重な閾値にしている。
  isolatedMinIntensity: 1.0,   // これ以上の震度なら、瞬間diffの条件を
                                // 満たさなくても単独トリガーする

  // 直近5秒平均によるノイズ除去。前tickとの比較だけだと、観測点固有の
  // 単発センサーノイズ(1tickだけ跳ねてすぐ戻るような揺らぎ)でも
  // riseThresholdを超えてしまうことがある。実データは1秒間隔で更新される
  // 前提で、直近5tick(=5秒)の平均を「その観測点の落ち着いた基準値」とみなし、
  // そこから見ても十分上回っていることを追加で要求することで誤検知を減らす。
  historyLength: 5,             // 平均に使う直近tick数(1Hz想定で5秒分)
  avgRiseThreshold: 0.4,        // 直近5秒平均からの上昇量がこれ以上必要
  isolatedAvgRiseThreshold: 1.0, // 孤立点の場合の、直近5秒平均からの上昇量の要求値

  // 直近10秒間の「上昇速度(1tickごとのdiff)」の最大値。ピークが少し前の
  // tickにあり、現在tickでは横ばい・微減していても拾えるようにするための
  // 判定材料(detectionRulesで使う)。
  riseRateHistoryLength: 10,   // 上昇速度の最大値を見る際の窓(1Hz想定で10秒分)

  // 近傍の裏付け判定(N点中K点以上)+複数ルールのアンサンブル。
  // 「近傍のうち任意の1点が時間窓内に急上昇していればOK」という判定は
  // 単一の近傍ノイズに引っ張られやすいため廃止し、「近い順にN点中K点以上が
  // 条件を満たす」という統計的に頑健な方式に置き換える。さらに、1つの
  // 万能な式ではなく、複数の観点(自点の現在値・自点の10秒最大上昇速度・
  // 近傍の現在値・近傍の10秒最大上昇速度)を組み合わせたルールをいくつか
  // 用意し、どれか1つでも満たせば検知とする(ごり押し型のアンサンブル)。
  // 弱い揺れを拾うルールほど、その分近傍の裏付け本数を厚くすることで、
  // 誤検知を増やさずに検知感度を上げている。
  // 震度0未満の点・孤立点(近傍なし)には適用しない(それぞれ別経路で判定)。
  detectionRules: [
    {
      // 強い揺れ・即応型: 自点が明確に上がっていて、近傍7点中2点も
      // 直近10秒で明確な上昇速度を記録していれば検知。
      minOwnIntensity: 1.0,
      minOwnRiseRateMax10s: 1.0,
      neighborCount: 7,
      requiredNeighborCount: 2,
      neighborMetric: "riseRateMax10s",
      minNeighborValue: 0.2,
    },
    {
      // 中程度・広域型: そこまで急激でなくても、近傍3点中2点が既に
      // ある程度の震度に達していれば検知。
      minOwnIntensity: 0.5,
      minOwnRiseRateMax10s: null,
      neighborCount: 3,
      requiredNeighborCount: 2,
      neighborMetric: "intensity",
      minNeighborValue: 1.0,
    },
    {
      // 急上昇・少数近傍即応型: 自点の上昇速度がそこそこ大きければ、
      // 近傍4点中1点の裏付けだけで速く検知する(速さ優先)。
      minOwnIntensity: 0.3,
      minOwnRiseRateMax10s: 0.6,
      neighborCount: 4,
      requiredNeighborCount: 1,
      neighborMetric: "riseRateMax10s",
      minNeighborValue: 0.3,
    },
    {
      // 広域同時多発型: 1点1点は弱くても、近傍8点中3点で同時に
      // 上がっていれば、広範囲の揺れとして検知する。
      //
      // 【誤検知対策A追加対応】detectionRulesMinIntensityを0.1へ下げた際、
      // このルール(近傍裏付けが3/8と緩い)がルール5(同5/8、より厳格)より
      // 先に評価されるため、新たに対象になった震度0.1〜0.2の範囲を
      // ルール4が奪ってしまい、ルール5の「厚い裏付けを要求する」設計が
      // 機能しない問題があった(要件定義2.2節)。minOwnIntensityを0.2→0.3へ
      // 引き上げ、震度0.1〜0.3の範囲はルール5(厳格な方)のみが担当する
      // ようにして重複を縮小した。
      minOwnIntensity: 0.3,
      minOwnRiseRateMax10s: 0.3,
      neighborCount: 8,
      requiredNeighborCount: 3,
      neighborMetric: "intensity",
      minNeighborValue: 0.2,
    },
    {
      // 微小地震・弱い揺れ専用型: 自点の条件は他ルールより大幅に緩めるが、
      // その分、近傍8点中5点(過半数)という厚い裏付けを要求することで
      // 誤検知の増加を抑える(単独の観測点ノイズでは近傍の過半数が
      // 同時に反応することはまず無いため)。
      minOwnIntensity: 0.1,
      minOwnRiseRateMax10s: 0.15,
      neighborCount: 8,
      requiredNeighborCount: 5,
      neighborMetric: "intensity",
      minNeighborValue: 0.1,
    },
  ],

  // 未確定(pending)状態の保持。震度0以上・近傍ありの通常検知は
  // detectionRulesに近傍の裏付けが組み込まれているためpendingを使わない。
  // 孤立点(単独トリガー)のみ、この仕組みで裏付け待ちを扱う。
  pendingExpireTicks: 3,       // 単独で急上昇した点が、これだけtickが経っても
                                // どの近傍からも裏付けを得られなければ静かに諦める

  // 【対策: 観測点の検知が重なると別々の地震が合成される問題】ある観測点が
  // 反応を完全に収めてから、次に反応が始まるまでにこれだけのtick(秒)が
  // 経っていれば「新しいエピソード」とみなし、既存のeventIdを解放する
  // (詳細はステップ1のコメント参照)。短すぎると、S波到達直後の一瞬の
  // 落ち込み等、同じ地震内の自然な揺らぎまで誤って「別の地震」と判定して
  // しまう。長すぎると、本来の目的(無関係な地震の混入防止)に間に合わない。
  // reactionAvgRiseThresholdの平均窓(historyLength=5秒)より十分長い値に
  // している。
  eventReleaseGapTicks: 10,

  // 【誤検知対策・microChain削除に伴う整理】このパラメータはもともと
  // 「震度0未満の微小変化専用のP波伝播速度連鎖(microChain)」の対象範囲を
  // 決める境界値だったが、microChain自体は密集地域での偶然の速度一致
  // (相関ノイズ)が誤検知の主因と判断して削除した。現在は「この値未満を
  // 弱い揺れとみなし、detectionRulesの対象外にする(その代わりステップ3b
  // の広域拡大検知(要件E)の対象にする)」という、より一般的な境界値として
  // 使っている。levelThresholds[0](0.5、震度0とみなす上限)と揃えている。
  weakIntensityCeiling: 0.5, // この値未満を「弱い揺れ」として扱う境界値

  // 【誤検知対策A】従来はステップ4(detectionRules評価)の対象を
  // weakIntensityCeiling(0.5)以上に限っていたため、ルール4
  // (minOwnIntensity: 0.2)・ルール5(同0.1)の閾値が常に0.5へ上書きされ、
  // 「無感地震〜弱い揺れを厚い近傍裏付けで拾う」という設計が機能して
  // いなかった。detectionRules側の最小値(ルール5の0.1)に合わせた専用の
  // ゲートを設け、ステップ4がこの値未満の点を対象外とするようにする。
  detectionRulesMinIntensity: 0.1, // detectionRules評価の対象とする震度下限
                                    // (ルール5のminOwnIntensityに合わせる)
  tickIntervalSeconds: 1,      // 1tickが何秒に相当するか(実データの更新間隔)

  // 【疎な観測点の近傍拡張】25km以内の近傍が少ない観測点(離島・海岸・山間部。全1628点のうち、
  // 0点が21、1〜2点が109)は、近傍の裏付けが取れず、孤立扱い(震度1.0以上か1秒で+1.2が必要)か、
  // 1〜2点の少数の裏付けになっていた。近傍がsparseNeighborMin点未満の観測点に限り、
  // sparseNeighborRadiusKm以内の近い順(最大maxNeighbors点)を、detectionRulesの裏付けに使う
  // (BFS拡張・クラスタ判定・孤立点の単独判定は従来のまま)。
  sparseNeighborEnabled: true,
  sparseNeighborMin: 3,
  sparseNeighborRadiusKm: 60,

  // 【配列型の微弱検知(weakArrayDetection.ts)】震度0未満〜0付近の、ごく弱い揺れ
  // (沖合の無感地震など)を、P波の伝播順序に合う観測点の立ち上がりの組み合わせとして
  // 検知する経路(ステップ3c)。既存の検知ルールは、観測点の値(震度の絶対値)や
  // 連結した広さを条件にするため、最大値が−1付近の弱い地震は検知できなかった。
  // 誤検知の恐れがあるため、無効にしたい場合は false にする。
  weakArrayEnabled: true,
  weakArrayParams: {},         // WeakArrayDetectorの設定の上書き(通常は空でよい)
  // 微弱検知は、弱い単独の地震のための経路。大きな地震(通常のイベントがこの点数以上)
  // の強い揺れが続いている間は、その揺れが遠方に届いた観測点が、別の小さなイベントとして
  // 検知され、イベントが分割・乱立する(東北沖M9のリプレイで、16個→19個に増えた)ので、
  // 検知を見送る。
  weakArrayStandDownPoints: 100,
  // 微弱検知のイベントに使った観測点を、イベントが消えたあと、再び新しいイベントに使わない時間(ms)。
  // 微弱検知の反応の保持時間(weakArrayParams.poolWindowSec=60秒)より長くする。
  weakArrayReuseBlockMs: 90_000,
  pWaveMinSpeedKmS: 5.5,       // 伝播速度として妥当とみなす下限(km/s)。
                                // BFS面的拡張(対策C)・quick retraction
                                // (対策B)の速度整合性チェックで使用
  pWaveMaxSpeedKmS: 8.0,       // 伝播速度として妥当とみなす上限(km/s)
                                // (shakeTestSimulation.tsのP波速度6.8km/sを中心に許容幅を持たせた値)

  // 【要件E】広域継続拡大による微小地震検知(旧microChainに代わる、震度0未満
  // 〜weakIntensityCeiling未満の弱い揺れを拾う唯一の経路)。
  // 強震モニタの実データで、広範囲(東北全域規模)にわたって震度上昇中の
  // 観測点が連続的に分布し、時間とともに面的に拡大していく事例が確認された。
  // microChain(3点以上の伝播速度一貫性連鎖)は厳密な速度整合性を要求する
  // ため、このような「広く・じわじわ広がる」タイプの揺れを拾えないことが
  // あった。震度上昇中の観測点の連結クラスタ(近傍25km以内で連結)を毎tick
  // 追跡し、広さ・継続的な拡大の両方を満たせば検知として採用する
  // (詳細はprocessTickのステップ3bを参照)。
  //
  // 【実データでのフィードバック】広域継続拡大検知の実運用テストで、UI上
  // 「震度上昇中(黄色)」に見える観測点の多くが検知(黒縁)に反映されて
  // いなかった。原因は、候補判定にmicroRiseThreshold(0.08)・
  // microAvgRiseThreshold(0.06)というmicroChain用の(比較的厳しい)基準を
  // 流用していたため。UI側の「上昇中」表示はごくわずかな上昇でも反映される
  // ため、基準のずれが取りこぼしを生んでいた。この経路は「広さ+継続性」の
  // 2段構えでノイズを弾く設計のため、候補基準自体は大きく緩めても誤検知
  // リスクは低いと判断し、専用の緩い閾値を新設した。また、初回のクラスタ
  // 形成時点で既に十分広ければ、growthTicks分の継続拡大を待たずに即検知する
  // パスも追加し、検知の遅さ(最低5秒のタイムラグ)を緩和する。
  //
  // 【誤検知対策・再々調整→ロールバック】一時的に「現在値 - 5〜10秒前の
  // 平均」という遅延窓平均方式に変更したが、バッファが貯まる10tick分
  // (10秒)、候補判定自体ができなくなり検知が大幅に遅くなる副作用があった。
  // microChain削除により密集地域の速度一致由来の誤検知は解消したと判断し、
  // 候補判定は即時diff方式(UIの「震度上昇中」表示とほぼ同等の感度)に戻す。
  broadRiseCandidateThreshold: 0.02, // 広域拡大検知専用の、候補に入れるための
                                      // 最小上昇量(前tickとの差)。UIの
                                      // 「震度上昇中」表示とほぼ同じ感度にする。
                                      // avgDiffによる足切りは行わない
                                      // (広さ+継続性+タイミング相関で別途
                                      // ノイズを弾くため)。
  broadRiseMinRadiusKm: 50,       // クラスタの半径(重心から最遠メンバーまでの
                                   // 距離)がこれ以上で「広域」候補とする
                                   // (propagationMaxRadiusKm=60kmよりやや小さく、
                                   // 1イベント分の面的拡張の範囲内に収まる規模)
  broadRiseImmediateRadiusKm: 90, // 初回クラスタ形成時点で既にこの半径以上
                                   // あれば、growthTicksの継続拡大実績を
                                   // 待たずに即検知する(broadRiseMinRadiusKm
                                   // の約1.8倍。既に明らかに広範囲であれば、
                                   // それ自体がノイズではなく本物である
                                   // 裏付けとして十分強いと判断)
  broadRiseGrowthTicks: 5,        // 拡大が継続している(または停滞、縮小して
                                   // いない)とみなすtick数がこれ以上で検知
                                   // (historyLength=5秒の窓と揃えた)
  broadRiseGrowthMinDeltaKm: 2,   // 半径の変化がこれ未満は「停滞」(継続実績を
                                   // 維持)、これ以上の減少で「縮小」とみなし
                                   // 継続実績をリセットする
  broadRiseOverlapRatio: 0.3,     // 前tickのクラスタと今tickのクラスタを同一と
                                   // みなす、メンバー重なり(Jaccard係数)の下限。
                                   // クラスタの分裂・合流も許容する緩さにして
                                   // いる(microChainの伝播速度ほど厳密な同一性
                                   // は求めない)

  // 【要件E追加対策】密集地域で「付近の観測点がたまたま同時に震度上昇する」
  // 相関ノイズ(交通振動・降雨等)が、broadRiseCandidateThreshold(0.02)の
  // 低さも相まって検知として誤って確定してしまう事例があったための対策。
  // クラスタ内で「起点からの距離」と「起点より遅れて候補になった時間」の
  // 相関係数を検証し、地震のような有限速度の伝播が見られない(≒同時多発的)
  // クラスタは検知を見送るようにする(computeBroadRiseTimingCorrelation参照)。
  broadRiseMinTimingCorrelation: 0.3, // 相関係数がこれ未満なら、同時多発的な
                                       // 相関ノイズの疑いとして検知を見送る
  broadRiseTimingMinSamples: 5,       // 相関係数を計算するために必要な最小
                                       // メンバー数。これ未満は判定材料不足として
                                       // 「本物とみなす」側に倒す(誤って弾かない)

  // 【25節】誤検知の素早い取り消し(quick retraction)用のパラメータ。
  // イベント作成からfalsePositiveCheckTicks以内に、(a)新たな観測点が
  // 1点も増えず、かつ(b)関与している観測点が軒並み「反応が収まった」
  // 状態(avgDiffがreactionAvgRiseThreshold未満)に戻っていれば、本物の
  // 地震ではなく単発のノイズ・瞬間的なスパイクだった可能性が高いと判断し、
  // 通常の寿命(eventDurationBaseMs、数十秒)を待たずにイベントを即座に
  // 取り消す。実際の地震は、揺れが面的に広がって観測点が増えていくか、
  // 少なくとも数秒〜数十秒は揺れが続く(shakeTestSimulation.tsの
  // HOLD_DURATION_MS等)ため、この両方が同時に起きることはまず無い。
  // 孤立トリガー(isolatedRiseThreshold、単独ですぐ確定扱いになる経路)は
  // 特に誤検知のリスクが高いため、この仕組みの主な対象になる。
  falsePositiveCheckTicks: 6, // イベント作成から何tick(≒秒)様子を見るか

  // 【誤検知対策B】quick retractionは従来「観測点数が増えていないこと」を
  // 本物判定の根拠にしていたが、観測点が密集する陸域で天候・交通振動等の
  // 地理的相関ノイズが発生すると、下のpropagationRiseThreshold(緩い基準)
  // によってBFS面的拡張が次々に近傍を巻き込み、観測点数が増え続けてしまう。
  // その結果、ノイズでも「観測点が増えた=本物」と誤判定され、取り消されずに
  // 数十秒残ってしまっていた。対策として、観測点数が増えているケースでも、
  // イベント内の検知時刻(detectionTimes)から実際の伝播速度を検証し、地震
  // として物理的に妥当な速度関係にあるペアの割合が一定基準を下回れば、
  // 取り消し対象とする。地理的相関ノイズは距離によらずほぼ同時多発になる
  // ため、速度が異常値(pWaveMaxSpeedKmS超)になりやすく、地震との差が
  // 出やすい。
  retractionSpeedConsistencyRatio: 0.5, // 妥当な速度レンジ(pWaveMinSpeedKmS〜
                                         // pWaveMaxSpeedKmS)に収まるペアの
                                         // 割合がこれ未満なら取り消し候補とする。
                                         // microChain(3点連鎖の速度整合を実質
                                         // 100%要求)ほど厳格にはせず、確定済み
                                         // イベントの取り消し判定として多少
                                         // 緩めている(detectionRulesの裏付け
                                         // 比率レンジ0.29〜0.63の中間水準)。
  retractionSpeedMinPairDistanceKm: 10, // これ未満の観測点ペアは、検知時刻の
                                         // ノイズで速度誤差が増幅されやすい
                                         // ため速度チェックの対象から除外する
                                         // (neighborRadiusKm=25kmより小さい値)。

  // 【誤検知対策B拡張】computeEventSpeedConsistencyRatioはretractionSpeed
  // MinPairDistanceKm未満のペアを除外するため、観測点間隔がそれより密な
  // 地域(都市部等)では有効なペアが得られず判定不能(null=「本物とみなす」
  // 側に倒れる)になりやすい弱点があった。密集地域でこそ問題になっている
  // 「付近の観測点がたまたま同時に上昇する」相関ノイズを弾けるよう、距離
  // による除外を行わないタイミング相関チェック(要件Eで先行導入した
  // computeBroadRiseTimingCorrelationと同じ考え方)もあわせて使う。
  retractionMinTimingCorrelation: 0.3, // 相関係数がこれ未満なら、同時多発的な
                                        // 相関ノイズの疑いとして取り消し対象とする
  retractionTimingMinSamples: 5,       // 相関係数の計算に必要な最小検知点数。
                                        // これ未満は判定材料不足として
                                        // 「本物とみなす」側に倒す

  // 面的拡張(BFS)。裏付けが取れて確定した点を核に、そこから緩い基準で
  // 近傍へ広げる(eq_detection.jsの「核は厳しく・拡張は緩く」を参考)。
  propagationRiseThreshold: 0.15, // これ以上の上昇があれば、単独では検知の
                                   // 裏付けにならなくても既存イベントへの
                                   // 取り込み(拡張)は許可する
  // 【検知点が少ない問題】BFS拡張の取り込み判定を、「そのtickの瞬間diff」だけでなく、
  // 直近10秒の最大上昇速度(riseRateMax10s)でも見る。以前は、隣の点がイベントに加わるより先に
  // 立ち上がった観測点は、その時のdiffが過ぎた後は、二度と取り込まれなかった。
  // また、伝播速度のチェックを、「今のtick」ではなく、両点の反応開始時刻の差で行い、同時に近い反応も
  // 許容する(以前は、距離/8〜距離/5.5秒の狭い窓の外の観測点は取り込まれなかった)。
  propagationUseRecentRise: true,
  propagationTimingMarginSec: 3,  // 反応開始の時刻差の許容(秒)。|差| <= 距離/pWaveMinSpeedKmS + この値
  // 【検知点が少ない問題】走時による取り込み(ステップ6b)。震源推定(epicenterEstimation.ts)の
  // 位置・発震時刻から計算したP波の到達時刻に、反応の開始時刻が合う観測点を、25km以内の近傍が
  // 検知済みかどうかに関係なく、そのイベントへ取り込む。揺れが弱く、観測点が離れた地域
  // (北海道東部など)で、震度0.1未満の弱い反応の観測点が、近傍の連鎖が切れて取り残されていた。
  indepEnabled: true,            // 独立した別の地震とみなして統合しない判定(independentSourceFit参照)
  earlyVetoEnabled: true,          // 主イベントのP波到達より早い検知の副イベントは統合しない(earlierThanMainWave)
  earlyVetoMaxFitCost: 8,          // 主イベントの点震源フィットの誤差がこれ以下のときだけ判定する
  earlyVetoSec: 20,                // P波到達よりこれだけ早ければ「早すぎる」とみなす(検知時刻の誤差の余裕)
  earlyVetoRatio: 0.7,             // 副イベントの検知点のうち、これ以上の割合が早ければ統合しない
  indepMinPoints: 12,            // 副イベントがこの点数以上で判定する(少ないと判別できない)
  indepMaxCost: 4.5,
  indepMinSeparationKm: 150,       // 主イベントの推定震央からこれ以上離れた所に震源が求まることが、独立とみなす条件
  indepMinLaterSec: 20,            // 副イベントの推定発震が、主イベントの発震よりこれ以上遅いこと
  indepFlatCostRatio: 0.85,        // 点震源の誤差が、「全点同時」とした誤差のこの倍以下であること(伝播の遅れが時刻を説明していること)
  indepExcessPerMag: 1.2,          // 主イベントのM7超過1あたり、上の下限に加える量
  indepMinExcess: 0.5,             // 主イベント由来の予想震度を上回る量(上位3点平均)の下限。コーダ約-1〜-2、独立地震約+1.5
  indepCapSec: 3,
  indepMarginDeg: 0.3,
  indepStepDeg: 0.15,
  gapFillEnabled: true,          // 更新間隔が空いた時、間のtickを補間して進める(processTick参照)
  gapFillMinMs: 1500,
  gapFillMaxMs: 6000,
  travelAbsorbEnabled: true,
  travelAbsorbMinPoints: 8,      // イベントがこの点数以上(推定が安定してから)で使う
  travelAbsorbMaxKm: 250,        // 震央からこの距離以内
  travelAbsorbGrowKm: 30,        // さらに、イベントの現在の広がり(震央から最も遠い検知点)+この距離以内。小さな地震で、遠方のノイズを取り込まないため
  travelAbsorbEarlySec: 3,       // P波の予測到達より、これだけ早い反応まで許容(秒)
  travelAbsorbLateSec: 6,        // P波の予測到達より、これだけ遅い反応まで許容(秒)
  travelAbsorbMinRise: 0.4,      // 直近10秒の最大上昇速度の下限(ノイズの偶然の一致を減らす)
  travelAbsorbMaxAgeSec: 25,     // 反応の開始から、これ以内の点だけ
  propagationMaxRadiusKm: 60,     // イベントの発生起点(最初に加わった点)から
                                   // これより離れた点へは拡張しない。上限が
                                   // 無いと、途中の弱いノイズや別の遠方の揺れを
                                   // 挟んで領域が際限なく膨らみ、本来無関係な
                                   // 別イベントと誤って統合されてしまうため。
                                   //
                                   // 【誤検知対策C】上記に加え、取り込み判定時に
                                   // 伝播元(current)から拡張先候補までの距離・
                                   // 時刻差から伝播速度を逆算し、pWaveMinSpeedKmS
                                   // 〜pWaveMaxSpeedKmSの範囲に収まらない場合は
                                   // 取り込まないようにする(詳細はprocessTick
                                   // ステップ6を参照)。propagationRiseThreshold
                                   // だけでは、密集地域でノイズが伝播速度を無視
                                   // して際限なく面的に広がり、Bの「観測点数が
                                   // 増えた」判定を誤魔化してしまうため。

  // 震度相当値(連続値) → イベントレベル(0〜4)への割り当て。
  // 4つのしきい値でレベル1〜4を区切る(この値未満はレベル0)。
  levelThresholds: [0.5, 2.0, 3.5, 5.0],

  // 【地域別の検知しきい値】特定の地域の観測点だけ、「上昇量」の基準を厳しくする。
  // 東京首都圏は交通・工事などの人為的な振動が多く、微小な揺れの誤検知が出やすいため、
  // この範囲(緯度・経度の矩形)にある観測点は、前tickとの差・直近5秒平均との差を
  // scale で割って(=scale倍の上昇を要求して)から、すべての上昇系しきい値
  // (reactionRiseThreshold・riseThreshold・isolatedRiseThreshold・
  // propagationRiseThreshold・broadRiseCandidateThreshold など)と比べる。
  // 震度の値そのもの(latestIntensity)や、震度による段階分け(levelThresholds)は変えない。
  // 複数の範囲が重なる観測点は、最も大きいscaleを使う。scale=1で無効。
  regionalRiseScales: [
    { name: "東京首都圏", minLat: 35.2, maxLat: 36.1, minLon: 138.9, maxLon: 140.5, scale: 1.5 },
  ],

  // イベントの統合・寿命
  mergeDistanceKm: 40,             // これより近い2つのイベントは統合する
  eventDurationBaseMs: 45_000,     // イベントの基本持続時間(ms)
  eventDurationPerLevelMs: 15_000, // レベルに応じて延びる持続時間(ms) x level

  // 【対策: 離島・海域を挟んだイベント統合】観測点の空白地帯(海域・離島間)
  // を挟むと、同じ地震でもmergeDistanceKm(40km、本土の密な観測点網を想定)
  // では届かず、複数の孤立したイベントとして残ってしまう事例が確認された。
  // canEventsShareOriginによる物理的な整合性チェック(タイミング+震度減衰)
  // を、ステップ7の統合判定にOR条件として追加する。
  // 【対策D: 実データでの深発地震(推定深さ110km等)による検知分散】以前は
  // 震源の深さを10km固定と仮定していたが、実際の地震(特に日本海溝〜
  // 日本海側にかけての深発地震)は数十〜数百kmの深さに及ぶことがあり、
  // 固定10km仮定では減衰計算が実態と大きく乖離し、本来同じ地震の断片が
  // 誤って別々のイベントのまま残ってしまう事例が確認された(1つの地震が
  // 推定深さ0km/110kmの5つのイベントに分裂していた)。単一の深さを仮定
  // する代わりに、複数の深さ候補を試し、その中で最も整合する(または
  // 最も広い到達距離になる)ものを採用するようにした。
  mergeDepthCandidatesKm: [5, 10, 20, 35, 50, 80, 120, 200], // 浅発〜深発
                                 // まで幅広くカバーする候補値(km)。実際の
                                 // 深さは分からないため、estimateMaxReachKm・
                                 // checkAttenuationConsistencyの両方で、
                                 // この中から最も都合の良い(=最も整合する)
                                 // 深さを採用する
  mergeFloorIntensity: -1.0,    // 「これ未満は物理的に検知され得ない」と
                                 // みなす震度の下限。この値まで減衰する
                                 // 震源距離を、地震の最大到達距離とする
  mergeReachMarginFactor: 1.2,  // 最大到達距離の逆算値に掛ける安全マージン
                                 // (震源の深さ・マグニチュード推定の粗さを
                                 // 考慮し、少し広めに許容する)
  // 【対策: タイミング整合性チェックが遠方の正当な統合を阻害していた
  // バグ】上記のタイミング整合性チェックは、当初BFS面的拡張・quick
  // retractionと同じpWaveMinSpeedKmS(5.5km/s、P波基準)を「最も遅い伝播
  // 速度」として使っていた。しかし、実際に観測される震度の立ち上がり
  // (reactionStartAt)はP波よりも遅いS波に強く連動するため、数百km規模の
  // 広域地震では、S波基準の実際の到達遅延がP波基準の許容上限を超えてしまい、
  // 本来統合すべき同一震源のイベントがタイミング整合性チェックの方で
  // 弾かれてしまう(実データで確認: 沖縄本島近海M7.0・震度4.4のケースで、
  // 距離488km・S波基準遅延125秒に対し、P波基準の許容上限は94秒しかなく
  // 統合されなかった)。タイミング整合性チェック専用に、S波速度
  // (shakeTestSimulation.tsのS_WAVE_SPEED_KM_S=3.9)を踏まえた、より
  // 遅い速度の下限を新設する。
  mergeTimingMinSpeedKmS: 3.0,  // タイミング整合性チェック専用の、最も遅い
                                 // 伝播速度の仮定。S波速度(3.9km/s)より
                                 // 少し余裕を持たせている(BFS拡張・quick
                                 // retractionのpWaveMinSpeedKmSとは別物、
                                 // 混同しないこと)
  mergeTimingMarginSec: 5,      // タイミング整合性チェックの許容誤差(秒)。
                                 // 起点の検知時刻(reactionStartAtベース)には
                                 // 多少のブレがあるため、固定の余裕を持たせる

  // 【対策: 明らかに別々の地震同士が誤って統合される問題】estimateMaxReachKm
  // による到達距離の上限チェック(2)だけでは、「遠くても理論上ゼロでは
  // ない」という緩い基準を通してしまい、歯止めにならないことが実データで
  // 確認された(宮城県沖M5.8・富山湾M5.8という明らかに無関係な2つの地震が
  // 誤って統合された。距離476kmは到達距離推定526kmより短く(2)は通過したが、
  // 476km地点でのM5.8地震からの予測震度は-1.26(無感)なのに対し、実際の
  // 観測震度は3.96で、差5.21は物理的に説明がつかない)。checkAttenuation
  // Consistencyで、実際に観測されている震度が減衰カーブと整合しているか
  // までチェックする。
  mergeAttenuationToleranceIntensity: 1.5, // 予測震度と実際の観測震度との
                                            // 許容誤差。震度→マグニチュード
                                            // の逆算の粗さ・観測点ごとの
                                            // 地盤差を考慮した値。要調整

  // 【対策C】epicenterEstimation.tsの推定震源同士が、これ以内の距離に
  // 収束していれば「同じ地震」の直接的な根拠として統合してよいとする
  // 閾値。収束済み(confirmed)の推定は、収束前と比べて位置の信頼度が
  // 高いため、mergeDistanceKm(40km、簡易判定用)よりは緩められるが、
  // それでも無関係な近隣の地震まで誤統合しないよう、控えめな値にする。
  mergeRefinedEstimateDistanceKm: 60,
  // 【対策: 同じ地震が複数のイベントに分散する問題】統合判定に、収束済みの震源推定
  // (主イベントの推定震源・発震時刻)から計算したP波・S波の走時を使う規則を加える
  // (canEventBeMergedByTravelTime参照)。
  mergeTravelTimeMinMainPoints: 20,  // 主イベントがこの点数以上で、推定が収束済みの時だけ使う
  mergeTravelTimeEarlySec: 4,        // 観測点の検知がP波到達よりこれだけ早くても許容(秒、検知時刻の誤差)
  mergeTravelTimeLateSec: 8,         // S波到達よりこれだけ遅くても許容(秒)
  mergeTravelTimeUnconfirmedMinPoints: 100, // 推定が未収束でも、主イベントがこの点数以上なら使う
  mergeTravelTimeInWindowRatio: 0.7, // 副イベントの観測点のうち、これ以上の割合が「P波〜S波」の窓に入れば統合
  mergeSurfaceWaveMinMagnitude: 6.5, // 主イベントの推定がこのM以上なら、窓の終わりを表面波の到達まで延ばす
  mergeSurfaceWaveSpeedKmS: 2.5,     // 表面波の速度の目安(km/s)。3.0だと、M7.5青森県東方沖で400km離れた北海道北部の観測点群(P波の約100秒後に検知)が窓から外れ、別イベントに分裂した
  mergeCodaEnabled: true,            // 大きな地震の後続動(coda)で遠方に出る小さなイベントを、主イベントへ統合する
  mergeCodaMinMagnitude: 6.5,        // 主イベントの推定がこのM以上
  mergeCodaMaxPoints: 20,            // 副イベントがこの点数以下(小さい)
  mergeCodaMaxSinceOriginSec: 900,   // 発震時刻からこの時間以内
  mergeCodaMarginKm: 60,             // 主イベントの検知範囲(震央から最も遠い検知点)にこの余裕を足した範囲内
};

// 2点間の距離(km, 簡易haversine)
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// 2つのバウンディングボックス(イベントの領域)間の最短距離(km)を概算する。
// イベント同士の統合判定に、中心点同士の距離ではなくこちらを使う。広範囲に
// 及ぶ揺れでは、各イベントの領域(バウンディングボックス)は隣接していても
// 中心点同士は離れていることが多く、中心点だけで判定すると統合されずに
// 小さなイベントが乱立してしまうため。
function rectMinDistanceKm(a, b) {
  const dLat = Math.max(0, a.minLat - b.maxLat, b.minLat - a.maxLat);
  const midLat = (a.centerLat + b.centerLat) / 2;
  const kmPerLon = 111 * Math.max(0.1, Math.cos(midLat * Math.PI / 180));
  const dLon = Math.max(0, a.minLon - b.maxLon, b.minLon - a.maxLon) * kmPerLon;
  const kmLat = dLat * 111;
  return Math.sqrt(kmLat * kmLat + dLon * dLon);
}

// 【対策: 離島・海域を挟んだイベント統合】shakeTestSimulation.tsの
// calcPeakIntensityと同じ、震源距離・マグニチュード・深さから震度を求める
// 減衰式(のコピー)。震度→距離の逆算(bisection)に使う。
// 【対策: 距離減衰式の誤差が大きい問題】司・翠川(1999)の正式な式に合わせて
// 更新した。詳細・参考文献はshakeTestSimulation.tsのcalcPeakIntensityの
// コメントを参照(この2つは常に同じ式を保つこと)。
function calcPeakIntensityForMerge(magnitudeJma, depthKm, distHypoKm, eventTypeCoeff = 0) {
  const mw = magnitudeJma - 0.171; // 宇津(1982): Mjma → Mw
  const faultLengthKm = Math.pow(10, 0.5 * mw - 1.85); // 宇津(1977): 断層長(km)
  const shortestDistKm = Math.max(distHypoKm - faultLengthKm * 0.5, 3);
  const logPgv600 =
    0.58 * mw +
    0.0038 * depthKm +
    eventTypeCoeff -
    Math.log10(shortestDistKm + 0.0028 * Math.pow(10, 0.5 * mw)) -
    0.002 * shortestDistKm -
    1.29;
  const pgv600 = Math.pow(10, logPgv600);
  const ARV = 1.0; // 観測点ごとの地盤増幅度データが無いため無補正
  const pgvSurface = pgv600 * 1.31 * ARV; // 工学的基盤600m/s→400m/sへの変換
  let intensity = 2.68 + 1.72 * Math.log10(pgvSurface);
  if (intensity > 7.5) intensity = 7.5 + (intensity - 7.5) * 0.1;
  return intensity;
}

// ピーク震度→マグニチュードの逆算(二分探索)。「ピーク観測点は震源直上
// (震源距離≈深さ)」という単純化した仮定を置いた、粗い推定。
// 【注意】下限を-5という物理的にありえない値まで広げているのは、これが
// 実在の地震のマグニチュードを推定する目的ではなく、あくまで「震度→到達
// 距離」の滑らかな補間曲線を作るための計算上のパラメータだから。下限を
// 通常のマグニチュード下限(例: 2)にすると、震源距離(≈深さ=
// mergeAssumedDepthKm)における最小到達震度がすでにそれなりの値になり、
// 震度0.1〜0.7程度の弱いイベントが軒並み同じ(過大な)到達距離に丸められて
// しまう(弱いイベントほど到達距離を短くしたいという設計意図が壊れる)。
function estimateMagnitudeFromPeakIntensity(peakIntensity, depthKm) {
  let lo = -5, hi = 9;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    const est = calcPeakIntensityForMerge(mid, depthKm, depthKm);
    if (est < peakIntensity) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

// マグニチュード→「震度がfloorIntensityまで減衰する震源距離」の逆算
// (二分探索)。震度は震源距離について単調減少のため安全に二分探索できる。
function estimateReachDistanceKm(magnitude, depthKm, floorIntensity) {
  let lo = depthKm, hi = 2000;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    const est = calcPeakIntensityForMerge(magnitude, depthKm, mid);
    if (est > floorIntensity) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

// 【対策: 離島・海域を挟んだイベント統合】観測されたピーク震度から、この
// 地震が物理的に検知され得る最大到達距離(震源からの距離)を逆算する。
// 弱いイベント(ノイズに近い)ほど短く、強い地震ほど長くなる。
// 【対策D】単一の深さ仮定ではなく、mergeDepthCandidatesKmの各候補で計算し、
// 最も広い(=最も許容的な)到達距離を採用する。深発地震は同じ近傍震度でも
// より遠くまで揺れが届くことがあるため、浅い深さだけを仮定していると
// 深発地震の正当な統合を過小に見積もってしまうことへの対策。
function estimateMaxReachKm(peakIntensity, params) {
  if (peakIntensity == null) return null;
  let maxReachKm = 0;
  for (const depthKm of params.mergeDepthCandidatesKm) {
    const magnitude = estimateMagnitudeFromPeakIntensity(peakIntensity, depthKm);
    const reachKm = estimateReachDistanceKm(magnitude, depthKm, params.mergeFloorIntensity);
    if (reachKm > maxReachKm) maxReachKm = reachKm;
  }
  return maxReachKm * params.mergeReachMarginFactor;
}

// 【対策: 明らかに別々の地震同士が誤って統合される問題】estimateMaxReachKm
// による到達距離の上限チェックは、「震度が検知不能なレベルまで減衰する
// 限界距離」という非常に緩い基準であり、「その距離で実際に観測されている
// 震度と整合しているか」までは見ていない。実データで、宮城県沖(M5.8)と
// 富山湾(M5.8)という明らかに無関係な2つの地震が誤って統合される事例が
// 確認された。距離(約476km)は片方の到達距離推定(約526km)より短かった
// ため上限チェックは通過してしまうが、実際にはその距離でM5.8の地震から
// 予測される震度はほぼ無感(-1.26)であるのに対し、実際の観測震度は3.96と
// 大きく乖離しており、物理的に説明がつかない値だった。
//
// このチェックでは、一方のイベントのピーク震度から推定したマグニチュード
// (estimateMagnitudeFromPeakIntensityと同じロジック)を使い、「もう一方の
// イベントの距離における予測震度」を計算し、そのイベントで実際に観測された
// ピーク震度との差を見る。差が大きすぎれば(mergeAttenuationTolerance
// Intensityを超えれば)、同じ震源からとは物理的に説明できないと判断する。
// A→B、B→Aの両方向で判定し、どちらか一方が整合していればOKとする
// (震度→マグニチュードの逆算はピーク観測点が震源直上という単純化した
// 仮定に基づく粗い推定のため、両方向を厳密に要求すると精度の粗さの影響を
// 受けやすくなるため)。
// 【対策D】単一の深さ仮定では、実際の震源が深発地震だった場合に整合しない
// と誤判定してしまう(実データで、1つの地震が推定深さ0km/110kmの5つの
// イベントに分裂する事例が確認された)。mergeDepthCandidatesKmの各候補で
// 判定し、最も整合する(diffが最小になる)深さを採用する。
function checkAttenuationConsistency(a, b, params) {
  if (a.peakIntensity == null || b.peakIntensity == null) return true; // 判定材料が無ければ弾かない
  const distKm = haversineKm(a.originLat, a.originLon, b.originLat, b.originLon);

  let bestDiff = Infinity;
  for (const depthKm of params.mergeDepthCandidatesKm) {
    const magnitudeA = estimateMagnitudeFromPeakIntensity(a.peakIntensity, depthKm);
    const predictedAtB = calcPeakIntensityForMerge(magnitudeA, depthKm, distKm);
    const diffAtB = Math.abs(predictedAtB - b.peakIntensity);

    const magnitudeB = estimateMagnitudeFromPeakIntensity(b.peakIntensity, depthKm);
    const predictedAtA = calcPeakIntensityForMerge(magnitudeB, depthKm, distKm);
    const diffAtA = Math.abs(predictedAtA - a.peakIntensity);

    bestDiff = Math.min(bestDiff, diffAtB, diffAtA);
  }

  return bestDiff <= params.mergeAttenuationToleranceIntensity;
}

// 【対策C: epicenterEstimation.tsのより精度の高い推定を統合判定に使う】
// shakeDetection.ts内の簡易チェック(canEventsShareOrigin・canEventsMerge)は、
// 「最初にイベントへ加わった1点」を起点、「観測されたピーク震度」だけを
// 手がかりにした粗い推定に頼っている。一方epicenterEstimation.tsは、
// グリッド探索+振幅較正(fitMagnitude)により、検知済みの全観測点を使った
// より精度の高い震源位置・深さ・マグニチュードを求めている。この、より
// 信頼できる推定が両方のイベントで収束済み(confirmed)であれば、そちらを
// 優先して使う。
//
// externalEstimatesは、App.tsx側でepicenterEstimation.tsのEpicenterEstimator
// を実行した結果を、engine.setExternalEstimates()経由で受け取ったもの
// (Map<eventId, { lat, lon, depthKm, magnitude, confirmed, ... }>)。
// 1tick遅れでの反映になるが、イベント統合の判定は瞬時性より精度を優先
// すべき処理のため許容している。
//
// 戻り値は3値: true(統合してよい)・false(統合しない)・null(精度の高い
// 推定がまだ揃っていない=判定材料不足、呼び出し側は従来の簡易チェックに
// フォールバックする)。
function canEventsMergeByRefinedEstimate(a, b, externalEstimates, params) {
  if (!externalEstimates) return null;
  const estA = externalEstimates.get(a.id);
  const estB = externalEstimates.get(b.id);
  // 収束済み(confirmed)の推定のみを信頼する。収束前は検知点数が少なく
  // 位置が大きくぶれるため、これを根拠に「整合する/しない」を判定すると
  // かえって誤判定のもとになる。
  if (!estA || !estB || !estA.confirmed || !estB.confirmed) return null;

  const distKm = haversineKm(estA.lat, estA.lon, estB.lat, estB.lon);

  // (a) 推定震源同士が十分近ければ、それ自体が「同じ地震である」という
  //     直接的で強い根拠になる(多数の観測点を使った推定同士が近い位置に
  //     収束したという事実そのもの)。震度整合性の判定を待たずに統合する。
  if (distKm <= params.mergeRefinedEstimateDistanceKm) return true;

  // (b) 震源が離れている場合でも、一方の推定マグニチュード・深さから、
  //     もう一方の観測点位置での予測震度を計算し、実際の観測ピーク震度と
  //     比較する(checkAttenuationConsistencyと同じ考え方だが、粗い
  //     起点・単一深さ仮定ではなく、推定済みの震源・深さ・マグニチュード
  //     を直接使えるぶんより正確)。
  let consistent = false;
  if (a.peakIntensity != null && estA.magnitude != null) {
    const predictedAtB = calcPeakIntensityForMerge(estA.magnitude, estA.depthKm, distKm);
    if (b.peakIntensity != null && Math.abs(predictedAtB - b.peakIntensity) <= params.mergeAttenuationToleranceIntensity) {
      consistent = true;
    }
  }
  if (!consistent && b.peakIntensity != null && estB.magnitude != null) {
    const predictedAtA = calcPeakIntensityForMerge(estB.magnitude, estB.depthKm, distKm);
    if (a.peakIntensity != null && Math.abs(predictedAtA - a.peakIntensity) <= params.mergeAttenuationToleranceIntensity) {
      consistent = true;
    }
  }
  return consistent;
}

// 【対策: 離島・海域を挟んだイベント統合】観測点の空白地帯(海域・離島間)を
// 挟むと、同じ地震でも複数の孤立したイベントとして検知され、通常の距離
// ベースの統合(rectMinDistanceKm <= mergeDistanceKm)では届かないことが
// あった。2つのイベントが物理的に同じ震源から来た可能性を、以下の3条件の
// ANDで判定する。
//
// (1) タイミング整合性(片側のみ): 三角不等式により、2つの起点の検知時刻差は
//     「起点間の距離を最も遅い伝播速度(mergeTimingMinSpeedKmS、S波速度基準)
//     で割った値」を超えられない(超えていれば、共通の震源からは物理的に
//     説明できないほど離れている=別の地震)。逆に時刻差が小さすぎることは、
//     共通震源に対しほぼ等距離なら普通に起こり得るため、除外条件には
//     使わない(下限なし)。【注意】BFS拡張・quick retractionのpWave
//     MinSpeedKmS(P波基準、5.5km/s)とは別のパラメータを使う。震度の
//     立ち上がり(reactionStartAt)はS波に強く連動するため、P波基準では
//     広域地震の正当な統合まで誤って弾いてしまうことが実データで確認された
//     (沖縄本島近海M7.0のケース)。
// (2) 震度減衰整合性(到達距離の上限): 起点間の距離が、どちらか一方の
//     ピーク震度から逆算される最大到達距離(estimateMaxReachKm)を超えない
//     こと。弱いイベント(ノイズに近い)同士では最大到達距離が小さくなる
//     ため、遠方のイベントとは統合されにくくなる。
// (3) 減衰カーブとの整合性(checkAttenuationConsistency): (2)だけでは
//     「到達距離の上限を超えていないか」という緩い基準しか見ておらず、
//     明らかに無関係な2つの地震が誤って統合される事例が実データで確認
//     された(宮城県沖・富山湾のケース)。一方のイベントの震度から推定
//     されるマグニチュードで、もう一方のイベントの距離での予測震度を
//     計算し、実際の観測震度との乖離が大きすぎないかを追加でチェックする。
function canEventsShareOrigin(a, b, params) {
  if (a.originLat == null || b.originLat == null) return false;
  if (a.originDetectedAt == null || b.originDetectedAt == null) return false;
  const distKm = haversineKm(a.originLat, a.originLon, b.originLat, b.originLon);

  const elapsedSec = Math.abs(a.originDetectedAt - b.originDetectedAt) / 1000;
  const maxAllowedSec = distKm / params.mergeTimingMinSpeedKmS + params.mergeTimingMarginSec;
  if (elapsedSec > maxAllowedSec) return false;

  const reachA = estimateMaxReachKm(a.peakIntensity, params);
  const reachB = estimateMaxReachKm(b.peakIntensity, params);
  const maxReach = Math.max(reachA ?? 0, reachB ?? 0);
  if (distKm > maxReach) return false;

  if (!checkAttenuationConsistency(a, b, params)) return false;

  return true;
}

// 【対策: 地震の検知範囲が成長すると無関係な地震同士が統合されてしまう
// 問題】ステップ7の統合判定は、当初「バウンディングボックス同士の距離が
// mergeDistanceKm(40km)以内」であれば、物理的な整合性を一切確認せず
// 無条件に統合していた(canEventsShareOriginは、この距離チェックを超えた
// 遠方のケースを救済するための"追加"条件として設計されていたため)。
// しかし、片方のイベント(例えば強い地震)がBFS面的拡張・広域拡大検知で
// 大きく成長すると、そのバウンディングボックスが、震源からは遠く離れた
// 無関係な別の地震の領域とたまたま40km以内に近づいてしまうことがあり、
// この場合は物理チェックを経由せず誤って統合されてしまう不具合が実データで
// 確認された(強い地震Aの成長中に、Aの震源から199km離れた場所で約80秒後に
// 発生した無関係な地震Bが、Aのバウンディングボックスの成長に伴い誤って
// 統合される事例をシミュレーションで再現)。
//
// 対策として、近接している場合(rectMinDistanceKm <= mergeDistanceKm)でも、
// 起点の情報(originLat/originDetectedAt/peakIntensity)が両方とも揃って
// いれば、canEventsShareOriginと同じタイミング・減衰の物理チェックを行う。
// ただし判定材料がまだ揃っていない場合(検知直後等)は、従来通り「近ければ
// 統合する」という寛容な挙動を維持する(これは、本当に同じ地震の一部が
// 処理タイミングの都合で分裂しているだけのケースを、材料不足を理由に
// 誤って統合し損ねないようにするため)。
// 【対策: 同じ地震が複数のイベントに分散する問題】
// 大きな地震では、同じ地震なのに、震源から離れた観測点群が別の小さなイベント(多くは
// 弱い遠方の揺れ、または震度の急上昇がS波到達で起きた観測点群)として検知され、統合
// されないことが実データ(2024能登M7.6・2021福島県沖M7.3・2011東北沖M9.0)で確認された。
// 従来の判定は、(1)起点同士の検知時刻差を最も遅い速度(3km/s)で割った許容値、(2)減衰式
// による予測震度との差(許容1.5)、のどちらも、P波とS波の検知の違い・遠方での減衰式の偏り
// に弱く、同じ地震の遠方の観測点群を弾いてしまっていた。
// そこで、主イベントの収束済みの震源推定(位置・深さ・発震時刻)から、副イベントの各観測点
// へのP波・S波の走時を計算し、各観測点の検知時刻が「P波到達の少し前〜S波到達の少し後」の
// 窓に入っているかで、同じ地震の波が届いたものかを判定する。窓に入る観測点の割合が
// mergeTravelTimeInWindowRatio以上なら、物理的に同じ地震とみなして統合する。
// (別の地震の観測点群は、検知時刻が主震の窓に収まる確率が低い)
export function pAndSTravelSec(epicentralKm, depthKm) {
  const t = lookupJmaTravelTime(getJmaTravelTimeTable(), epicentralKm, depthKm);
  if (t && t.sTimeSec != null) return [t.pTimeSec, t.sTimeSec];
  const hypoKm = Math.hypot(epicentralKm, depthKm);
  return [hypoKm / 6.8, hypoKm / 3.9];
}
// 【対策: 別々の地震が誤って統合される問題】副イベントの検知点が、そのイベント自身の点震源(クラスターの
// 範囲内の浅い震源)から広がるP波として、到達時刻をよく説明できるかを調べる。説明できれば、主イベントの
// 後続動(coda)や遠方の揺れではなく、独立した別の地震とみなして、統合しない。主イベントの後続動は、
// 主イベントの震源から平面的に伝わる波なので、クラスターの内側に震源を置いても、到達時刻の並びを説明できない。
// 検知は、真のP波到達より「遅れる」ことはあっても「早まる」ことはほぼ無いので、非対称のロバスト誤差を使う
// (発生時刻は残差の下位25%点、それより早い側は4倍の重み、遅い側は1点あたりindepCapSecで頭打ち)。
export function independentSourceFit(ev, params) {
  const cache = ev._indepFit;
  if (cache && Math.abs(cache.n - ev.pointCount) < 3) return cache.fit;
  const all = [...ev.detectionTimes.values()];
  if (all.length < params.indepMinPoints) { ev._indepFit = { n: ev.pointCount, fit: null }; return null; }
  const step = Math.max(1, Math.floor(all.length / 60));
  const dets = all.filter((_, i) => i % step === 0);
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  for (const d of dets) { minLat = Math.min(minLat, d.lat); maxLat = Math.max(maxLat, d.lat); minLon = Math.min(minLon, d.lon); maxLon = Math.max(maxLon, d.lon); }
  const m = params.indepMarginDeg;
  const cap2 = params.indepCapSec * params.indepCapSec;
  const n = dets.length;
  const r = new Array(n);
  let best = null;
  for (let lat = minLat - m; lat <= maxLat + m + 1e-9; lat += params.indepStepDeg) {
    for (let lon = minLon - m; lon <= maxLon + m + 1e-9; lon += params.indepStepDeg) {
      for (const depth of [10, 40, 80]) {
        for (let i = 0; i < n; i++) {
          r[i] = dets[i].detectedAt / 1000 - pAndSTravelSec(haversineKm(lat, lon, dets[i].lat, dets[i].lon), depth)[0];
        }
        const sorted = [...r].sort((a, b) => a - b);
        const origin = sorted[Math.floor((n - 1) * 0.25)];
        let sum = 0;
        for (let i = 0; i < n; i++) {
          const dev = r[i] - origin; const sq = dev * dev;
          sum += dev < 0 ? 4 * Math.min(sq, cap2) : Math.min(sq, cap2);
        }
        const cost = sum / n;
        if (!best || cost < best.cost) best = { cost, originMs: origin * 1000, lat, lon, depth };
      }
    }
  }
  ev._indepFit = { n: ev.pointCount, fit: best };
  return best;
}
// 副イベントの観測点の震度が、主イベントの震源・規模から予想される震度を、どれだけ上回るか(上位3点の平均)。
// 主イベントの後続動・遠方の揺れなら、予想(減衰式)と同程度かそれ以下だが、独立した別の地震なら、
// 自身の震央付近で、主イベント由来の予想を大きく上回る揺れを観測する。
function intensityExcessOverMain(ev, estMain) {
  if (estMain.magnitude == null || estMain.lat == null) return null;
  const ex = [];
  for (const d of ev.detectionTimes.values()) {
    if (d.intensity == null) continue;
    const epi = haversineKm(estMain.lat, estMain.lon, d.lat, d.lon);
    const exp = calcPeakIntensity(estMain.magnitude, estMain.depthKm ?? 10, Math.hypot(epi, estMain.depthKm ?? 10));
    ex.push(d.intensity - exp);
  }
  if (ex.length === 0) return null;
  ex.sort((a, b) => b - a);
  const k = Math.min(3, ex.length);
  let s = 0; for (let i = 0; i < k; i++) s += ex[i];
  return s / k;
}
// 検知時刻が距離によらず一定(同時)とみなした場合の誤差(independentSourceFitと同じ頭打ち誤差、発生時刻=下位25%点)。
// 点震源の誤差がこれと大差なければ、時刻の差(距離による遅れ=波の伝播)が小さく、点震源の根拠が弱い
// (コンパクトな集団や、距離によらず遅れて検知される場合は、どんな震源でも当てはまってしまう)。
function flatTimeCost(ev, params) {
  const cap2 = params.indepCapSec * params.indepCapSec;
  const t = [...ev.detectionTimes.values()].map((d) => d.detectedAt / 1000).sort((a, b) => a - b);
  if (t.length === 0) return null;
  const o = t[Math.floor((t.length - 1) * 0.25)];
  let sum = 0;
  for (const x of t) sum += Math.min((x - o) * (x - o), cap2);
  return sum / t.length;
}
export function looksIndependent(ev, mainEst, params) {
  if (!params.indepEnabled) return false;
  const fit = independentSourceFit(ev, params);
  if (!fit) return false;
  const excess = intensityExcessOverMain(ev, mainEst);
  // 主イベントの震央に近い所に震源が求まる副イベントは、同じ地震の分裂(破片)の可能性が高いので、独立とはみなさない。
  const sepKm = mainEst && mainEst.lat != null ? haversineKm(mainEst.lat, mainEst.lon, fit.lat, fit.lon) : 0;
  const laterOk = mainEst && mainEst.originTime != null ? (fit.originMs - mainEst.originTime) / 1000 >= params.indepMinLaterSec : true;
  // 主イベントが大きいほど震源域が広く、点震源の減衰式による予想震度は過小になる(実際の揺れはもっと広く強い)ので、
  // 「予想を上回る量」の基準を、M7を超える分だけ厳しくする。
  const minExcess = params.indepMinExcess + params.indepExcessPerMag * Math.max(0, (mainEst?.magnitude ?? 0) - 7);
  const ok0 = fit.cost <= params.indepMaxCost && excess != null && excess >= minExcess
    && sepKm >= params.indepMinSeparationKm && laterOk;
  const mainCost = ok0 ? flatTimeCost(ev, params) : null;
  const ok = ok0 && (mainCost == null || fit.cost <= params.indepFlatCostRatio * mainCost);
  return ok;
}

// 【対策: 同時期に離れた場所で起きた別の地震が統合される問題】副イベントの検知が、主イベントの震源から
// 伝わるP波の到達より、明らかに「早い」ときは、主イベントの波では起こせない検知なので、別の地震である。
// (2018-01-05 富山と茨城沖の2地震: 約350km離れ、検知は約8秒差。従来の統合判定は「遅すぎない」という
// 片側のタイミング確認だけで、早すぎる側を見ていなかった。)主イベントの震源は、独立判定と同じ点震源の
// フィット(independentSourceFit)で求めるので、推定が未収束でも使える。フィットの誤差が大きい
// (主イベントの震源が定まらない=大地震の広がった検知など)ときは判定しない。
function earlierThanMainWave(main, other, params) {
  if (!params.earlyVetoEnabled) return false;
  const fit = independentSourceFit(main, params);
  if (!fit || fit.cost > params.earlyVetoMaxFitCost) return false;
  const dets = [...other.detectionTimes.values()];
  if (dets.length === 0) return false;
  let early = 0;
  for (const d of dets) {
    const epi = haversineKm(fit.lat, fit.lon, d.lat, d.lon);
    const tp = pAndSTravelSec(epi, fit.depth)[0];
    if ((d.detectedAt - fit.originMs) / 1000 < tp - params.earlyVetoSec) early++;
  }
  return early / dets.length >= params.earlyVetoRatio;
}

function canEventBeMergedByTravelTime(main, other, estMain, params) {
  if (!estMain || estMain.originTime == null) return false;
  if (main.pointCount < params.mergeTravelTimeMinMainPoints) return false;
  // 推定が収束(confirmed)していなくても、主イベントが十分大きければ使う。2011東北沖M9.0の
  // ように震源域が大きい地震では、推定が収束しないまま観測点が数百点になり、別イベントが
  // 統合されずに残っていた。窓(P波〜S波/表面波)は広いので、粗い推定でも判定できる。
  if (!estMain.confirmed && main.pointCount < params.mergeTravelTimeUnconfirmedMinPoints) return false;
  const dets = [...other.detectionTimes.values()];
  if (dets.length < 1) return false;
  if (looksIndependent(other, estMain, params)) return false;
  // 1点だけの副イベント(孤立した観測点の検知)は、偶然、窓に入る可能性が高いので、窓を
  // 広げる加算(大きな地震の表面波・破壊継続時間)は使わず、P波〜S波の窓だけで判定する。
  const strict = dets.length < 2;
  let inWindow = 0;
  for (const d of dets) {
    const epiKm = haversineKm(estMain.lat, estMain.lon, d.lat, d.lon);
    const [tp, ts] = pAndSTravelSec(epiKm, estMain.depthKm);
    const lagSec = (d.detectedAt - estMain.originTime) / 1000 - tp; // P波到達からの遅れ
    let lateLimitSec = (ts - tp) + params.mergeTravelTimeLateSec;
    // 大きな地震(推定M6.5以上)では、遠方の観測点が、S波ではなく、その後に届く表面波
    // (速度およそmergeSurfaceWaveSpeedKmS)の立ち上がりで初めて検知されることがある
    // (2021福島県沖M7.3で、震源から250〜300km離れた新潟・山形の観測点群が、P波到達の
    // 約60〜70秒後に検知された)。この場合は、窓の終わりを表面波の到達まで延ばす。
    if (!strict && estMain.magnitude != null && estMain.magnitude >= params.mergeSurfaceWaveMinMagnitude) {
      const hypoKm = Math.hypot(epiKm, estMain.depthKm);
      lateLimitSec = Math.max(lateLimitSec, hypoKm / params.mergeSurfaceWaveSpeedKmS - tp + params.mergeTravelTimeLateSec);
      // 震源の破壊が続く時間(目安 10^(0.5×(M-5)) 秒。M7で約10秒、M7.6で約20秒、M8で約30秒)
      // だけ、強い揺れの到達が遅れる。2024能登M7.6で、震源から100〜120kmの新潟の観測点が、
      // 強い揺れ(震度5)を捉えて検知されたのは、P波到達の約30秒後だった(S波は約13秒後)。
      lateLimitSec += Math.pow(10, 0.5 * (estMain.magnitude - 5));
    }
    if (lagSec >= -params.mergeTravelTimeEarlySec && lagSec <= lateLimitSec) inWindow++;
  }
  if (inWindow / dets.length >= params.mergeTravelTimeInWindowRatio) return true;
  // 【対策: 大きな地震の後続動で遠方に分裂イベントが出る問題】M6.5以上の地震では、遠方で
  // P波〜表面波の窓を過ぎた後の揺れ(coda・長周期)でも、観測点が反応して小さなイベントが
  // 出る(M7.5青森県東方沖: 震央から300〜480km、P波の100〜190秒後)。主イベントの検知範囲の
  // 内側で、発震から一定時間内の小さな副イベントは、別の地震である可能性より、同じ地震の
  // 後続動である可能性が高いので統合する。
  if (params.mergeCodaEnabled && estMain.magnitude != null && estMain.magnitude >= params.mergeCodaMinMagnitude
      && other.pointCount <= params.mergeCodaMaxPoints && estMain.lat != null) {
    let latest = 0;
    for (const d of dets) latest = Math.max(latest, d.detectedAt);
    if ((latest - estMain.originTime) / 1000 <= params.mergeCodaMaxSinceOriginSec) {
      let radius = 0;
      for (const d of main.detectionTimes.values()) radius = Math.max(radius, haversineKm(estMain.lat, estMain.lon, d.lat, d.lon));
      let inside = 0;
      for (const d of dets) if (haversineKm(estMain.lat, estMain.lon, d.lat, d.lon) <= radius + params.mergeCodaMarginKm) inside++;
      if (inside / dets.length >= params.mergeTravelTimeInWindowRatio) return true;
    }
  }
  return false;
}

// 関連イベントの一括統合(広域の揺れ上昇・BFS拡張など)で、主イベントとは独立した別の地震とみなせる副イベントは
// 統合の対象から外す(canEventsMergeの独立判定と同じ基準)。
function dropIndependentEvents(related, externalEstimates, params) {
  if (related.length < 2) return related;
  let main = related[0];
  for (const e of related) if (e.pointCount > main.pointCount) main = e;
  const estM = externalEstimates ? externalEstimates.get(main.id) : null;
  const useEst = estM && estM.originTime != null && main.pointCount >= params.mergeTravelTimeMinMainPoints;
  return related.filter((e) => e === main || !(earlierThanMainWave(main, e, params) || (useEst && looksIndependent(e, estM, params))));
}

function canEventsMerge(a, b, params, externalEstimates) {
  // 主イベントの波では起こせない(P波の到達より早い)検知の副イベントは、別の地震なので、どの経路でも統合しない。
  {
    const aIsMain0 = a.pointCount >= b.pointCount;
    if (earlierThanMainWave(aIsMain0 ? a : b, aIsMain0 ? b : a, params)) return false;
  }
  // 【対策】収束済みの主イベントの推定から計算した走時の窓に、副イベントの観測点が
  // 収まっていれば、同じ地震として統合する(上のcanEventBeMergedByTravelTime参照)。
  if (externalEstimates) {
    const aIsMain = a.pointCount >= b.pointCount;
    const main = aIsMain ? a : b, other = aIsMain ? b : a;
    // 副イベントが、主イベントとは独立した別の地震とみなせるなら、後段の判定(推定同士の整合など)でも統合しない。
    const estM = externalEstimates.get(main.id);
    if (estM && estM.originTime != null && main.pointCount >= params.mergeTravelTimeMinMainPoints && looksIndependent(other, estM, params)) return false;
    if (canEventBeMergedByTravelTime(main, other, externalEstimates.get(main.id), params)) return true;
  }
  // 【対策C】精度の高い外部推定(epicenterEstimation.ts)が両方のイベントで
  // 収束済みであれば、それを最優先で使う。null(判定材料不足)の場合のみ、
  // 以下の簡易チェックにフォールバックする。
  const refinedResult = canEventsMergeByRefinedEstimate(a, b, externalEstimates, params);
  if (refinedResult != null) return refinedResult;

  const closeEnough = rectMinDistanceKm(a, b) <= params.mergeDistanceKm;

  if (!closeEnough) {
    // 遠方の場合は、物理的整合性が明確に確認できた場合のみ統合する
    // (11節: 離島・海域を挟んだケースの救済)。
    return canEventsShareOrigin(a, b, params);
  }

  // 近接している場合: 判定材料が両方揃っていなければ、従来通り無条件で
  // 統合を許可する(早期段階の取りこぼし防止を優先)。
  if (a.originLat == null || b.originLat == null) return true;
  if (a.originDetectedAt == null || b.originDetectedAt == null) return true;

  const distKm = haversineKm(a.originLat, a.originLon, b.originLat, b.originLon);
  const elapsedSec = Math.abs(a.originDetectedAt - b.originDetectedAt) / 1000;
  const maxAllowedSec = distKm / params.mergeTimingMinSpeedKmS + params.mergeTimingMarginSec;
  if (elapsedSec > maxAllowedSec) return false;

  // 到達距離の上限チェック(estimateMaxReachKm)は、近接ケースでは距離が
  // 短く実質的に常に満たされるため省略し、より判別力のある減衰カーブとの
  // 整合性チェックのみ行う。
  if (!checkAttenuationConsistency(a, b, params)) return false;

  return true;
}

// 【誤検知対策B】イベント内の観測点ペアの検知時刻(detectionTimes)から、
// 実際の伝播速度が地震波として物理的に妥当な範囲
// (pWaveMinSpeedKmS〜pWaveMaxSpeedKmS)に収まっているペアの割合を計算する。
// 距離がretractionSpeedMinPairDistanceKm未満のペアは、検知時刻のノイズで
// 速度誤差が増幅されやすいため除外する。評価対象となるペアが無ければnullを
// 返す(判定材料が無い=速度不整合とは断定できないため、呼び出し側は
// 「本物とみなす」側に倒す)。
function computeEventSpeedConsistencyRatio(event, params) {
  const detections = [...event.detectionTimes.values()];
  if (detections.length < 2) return null;
  let validCount = 0;
  let consistentCount = 0;
  for (let i = 0; i < detections.length; i++) {
    for (let j = i + 1; j < detections.length; j++) {
      const a = detections[i];
      const b = detections[j];
      const distKm = haversineKm(a.lat, a.lon, b.lat, b.lon);
      if (distKm < params.retractionSpeedMinPairDistanceKm) continue;
      const seconds = Math.abs(a.detectedAt - b.detectedAt) / 1000;
      if (seconds <= 0) continue; // 同時刻ペアは速度が定義できないため対象外
      const speedKmS = distKm / seconds;
      validCount++;
      if (speedKmS >= params.pWaveMinSpeedKmS && speedKmS <= params.pWaveMaxSpeedKmS) consistentCount++;
    }
  }
  if (validCount === 0) return null;
  return consistentCount / validCount;
}

// 【要件E追加対策・誤検知対策B拡張】地理的相関ノイズ判別の共通ロジック。
// 「起点(最も早く条件を満たした点)からの距離」と「起点より遅れて条件を
// 満たした時間」のペア配列から、ピアソンの相関係数を計算する。本物の地震
// であれば、伝播に有限の速度がかかるため距離が離れるほど遅れて反応する
// はず(正の相関)。一方、相関ノイズ(交通振動・降雨等)は地理的に相関し
// つつもほぼ同時多発的に現れるため、距離によらず遅れがバラつき、相関が
// 弱くなりやすい。値が退化している(全点が同距離/同時刻)場合はnullを返す。
function pearsonCorrelation(xs, ys) {
  const n = xs.length;
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;
  let covXY = 0, varX = 0, varY = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - meanX;
    const dy = ys[i] - meanY;
    covXY += dx * dy;
    varX += dx * dx;
    varY += dy * dy;
  }
  if (varX === 0 || varY === 0) return null;
  return covXY / Math.sqrt(varX * varY);
}

// 距離(km)・経過時間(秒)のペア配列を作る共通処理。entriesは
// { lat, lon, sinceMs }[]。起点(sinceMsが最小の点)を基準に、各点の
// 「起点からの距離」と「起点より遅れた時間」を求める。
function buildTimingPairs(entries) {
  let origin = entries[0];
  for (const e of entries) {
    if (e.sinceMs < origin.sinceMs) origin = e;
  }
  const xs = [];
  const ys = [];
  for (const e of entries) {
    xs.push(haversineKm(origin.lat, origin.lon, e.lat, e.lon));
    ys.push((e.sinceMs - origin.sinceMs) / 1000);
  }
  return { xs, ys };
}

// 【要件E】広域拡大検知の候補になった時刻(broadRiseCandidateSince)を使った
// タイミング相関の判定。メンバー数が足りない場合はnull(判定材料不足=
// 「本物とみなす」側に倒す)。
function computeBroadRiseTimingCorrelation(memberIds, points, params) {
  const entries = memberIds
    .map((id) => points.get(id))
    .filter((p) => p && p.broadRiseCandidateSince != null)
    .map((p) => ({ lat: p.lat, lon: p.lon, sinceMs: p.broadRiseCandidateSince }));
  if (entries.length < params.broadRiseTimingMinSamples) return null;
  const { xs, ys } = buildTimingPairs(entries);
  return pearsonCorrelation(xs, ys);
}

// 【誤検知対策B拡張】quick retractionでの、イベントの検知時刻
// (event.detectionTimes)を使ったタイミング相関の判定。
// computeEventSpeedConsistencyRatioは近距離ペア(retractionSpeedMinPairDistanceKm
// 未満)を除外するため、観測点間隔がそれより密な地域では有効なペアが
// 得られず判定不能(null)になりやすい弱点があった。このタイミング相関は
// 距離によるペア除外を行わないため、密集地域でも機能する。
function computeEventTimingCorrelation(event, params) {
  const entries = [...event.detectionTimes.values()].map((d) => ({ lat: d.lat, lon: d.lon, sinceMs: d.detectedAt }));
  if (entries.length < params.retractionTimingMinSamples) return null;
  const { xs, ys } = buildTimingPairs(entries);
  return pearsonCorrelation(xs, ys);
}

// 震度相当値(連続値) → イベントレベル(0〜4)。
export function intensityToShakeLevel(intensity, levelThresholds = DEFAULT_SHAKE_DETECTION_PARAMS.levelThresholds) {
  for (let level = levelThresholds.length; level >= 1; level--) {
    if (intensity >= levelThresholds[level - 1]) return level;
  }
  return 0;
}

// 直近履歴(historyに積んだ過去の値)の単純平均。履歴が無ければnull。
function computeBaselineAvg(history) {
  if (history.length === 0) return null;
  let sum = 0;
  for (const v of history) sum += v;
  return sum / history.length;
}

// 連鎖(microChainFromIdのリンク)を辿って、targetIdが含まれているかを調べる。
// A→B→A のような循環リンクができるのを未然に防ぐために使う
// (循環ができると連鎖を辿る処理が無限ループしてクラッシュするため)。
// maxStepsは無限ループの安全弁(既に壊れたデータが紛れ込んでいても止まる)。
// detectionRulesのいずれかを満たすか判定する。満たした最初のルールについて、
// 条件を満たした近傍点(matchedNeighbors)も返す(イベントへの合流に使う)。
//
// 【26節: 離島等、近傍観測点が少ない場所での検知遅延・分散への対策】
// 以前はrule.requiredNeighborCountを固定の絶対数として扱っていた
// (例: 「近傍8点中5点」なら、実際の近傍が2点しか無い場所では絶対に
// 満たせない=5点必要なルールは事実上使えない)。離島など、
// neighborRadiusKm(25km)以内に十分な数の観測点が無い場所では、
// isolatedRiseThreshold(近傍0点専用、高いしきい値で単独即時確定)の
// 対象にすらならない「近傍1〜4点」の中途半端な観測点が、どのルールも
// 満たせず検知が遅れたり、島ごとにバラバラに(検知できたとしても)
// 分散した小さいイベントになったりしていた。
// 対策として、必要人数を「候補数に対する比率」で決めるようにした。
// 近傍が豊富な場所(候補数がneighborCountちょうど)では、これまでと全く
// 同じrequiredNeighborCountになるため、既存の(十分な観測点密度がある
// 地域での)挙動には影響しない。候補が少ない場所では、その分必要人数も
// 比例して減る(ただし0にはならないよう、最低1点の裏付けは常に必要)。
function evaluateDetectionRules(point, points, rules) {
  for (const rule of rules) {
    if (rule.minOwnIntensity != null && point.latestIntensity < rule.minOwnIntensity) continue;
    if (rule.minOwnRiseRateMax10s != null) {
      if (point.riseRateMax10s == null || point.riseRateMax10s < rule.minOwnRiseRateMax10s) continue;
    }

    const candidates = (point.extPoints && point.extPoints.length > 0 ? point.extPoints : point.nearPoints).slice(0, rule.neighborCount);
    if (candidates.length === 0) continue; // 近傍が無い(isolated経路の対象)

    const matchedNeighbors = [];
    for (const np of candidates) {
      const neighbor = points.get(np.id);
      if (!neighbor) continue;
      const neighborValue = rule.neighborMetric === "riseRateMax10s" ? neighbor.riseRateMax10s : neighbor.latestIntensity;
      if (neighborValue != null && neighborValue >= rule.minNeighborValue) matchedNeighbors.push(neighbor);
    }

    const requiredRatio = rule.requiredNeighborCount / rule.neighborCount;
    const requiredCount = Math.max(1, Math.ceil(candidates.length * requiredRatio));
    if (matchedNeighbors.length >= requiredCount) {
      return { matched: true, matchedNeighbors };
    }
  }
  return { matched: false, matchedNeighbors: [] };
}

let eventIdSeq = 1;

function createEvent(now, tick) {
  return {
    id: eventIdSeq++,
    level: 0,
    pointIds: new Set(),
    pointCount: 0,
    minLat: null, maxLat: null, minLon: null, maxLon: null,
    centerLat: null, centerLon: null,
    originLat: null, originLon: null, // 最初にこのイベントへ加わった点の座標(不変)。
                                        // BFS面的拡張がここからどれだけ離れて良いかの基準にする。
    // 【対策: 離島・海域を挟んだイベント統合】最初にこのイベントへ加わった
    // 点の検知時刻(不変)。イベント同士が同じ震源から来ている可能性を
    // 判定するタイミング整合性チェックに使う(canEventsShareOrigin参照)。
    originDetectedAt: null,
    // このイベントでこれまでに観測された震度相当値のピーク(連続値、level
    // (0〜4の離散値)とは別)。震度減衰整合性チェック(estimateMaxReachKm)に
    // 使う。
    peakIntensity: null,
    // 観測点ごとの「最初にこのイベントへ加わった実時刻」。epicenterEstimation.ts
    // の震源推定(検知時刻ベースの走時解析)専用のデータで、検知アルゴリズム
    // 自体はこの値を参照しない。id -> { lat, lon, detectedAt }
    detectionTimes: new Map(),
    confirmed: false,
    createdAt: now,
    updatedAt: now,
    expireAt: now,
    // 【25節: 誤検知の素早い取り消し】作成時のtick番号と、判定用の状態。
    // 詳細はprocessTick内の該当ステップのコメント参照。
    createdTick: tick,
    pointCountAtWindowStart: null,
    retractionCheckDone: false,
  };
}

function addPointToEvent(event, point, level, now, params) {
  if (level > event.level) event.level = level;
  if (event.originLat == null) {
    event.originLat = point.lat;
    event.originLon = point.lon;
    // 【対策: 離島・海域を挟んだイベント統合】起点の検知時刻も、座標と
    // 同様に不変として記録しておく(detectionTimesの記録方式と同じ、
    // reactionStartAtベース)。
    event.originDetectedAt = point.reactionStartAt ?? now;
  }
  if (point.latestIntensity != null) {
    event.peakIntensity = event.peakIntensity == null
      ? point.latestIntensity
      : Math.max(event.peakIntensity, point.latestIntensity);
  }  if (!event.pointIds.has(point.id)) {
    event.pointIds.add(point.id);
    event.pointCount = event.pointIds.size;
  }
  // 震源推定用に、この観測点が最初にイベントへ加わった時刻・その時点の震度
  // 相当値(level)を記録する(2回目以降の呼び出しでは上書きしない = あくまで
  // 「最初に検知した時刻・その時の震度」。揺れの広がり方(震度の減衰パターン)・
  // 方向を震源推定に使う際、震度が最も高い観測点ほど震源に近いはず、という
  // 手がかりに使う)。
  // 【23節】detectedAtには、判定ルールが確定した時刻(now)ではなく、この点が
  // 実際に反応し始めた時刻(point.reactionStartAt)を使う。判定ルール自体
  // (近傍の裏付けを待つこと)は誤検知防止のためそのまま維持しつつ、記録
  // される時刻だけを実際のP波到達に近づけることで、震源推定・PS円描画の
  // ズレを減らす。reactionStartAtが無い(理論上起こらないはずだが念のため)
  // 場合はnowにフォールバックする。
  // 【対策: マグニチュード推定が常に低い値に収束するバグ】以前はここで
  // level(0〜4の離散値、levelThresholds=[0.5,2.0,3.5,5.0]で丸めたもの)しか
  // 記録していなかった。epicenterEstimation.ts側の震度減衰フィット
  // (fitMagnitude・computeAmplitudeWeightedCentroid)は、この離散値を
  // calcPeakIntensityの連続値スケール(理論上7.5まで届く)と直接比較して
  // いたため、震源直上で震度6〜7に達するような強い地震でも「level=4」しか
  // 見えず、実際の強さを表現できていなかった(どんな地震でもだいたい
  // マグニチュード3前半に収束する原因)。連続値のintensityも別途記録する。
  // また、以前は最初にこの点がイベントに追加された時点のlevel/intensity
  // スナップショットのまま更新されなかったが、震度減衰フィットは「その
  // 観測点のピーク振幅」を見たい処理のため、以後の呼び出しでもより高い
  // 値が来ればlevel・intensity両方を更新するようにした。
  if (!event.detectionTimes.has(point.id)) {
    const detectedAt = point.reactionStartAt ?? now;
    // 【対策: S-P時間差による深さ推定の補強】sWaveDetectedAtは、検知した
    // 瞬間にはまだ観測されていない(急上昇の基準をまだ満たしていない)ことが
    // 多いため、その場合はnullのまま記録しておき、下のelse節で後から
    // 埋める。
    event.detectionTimes.set(point.id, {
      lat: point.lat, lon: point.lon, detectedAt, level, intensity: point.latestIntensity,
      sWaveDetectedAt: point.sWaveArrivalAt ?? null,
    });
  } else if (point.latestIntensity != null) {
    const d = event.detectionTimes.get(point.id);
    if (d.intensity == null || point.latestIntensity > d.intensity) d.intensity = point.latestIntensity;
    if (level > d.level) d.level = level;
    if (d.sWaveDetectedAt == null && point.sWaveArrivalAt != null) d.sWaveDetectedAt = point.sWaveArrivalAt;
  }
  event.minLat = event.minLat == null ? point.lat : Math.min(event.minLat, point.lat);
  event.maxLat = event.maxLat == null ? point.lat : Math.max(event.maxLat, point.lat);
  event.minLon = event.minLon == null ? point.lon : Math.min(event.minLon, point.lon);
  event.maxLon = event.maxLon == null ? point.lon : Math.max(event.maxLon, point.lon);
  event.centerLat = (event.minLat + event.maxLat) / 2;
  event.centerLon = (event.minLon + event.maxLon) / 2;
  event.updatedAt = now;
  event.expireAt = now + params.eventDurationBaseMs + event.level * params.eventDurationPerLevelMs;
  point.eventId = event.id;
  // 2点以上揃った時点で即確定(孤立トリガーは呼び出し側で個別に確定させる)。
  // 「近傍2点がほぼ同時に急上昇した」こと自体が、旧実装のスコア閾値より
  // 強いノイズ耐性を持つため、多数の観測点が揃うのを待つ必要がない。
  if (!event.confirmed && event.pointCount >= 2) event.confirmed = true;
}

function mergeEventInto(target, other) {
  for (const id of other.pointIds) target.pointIds.add(id);
  target.pointCount = target.pointIds.size;
  // detectionTimesも合流させる(既にtargetに記録がある点はそちらを優先=
  // より早い/先に統合された側の記録を残す。通常はほぼ同時なので影響は軽微)。
  for (const [id, d] of other.detectionTimes) {
    if (!target.detectionTimes.has(id)) target.detectionTimes.set(id, d);
  }
  if (other.level > target.level) target.level = other.level;
  if (target.originLat == null) {
    target.originLat = other.originLat;
    target.originLon = other.originLon;
    target.originDetectedAt = other.originDetectedAt;
  }
  if (other.peakIntensity != null) {
    target.peakIntensity = target.peakIntensity == null
      ? other.peakIntensity
      : Math.max(target.peakIntensity, other.peakIntensity);
  }
  if (other.minLat != null) {
    target.minLat = target.minLat == null ? other.minLat : Math.min(target.minLat, other.minLat);
    target.maxLat = target.maxLat == null ? other.maxLat : Math.max(target.maxLat, other.maxLat);
    target.minLon = target.minLon == null ? other.minLon : Math.min(target.minLon, other.minLon);
    target.maxLon = target.maxLon == null ? other.maxLon : Math.max(target.maxLon, other.maxLon);
  }
  if (target.minLat != null) {
    target.centerLat = (target.minLat + target.maxLat) / 2;
    target.centerLon = (target.minLon + target.maxLon) / 2;
  }
  target.confirmed = target.confirmed || other.confirmed || target.pointCount >= 2;
  target.updatedAt = Math.max(target.updatedAt, other.updatedAt);
  target.expireAt = Math.max(target.expireAt, other.expireAt);
}

// 海底観測点(id 5000以上、S-net等)かどうかの判定。App.tsx側の「揺れ上昇中
// 判定の対象外」という既存の扱いと同じ基準を踏襲している。
function isOceanBottomStationId(id) {
  const idNum = Number(id);
  return Number.isFinite(idNum) && idNum >= 5000;
}

/**
 * 揺れ検知エンジン本体。観測点マスタが揃ったら initialize() を一度呼び、
 * 以降はデータ更新のたびに processTick() を呼ぶ。
 */
// P波の初動からS波到達とみなせるまでの最短時間(ms)。上記sharpRiseのコメント参照。
const S_ARRIVAL_MIN_DELAY_MS = 2000;

// 観測点の位置から、上昇量に掛ける地域別の係数(regionalRiseScales)を求める。
// どの範囲にも入らなければ1(補正なし)。
export function regionalRiseScaleFor(lat, lon, regions = DEFAULT_SHAKE_DETECTION_PARAMS.regionalRiseScales) {
  let scale = 1;
  if (!Array.isArray(regions) || lat == null || lon == null) return scale;
  for (const r of regions) {
    if (lat >= r.minLat && lat <= r.maxLat && lon >= r.minLon && lon <= r.maxLon && r.scale > scale) {
      scale = r.scale;
    }
  }
  return scale;
}

export class ShakeDetectionEngine {
  constructor(params = {}) {
    this.params = { ...DEFAULT_SHAKE_DETECTION_PARAMS, ...params };
    this.points = new Map();   // id -> pointState
    this.events = new Map();   // id -> event
    this.tickIndex = 0;        // lastRiseTick等の基準となる、tickの通し番号
    this.initialized = false;
    // 【要件E】広域継続拡大検知用の、前tick時点の連結クラスタ一覧
    // ({ members: Set<id>, centerLat, centerLon, radiusKm, growthStreak }[])。
    this.broadRiseClusters = [];
    // 【対策C】epicenterEstimation.tsのより精度の高い推定結果
    // (Map<eventId, { lat, lon, depthKm, magnitude, confirmed, ... }>)。
    // shakeDetection.ts自体はepicenterEstimation.tsに依存していないため、
    // 呼び出し側(App.tsx)がsetExternalEstimates()経由で毎tick渡す想定。
    // イベント統合判定(canEventsMerge)で、粗い簡易チェックより優先して使う。
    this.externalEstimates = new Map();
    // データ源の切り替え(リアルタイム⇔リプレイ・検知テスト)直後に検知を
    // 一時的に無効化する期間の終了時刻(ms、processTickのnow基準)。
    // resetForSourceChange()が設定する。0なら無効化期間なし。
    this.suppressUntil = 0;
    // 配列型の微弱検知(initializeで作る。weakArrayDetection.ts参照)
    this.weakArray = null;
    // 微弱検知のイベントに加えた観測点 → 再び新しいイベントに使わない期限(ms)。
    // 微弱検知は反応の記録をpoolWindowSec(60秒)保持するが、イベントの寿命(45秒)の方が
    // 短いので、イベントが消えたあとも同じ反応が残っていて、同じ地震から、もう一度
    // イベントが作られてしまう(福島県沖・熊本の実データで、2つ目のイベントが出た)。
    // これを防ぐため、使い終えた観測点を一定時間、探索から除く。
    this.weakUsedUntil = new Map();
    // 微弱検知の履歴を、最初に渡された値で埋める(WeakArrayDetector.seed)。初期化・切替の直後に立てる。
    this.weakArrayNeedsSeed = true;
  }

  // 【データ源切り替え対策】リアルタイム震度⇔リプレイ・地震検知テストの
  // 切り替え時に呼ぶ。観測点ごとの履歴・上昇状態・進行中のイベント・広域
  // 拡大検知の追跡状態・外部の震源推定をすべて破棄し、切り替え前のデータ源
  // の検知が新しいデータ源に持ち越されないようにする(観測点マスタ由来の
  // 近傍点リストは残す)。あわせて、切り替え直後suppressMs(既定2秒)の間は
  // 検知を無効化する。この間もprocessTickの値の更新(ステップ1)は行うため、
  // 新しいデータ源の履歴(直近5秒平均等の基準)は無効化期間中に貯まり、
  // 期間が明けた最初のtickから通常どおり検知できる。切り替え前後の値の
  // ギャップを「急上昇」と誤検知しないよう、直前値(latest/prev)も
  // nullに戻しているので、切り替え後の最初のtickは差分0として扱われる。
  resetForSourceChange(now = Date.now(), suppressMs = 2000) {
    for (const point of this.points.values()) {
      point.prevIntensity = null;
      point.latestIntensity = null;
      point.intensityDiff = 0;
      point.history = [];
      point.avgDiff = null;
      point.riseRateHistory = [];
      point.riseRateMax10s = null;
      point.lastRiseTick = null;
      point.pendingSince = null;
      point.eventId = null;
      point.reactionStartAt = null;
      point.lastReactionEndTick = null;
      point.sWaveArrivalAt = null;
      point.broadRiseCandidateSince = null;
      point.lastOnsetAt = null;
    }
    this.events = new Map();
    this.broadRiseClusters = [];
    this.externalEstimates = new Map();
    this.suppressUntil = now + suppressMs;
    if (this.weakArray) this.weakArray.reset();
    this.weakUsedUntil = new Map();
    this.weakArrayNeedsSeed = true;
    this.lastTickNow = null;
    this.lastTickValues = null;
  }

  // 【対策C】App.tsx側でepicenterEstimation.tsのEpicenterEstimatorを実行した
  // 結果を渡すためのsetter。processTickの外(通常は同じtickの後半、または
  // 次のtickの頭)で呼ぶことを想定しており、1tick遅れでの反映になるが、
  // イベント統合の判定は瞬時性より精度を優先すべき処理のため許容している。
  // 配列型の微弱検知(weakArrayDetection.ts)のオン/オフ。設定画面から、実行中に切り替える。
  // initialize前なら、設定だけ記録し、initializeで検知器を作る。
  setWeakArrayEnabled(enabled) {
    this.params = { ...this.params, weakArrayEnabled: !!enabled };
    if (!enabled) {
      this.weakArray = null;
    } else if (!this.weakArray && this.initialized) {
      this.weakArray = new WeakArrayDetector([...this.points.values()].map(pt => ({ id: pt.id, lat: pt.lat, lon: pt.lon })), this.params.weakArrayParams);
      this.weakArrayNeedsSeed = true;
    }
  }

  setExternalEstimates(estimates) {
    this.externalEstimates = estimates || new Map();
  }

  // 観測点の位置情報から近傍点リストを事前計算する(SetupNearPoints相当)。
  // 観測点マスタが変わった時だけ呼び直せばよい(毎tick呼ぶ必要はない)。
  initialize(stations) {
    const { neighborRadiusKm, maxNeighbors } = this.params;
    // 海底観測点(id 5000以上、S-net等)は検知の対象外とする。マスタの時点で
    // 除外しておくことで、自身がトリガーになることはもちろん、他の観測点の
    // 近傍裏付けとして使われることも無くなる。
    const targetStations = stations.filter((s) => !isOceanBottomStationId(s.id));
    const prevPoints = this.points;
    this.points = new Map();
    for (const s of targetStations) {
      const prev = prevPoints.get(s.id);
      this.points.set(s.id, {
        id: s.id,
        lat: s.lat,
        lon: s.lon,
        riseScale: regionalRiseScaleFor(s.lat, s.lon, this.params.regionalRiseScales),
        prevIntensity: prev ? prev.prevIntensity : null,
        latestIntensity: prev ? prev.latestIntensity : null,
        intensityDiff: 0,
        history: prev ? prev.history : [], // 直近historyLength件の値(5秒平均の元データ)
        avgDiff: prev ? prev.avgDiff : null,
        riseRateHistory: prev ? prev.riseRateHistory : [], // 直近riseRateHistoryLength件の上昇速度(diff)
        riseRateMax10s: prev ? prev.riseRateMax10s : null,  // その最大値
        lastRiseTick: prev ? prev.lastRiseTick : null,
        pendingSince: prev ? prev.pendingSince : null,
        eventId: prev ? prev.eventId : null,
        // 【23節】この観測点が「今の上昇」に反応し始めた実時刻(ms)。
        // detectionRules(近傍の裏付けを含む)が確定するのを待たず、ごく緩い
        // 基準(reactionRiseThreshold等)で反応開始を追跡しておき、実際に
        // イベントへ追加される際にdetectedAtとして使う(addPointToEvent
        // 参照)。上昇が止まればnullに戻す(「今の上昇の開始時刻」を常に
        // 表すため)。
        reactionStartAt: prev ? prev.reactionStartAt : null,
        // 【対策: 観測点の検知が重なると別々の地震が合成される問題】反応が
        // 最後に止まった(reactionStartAtがnullに戻った)tick番号。次に
        // 反応が始まった際、これとの間隔がeventReleaseGapTicks以上あれば
        // 「新しいエピソード」とみなし、既存のeventIdを解放する。
        lastReactionEndTick: prev ? prev.lastReactionEndTick : null,
        // 【対策: S-P時間差による深さ推定の補強】その観測点でのS波到達
        // (急上昇の開始)時刻。reactionStartAtと同様、反応が止まればnullに
        // 戻す(詳細はステップ1のコメント参照)。
        sWaveArrivalAt: prev ? prev.sWaveArrivalAt : null,
        // 【要件E追加対策】この観測点が「今、広域拡大検知の候補基準
        // (broadRiseCandidateThreshold)を満たす上昇を続けている」実時刻(ms)。
        // reactionStartAtと同様、上昇が止まればnullに戻す。密集地域での
        // 相関ノイズ(同時多発的な上昇)を、実際の地震の伝播(距離に応じた
        // 出現時刻の遅れ)と区別するための材料として使う
        // (computeBroadRiseTimingCorrelation参照)。
        broadRiseCandidateSince: prev ? prev.broadRiseCandidateSince : null,
        nearPoints: [],
        lastOnsetAt: prev ? prev.lastOnsetAt : null, // 直近の反応開始時刻(反応が止まっても残す。走時による取り込み用)
        extPoints: [], // 疎な観測点の裏付け用(近傍が少ない時だけ、より遠い近傍を含む)
      });
    }
    for (const s of targetStations) {
      const point = this.points.get(s.id);
      const candidates = [];
      for (const other of targetStations) {
        if (other.id === s.id) continue;
        const dist = haversineKm(s.lat, s.lon, other.lat, other.lon);
        if (dist > neighborRadiusKm) continue;
        candidates.push({ id: other.id, distanceKm: dist });
      }
      candidates.sort((a, b) => a.distanceKm - b.distanceKm);
      point.nearPoints = candidates.slice(0, maxNeighbors);
      point.extPoints = [];
      if (this.params.sparseNeighborEnabled && point.nearPoints.length < this.params.sparseNeighborMin) {
        const ext = [];
        for (const other of targetStations) {
          if (other.id === s.id) continue;
          const dist = haversineKm(s.lat, s.lon, other.lat, other.lon);
          if (dist > this.params.sparseNeighborRadiusKm) continue;
          ext.push({ id: other.id, distanceKm: dist });
        }
        ext.sort((a, b) => a.distanceKm - b.distanceKm);
        point.extPoints = ext.slice(0, maxNeighbors);
      }
    }
    this.initialized = true;
    // 配列型の微弱検知。観測点の座標が確定したこのタイミングで作る(格子との対応を
    // 事前に計算するため、毎tickではなく初期化時に1度だけ行う)。
    this.weakArray = this.params.weakArrayEnabled
      ? new WeakArrayDetector([...this.points.values()].map(pt => ({ id: pt.id, lat: pt.lat, lon: pt.lon })), this.params.weakArrayParams)
      : null;
    this.weakArrayNeedsSeed = true;
    // 観測点マスタが変わると古いidを参照したクラスタが残ってしまうため、
    // 広域継続拡大検知の追跡状態もリセットする。
    this.broadRiseClusters = [];
  }

  // 1回分のデータ更新を処理し、現在のイベント一覧(確定/未確定含む)を返す。
  // valuesMap: Map<観測点id, 震度相当値>。データが無い観測点はキーごと無し。
  //
  // 【対策: 更新間隔が空くと検知・推定が不安定になる問題】エンジンは「1回の呼び出し=1tick(約1秒)」
  // 前提で、履歴・上昇速度・イベントの寿命などをtick数で数えている。ところが実際には、リプレイの
  // 高速再生(描画が間に合わず複数フレームを1度に進める)や、配信の一時的な遅れで、前回から2〜数秒
  // 空いて呼ばれることがある。M7.5青森県東方沖のリプレイで、2〜5フレームおきに間引いて渡すと、
  // 震源推定が経度で0.7度ほど行き来し、一瞬だけ別イベントが出て消える現象を再現した。
  // 前回から gapFillMinMs〜gapFillMaxMs 空いた場合は、前回と今回の値を直線補間した値で、間のtickを
  // 1秒刻みで補って進める(補間はその間の観測点だけ。値が片方にしか無い観測点は補間しない)。
  processTick(valuesMap, now = Date.now()) {
    const { params } = this;
    const prevNow = this.lastTickNow, prevVals = this.lastTickValues;
    this.lastTickNow = now;
    this.lastTickValues = valuesMap;
    if (params.gapFillEnabled && prevNow != null && prevVals && this.initialized) {
      const gap = now - prevNow;
      if (gap >= params.gapFillMinMs && gap <= params.gapFillMaxMs) {
        const n = Math.round(gap / 1000);
        for (let k = 1; k < n; k++) {
          const r = k / n;
          const mid = new Map();
          for (const [id, v1] of valuesMap) {
            const v0 = prevVals.get(id);
            mid.set(id, v0 == null ? v1 : v0 + (v1 - v0) * r);
          }
          this.processTickCore(mid, prevNow + gap * r);
        }
      }
    }
    return this.processTickCore(valuesMap, now);
  }

  processTickCore(valuesMap, now = Date.now()) {
    const { params, points } = this;
    if (!this.initialized) return [];
    this.tickIndex += 1;
    const tick = this.tickIndex;
    if (this.weakArrayNeedsSeed && this.weakArray) {
      this.weakArray.seed(now / 1000, valuesMap);
      this.weakArrayNeedsSeed = false;
    }

    // 1) 値の更新。上昇量は「前tickとの差」に加えて「直近5秒平均との差」も
    //    使うため、上書きする前の値をhistoryに積んでおく。あわせて、直近
    //    10秒間の「上昇速度(diff)」の最大値も更新する(detectionRulesで使用)。
    for (const point of points.values()) {
      const value = valuesMap.has(point.id) ? valuesMap.get(point.id) : null;
      if (point.latestIntensity != null) {
        point.history.push(point.latestIntensity);
        if (point.history.length > params.historyLength) point.history.shift();
      }
      point.prevIntensity = point.latestIntensity;
      point.latestIntensity = value;
      // 地域別の係数(regionalRiseScales。東京首都圏など)で割って、上昇系のしきい値を実質的に引き上げる。
      const riseScale = point.riseScale ?? 1;
      point.intensityDiff = (value != null && point.prevIntensity != null) ? (value - point.prevIntensity) / riseScale : 0;
      const baselineAvg = value != null ? computeBaselineAvg(point.history) : null;
      point.avgDiff = baselineAvg != null ? (value - baselineAvg) / riseScale : null;

      point.riseRateHistory.push(point.intensityDiff);
      if (point.riseRateHistory.length > params.riseRateHistoryLength) point.riseRateHistory.shift();
      point.riseRateMax10s = point.riseRateHistory.length > 0 ? Math.max(...point.riseRateHistory) : null;

      // 【23節】反応開始時刻の追跡。detectionRulesの確定を待たず、ごく緩い
      // 基準で「今まさに上がり始めているか」を毎tick判定し、上がり始めた
      // 最初のtickの実時刻を記録しておく(後でこの点がイベントに追加される
      // 際、addPointToEventがdetectedAtとしてこれを使う)。上昇が止まれば
      // nullに戻し、常に「今の上昇の開始時刻」を表すようにする。
      const reacting = value != null
        && point.intensityDiff >= params.reactionRiseThreshold
        && (point.avgDiff == null || point.avgDiff >= params.reactionAvgRiseThreshold);
      if (reacting) {
        // 【対策: 観測点の検知が重なると別々の地震が合成される問題】
        // point.eventIdは、いったんイベントへ紐付くと、そのイベントが
        // 存命の間(quick retraction・期限切れで解放されるまで)ずっと
        // 保持され続ける設計だった。そのため、同じ観測点が一度反応を
        // 完全に収めた後、十分な間隔を空けて全く別の(無関係な)地震で
        // 再び反応し始めても、「point.eventIdが既にセットされている」と
        // いう理由だけで、機械的に元のイベントへ追加され続けてしまって
        // いた(観測点の検知が時間差で重なる=同じ観測点が複数の地震で
        // 使い回される状況で、無関係な地震同士が合成されてしまう不具合)。
        // 反応が完全に止まっていた期間が eventReleaseGapTicks 以上あった
        // 後に再び反応し始めた場合は、「新しいエピソード」とみなして
        // point.eventIdを解放する。これにより、このtickの以降の処理
        // (ステップ3b・ステップ4・孤立点判定)で、改めて新規イベントの
        // 作成、または(本当に同じ地震の続きであれば)物理的整合性チェック
        // 付きの経路で正しく紐付け直される。
        if (
          point.eventId != null &&
          point.reactionStartAt == null && // このtickで新たに反応が始まった(=直前まで反応していなかった)
          point.lastReactionEndTick != null &&
          tick - point.lastReactionEndTick >= params.eventReleaseGapTicks
        ) {
          point.eventId = null;
        }
        if (point.reactionStartAt == null) { point.reactionStartAt = now; point.lastOnsetAt = now; }
      } else {
        if (point.reactionStartAt != null) point.lastReactionEndTick = tick;
        point.reactionStartAt = null;
        // 反応そのものが止まったら、次に反応が再開した際に改めてS波到達を
        // 検出し直せるよう、あわせてリセットする。
        point.sWaveArrivalAt = null;
      }

      // 【対策: S-P時間差による深さ推定の補強】reactionStartAt(ごく緩い
      // 基準、P波の初期微動オンセットに近い)とは別に、riseThreshold(0.5)・
      // avgRiseThreshold(0.4)という「急上昇」の基準(既存のステップ2で
      // lastRiseTickの判定に使っているものと同じ)を初めて満たした時刻を、
      // その観測点でのS波到達(主要動の始まり)相当として記録する。一度
      //記録したら、その反応が続いている間は上書きしない(最初の到達時刻を
      // 保持し続ける)。反応が完全に止まればreactionStartAtと一緒にリセット
      // される(上のelse節を参照)。epicenterEstimation.ts側で、reactionStartAt
      // (P波相当)との差=S-P時間差を、震源距離(≒深さ)の直接的な手がかりと
      // して使う。
      if (point.reactionStartAt != null && point.sWaveArrivalAt == null) {
        // 【実データ(2026-08-28青森県東方沖M4.6・08-30千葉県東方沖M4.8の
        // リプレイ)で判明した不具合の修正】以前は、P波の立ち上がり(reactionStartAt)
        // と同じtickで「急上昇」の基準を満たすと、そのtickがS波到達として記録
        // されていた。観測点の震度は地震がない間-3付近で張り付いているため、
        // P波の初動(-3→0台への跳ね上がり)自体が「急上昇」に該当し、ほとんどの
        // 観測点でS-P時間差が0秒(理論値は数秒〜十数秒)になっていた。これが
        // 震源推定のS-P時間差ペナルティ(computeSpTimePenalty)を通じて、
        // 「震源が観測点の直下にある」という誤った制約として働き、推定が陸側・
        // 深さ0へ引き寄せられていた。P波の初動から最低
        // S_ARRIVAL_MIN_DELAY_MS経ってからの急上昇だけをS波到達とみなす。
        const sharpRise = value != null
          && (now - point.reactionStartAt) >= S_ARRIVAL_MIN_DELAY_MS
          && point.intensityDiff >= params.riseThreshold
          && (point.avgDiff == null || point.avgDiff >= params.avgRiseThreshold);
        if (sharpRise) point.sWaveArrivalAt = now;
      }

      // 【要件E追加対策】広域拡大検知の候補基準を満たしている間の開始時刻を
      // 追跡する。reactionStartAtとは基準(broadRiseCandidateThreshold)が
      // 異なるため別フィールドで管理する。
      const broadRiseCandidate = value != null && point.intensityDiff >= params.broadRiseCandidateThreshold;
      if (broadRiseCandidate) {
        if (point.broadRiseCandidateSince == null) point.broadRiseCandidateSince = now;
      } else {
        point.broadRiseCandidateSince = null;
      }
    }

    // 【データ源切り替え対策】resetForSourceChange()直後の無効化期間中は、
    // 上のステップ1(値・履歴の更新)だけ行い、検知処理(ステップ2以降)と
    // イベントの生成・更新はスキップする。
    if (now < this.suppressUntil) {
      this.broadRiseClusters = [];
      return [];
    }

    // 2) 急上昇の判定。このtickで上がった観測点にtick番号を刻んでおく
    //    (孤立点のisolatedRiseThreshold判定で使う。非孤立点はdetectionRules
    //    で判定するため、ここでのマーキング自体は使わない)。
    //    前tickとの差(瞬時diff)に加えて、直近5秒平均からの差も一定以上
    //    無ければ「急上昇」とは認めない(単発ノイズの弾き)。ただし観測点が
    //    復帰直後などで履歴がまだ無い(avgDiff == null)場合は、検知が
    //    遅れないよう瞬時diffのみで判定する。
    for (const point of points.values()) {
      if (point.latestIntensity == null) continue;
      const instantRise = point.intensityDiff >= params.riseThreshold;
      const avgRise = point.avgDiff == null || point.avgDiff >= params.avgRiseThreshold;
      if (instantRise && avgRise) {
        point.lastRiseTick = tick;
      }
    }

    // 【誤検知対策・microChain削除】旧ステップ3(震度0未満の微小変化専用、
    // P波伝播速度に基づく3点連鎖検知)は削除した。密集地域では観測点間隔が
    // 狭いため、偶然の速度一致(相関ノイズ由来)が成立しやすく、誤検知の
    // 主因の一つと判断したため。震度0未満〜weakIntensityCeiling未満の
    // 微小な揺れの検知は、以降のステップ3b(広域拡大検知、要件E)に一本化する。

    // 3b) 【要件E】広域継続拡大による微小地震検知(microChainとは並列の別経路)。
    //     震度上昇中(broadRiseCandidateThresholdによる、UIの「震度上昇中」表示
    //     とほぼ同等の緩い基準)の観測点を、近傍25km以内の連結成分(Union-Find)
    //     としてクラスタ化し、前tickの対応するクラスタと比較して「広さ」と
    //     「継続的な拡大」の両方を満たせば検知として採用する。microChainの
    //     厳密な速度整合性では拾えない、広範囲にじわじわ広がるタイプの揺れを
    //     補う経路。候補基準自体はmicroChainより大幅に緩いが、広さ・継続性の
    //     2段構えで別途ノイズを弾く設計のため問題ない。
    {
      const candidateIds = [];
      for (const point of points.values()) {
        if (point.latestIntensity == null || point.latestIntensity >= params.weakIntensityCeiling) continue;
        // ステップ1で計算済みのbroadRiseCandidateSince(遅延窓平均ベースの
        // 候補判定、computeBroadRiseDelayedAvgDiff参照)をそのまま使う。
        if (point.broadRiseCandidateSince != null) candidateIds.push(point.id);
      }

      // 近傍25km以内(nearPoints)を辺とした連結成分をUnion-Findで求める。
      const parent = new Map();
      const find = (id) => {
        let root = id;
        while (parent.get(root) !== root) root = parent.get(root);
        let cursor = id;
        while (parent.get(cursor) !== root) {
          const next = parent.get(cursor);
          parent.set(cursor, root);
          cursor = next;
        }
        return root;
      };
      for (const id of candidateIds) parent.set(id, id);
      const candidateSet = new Set(candidateIds);
      for (const id of candidateIds) {
        const point = points.get(id);
        for (const np of point.nearPoints) {
          if (!candidateSet.has(np.id)) continue;
          const rootA = find(id);
          const rootB = find(np.id);
          if (rootA !== rootB) parent.set(rootA, rootB);
        }
      }
      const clusterMemberIds = new Map(); // root -> id[]
      for (const id of candidateIds) {
        const root = find(id);
        if (!clusterMemberIds.has(root)) clusterMemberIds.set(root, []);
        clusterMemberIds.get(root).push(id);
      }

      // 各クラスタの重心・半径(重心から最遠メンバーまでの距離)を算出する。
      const currentClusters = [];
      for (const memberIds of clusterMemberIds.values()) {
        let sumLat = 0, sumLon = 0;
        for (const id of memberIds) {
          const p = points.get(id);
          sumLat += p.lat;
          sumLon += p.lon;
        }
        const centerLat = sumLat / memberIds.length;
        const centerLon = sumLon / memberIds.length;
        let radiusKm = 0;
        for (const id of memberIds) {
          const p = points.get(id);
          const d = haversineKm(centerLat, centerLon, p.lat, p.lon);
          if (d > radiusKm) radiusKm = d;
        }
        currentClusters.push({ members: new Set(memberIds), centerLat, centerLon, radiusKm });
      }

      // 前tickのクラスタとメンバーの重なり(Jaccard係数)で対応付け、
      // 拡大・停滞・縮小に応じてgrowthStreakを更新する。
      const prevClusters = this.broadRiseClusters;
      const nextClusters = [];
      for (const cluster of currentClusters) {
        let bestPrev = null;
        let bestOverlap = 0;
        for (const prev of prevClusters) {
          let intersection = 0;
          for (const id of cluster.members) if (prev.members.has(id)) intersection++;
          const union = cluster.members.size + prev.members.size - intersection;
          const overlap = union > 0 ? intersection / union : 0;
          if (overlap > bestOverlap) { bestOverlap = overlap; bestPrev = prev; }
        }
        let growthStreak = 0;
        if (bestPrev && bestOverlap >= params.broadRiseOverlapRatio) {
          const deltaKm = cluster.radiusKm - bestPrev.radiusKm;
          if (deltaKm >= params.broadRiseGrowthMinDeltaKm) {
            growthStreak = bestPrev.growthStreak + 1; // 拡大
          } else if (deltaKm <= -params.broadRiseGrowthMinDeltaKm) {
            growthStreak = 0; // 縮小 → 継続実績をリセット
          } else {
            growthStreak = bestPrev.growthStreak; // 停滞 → 実績を維持
          }
        }
        nextClusters.push({ ...cluster, growthStreak });
      }
      this.broadRiseClusters = nextClusters;

      // 広さ・継続拡大の両方を満たすクラスタを検知として採用する。
      for (const cluster of nextClusters) {
        // 通常経路: 広さ+継続的な拡大の両方を満たす。
        // 即時経路: 初回から明らかに広範囲(broadRiseImmediateRadiusKm以上)
        //   であれば、growthTicks分の継続拡大実績を待たずに検知する
        //   (要件Eフィードバック: 検知の遅さ対策)。
        const meetsGrowthPath = cluster.radiusKm >= params.broadRiseMinRadiusKm
          && cluster.growthStreak >= params.broadRiseGrowthTicks;
        const meetsImmediatePath = cluster.radiusKm >= params.broadRiseImmediateRadiusKm;
        if (!meetsGrowthPath && !meetsImmediatePath) continue;

        // 【要件E追加対策】広さ・継続性の条件を満たしていても、密集地域での
        // 相関ノイズ(たまたま同時多発的に上昇)である疑いが強い場合は見送る。
        const timingCorrelation = computeBroadRiseTimingCorrelation([...cluster.members], points, params);
        const timingOk = timingCorrelation == null || timingCorrelation >= params.broadRiseMinTimingCorrelation;
        if (!timingOk) continue;

        const relatedEventIds = new Set();
        for (const id of cluster.members) {
          const p = points.get(id);
          if (p.eventId != null) relatedEventIds.add(p.eventId);
        }
        let relatedEvents = [...relatedEventIds].map(id => this.events.get(id)).filter(Boolean);
        relatedEvents = dropIndependentEvents(relatedEvents, this.externalEstimates, params);

        let targetEvent;
        if (relatedEvents.length > 1) {
          relatedEvents.sort((a, b) => a.createdAt - b.createdAt);
          targetEvent = relatedEvents[0];
          for (const other of relatedEvents.slice(1)) {
            if (other.id === targetEvent.id) continue;
            mergeEventInto(targetEvent, other);
            this.events.delete(other.id);
          }
        } else if (relatedEvents.length === 1) {
          targetEvent = relatedEvents[0];
        } else {
          targetEvent = createEvent(now, tick);
          this.events.set(targetEvent.id, targetEvent);
        }

        for (const id of cluster.members) {
          const p = points.get(id);
          const level = intensityToShakeLevel(p.latestIntensity, params.levelThresholds);
          addPointToEvent(targetEvent, p, level, now, params);
          p.pendingSince = null;
        }
        // 広さ・継続的な拡大という強い裏付けがあるため、待たずに確定扱いにする。
        targetEvent.confirmed = true;
      }
    }

    // 3c) 【配列型の微弱検知】震度0未満〜0付近の、ごく弱い揺れ(沖合の無感地震など)を、
    //     P波の伝播順序に合う、複数の観測点の立ち上がりの組み合わせとして検知する
    //     (詳細はweakArrayDetection.ts)。既存の検知ルール・広域拡大検知(ステップ3b)が
    //     拾えなかった揺れを補う経路で、既に通常のイベントに属している観測点は
    //     探索から除く(同じ地震を二重に検知しないため)。
    if (this.weakArray) {
      const excludeIds = new Set();
      for (const p of points.values()) {
        const ev = p.eventId != null ? this.events.get(p.eventId) : null;
        if (ev) {
          if (!ev.weakArray && p.absorbedEventId !== ev.id) excludeIds.add(p.id); // 通常のイベントに属している点は除く(走時で取り込んだ点は除かない。除くと「届いているはずの点数K」が減り、スコアが膨らむ)
          continue; // 微弱検知のイベントに属している点は、そのイベントの成長のため、除かない
        }
        // イベントに属していないが、微弱検知で使い終えて間もない点(イベントが消えた直後)は除く
        const until = this.weakUsedUntil.get(p.id);
        if (until != null) {
          if (until > now) excludeIds.add(p.id); else this.weakUsedUntil.delete(p.id);
        }
      }
      const match = this.weakArray.update(now / 1000, valuesMap, excludeIds);
      let bigEventActive = false;
      for (const ev of this.events.values()) {
        if (!ev.weakArray && ev.pointCount >= params.weakArrayStandDownPoints) { bigEventActive = true; break; }
      }
      if (match && !bigEventActive) {
        const memberPoints = [];
        for (const m of match.members) {
          const p = points.get(m.id);
          if (p) memberPoints.push({ m, p });
        }
        const relatedEventIds = new Set();
        for (const { p } of memberPoints) {
          if (p.eventId != null && this.events.has(p.eventId)) relatedEventIds.add(p.eventId);
        }
        let relatedEvents = [...relatedEventIds].map(id => this.events.get(id));
        relatedEvents = dropIndependentEvents(relatedEvents, this.externalEstimates, params);
        let targetEvent;
        if (relatedEvents.length > 1) {
          relatedEvents.sort((a, b) => a.createdAt - b.createdAt);
          targetEvent = relatedEvents[0];
          for (const other of relatedEvents.slice(1)) {
            mergeEventInto(targetEvent, other);
            this.events.delete(other.id);
          }
        } else if (relatedEvents.length === 1) {
          targetEvent = relatedEvents[0];
        } else {
          targetEvent = createEvent(now, tick);
          targetEvent.weakArray = true;
          this.events.set(targetEvent.id, targetEvent);
        }
        for (const { m, p } of memberPoints) {
          if (targetEvent.pointIds.has(p.id)) continue; // 既に加わっている点は、期限(expireAt)を延ばさない
          // 検知時刻は、確定した今ではなく、実際に立ち上がった時刻にする(震源推定のため)
          p.reactionStartAt = m.onsetSec * 1000;
          this.weakUsedUntil.set(p.id, now + params.weakArrayReuseBlockMs);
          const level = intensityToShakeLevel(p.latestIntensity ?? -3, params.levelThresholds);
          addPointToEvent(targetEvent, p, level, now, params);
          p.pendingSince = null;
        }
        // 複数の観測点がP波の伝播順序に合うという強い裏付けがあるため、確定扱いにする。
        // 立ち上がりが弱く、数秒で収まる揺れなので、素早い取り消し(ステップ9)の対象外にする。
        targetEvent.confirmed = true;
        if (targetEvent.weakArray) targetEvent.retractionCheckDone = true;
      }
    }

    // 4) イベント割当。震度0未満・かつ近傍がある点は、ステップ3bの広域
    //    継続拡大検知(要件E)で扱うためここでは対象外にする。孤立点(近傍
    //    なし)はそもそも近傍N点中K点方式が組めないため、従来どおり
    //    isolatedRiseThresholdで単独判定する。それ以外(震度0以上、または
    //    震度0未満でも孤立点)は、detectionRulesのアンサンブルで判定する
    //    (近傍の裏付けもルールに組み込まれているため、任意の1点との時間窓
    //    一致は見ない)。
    for (const point of points.values()) {
      const isolated = point.nearPoints.length === 0;

      if (isolated) {
        // 【対策: 離島・岬など孤立点の未検知(続き)】lastRiseTick(瞬間diffが
        // riseThreshold(0.5)を超えた時だけ更新される)のみをゲートにすると、
        // isolatedMinIntensityによる絶対値ベースの判定を追加しても、緩やか
        // な上昇(1tickあたりriseThreshold未満)では一度もこのブロックに
        // 到達できず、死んだ経路になってしまう。震度が既にisolatedMin
        // Intensity以上ならゲートを通すようにする。
        const hasExt = point.extPoints && point.extPoints.length > 0
          && point.latestIntensity != null && point.latestIntensity >= params.detectionRulesMinIntensity;
        if (!hasExt && point.lastRiseTick !== tick && (point.latestIntensity == null || point.latestIntensity < params.isolatedMinIntensity)) continue;

        if (point.eventId != null) {
          const event = this.events.get(point.eventId);
          if (event) {
            const level = intensityToShakeLevel(point.latestIntensity, params.levelThresholds);
            addPointToEvent(event, point, level, now, params);
          }
          point.pendingSince = null;
          continue;
        }

        const isolatedAvgOk = point.avgDiff == null || point.avgDiff >= params.isolatedAvgRiseThreshold;
        // 【対策: 離島・岬など孤立点の未検知】瞬間diffベースの急上昇条件に
        // 加えて、震度そのものが十分高ければ(上昇の仕方が緩やかでも)
        // 検知するOR条件を追加した。
        const triggered = (point.intensityDiff >= params.isolatedRiseThreshold && isolatedAvgOk)
          || point.latestIntensity >= params.isolatedMinIntensity;
        if (!triggered) {
          // 近傍0点でも、60km以内に観測点があれば、その裏付けでdetectionRulesを試す(下の通常経路へ)
          const ext = point.extPoints && point.extPoints.length > 0
            && point.latestIntensity != null && point.latestIntensity >= params.detectionRulesMinIntensity;
          if (!ext) {
            if (point.pendingSince == null) point.pendingSince = tick;
            continue;
          }
        } else {
        point.pendingSince = null;

        const targetEvent = createEvent(now, tick);
        this.events.set(targetEvent.id, targetEvent);
        const level = intensityToShakeLevel(point.latestIntensity, params.levelThresholds);
        addPointToEvent(targetEvent, point, level, now, params);
        // 孤立トリガー(近傍なしで単独発火)は、単独でも高いしきい値を越えて
        // いるため、待たずにそのまま確定扱いにする。
        targetEvent.confirmed = true;
        continue;
        }
      }

      // 【誤検知対策A】従来はweakIntensityCeiling(0.5)未満を一律で
      // 除外していたため、ルール4/5の低いminOwnIntensity(0.2/0.1)が常に
      // 0.5へ上書きされていた。detectionRules専用のゲート
      // (detectionRulesMinIntensity)に変更し、震度0.1〜0.5の範囲も
      // detectionRulesで評価されるようにする(ステップ3のmicroChainとは
      // 重複して評価されるが、これは元々の「ごり押し型アンサンブル」の
      // 設計意図と整合しており、イベント統合ロジックで二重登録も起きない)。
      if (point.latestIntensity == null || point.latestIntensity < params.detectionRulesMinIntensity) continue;

      if (point.eventId != null) {
        // 既にイベントに属している点は、ルールを満たしていればレベル・
        // 寿命を更新するだけ(裏付けとなった近傍も合流させる)。
        const result = evaluateDetectionRules(point, points, params.detectionRules);
        if (result.matched) {
          const event = this.events.get(point.eventId);
          if (event) {
            const level = intensityToShakeLevel(point.latestIntensity, params.levelThresholds);
            addPointToEvent(event, point, level, now, params);
            for (const nb of result.matchedNeighbors) {
              const nbLevel = intensityToShakeLevel(nb.latestIntensity, params.levelThresholds);
              addPointToEvent(event, nb, nbLevel, now, params);
            }
          }
        }
        continue;
      }

      const result = evaluateDetectionRules(point, points, params.detectionRules);
      if (!result.matched) continue; // ルールは近傍の裏付けを内包しているため、pendingは使わない

      // ルールを満たした近傍のうち、既にイベントに属している点があれば合流する。
      const relatedEventIds = new Set();
      for (const nb of result.matchedNeighbors) if (nb.eventId != null) relatedEventIds.add(nb.eventId);
      let relatedEvents = [...relatedEventIds].map(id => this.events.get(id)).filter(Boolean);
        relatedEvents = dropIndependentEvents(relatedEvents, this.externalEstimates, params);

      let targetEvent;
      if (relatedEvents.length > 1) {
        relatedEvents.sort((a, b) => a.createdAt - b.createdAt);
        targetEvent = relatedEvents[0];
        for (const other of relatedEvents.slice(1)) {
          if (other.id === targetEvent.id) continue;
          mergeEventInto(targetEvent, other);
          this.events.delete(other.id);
        }
      } else if (relatedEvents.length === 1) {
        targetEvent = relatedEvents[0];
      } else {
        targetEvent = createEvent(now, tick);
        this.events.set(targetEvent.id, targetEvent);
      }

      const level = intensityToShakeLevel(point.latestIntensity, params.levelThresholds);
      addPointToEvent(targetEvent, point, level, now, params);
      for (const nb of result.matchedNeighbors) {
        const nbLevel = intensityToShakeLevel(nb.latestIntensity, params.levelThresholds);
        addPointToEvent(targetEvent, nb, nbLevel, now, params);
      }
    }

    // 5) pendingのまま長く裏付けを得られない点は静かに諦める(誤報にしない。
    //    現在はisolated点のみがpendingSinceを使う)。
    for (const point of points.values()) {
      if (point.pendingSince != null && tick - point.pendingSince > params.pendingExpireTicks) {
        point.pendingSince = null;
      }
    }

    // 6) 確定した揺れの周辺への面的な拡張(BFS)。2点同時多発の裏付けが
    //    取れた点(イベントの核)を起点に、単独では検知の裏付けにならない
    //    程度の弱い上昇(propagationRiseThreshold)でも、既存イベントの
    //    近傍であればそのまま同じイベントに取り込んでいく。これにより、
    //    核から面として自然に広がり、検知エリアがまだらに欠けるのを防ぐ
    //    (eq_detection.jsのexpandDetectedAreaの考え方を移植)。
    //    ただし、イベントの発生起点(originLat/originLon)からの距離が
    //    propagationMaxRadiusKmを超える点へは拡張しない。上限が無いと、
    //    途中の弱いノイズを挟んで領域が際限なく広がり、地理的に離れた
    //    別々の地震のイベント同士が誤って統合されてしまうため。
    const propagationQueue = [];
    for (const point of points.values()) {
      if (point.eventId != null) propagationQueue.push(point.id);
    }
    let qi = 0;
    while (qi < propagationQueue.length) {
      const current = points.get(propagationQueue[qi++]);
      const event = this.events.get(current.eventId);
      if (!event) continue;
      for (const np of current.nearPoints) {
        const neighbor = points.get(np.id);
        if (!neighbor || neighbor.eventId != null) continue;
        if (neighbor.latestIntensity == null) continue;
        const riseNow = params.propagationUseRecentRise && neighbor.riseRateMax10s != null
          ? Math.max(neighbor.intensityDiff, neighbor.riseRateMax10s) : neighbor.intensityDiff;
        if (riseNow < params.propagationRiseThreshold) continue;
        if (event.originLat != null) {
          const distFromOrigin = haversineKm(event.originLat, event.originLon, neighbor.lat, neighbor.lon);
          if (distFromOrigin > params.propagationMaxRadiusKm) continue;
        }
        // 【誤検知対策C】伝播元(current)から拡張先候補までの距離・時刻差から
        // 伝播速度を逆算し、地震波として物理的に妥当な範囲
        // (pWaveMinSpeedKmS〜pWaveMaxSpeedKmS)に収まらなければ取り込まない。
        // currentの検知時刻が記録されていない(=まだイベントのdetectionTimes
        // に載っていない)場合はチェックをスキップして従来通り許可する。
        const currentDetection = event.detectionTimes.get(current.id);
        if (currentDetection && params.propagationUseRecentRise) {
          // 反応開始時刻の差で判定する(neighborが反応していない=reactionStartAtが無い場合は、チェックしない)
          if (neighbor.reactionStartAt != null) {
            const distKm = haversineKm(current.lat, current.lon, neighbor.lat, neighbor.lon);
            const dtSec = Math.abs(neighbor.reactionStartAt - currentDetection.detectedAt) / 1000;
            if (dtSec > distKm / params.pWaveMinSpeedKmS + params.propagationTimingMarginSec) continue;
          }
        } else if (currentDetection) {
          const distFromCurrentKm = haversineKm(current.lat, current.lon, neighbor.lat, neighbor.lon);
          const elapsedSeconds = (now - currentDetection.detectedAt) / 1000;
          if (elapsedSeconds > 0 && distFromCurrentKm > 0) {
            const propagationSpeedKmS = distFromCurrentKm / elapsedSeconds;
            if (propagationSpeedKmS < params.pWaveMinSpeedKmS || propagationSpeedKmS > params.pWaveMaxSpeedKmS) continue;
          }
        }
        const level = intensityToShakeLevel(neighbor.latestIntensity, params.levelThresholds);
        addPointToEvent(event, neighbor, level, now, params);
        neighbor.pendingSince = null;
        propagationQueue.push(neighbor.id);
      }
    }

    // 6b) 走時による取り込み。外部の震源推定(位置・深さ・発震時刻)があるイベントについて、
    //     まだどのイベントにも属していない観測点のうち、反応の開始時刻がP波の予測到達に合うものを取り込む。
    if (params.travelAbsorbEnabled && this.externalEstimates && this.externalEstimates.size > 0) {
      const cands = [];
      for (const [id, ev] of this.events) {
        const est = this.externalEstimates.get(id);
        if (!est || est.originTime == null || est.lat == null) continue;
        if (ev.pointCount < params.travelAbsorbMinPoints) continue;
        let radius = 0;
        for (const d of ev.detectionTimes.values()) radius = Math.max(radius, haversineKm(est.lat, est.lon, d.lat, d.lon));
        cands.push({ ev, est, reachKm: Math.min(params.travelAbsorbMaxKm, radius + params.travelAbsorbGrowKm) });
      }
      if (cands.length > 0) {
        for (const point of points.values()) {
          if (point.eventId != null || point.latestIntensity == null || point.lastOnsetAt == null) continue;
          if (now - point.lastOnsetAt > params.travelAbsorbMaxAgeSec * 1000) continue;
          if (point.riseRateMax10s == null || point.riseRateMax10s < params.travelAbsorbMinRise) continue;
          let best = null;
          for (const { ev, est, reachKm } of cands) {
            const epiKm = haversineKm(est.lat, est.lon, point.lat, point.lon);
            if (epiKm > reachKm) continue;
            const [tp] = pAndSTravelSec(epiKm, est.depthKm ?? 10);
            const lag = (point.lastOnsetAt - est.originTime) / 1000 - tp;
            if (lag < -params.travelAbsorbEarlySec || lag > params.travelAbsorbLateSec) continue;
            if (!best || Math.abs(lag) < best.absLag) best = { ev, absLag: Math.abs(lag), lag };
          }
          if (!best) continue;
          const level = intensityToShakeLevel(point.latestIntensity, params.levelThresholds);
          addPointToEvent(best.ev, point, level, now, params);
          const d = best.ev.detectionTimes.get(point.id);
          if (d) d.detectedAt = point.lastOnsetAt;
          point.absorbedEventId = best.ev.id;
          point.pendingSince = null;
        }
      }
    }

    // 7) 領域が近い(または重なる)イベント同士の統合。1回のtickで広範囲に
    //    同時多発したイベント群が、小さなイベントのまま乱立しないよう、
    //    「これ以上統合できるペアが無くなるまで」繰り返す(連鎖的な統合)。
    //    【対策: 地震の検知範囲が成長すると無関係な地震同士が統合される
    //    問題】以前は距離ベース判定(rectMinDistanceKm <= mergeDistanceKm)
    //    を満たせば物理チェックなしで無条件に統合していたが、成長した
    //    イベントのバウンディングボックスが無関係な遠方の地震にたまたま
    //    近づいただけで誤統合される不具合があったため、近接時にも物理
    //    チェックを行うcanEventsMergeに統一した(詳細はcanEventsMergeの
    //    コメント参照)。
    let merged = true;
    while (merged) {
      merged = false;
      const eventList = [...this.events.values()];
      for (let i = 0; i < eventList.length; i++) {
        const a = eventList[i];
        if (!this.events.has(a.id) || a.centerLat == null) continue;
        for (let j = i + 1; j < eventList.length; j++) {
          const b = eventList[j];
          if (!this.events.has(b.id) || b.centerLat == null) continue;
          if (canEventsMerge(a, b, params, this.externalEstimates)) {
            // 3つ以上のイベントが互いに統合できる場合は、より近いイベントへ統合する(同時期に遠く離れて起きた
            // 2つの地震の、どちらにも当てはまる遅れて検知された点が、大きい方へ吸われて、遠い方に付くのを防ぐ)。
            const cd = (x, y) => haversineKm(x.centerLat, x.centerLon, y.centerLat, y.centerLon);
            const dab = cd(a, b);
            let hasCloser = false;
            for (const c of eventList) {
              if (c === a || c === b || !this.events.has(c.id) || c.centerLat == null) continue;
              if ((cd(c, a) < dab && canEventsMerge(c, a, params, this.externalEstimates))
                  || (cd(c, b) < dab && canEventsMerge(c, b, params, this.externalEstimates))) { hasCloser = true; break; }
            }
            if (hasCloser) continue;
            mergeEventInto(a, b);
            this.events.delete(b.id);
            merged = true;
          }
        }
      }
    }

    // 8) 期限切れイベントの削除
    for (const [id, event] of this.events) {
      if (event.expireAt < now) this.events.delete(id);
    }

    // 9) 誤検知の素早い取り消し(quick retraction、25節)。作成から
    //    falsePositiveCheckTicks以内のイベントについて、(観測点が1点も
    //    増えていないか、または増えていても伝播速度が地震として妥当でない)
    //    かつ関与する観測点が軒並み反応が収まっていれば、ノイズ・瞬間的な
    //    スパイクだったとみなして即座に取り消す(通常の寿命=
    //    eventDurationBaseMsを待たない)。判定は2段階:
    //    (a) 作成の次のtickで、その時点のpointCountを基準値として記録する
    //        (作成直後は複数点が同tickでまとめて加わるため、その直後の
    //        状態を「初期の大きさ」とする)。
    //    (b) falsePositiveCheckTicks経過した時点で1回だけ判定する。
    //    【誤検知対策B】観測点が増えているケースも、以前は無条件に「本物」
    //    として除外していたが、地理的相関ノイズがBFS面的拡張で観測点数を
    //    増やし続けてしまうケースに対応するため、伝播速度の整合性チェック
    //    (computeEventSpeedConsistencyRatio)を追加した。
    for (const event of this.events.values()) {
      if (event.retractionCheckDone) continue;
      const ticksSinceCreated = tick - event.createdTick;
      if (event.pointCountAtWindowStart == null) {
        if (ticksSinceCreated >= 1) event.pointCountAtWindowStart = event.pointCount;
        continue;
      }
      if (ticksSinceCreated < params.falsePositiveCheckTicks) continue;

      event.retractionCheckDone = true;

      // 【誤検知対策B再拡張】密集地域の相関ノイズは、しばらく反応が続く
      // (stillReactingがtrueであり続ける)ことが多く、従来の「観測点数が
      // 増えた場合だけ物理的整合性をチェックする」構造だと、stillReacting
      // のOR条件によってタイミング相関チェックが素通りされてしまう
      // ケースがあることがシミュレーションで判明した。そのため、十分な
      // サンプル数があるかぎり、タイミング相関チェックをstillReactingより
      // 優先する独立した判定に格上げする。相関が明確に弱い(同時多発的)場合は、
      // 観測点数の増減・反応継続の有無に関わらず取り消し対象とする。
      const timingCorrelation = computeEventTimingCorrelation(event, params);
      const timingClearlyInconsistent = timingCorrelation != null && timingCorrelation < params.retractionMinTimingCorrelation;

      if (!timingClearlyInconsistent) {
        const pointsIncreased = event.pointCount > event.pointCountAtWindowStart;
        if (pointsIncreased) {
          // 【誤検知対策B】従来は観測点が増えていれば無条件に「本物」として
          // scrubをスキップしていたが、密集地域では地理的相関ノイズ(天候・
          // 交通振動等)でもBFS面的拡張(propagationRiseThreshold)により
          // 観測点数が増え続けてしまい、この条件だけでは誤検知を取り消せない
          // ケースがあった。観測点数が増えている場合でも、検知時刻から見た
          // 伝播速度が地震として妥当な範囲に収まっているか(=speedConsistency)
          // を追加で確認し、妥当と言えない場合は下のstillReacting判定に委ねる。
          const speedConsistency = computeEventSpeedConsistencyRatio(event, params);
          const speedConsistent = speedConsistency == null || speedConsistency >= params.retractionSpeedConsistencyRatio;
          if (speedConsistent) continue; // 観測点が増え、伝播速度も整合→本物とみなす
        }

        let stillReacting = false;
        for (const id of event.pointIds) {
          const p = points.get(id);
          if (p && p.avgDiff != null && p.avgDiff >= params.reactionAvgRiseThreshold) {
            stillReacting = true;
            break;
          }
        }
        if (stillReacting) continue; // まだ反応が続いている→本物とみなす
      }

      // 取り消し: 関与していた観測点を解放し(誤検知の残骸を引きずらない、
      // 本当に揺れ始めた場合は改めて新規イベントとして検知できるようにする)、
      // イベント自体を削除する。
      for (const id of event.pointIds) {
        const p = points.get(id);
        if (p && p.eventId === event.id) p.eventId = null;
      }
      this.events.delete(event.id);
    }

    // 【対策: マグニチュードが検知時の小さな揺れ(P波の初動)で決まってしまう問題】
    // 各観測点の記録(detectionTimes)のintensity/levelは、その点がイベントに
    // 加わった時の値のまま、一部の経路でしか更新されていなかった。実データ
    // (2021福島県沖M7.3・2026三陸沖M7.7のリプレイ)で、検知から数十秒経っても
    // 記録の震度が検知時の1〜3台のままで、実際の最大(5〜6)より2〜3低く、
    // 震源推定のマグニチュードが実際より2〜3も小さくなっていた。マグニチュード
    // 推定は「その観測点のこれまでの最大振幅」を見るべき処理のため、毎tick、
    // イベントに属する全観測点の記録を、現在の値が大きければ更新する。
    for (const event of this.events.values()) {
      for (const [id, d] of event.detectionTimes) {
        const p = points.get(id);
        if (!p || p.latestIntensity == null) continue;
        if (d.intensity == null || p.latestIntensity > d.intensity) d.intensity = p.latestIntensity;
      }
    }

    // detectionTimes(Map)は外部にそのまま渡さず、epicenterEstimation.tsが
    // 使いやすい配列形式(detections)に変換して返す。震源推定を使わない
    // 既存の呼び出し側(App.jsx等)には影響しない追加フィールドなので、
    // 他のフィールド(level/pointCount/centerLat/centerLon/confirmed等)の
    // 扱いはこれまでと変わらない。
    return [...this.events.values()]
      .filter(e => e.centerLat != null)
      .map(e => {
        const { detectionTimes, ...rest } = e;
        return {
          ...rest,
          pointIds: [...e.pointIds],
          detections: [...detectionTimes].map(([id, d]) => ({
            id, lat: d.lat, lon: d.lon, detectedAt: d.detectedAt, level: d.level, intensity: d.intensity,
            sWaveDetectedAt: d.sWaveDetectedAt,
          })),
        };
      })
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }
}
