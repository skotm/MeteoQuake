# MeteoQuake-KyoshinViewer
地震・津波情報を閲覧することができます。
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

## 利用規約・注意事項について

[利用規約 - Term of use](https://github.com/skotm/MeteoQuake-KyoshinViewer/blob/main/public/terms-of-use.md)

[プライバシーポリシー - privacy policy](https://github.com/skotm/MeteoQuake-KyoshinViewer/blob/main/public/privacy-policy.md)

[注意事項 - notice](https://github.com/skotm/MeteoQuake-KyoshinViewer/blob/main/public/notices.md)

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
- [jma_int_stations](https://github.com/iku55/jma_int_stations) ([iku55](https://github.com/iku55)氏)


#### 参考にしたプログラム

- 本プログラムのUIデザインは、[EQMonitor](https://github.com/YumNumm/EQMonitor)（[YumNumm](https://github.com/YumNumm)氏）のデザインを参考にさせていただきました。
- 津波タブの機能は
[scratch-realtime-earthquake-viewer-page](https://github.com/kotoho7/scratch-realtime-earthquake-viewer-page)([kotoho7](https://github.com/kotoho7)氏)を参考にさせていただきました。
- 本プログラムのS-netのリアルタイム震度の取得方法については、
  - [umishiru-snet-shindo](https://github.com/t0729/umishiru-snet-shindo) 
([t0729](https://github.com/t0729)氏)
  - [S-net_Viewer](https://github.com/Ichihai1415/S-net_Viewer) ([Ichihai1415](https://github.com/Ichihai1415)氏) を参考にしました。
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

