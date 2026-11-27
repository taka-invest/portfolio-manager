# 競合サービスの機能・データ調査

確認日：2026-11-27（すべてのURL）／調査方法：公式サイト・ヘルプ・料金ページを優先。取得できなかった本文は「未確認」とした

ラベル：**[確認済み]** 公式ページで確認／**[公式ブログ等]** 公式の二次的な記事・検索スニペット／**[第三者]** 公式以外／**[未確認]**／**[提案]** 調査者の提案

価格は確認日の表示額。変更されることがある。

---

## 1. 予想・バリュエーション：TIKR／Koyfin（最も参考にする）

| 項目 | TIKR | Koyfin |
|---|---|---|
| 予想の年数 | Free 1年／Plus 2年／Pro 4年／Ultimate 5年 [確認済み] https://www.tikr.com/pricing | 2032年まで、年次・四半期の切替 [確認済み] https://koyfin.com/help/actuals-consensus |
| 予想の中身 | Revenue・EBITDA・FCF・EPS等 100以上の指標 [確認済み] https://www.tikr.com/fundamental-analysis | 平均・中央値・High/Low・予想数の表示切替、会計年度／暦年の切替 [確認済み] |
| GAAPと調整後 | 正規化（Non-GAAP）とGAAP EPSの両方 [公式ブログ等] | 予想は調整後が基本、GAAP項目は明示 [確認済み] |
| 予想の修正履歴 | 予想の推移・Beats & Misses [公式ブログ等] | Estimates Trends（年次・四半期の推移をチャートと表で） [公式ブログ等] |
| フォワード倍率 | NTM＝FY1とFY2を残り期間で加重 [公式ブログ等] https://www.tikr.com/blog/ntm-next-twelve-months-explained-how-forward-looking-metrics-help-you-value-stocks | NTM P/E 等、過去のフォワードP/Eを描画 [公式ブログ等] |
| 過去レンジ | P/E・EV/EBITDA・P/FCFの長期チャート [公式ブログ等] | 自社の10年・20年や同業と比べたパーセンタイル順位を列に置ける [確認済み] https://koyfin.com/help/percentile-rank-snapshot-feature |
| スクリーナー | 保存数 Free 1〜無制限、予想EPS成長等で抽出 [確認済み／公式ブログ等] | 条件にした指標がそのまま結果の列になる、My Screens [確認済み] |
| データ元 | S&P Capital IQ [確認済み] | S&P Capital IQ [確認済み] https://koyfin.com/help/faq/where-do-you-get-your-data |
| 料金（月） | Free／Plus $24.95／Pro $54.95／Ultimate $119.95 [確認済み] | Free／Plus $39／Premium $79／Advisor $209〜 [確認済み] https://www.koyfin.com/pricing/ |
| API・再利用 | 公開API 未確認、規約本文 未確認 | 財務・予想は「ベンダーの制約によりダウンロード不可」 [確認済み] https://www.koyfin.com/help/faq/can-i-download-data |

**示唆**
- 複数年先の予想と修正履歴は、両社とも**有料のライセンスデータ**（S&P Capital IQ）に依存している。スクレイピングして自分のアプリに溜めるのは不可。
- 参考にするのは**見せ方**に限る。
  - 実績と予想を1本の時系列にする
  - 予想の列は色で分ける
  - アナリスト数と予想の幅を併記する
  - 現在の倍率を、過去レンジとパーセンタイルの中に置く
  - NTMの算式を示す

## 2. スクリーナー：FINVIZ／TradingView

| 項目 | FINVIZ | TradingView |
|---|---|---|
| 条件 | Descriptive／Fundamental／Technical。Forward P/E、PEG、P/FCF、ROIC、RSI(14)、Gap、52W High/Low、ATR、Relative Volume、パターン [確認済み] https://finviz.com/help/screener.ashx | 銘柄情報・テクニカル・財務・バリュエーション・成長・マージン等、列セットの期間変更 [確認済み] https://www.tradingview.com/support/solutions/43000718866/ |
| 定義の例 | Relative Volume＝3か月平均出来高に対する比（時間帯補正）、Gap＝前日終値→当日始値の% [確認済み] | — |
| 保存 | プリセット保存（Free 50・Elite 無制限） [確認済み] | 画面の保存・プリセット [確認済み] |
| 結果の見せ方 | Overview／Valuation／Technical／Charts 等の表示切替、ヒートマップ [確認済み／第三者] | 表とチャート一覧の切替 [確認済み] |
| 独自指標での抽出 | — | Pine Screener：1つの指標を最大4,000銘柄に適用。直近500本・有料 [確認済み] https://www.tradingview.com/support/solutions/43000742436/ |
| 料金 | Elite $39.50/月・$299.50/年 [確認済み] https://finviz.com/elite.ashx | Essential $12.95〜Ultimate $199.95/月（年払い表示） [確認済み] https://www.tradingview.com/pricing/ |
| API・規約 | 公式API（Elite、10件/5秒） [確認済み] https://finviz.com/api-and-exports ／規約本文 未確認 | データは表示専用。スクレイパー・非公開エンドポイントの使用を禁止 [確認済み] https://www.tradingview.com/policies/ |

