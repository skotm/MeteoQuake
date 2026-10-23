# ShakeDetectionEngine — 地震検知のまとめ

このファイルは、KyoshinEewViewer の ShakeDetectionEngine.cs の検出アルゴリズムをまとめた Markdown ドキュメントです。

---

# 揺れ検知方法（概要）

ShakeDetectionEngine による検知は次の流れで行われます。

1. 観測点ごとに画像ピクセルから強度を計算して更新する（ProcessImage）
2. 各観測点について異常値判定・近傍情報の確認を行う（ProcessEvents）
3. 近傍の反応を重み付きで集約してスコアを算出し、閾値超過でイベントを生成／既存イベントに追加／イベント同士を統合する
4. 必要条件を満たしたらイベントを「確定」として通知系に渡す

対象ソース例:
- src/KyoshinEewViewer.Core/ShakeDetection/ShakeDetectionEngine.cs
- src/KyoshinEewViewer.Core/Models/KyoshinEvent.cs
- src/KyoshinEewViewer/Series/KyoshinMonitor/Services/KyoshinMonitorWatchService.cs

---

# 入力と初期化

- 入力
  - SKBitmap（マップ画像フレーム）
  - RealtimeObservationPoint[]（観測点の位置・画像上の座標・履歴等）
  - 現在時刻（DateTime）
- 初期化
  - Initialize(points) → SetupNearPoints()：各点に対し近傍点リストを作成（距離 < MaxSearchDistance、上位 MaxNearPoints、各近傍の距離重みを計算して格納）

---

# 画像処理（ProcessImage）

- 各観測点について:
  - bitmap.GetPixel(point.ImageLocation) を取得
  - alpha != 255 → 欠測扱い（point.Update(null, null)）
  - 有効ピクセル → 色をスケール変換 → 強度に変換 → point.Update(color, intensity)
- 更新後、ProcessEvents(time) を呼び検出処理を行う

---

# 異常値除外（先頭処理）

- point.LatestIntensity が存在し、次を満たすと一時除外（point.IsTmpDisabled = true）：
  - IntensityDiff < 1（変化小）かつイベント未割当
  - latestIntensity >= (HasNearPoints ? 3 : 5)（離島は閾値が大きい）
  - |IntensityAverage - latestIntensity| <= 1（短期平均との乖離小）
  - かつ(既に一時除外中 または 全近傍で (latestIntensity - near.LatestIntensity) >= 3)
- 目的：単独スパイク等のノイズ抑制。復帰条件で IsTmpDisabled = false に戻す。

---

# 基本的な検出条件（早期スキップ）

- point.IntensityDiff < Parameters.MinDetectionDiff → 検出対象外（ただし既存イベントの期限切れ処理は行う）
- 近傍データが未計算・欠測や point.LatestIntensity が null → スキップ

---

# 近傍の有効重み合計

- availableTotalWeight = Σ(near.Weight) for near.Point.HasValidHistory のみ
- availableTotalWeight が小さい → 「孤立（離島）」扱い（単独判定に分岐）

---

# 単独（離島）判定

- 条件: availableTotalWeight < Parameters.IsolatedThreshold
- 単独判定時の生成条件:
  - point.IntensityDiff >= Parameters.IsolatedDetectionDiff
  - point.Event が null のとき新規 KyoshinEvent を作成
- イベント持続時間はレベルに応じて Parameters.GetSeconds(level)

---

# 近傍重み付きスコア計算（通常ケース）

- 変数:
  - score = 0
  - penaltyScore = 0
  - contributingPointCount = 0
  - events = 近傍が属する既存イベントのリスト（point.Event を含む場合も）
- 各近傍 np について:
  - 無効（IsTmpDisabled）または履歴なし → スキップ
  - np.Point.IntensityDiff >= Parameters.MinDetectionDiff の場合:
    - score += np.Weight * (np.Point.IntensityDiff - Parameters.ScoreIntensityOffset)
    - contributingPointCount++
    - np.Point.Event != null → events に追加
  - ���応なし（IntensityDiff < MinDetectionDiff）:
    - penaltyScore += np.Weight * Parameters.NoChangePenaltyFactor
- 最終スコア:
  - finalScore = score - penaltyScore
  - threshold = availableTotalWeight * Parameters.ScoreThresholdRatio

- ノイズ回避:
  - contributingPointCount <= 1 → スキップ（単独寄与はノイズの可能性）
  - finalScore < threshold → スキップ

---

# スコア合格時のイベント処理

