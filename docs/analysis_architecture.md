# 解析処理の構成(検知・震源推定)

地震検知・震源推定の処理は、地図の描画(`app/MapCanvas.jsx`)から切り離してある。

```
src/
├── engines/                  検知・推定のエンジンと、その直接の部品(DOM・React非依存)
│   ├── shakeDetection.ts         揺れ検知エンジン(ShakeDetectionEngine)
│   ├── weakArrayDetection.ts     微弱検知(配列型)
│   ├── gridDetection.ts          グリッド(セル)方式の検知(GridDetector)
│   ├── epicenterEstimation.ts    震源推定(EpicenterEstimator / estimateEpicenter)
│   ├── epicenterConfidence.ts    震源推定の信頼度
│   ├── stationTerritory.ts       観測点の担当領域(ボロノイ)
│   ├── jmaTravelTime.ts          走時表(気象庁の走時表の読み込み・参照)
│   └── shakeTestSimulation.ts    検知テスト配信の模擬地震(テストでも使う)
├── analysis/
│   ├── analysisPipeline.ts   解析本体。揺れ検知・震源推定・グリッド検知を1tick分進める(DOM・React非依存)
│   ├── analysisRunner.ts     MapCanvasが使う実行役。同期 / Workerを切り替える(失敗時は同期へ戻る)
│   ├── analysisClient.ts     メインスレッド側のWorkerクライアント(tickが溜まったらまとめる)
│   ├── analysisProtocol.ts   メインスレッド⇔Workerのメッセージ定義
│   └── workerHandler.ts      Worker側のメッセージ処理(pipelineを持つ)
├── workers/
│   └── earthquakeWorker.ts   Web Workerの入口(workerHandlerをselfに取り付けるだけ)
└── app/MapCanvas.jsx         pipelineの結果を描画する(解析の処理は持たない)
```

## 動作モード(同期 / Worker)

`MapCanvas.jsx` は、`AnalysisRunner`(`analysis/analysisRunner.ts`)経由で解析を呼ぶ。実行方法は2つ:

| モード | 動作 |
|---|---|
| 同期(既定) | `AnalysisPipeline`を同じスレッドで直接呼ぶ。`onResult`は`tick()`の中でその場で呼ばれる(従来と同じ動作・タイミング) |
| Worker | 解析を別スレッドで行う。結果は非同期(1tick以上遅れて)返り、`applyAnalysis`(描画)が後から呼ばれる |

**Workerを有効にする**: URLに `?analysisWorker=1`(無効化は `?analysisWorker=0`)、または
`localStorage.setItem("meteoquake.analysisWorker", "1")`。優先順位は URL > localStorage > 既定値
(`analysisRunner.ts`の`ANALYSIS_WORKER_DEFAULT`、現在false)。ブラウザで一通り確認できたら、既定値をtrueにする。

Workerモードの挙動:
- Workerは**最初に使われた時**に作る(StrictModeの二重描画で、Workerを作りすぎないため)。終了処理はMapCanvasでは呼ばない。
- Workerを作れない、またはWorkerがエラー(スクリプトの読み込み失敗・未捕捉の例外)を起こした場合は、**自動で同期モードへ戻る**
  (観測点・微弱検知の設定は引き継ぐ。検知の状態は最初からやり直しになる)。コンソールに警告が出る。
- Worker内の1tickの処理が例外になった場合は、警告を出して、そのtickを飛ばす(Workerは使い続ける)。
- Worker処理中に次のtickが来たら溜め、まとめて送る。Worker側は検知を全tick分進め、重い震源推定は最後の1tickだけ行う。
  まとめられたtickの`applyAnalysis`は呼ばれない(最後のtickの結果だけが描画される)。
- 走時表(`public/jma-travel-time.json`)は、MapCanvasが取得して`setTravelTable`でWorkerへ渡す
  (Workerは自分のモジュール空間を持つので、App.jsxがメインスレッドに設定した走時表は見えない)。届くまでは定速モデル。
- `applyAnalysis`は、tickを送った時点の設定・地図の値で描画する(次のtickで最新に追いつく)。地図が破棄された後に届いた結果は捨てる。

## 検証

- `tests/analysisPipeline.test.ts`: 移す前のeffectの処理(参照実装)との一致(データ源の切り替え・リプレイのシーク・グリッド検知のON/OFF含む)
- `tests/analysisWorker.test.ts`: 実際の別スレッド(worker_threads)で、メインスレッドの直接実行と全tick一致。tickのまとめ送り・推定の省略・例外の伝播
- `tests/analysisRunner.test.ts`: モード切り替え、Workerの遅延生成、失敗時の同期へのフォールバック、有効化フラグ
- `npm run replay -- --worker ...`: 実リプレイ(2025-12-08 青森県東方沖M7.5)398フレームで、通常実行と全tick一致
- 未確認: **ブラウザでの実行**(Viteのビルド、実際のWeb Worker、画面の描画)。Workerの入口(`workers/earthquakeWorker.ts`)をesbuildで
  バンドルし、ブラウザのWorkerスコープを模した環境で動かし、直接実行と一致することまでは確認済み。