**示唆**
- 「条件の3分類」「プリセット保存」「表示列セットの切替」「条件にした指標が列に出る」は、個人アプリでも安く作れる。
- データの取得は自前（SEC・正規のAPI）で行い、両社から取ってくることはしない。

## 3. バックテストの見せ方：Portfolio Visualizer／TradingView Strategy Tester／TrendSpider

| 項目 | 内容 | 出典 |
|---|---|---|
| PV Backtest Portfolio の出力 | CAGR・標準偏差・最良/最悪年・最大DD・Sharpe・Sortino・VaR/CVaR・上下キャプチャ・β/α。成長曲線（対数・インフレ調整）、年次/月次リターン、下落ワースト10、1〜10年のローリングリターン、相関 [確認済み] | https://www.portfoliovisualizer.com/backtest-portfolio |
| PV リバランス | なし／年・半年・四半期・月／乖離幅バンド [確認済み] | 同上 |
| PV の注記 | 結果は手数料・税を含まない。最も新しい資産で開始日が切られる [確認済み] | 同上・FAQ |
| PV タクティカル | 移動平均・デュアルモメンタム・目標ボラ等。来月のシグナルを出す [確認済み／第三者] | https://www.portfoliovisualizer.com/tactical-asset-allocation-model |
| PV 料金 | Free（15資産・履歴制限）／Basic $30／Pro $55（月、年払い） [確認済み] | https://www.portfoliovisualizer.com/pricing |
| TV Strategy Tester | 損益曲線、最大DD、勝率、プロフィットファクター、Buy&Hold比較、取引ごとの含み益・含み損、リターン分布、Sharpe・Sortino。手数料・スリッページの設定 [確認済み] | https://www.tradingview.com/support/solutions/43000764138/ |
| TrendSpider | 基本16指標＋上級8指標（Expectancy、Exposure、Buy&HoldのMax DD等）。売買矢印をチャートに表示、CSV出力、複数戦略の比較 [確認済み] | https://trendspider.com/learning-center/basic-backtesting-metrics/ |

**示唆**
- 結果の型を1つに決めて、どの検証でも同じ表と図で見せるのがよい。
  - 要約の数字
  - 損益曲線とBuy&Holdの比較
  - 水面下チャート（ドローダウン）
  - 年次リターン
  - ローリングリターン
  - 取引一覧
- 「手数料・税・スリッページを含むか」「開始日を何が決めたか」を必ず表示する。

## 4. 検証の作法：QuantConnect（考え方だけ参考）

- LEANはオープンソース（Apache-2.0）。手数料・スリッページ・約定・配当などを銘柄ごとに現実に近づけて設定できる（Reality modeling）。既定のスリッページは0 [確認済み] https://www.quantconnect.com/docs/v2/writing-algorithms/reality-modeling/key-concepts
- ウォークフォワード最適化は組み込みではなく、アルゴリズム内で定期的に再学習する形で自作する [確認済み] https://www.quantconnect.com/docs/v2/writing-algorithms/optimization/walk-forward-optimization
- 米国株データ（AlgoSeek）は上場廃止銘柄を含み、生存バイアスなしと明記。データは原則QuantConnect上でのみ利用でき、エクスポートは禁止 [確認済み] https://www.quantconnect.com/terms/
- 参考文献：López de Prado『Advances in Financial Machine Learning』(2018)。Triple Barrier・Meta-labeling・Purged k-fold／Embargo [第三者（目次）]。確率較正は scikit-learn のドキュメント [確認済み] https://scikit-learn.org/stable/modules/calibration.html

**示唆**：既定値を楽観的にしない（手数料・スリッページ0を既定にしない）。パラメーターは2〜3個に絞る。確率を出すなら較正曲線とBrierスコアも出す。

## 5. データ取得元の実現性（このアプリにとって最重要）

「無料でダウンロードできる」と「研究・保存・再配布が許されている」は別の問題として扱う。

