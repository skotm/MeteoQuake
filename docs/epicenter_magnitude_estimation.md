# 震源・マグニチュード・深さの推定方法（設計・アルゴリズムまとめ）

このドキュメントは、MeteoQuake‑KyoshinViewer において「画像ベースの揺れ検知（ShakeDetection）」の結果や観測点データを使って、震源（Epicenter）・発生時刻（Origin time）・深さ（Depth）・マグニチュード（Magnitude）を推定するための処理設計とアルゴリズムをまとめたものです。

注意：現在のリポジトリ（参考実装）では、ShakeDetectionEngine は揺れ領域とイベントレベルを検出しますが、厳密な震源・M・深さの逆解析を行う実装は標準では含まれていません。本稿はその機能を実装／追加するための設計ガイドです。

---

## 目次

- 概要
- 必要データ（入力）
- 高レベルワークフロー
- 震源（Epicenter）・発生時刻（Origin time）推定
  - 到達時刻法（TDOA / 最小二乗）
  - グリッド探索
  - 実装上の注意点
- 深さ（Depth）の推定
- マグニチュード（Magnitude）の推定
  - 振幅モデルと較正
  - 統計的推定（最尤、重み付け最小二乗）
- 不確かさ評価と品質指標
- TravelTimeTableService の利用
- RealtimeObservationPoint の利用（本アプリにおけるデータ）
- 統合ポイント（アプリ内での呼び出し場所）
- テスト・検証手順
- 実装例（擬似コード）

---

## 概要

震源・発生時刻・深さ・マグニチュードを推定する一般的な方針は「各観測点で観測された到達時刻（または検知時刻）と振幅情報を使って、震源パラメータを最適化（最小化）する」ことです。到達時刻を主情報源にする方法が最も一般的で、到達時刻差（TDOA: Time Difference Of Arrival）を使うと良いです。

---

## 必要データ（入力）

- 観測点情報（RealtimeObservationPoint）
  - 緯度経度（Location）
  - 各点の検出時刻（point.EventedAt や履歴に記録された検知タイムスタンプ）
  - 振幅・強度情報（point.LatestIntensity や履歴の振幅指標）
  - 観測点の利用可否フラグ（IsTmpDisabled など）
- 走時表（TravelTimeTable）
  - 深さ毎・距離毎の P/S 波到達時間テーブル（既存の TravelTimeTableService）
- 初期推定パラメータ（探索範囲、グリッド解像度、重みなど）

注意：画像由来の強度は絶対振幅（物理量）に直結しない場合が多いので、マグニチュード推定には観測点ごとの較正係数が必要です。

---

## 高レベルワークフロー

1. データ収集
   - ShakeDetection によりイベント検出された点集合を取得（KyoshinEvent.Points）。各点の EventedAt（検知時刻）と振幅指標を収集する。
2. 前処理
   - 無効点（IsTmpDisabled、履歴不足、欠測）を除外。
   - タイムスタンプの同期・補正（時計ずれ調整があれば適用）
3. 震源・時刻・深さの同時推定
   - 到達時刻モデル（走時表）を用いて、震源位置 (x,y), 深さ z, 発生時刻 t0 の組を最適化する。
   - 最適化手法：非線形最小二乗（Levenberg–Marquardt）またはグリッド探索＋局所最適化。
4. マグニチュード推定
   - 推定した震源距離と観測振幅から、減衰モデルを仮定して M を推定（較正係数要）
5. 不確かさ評価
   - 残差分散、ヤコビアンからのパラメータ共分散行列、ブートストラップなどで不確かさを算出
6. 結果出力
   - UI に Hypocenter（位置・深さ・発生時刻・信頼度）を渡す。P/S 波円描画には TravelTimeTableService を利用。

---

## 震源（Epicenter）・発生時刻（Origin time）推定

### 到達時刻方程式

観測点 i に対して理論到達時刻は：

T_i = t0 + Ttravel(depth, distance_i)

- t0: 震源発生時刻（未知）
- Ttravel(depth, distance): 走時表から得られる P 波到達時間（あるいは S 波）
- distance_i: 推定震源位置と観測点 i との距離（球面距離）

実際の観測時刻 t_i（point.EventedAt 等）との残差 r_i は：

r_i = t_i - (t0 + Ttravel(depth, distance_i))

最小二乗では Σ w_i * r_i^2 を最小化する。

### 最適化パラメータ

- パラメータベクトル: θ = (lat, lon, depth, t0)
- 重み w_i は観測時刻の信頼度（検出精度、振幅の S/N 比）に基づく

### 実装手法

- グリッド探索（粗解像度）
  - 領域（緯度経度範囲・深さレンジ）をグリッド分割し、各グリッド点で最適 t0（閉形式解）を求めて残差和を評価。上位候補に対して局所最適化。
- 非線形最小二乗（Levenberg–Marquardt）
  - 初期値はグリッド探索や検出点重心で与える。
  - ヤコビアンは ∂r_i/∂θ を数値微分または解析的に計算して最適化。
- 到達時刻差（TDOA）を使う方法
  - 観測点ペアの時刻差 Δt_ij = t_i - t_j を用いることで t0 を消し、位置情報のみの最適化を行うことができる（双曲線法）。その後 t0 を後で推定。

### t0 の最適化（閉形式）

t0 は他パラメータ固定時に最小二乗解として解析的に求まる：

t0 = mean_i ( t_i - Ttravel(depth, distance_i) )

（重み付き平均を使うことが多い）

### 実装上の注意点

- 観測時刻の誤差（秒〜数秒）が小さいことが重要。画像取得頻度や処理遅延が大きい場合、時刻基準の補正が必要。
- 深さは到達時間に対する影響が弱く同定困難な場合が多い — 深さはグリッドでスキャンして t0/位置を同時最適化するのが現実的。

