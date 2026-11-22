# V2.3 検証結果

Chromium 156.0.8078.79 と Playwright 1.65.1 で確認しました。

| 実行 | 結果 |
|---|---|
| `npm test` | 13 件成功 |
| `PM_CHROMIUM=/usr/bin/chromium npm run test:browser` | PC 4 件、スマホ 4 件、計 8 件成功 |
| `git diff --check` | 問題なし |

計算テストではサンプルの排除、旧履歴の移行、複数口座の集計、積立 NISA 投信の除外、保有数量・円取得原価の不変性、為替による再評価、株価・為替の失敗と期限切れ、休場日・短縮取引日、PLTR の売却上限、サテライト待機、SPCX の発行体確認と監視、税・損益通算・現金・配分の整合性、現金上限、CSV、API 制限を確認しました。

ブラウザーでは架空の口座・保有・価格応答で、初回表示、ロット登録、現金の保存と確認、価格更新、CSV のダウンロード、通信失敗時の計算保留、旧データの差分承認・キャンセル、バックアップ復元、JSONBin の同意制御、破損データの保全、企業評価の保存・再表示を確認しました。どちらのビューポートもページ全体に横はみ出しがないことを検証しました。幅のある明細と売買表は表の領域内で横スクロールできます。

| 表示 | ビューポート | スクリーンショット |
|---|---|---|
| PC | 1440 × 960 CSS px | [PC の資産サマリー](desktop.webp) |
| スマホ | 390 × 664 CSS px、iPhone 13 の寸法を Chromium でエミュレート | [スマホの資産サマリー](mobile.webp) |

ECB 指定の Frankfurter API から USD/JPY と基準日を取得しました。Nasdaq の公開情報では `SPCX` の発行体、上場市場、価格情報を確認しました。利用者の Finnhub の契約・権限で取得できる価格と、実際の JSONBin・旧ローカルファイルは未検証です。スマホの確認はエミュレーションです。 [Frankfurter API](https://api.frankfurter.dev/v2/providers/ecb/rate/usd/jpy) [Nasdaq SPCX](https://www.nasdaq.com/market-activity/stocks/spcx)