| データ | 取得元 | 無料 | 個人利用 | 履歴 | 注意 | 出典 |
|---|---|---|---|---|---|---|
| VIX 日次 | FRED `VIXCLS` | ○ | ○（出典明記） | 1990-01-02〜 | 終値のみ | https://fred.stlouisfed.org/series/VIXCLS |
| VIX・VIX3M・VIX9D・VVIX 日次OHLC | Cboe CSV | ○ | 閲覧は可。電子的な保存は事前同意が必要と読める文言 | VIX 1990〜、VIX3M 2009-09-18〜 | 自動取得・蓄積は規約上グレー | https://www.cboe.com/us/indices/dashboard/VIX/ ほか |
| VIX先物の清算値 | Cboe 限月別CSV | ○ | 同上 | 2013〜（掲載ページの記載） | 連続系列は自作 | Cboe 先物の過去データページ |
| NASDAQ-100・NASDAQ総合 日次 | FRED `NASDAQ100`／`NASDAQCOM` | ○ | 非商用・個人利用に限り可（Pre-Approval系列） | 1986〜／1971〜 | 終値のみ。公開・再配布は不可 | https://fred.stlouisfed.org/legal/ |
| S&P 500 日次 | FRED `SP500` | ○ | 同上 | **直近10年のみ** | 長期の検証には不足 | 同上 |
| ハイイールド・スプレッド | FRED `BAMLH0A0HYM2`（ICE） | ○ | 内部利用のみ | **直近3年のみ**（2026年4月から） | 長期の検証には使えない | 同上 |
| 株価（現在使っている取得元） | Yahoo 非公式 chart | — | **規約で自動収集を禁止**（2(d)(e)） | — | 本番で利用中。リスクとして要対応 | https://legal.yahoo.com/us/en/yahoo/terms/otos/index.html |
| 次回決算・EPSサプライズ | Finnhub 無料 | ○ | Personal Use | 決算カレンダー 1か月＋、サプライズ4四半期 | 現在利用中。EPS・売上予想エンドポイント、日足は無料対象外 | https://finnhub.io/pricing |
| 5年先までの予想 | Finnhub Estimate-2 | $200/月・市場（年払い） | Personal Use | 過去20年以上 | 費用対効果の検討が必要 | Finnhub 予想データの料金ページ |
| アナリスト予想 | FMP `/stable/analyst-estimates` | Basic $0〜Ultimate $139/月 | 個人 | 年数は未確認 | 「Full」はUltimateのみ | https://site.financialmodelingprep.com/pricing-plans |
| 上場廃止銘柄を含む米国株 | Norgate Platinum | $630/年 | 個人ライセンスの条件 未確認 | 1990〜、指数の過去構成銘柄あり | 騰落数等（Extras）は Gold $360/年〜 | https://norgatedata.com/prices.php |
| 同上 | Sharadar（個人） | Bundle $69/月・$499/年 | 個人 | 1998〜 | 上場廃止銘柄を含むかはページ上で未確認 | sharadar.com |
| 市場の騰落数・上昇/下落出来高 | — | 無料で信頼できる長期履歴は見つからず | — | — | 有償（Norgate Extras等） | — |
| SEC EDGAR | SEC | ○ | ○ | — | 毎秒10件まで、連絡先付きUser-Agent必須（現在は毎秒2件で運用） | https://www.sec.gov/search-filings/edgar-search-assistance/accessing-edgar-data |

> **訂正（2026-11-27）**：FRED の website 規約 (p) は、書面の同意なく FRED のコンテンツを保存・キャッシュ・アーカイブすることを禁止しており、個人利用の例外の記載がない。下の表の「個人利用 ○」は**ダウンロードと利用**の許諾であり、**手元への保存**までは保証しない。対応は `DATA_SOURCE_MIGRATION.md` §4。

**最重要の示唆**
1. **買い場研究の最初の段階は、FREDだけで完結できる**。使う系列は VIXCLS（1990〜）、NASDAQ100（1986〜）、NASDAQCOM（1971〜）。どれも終値のみなので、約定は「翌営業日の終値」で近似する。
2. VIXの期間構造（VIX3M）は2009年以降しかない。期間構造を使う分析は、件数がさらに少なくなる。
3. **本番の株価・VIXはYahooの非公式エンドポイントに依存しており、規約上のリスクがある**。代替の取得元を決める必要がある（`FEATURE_PRIORITIZATION.md` P0-4）。
4. 公開リポジトリにFRED（Pre-Approval系列）・Cboe・ICEの生データを入れると、再配布にあたる。生データは非公開の場所（手元のPC、Firestoreの本人専用領域）に置き、リポジトリには計算方法だけを入れる。
