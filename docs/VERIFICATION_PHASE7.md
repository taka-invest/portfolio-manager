# Phase 7 総合検証の記録

実施: 2026-11-24 ／ 対象: main `410012d`（本番公開版）＋ブランチ `feature/phase7-verification`（PER/PSR・テーマ検証の追加）
判定: ✅ 合格 ／ 🟡 条件付き・一部未確認 ／ 👤 オーナーの実機確認が必要 ／ ⬜ 未実施

## 実行したテスト（すべて成功）

| 種類 | 件数 | 実行方法 |
|---|---|---|
| 単体テスト（node:test） | 98 | `npm test` |
| Firestoreルール（Emulator） | 12 | `npm run test:rules` |
| API結合（Auth＋Firestore＋Functions Emulator） | 5 | `npm run test:api` |
| ブラウザー（Playwright、PC・スマホ） | 54成功・12スキップ（端末別の意図的なスキップ） | `npx playwright test --workers=1` |
| 本番スモーク（ログインなし・読み取りのみ） | 42/42 | `node scripts/smoke-production.mjs` |
| GitHub Actions | 成功 | PR時に自動実行 |

（ ）内の番号は、テスト名に含まれる語句です。

## 資産管理

| 項目 | 判定 | 根拠 |
|---|---|---|
| 保有株数の一致 | 👤 | 計算は「prices and FX revalue assets without changing stored basis or shares」「multiple brokerage lots aggregate」で保証。実際の株数が証券口座と一致するかは、オーナーの照合が必要（現在の22ロットは参考データのため全件「口座未確認」） |
| 取得原価の一致 | 👤 | 同上。保存・取込の際に原価が変わらないことは「backups validate child records」「legacy migration keeps old data」で確認済み。`MOD`の原価¥0は要確認 |
| 現金残高の一致 | 👤 | 「estimated taxes, eligible offsets, currency balances and post-trade positions reconcile」。実際の残高はオーナーが照合 |
| 円ドル換算 | ✅ | 「prices and FX revalue assets」「keyless FX endpoint provides timestamped quote」「user verified USDJPY … expires after ten minutes」「untimestamped daily ECB reference is still rejected」 |
| 目標配分（NVDA15/AVGO10/PLTR30/APP20/SOFI5/CRDO3/RKLB4/SPCX3・現金10%） | ✅ | `app/data.js`の既定値。「attained allocation: integer shares, cash >= minimum」「cash target shortfall is never passed」。NISA投信の除外は「tsumitate funds and other assets are excluded and NISA stock remains」 |
| 税引後の売却金額 | ✅ | 「funded sell/buy case: tax, reserve, integer lot cap…reconcile」「clearing account name does not block taxation; stock sale produces taxable gains」 |
| 動的ピラミッディング（A/B/C＝累積50/80/100%） | ✅ | 「A/B/C are cumulative 50/80/100% of live shortage, not fixed yen amounts」「existing initial NVDA shares reduce A purchase; B subtracts ACTUAL A orders at current market prices」「market-only repricing changes A budget」 |
| PLTR 30%下限 | ✅ | 「PLTR sell floor blocks additional liquidation; visible shortage is retained」「A day uses recent manual broker FX, still respects PLTR hard 30% sell floor」「PLTR zero sale cap is hard blocker」「fully satisfied target never unnecessarily sells PLTR」 |
| データ不備時に売買を出さない | ✅ | 「missing, stale and failed quote or FX conditions withhold all orders and CSV」「empty or stale data never produces buy/sell recommendations」 |

## 企業分析（修正版のSEC財務計算）