---

## 深さ（Depth）の推定

- 深さは到達時刻に対して影響があるが、観測点分布や到達時間精度が不十分だと不確か。
- 実用的手法：深さを離散候補（例 0〜100km を 1km 刻み）で評価し、それぞれについて緯度経度・t0 を最適化して最良の残差を選ぶ。
- 連続推定を行う場合は、(lat,lon,depth,t0) を同時に最小化する非線形最適化を用いるが、初期値・正則化が重要。

---

## マグニチュード（Magnitude）の推定

### 基本方針

観測点 i の振幅 A_i（または画像から得た強度指標）と距離 R_i を用い、次のようなモデルで推定します。

log(A_i) = a * M + b * log(R_i) + c + ε_i

- M: マグニチュード（未知）
- a, b, c: モデル係数（a は理論的に比例関係、b は距離減衰係数）
- R_i: 震源と観測点の距離
- ε_i: 観測ノイズ

通常は a≈(ln 10) のスケール等、標準的な減衰モデルに基づく係数で線形化して最小二乗で M を推定する。

### 実務上の課題

- 画像からの強度は波形振幅そのものではない可能性が高い（非線形レンダリング・しきい値処理など）。
- 観測点ごとに校正係数（観測感度）を導入する必要がある。
- 大規模実装では周波数帯別の校正や観測機器特性を考慮する。

### 実装例（簡易）

1. 推定震源位置で各点の距離 R_i を計算
2. 振幅指標 A_i（可能なら実効振幅）を取得
3. ログスケールで線形回帰して M を推定（重み付き最小二乗）

---

## 不確かさ評価と品質指標

- 残差平方和（RSS）や標準誤差
- パラメータ推定の共分散行列（ヤコビアン J を用いて近似）
- ブートストラップやジャックナイフによる信頼区間
- 観測数、有効観測点の地理的分布（領域が偏っていると位置のバイアスが生じる）

---

## TravelTimeTableService の利用

- 既存の TravelTimeTableService は、震源の深さと経度緯度に基づく距離に対して P/S 波の到達時間を補間して返す機能があります。
- 震源推定時には Ttravel(depth, distance) の評価にこれを使います。
- 参照: `src/.../TravelTimeTableService.cs`

---

## RealtimeObservationPoint の利用（本アプリ）

- ShakeDetectionEngine が作る KyoshinEvent の Points 配列から、観測点の EventedAt（検知時刻）や LatestIntensity を取得できます。
- EventedAt を観測到達時刻 t_i として扱い、到達時刻法の入力にするのが現実的。
- ただし EventedAt は内部ロジックで上書き・延長されることがある（EventedExpireAt等）ので、取り扱いに注意。

---

## 統合ポイント（アプリ内での呼び出し候補）

- KyoshinMonitorWatchService: 画像処理ループの中心で ShakeDetectionEngine を呼び出しているため、検出直後に推定モジュールを呼び出すのが自然。
- 新規サービス案: `HypocenterEstimatorService` を作り、検出イベント（KyoshinEvent）が更新されたタイミングで推定を行い、その結果を Eew もしくは UI 用の Hypocenter 表示構造に流す。

---

## テスト・検証手順

1. リプレイデータで既知の EEW と併せて実行し、推定値と公式 EEW の震源・深さ・M を比較。
2. 合成データ（既知震源・M・深さ）を用意し、観測点時刻にノイズを加えて推定精度を評価。
3. パラメータ（重み・解像度）の感度解析。
4. ブートストラップで不確かさ評価。

---

## 実装例（擬似コード）

```text
入力: 観測点集合 { (lat_i, lon_i, t_i, A_i) }, TravelTimeTableService
出力: 推定 (lat, lon, depth, t0, M)

1. 前処理: 有効点のみを選択、時刻補正
2. グリッド探索: depth 候補ごとに
   for each grid point (lat_g, lon_g):
     compute distance_i
     compute predicted travel times Ttravel(depth, distance_i)
     compute t0_hat = weighted_mean( t_i - Ttravel )
     compute residuals r_i = t_i - (t0_hat + Ttravel)
     score = sum(w_i * r_i^2)
   choose best (lat0, lon0, depth0)
3. 局所最適化: use Levenberg–Marquardt to refine (lat,lon,depth,t0)
4. Magnitude 推定: compute R_i, fit log(A_i) = alpha*M + beta*log(R_i)+const
5. 出力と不確かさ
```

---

## まとめ

- 震源・発生時刻・深さの推定は、到達時刻方程式と走時表を用いるのが標準的なアプローチであり、本アプリでは TravelTimeTableService と観測点の検知時刻（EventedAt）を活用して実装できます。
- マグニチュード推定には振幅の較正が必要で、画像ベースの強度をそのまま使うと誤差が大きくなる恐れがあります。
- 実装は「グリッド探索＋局所最適化」か「非線形最小二乗（同時推定）」が実用的で、初期値設定・重み付け・不確かさ評価が重要です。

---

### 参考ソース（リポジトリ内）

- ShakeDetectionEngine（揺れ検出）: src/KyoshinEewViewer.Core/ShakeDetection/ShakeDetectionEngine.cs
- KyoshinEvent（検出イベントモデル）: src/KyoshinEewViewer.Core/Models/KyoshinEvent.cs
- TravelTimeTableService（走時表）: src/KyoshinEewViewer/Series/KyoshinMonitor/Services/TravelTimeTableService.cs
- JMA/EEW パーサ（震源データ取り込み）: src/KyoshinEewViewer.JmaXmlParser/Data/Earthquake
- KyoshinMonitorWatchService（画像取得 → 検出の呼び出し）: src/KyoshinEewViewer/Series/KyoshinMonitor/Services/KyoshinMonitorWatchService.cs

