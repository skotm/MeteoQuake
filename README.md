# MeteoQuake 

地震・津波情報、気象情報を閲覧することができます。

アプリ内のタブごとに、以下の情報を確認することができます。

### **リアルタイム震度**
  <img width="1278" height="590" alt="image" src="https://github.com/user-attachments/assets/6f18089b-818d-495b-9cc3-c3103e849489" />
   防災科研の強震モニタを元にしたリアルタイム震度を表示します。また地震発生直後に、気象庁から発表される緊急地震速報を表示します。 (※ 強震モニタは、揺れの様子を直感的に捉えることを目的としています。配信用サーバーでリアルタイムで観測値を処理しているため、ノイズ等により観測値が変動します。 そのため、本アプリケーションで表示される観測値は、あくまで参考値としてご利用ください。)

### **地震情報**
  <img width="1278" height="590" alt="image" src="https://github.com/user-attachments/assets/c5297fdd-1c50-4b18-bb80-b0be32356a59" />

  <div>P2P地震情報APIから取得した地震情報を表示します。その他、気象庁の震度データベースから取得した地震情報や、地震の推計震度分布を表示することができます。

### **津波情報**
  <img width="1278" height="590" alt="image" src="https://github.com/user-attachments/assets/dfae9d01-cbda-47ea-bb8a-07f27493bce4" />

  <div>地震等に伴い気象庁から発表される 大津波警報, 津波警報, 津波注意報, 津波予報 のデータを表示します。その他、津波を引き起こした地震や観測された津波の最大波(参考値)を確認することができます。
  
### **気象情報**
<img width="1278" height="590" alt="image" src="https://github.com/user-attachments/assets/a72b394a-9a74-494d-9e2f-5ce3b92d347a" />

  気象庁が発表する台風情報や雨雲レーダー、1/3/24時間降水量、天気分布、気温分布を地図で確認することができます。また、気象庁が発表する現在地や登録地点の天気予報や地域時系列予報、3/7日間天気予報を表示します。
  
### **警報等防災情報**
<img width="1278" height="590" alt="image" src="https://github.com/user-attachments/assets/85d13bd7-9e4d-4bc4-bd0d-e8c3cb5324be" />

  気象庁が発表する警報、注意報等の情報を地図上に表示します。また、土砂キキクルや浸水キキクルの過去、現在の状況を確認することができます。

## 利用方法・インストール方法

