# P7b: 地図の移動の調査用ログ(src/app/MapCanvas.jsx のみ)

1. このファイルを上書きして、開発サーバーを再起動(preview の場合は build し直す)
2. アプリを開いているのと同じアドレス(ポート番号も同じ)のタブで、コンソールに次を実行
     localStorage.setItem("debugCameraMoves", "1")
3. 再読み込みすると、コンソールに「[camera] デバッグログ有効」が1行出る(出なければ、このファイルが反映されていない)
4. 気象タブか警報タブを開き、地図が動く場面を再現する。
   [camera] movestart / zoomstart(プログラム)のスタック、または [camera] resize が出る
止めるには:  localStorage.removeItem("debugCameraMoves")