| 項目 | 判定 | 根拠 |
|---|---|---|
| SECの財務情報 | ✅ | PLTR・APP・NVDAの実データ（`tests/fixtures/sec`）で、通期売上と四半期の売上・営業CF・設備投資・FCFが提出値と一致。旧Netlify版とも元データは全件一致（`docs/FINANCIAL_VERIFICATION.md`） |
| Rule of 40 | ✅ | TTM成長率＋TTM FCFマージン（標準）と、旧定義（単四半期の前年比＋営業利益率）を併記。手計算した値と一致 |
| 成長率（前年比・TTM・加速度） | ✅ | 期末日で照合。旧版の「15か月前と比較する」欠陥を修正（PLTR 130.5%→95.9%） |
| EPS | ✅ | 希薄化後EPS。第4四半期は近似値として明示、会計年度末のTTMは通期EPS（正確な値） |
| PER | ✅（本ブランチで追加） | 株価 ÷ TTM希薄化後EPS。赤字や株価未取得のときは算出しない。NVDA 20.9倍・PLTR 111.4倍（2026-11-23終値）。旧版の「時価総額÷営業利益」は一般的なPERではないため置き換え。本番反映済み（2026-11-24、オーナーが本番画面で表示を確認） |
| 営業利益率 | ✅ | 四半期・TTMとも、旧版と値が一致 |
| FCF | ✅ | 営業CF − 設備投資。開示がない場合は欠損（APP） |
| 株価推定（10年後モデル） | 🟡 | 計算はマシャ式のまま、前提と警告を表示。前提（上限40%成長が10年続く、PER水準、税率係数0.75）が妥当かは**オーナーの判断事項** |
| スクリーナー | ✅ | 旧ルールを修正版データに適用。Emulatorで実データ5銘柄を確認。本番の認証ゲートは確認済み |
| チャート | ✅ | 調整後の終値。Emulatorで実データ（NVDA 5年週足262点）を確認 |
| 市場分析（VIX/VXN/F&G） | ✅ | 自前API経由。Emulatorで実データを確認。API未公開時の予備経路と、保有銘柄を中継サービスに送らないことをテストで確認 |
| 売買判断への使用 | 🟡 | すべての分析画面に「検証中の参考値」と表示中。10年後モデルの前提をオーナーが承認するまでは、この表示を外さない |

## データ保存

| 項目 | 判定 | 根拠 |
|---|---|---|
| Googleログイン | ✅ | 本番でオーナーがログインし、個別企業分析（NVDA）を確認（2026-11-24） |
| ログアウト | 👤 | 本番での手動確認が必要（設定・データ管理 → ログアウト → 分析画面で「ログインが必要」と表示されること） |
| 別PCでの復元 | ✅ | シークレットウィンドウ（別PC相当）で、クラウドから22ロットを復元（2026-11-23） |
| JSONバックアップ | ✅ | 「fresh start, market updates, verified lots, exports…」。クラウド保存の前に自動でJSONをダウンロード |
| 既存データの移行 | ✅ | 旧版のJSONを取り込み → クラウドに保存 → 本番で復元 |
| 同時更新時の競合検知 | ✅ | ルールテスト「transactional overwrite with backup snapshot succeeds; concurrent writer is detected」「revision must increase by exactly one」 |
| 未認証アクセスの拒否 | ✅ | ルールテスト、API結合テスト、本番スモーク（全APIで401） |
| 他のUIDからのアクセス拒否 | ✅ | 「an allowed user cannot read or write another allowed user data」「Google user NOT on the allowlist → 403 on every API」 |

## 画面

| 項目 | 判定 | 根拠 |
|---|---|---|
| PC／スマホ | ✅ | Playwrightの2プロジェクト（PC 1440×960、iPhone 13）。横スクロールが出ないことを確認 |
| ダーク／ライト | ✅ | 「every route reloads cleanly … in both themes」、ライトモードの見出しのコントラスト4.5:1以上 |
| 画面遷移・再読み込み | ✅ | 全11ルートで、直接リンクと再読み込みのあともテーマを保持したまま表示 |
| 更新失敗時の表示 | ✅ | 未ログイン／許可なし／API未公開／SEC連絡先の未設定／上流の失敗を区別して表示 |

## Phase 7で見つけて直したこと
- PERとPSRがなかった → 定義を明示して追加
- 新しい画面にテーマとコントラストの自動テストがなかった → 追加
- 本番の確認を毎回同じ手順で行えるよう、スモークテストのスクリプトを追加

## 残っている確認（オーナー）
1. 本番での**ログアウト**動作
2. 22ロットの**株数・原価・現金を証券口座と照合**し、「実保有・現金を確認」→ クラウドに保存
3. **予算アラート**の設定確認
4. **10年後株価モデルの前提**を承認するか、見直すか