- point.EventedAt = time を設定
- events を一意化して uniqueEvents を取得
  - uniqueEvents.Count > 1 → 最も古いイベントに他を MergeEvent して統合、KyoshinEvents から削除。統合先に point を AddPoint、UpdateEventConfirmation を呼ぶ
  - uniqueEvents.Count == 1 → そのイベントに AddPoint、UpdateEventConfirmation を呼ぶ
  - uniqueEvents.Count == 0 → 新規 KyoshinEvent を作成して KyoshinEvents に追加、UpdateEventConfirmation を呼ぶ

- AddPoint の効果:
  - イベントのレベルアップ判定（既存点に同等以上のレベルがあれば Level を更新）
  - イベント領域（TopLeft/BottomRight）更新
  - point.EventedExpireAt を延長

---

# イベント間の距離マージ

- 全イベントを時系列で巡回して pairwise 比較
- mergeDistance = Parameters.GetMergeDistance(max(evt.Level, evt2.Level))
- evt.CheckNearby(evt2, mergeDistance) が true → evt.MergeEvent(evt2)、KyoshinEvents から evt2 を削除
- 目的: 近接して同一現象のイベントを統合

---

# イベント確定ルール（UpdateEventConfirmation）

- 既に確定なら何もしない
- 確定条件（レベル／点数により）:
  - Level <= Weaker && PointCount > Parameters.WeakerConfirmPointCount
  - Level == Weak && PointCount > Parameters.WeakConfirmPointCount
  - Level > Weak → 即確定
- 確定したイベントは通知経路（KyoshinEventStateTracker → Workflow）へ渡される

---

# 主なパラメータ（ShakeDetectionParameters）

- MinDetectionDiff：検出に必要な最小差分
- IsolatedThreshold：近傍重み合計がこの閾値未満なら孤立扱い
- IsolatedDetectionDiff：孤立時の検出差分閾値
- ScoreIntensityOffset：近傍の差分から差し引くオフセット
- NoChangePenaltyFactor：近傍が無反応の際のペナルティ係数
- ScoreThresholdRatio：availableTotalWeight に掛ける閾値比
- MaxSearchDistance：近傍探索距離上限
- MaxNearPoints：近傍選択の最大個数
- WeakerConfirmPointCount / WeakConfirmPointCount：���定に必要な点数

（実際の既定値は ShakeDetectionParameters を参照）

---

# デバッグ・可視化

- DEBUG ビルドで各点に point.DebugAvailableTotalWeight、DebugDetectionScore、DebugDetectionThreshold、DebugNoChangePenalty 等が設定される
- ShakeDetectionVerifierLayer や ShakeDetectionAreaLayer で点・イベント・スコア等を地図上に表示できる
- Logger による Info/Debug 出力あり

---

# 問題点・注意点・改善提案

- SetupNearPoints の近傍ソートに自己距離参照のバグがある（実装確認・修正推奨）
- パラメータ感度が高く、観測網の密度や画像特性に応じてチューニングが必要
- 時刻同期（画像取得の遅延/ジャンプ）がイベント寿命やマージに影響するため、WatchService の時刻管理は重要
- ノイズ除去の高度化案：移動中央値フィルタや時系列の外れ値検出（zスコア）、近傍の時間整合性を利用した追加フィルタ
- 評価方法：既知イベントのリプレイ、合成データによる真陽性/偽陽性評価、パラメータスイープ

---

# 検証手順（簡易）

1. リプレイデータで既知ケースを再生（Tools/EarthquakeReplayFilePacker）し、検出タイミングとレベルを確認  
2. 合成ケース（単独スパイク、近傍一斉上昇、部分的ノイズ）を作り、閾値での検出/非検出を評価  
3. DEBUG 表示で点ごとの score/penalty/availableWeight を可視化して閾値調整  
4. パラメータスイープで ROC 的に最適点を探索

---

# 参考箇所（実装ファイル）

- ShakeDetectionEngine.cs（検出本体）
  src/KyoshinEewViewer.Core/ShakeDetection/ShakeDetectionEngine.cs
- KyoshinEvent.cs（イベントモデル）
  src/KyoshinEewViewer.Core/Models/KyoshinEvent.cs
- KyoshinMonitorWatchService.cs（画像取得→検出の起点）
  src/KyoshinEewViewer/Series/KyoshinMonitor/Services/KyoshinMonitorWatchService.cs
- ShakeDetectionVerifierLayer.cs / ShakeDetectionAreaLayer.cs（可視化）
  src/KyoshinEewViewer/Series/ShakeDetectionVerifier/ShakeDetectionVerifierLayer.cs
  src/KyoshinEewViewer/Series/KyoshinMonitor/ShakeDetectionAreaLayer.cs