Webアプリケーションのため、[ウェブサイト](https://skotm.github.io/MeteoQuake/) へアクセスするだけで利用できます。

また、PWAに対応しているため、ネイティブアプリのようにデバイスへインストールすることができます。  
(全ての端末・ブラウザで使用できるとは限りません)

- デスクトップChromeの場合  
  **アドレスバーのインストールボタン または メニュー → 保存と共有 → インストール**

- iOSの場合  
  **共有 → ホーム画面に追加**

- Androidの場合  
  **インストールバナー または メニュー → ホーム画面に追加**

## 利用規約・注意事項について

[利用規約 - Term of use](https://github.com/skotm/MeteoQuake/blob/main/public/terms-of-use.md)

[プライバシーポリシー - privacy policy](https://github.com/skotm/MeteoQuake/blob/main/public/privacy-policy.md)

[注意事項 - notice](https://github.com/skotm/MeteoQuake/blob/main/public/notices.md)

を必ずご確認の上ご利用ください。

## クレジット・謝辞
### 出典
- [海しる 強震動情報レイヤー](https://www.msil.go.jp/msil/htm/main.html)
- [強震モニタ](http://www.kmoni.bosai.go.jp)
- [気象庁 震度データベース](https://www.data.jma.go.jp/svd/eqdb/data/shindo/index.html)
- [P2P地震情報 API](https://www.p2pquake.net/develop/json_api_v2/)
- [Wolfx Open API](https://wolfx.jp/docs/open-api)
#### 日本地図
- [気象庁 予報区等GISデータ](https://www.data.jma.go.jp/developer/gis.html)
#### 世界地図
- [Natural Earth 1:10m Cultural Vectors (Japan POV)](https://www.naturalearthdata.com/downloads/10m-cultural-vectors/)
- [NOAA ETOPO](https://www.ngdc.noaa.gov/mgg/global/)
#### 観測点座標データ
- [kyoshin-monitor-observation-points](https://github.com/ingen084/kyoshin-monitor-observation-points/blob/master/intensity-points.json) ([ingen084](https://github.com/ingen084)氏) — MIT License, Copyright (c) 2025 ingen084。ライセンスの全文は、アプリの「設定 → 利用規約等・注意事項 → ライセンス」と、`public/licenses/MIT-KyoshinMonitorObservationPoints.txt` にあります。
- [jma_int_stations](https://github.com/iku55/jma_int_stations) ([iku55](https://github.com/iku55)氏)

#### ライブラリ
アプリの中で動くソフトウェアとして、以下を使用しています。ライセンスの全文は、アプリの「設定 → 利用規約等・注意事項 → ライセンス」と、`public/licenses/` にあります。
- [React](https://github.com/facebook/react) / React DOM / Scheduler — MIT License, Copyright (c) Meta Platforms, Inc. and affiliates.
- [MapLibre GL JS](https://github.com/maplibre/maplibre-gl-js) 4.7.1(CDNから読み込み) — BSD 3-Clause License, Copyright (c) 2023, MapLibre contributors
- [Turf.js](https://github.com/Turfjs/turf) 6.5.0(CDNから読み込み) — MIT License, Copyright (c) 2019 Morgan Herlocker
- [Workbox](https://github.com/GoogleChrome/workbox) (オフライン対応のService Worker) — MIT License, Copyright 2018 Google LLC

依存ライブラリを追加・更新したら、`npm run licenses` でライセンス表示のチェックができます(`npm run build` の前にも自動で実行されます)。CDNから読み込む MapLibre GL JS・Turf.js のバージョンを上げる時は、`src/app/mapDataLoaders.js` のバージョンと、`public/licenses/` の全文を、そのバージョンの上流の LICENSE に更新してください。

#### フォント
端末ごとの表示の違いをなくすため、以下のフォントをアプリに同梱しています。いずれも [SIL Open Font License 1.1](https://openfontlicense.org) のもとで配布されています。ライセンスの全文は、アプリの「設定 → 利用規約等・注意事項 → ライセンス」と、`public/licenses/` にあります。
- [Noto Sans JP](https://fonts.google.com/noto/specimen/Noto+Sans+JP) (日本語) — Copyright 2014-2021 Adobe (http://www.adobe.com/), with Reserved Font Name 'Source'.
- [Inter](https://github.com/rsms/inter) (数字・英字) — Copyright (c) 2016 The Inter Project Authors
- フォントの配信には [Fontsource](https://fontsource.org/) の `@fontsource-variable/noto-sans-jp`・`@fontsource-variable/inter` を利用しています(フォント自体のライセンスは上記のとおりです)。

#### 震度配色
設定の「表示設定 → 震度配色」で選べる震度の配色のうち、以下は、出典の配色を利用しています。
- **Kiwi Monitor配色**: 「Kiwi Monitor カラースキーム 第3版」(2022年8月17日現在)の配色一覧を利用しています。出典: [Kiwi Monitor](https://kiwimonitor.amebaownd.com/posts/36819100/)
- **srev配色**: [kotoho7](https://github.com/kotoho7)氏の地震ビューア([scratch-realtime-earthquake-viewer-page](https://github.com/kotoho7/scratch-realtime-earthquake-viewer-page))の震度の配色を利用しています。

その他の「MeteoQuake配色」「eqs viewer配色」は、本アプリ独自の配色です。「気象庁配色」は、気象庁の「ホームページにおける気象情報の配色に関する設定指針」に定められた値を使っています。

#### 参考にしたプログラム

- [KyoshinEewViewerIngen](https://github.com/ingen084/KyoshinEewViewerIngen)([ingen084](https://github.com/ingen084)氏)を参考にさせていただきました。MIT License, Copyright (c) 2019 ingen084。ライセンスの全文は、アプリの「設定 → 利用規約等・注意事項 → ライセンス」と、`public/licenses/MIT-KyoshinEewViewerIngen.txt` にあります。
- 本プログラムのUIデザインは、[EQMonitor](https://github.com/YumNumm/EQMonitor)（[YumNumm](https://github.com/YumNumm)氏）のデザインを参考にさせていただきました。EQMonitorは MIT License (Copyright (c) 2022 YumNumm) で公開されており、ライセンスの全文は、アプリの「設定 → 利用規約等・注意事項 → ライセンス」と、`public/licenses/MIT-EQMonitor.txt` にあります。
- 津波タブの機能は
[scratch-realtime-earthquake-viewer-page](https://github.com/kotoho7/scratch-realtime-earthquake-viewer-page)([kotoho7](https://github.com/kotoho7)氏)を参考にさせていただきました。
- 本プログラムのS-netのリアルタイム震度の取得方法については、
  - [umishiru-snet-shindo](https://github.com/t0729/umishiru-snet-shindo) 
([t0729](https://github.com/t0729)氏)
  - [S-net_Viewer](https://github.com/Ichihai1415/S-net_Viewer) ([Ichihai1415](https://github.com/Ichihai1415)氏) を参考にしました。S-net_Viewer は MIT License (Copyright (c) 2022 Ichihai1415) で公開されており、ライセンスの全文は、アプリの「設定 → 利用規約等・注意事項 → ライセンス」と、`public/licenses/MIT-SnetViewer.txt` にあります。
- 本プログラムの地震検知プログラムは
  - [KyoshinEewViewerIngen](https://github.com/ingen084/KyoshinEewViewerIngen)([ingen084](https://github.com/ingen084)氏)を参考にしました。

#### 謝辞

- [t0729](https://github.com/t0729)氏
- [anesewo](https://github.com/anesewo)氏
  - 地震検知プログラムのノウハウ提供

#### 参考にした記事
- [Ichihai1415](https://github.com/Ichihai1415)氏: [震度データベースの地震一覧を取得する](https://qiita.com/Ichihai1415/items/a2af335ad68224b1280f)
- [JQuake](https://jquake.net/)氏 : [多項式補間を使用して強震モニタ画像から数値データを決定する](https://qiita.com/NoneType1/items/a4d2cf932e20b56ca444)
- [soshi1822](https://github.com/soshi1822)氏 : [推計震度分布のGeoJSON化](https://qiita.com/soshi1822/items/59cac82f83b032653206)
- [kotoho7](https://github.com/kotoho7)氏 : [揺れ検知から震央を検出してみる](https://note.com/kotoho7/n/n59e423877b1b)
