# Firebase移行 進捗記録（MIGRATION_PROGRESS）

次のセッションはまずこのファイルと`docs/MIGRATION_AUDIT.md`を読むこと。

- Firebaseプロジェクト: Finance Base `finance-base-edcc7`（Sparkプラン、2026-11-23時点）
- 作業ブランチ: `feature/firebase-foundation-phase1`（PR #16）
- 旧サイト（移行完了まで維持）: GitHub Pages `portfolio_manager.html`／Netlify `masya-stock-analyzer`
- Stock Analyzer最新ソース: `C:\Users\defaultuser0\Documents\masya_app\`（git管理外。読み取り専用で参照）

## フェーズ状況

| Phase | 内容 | 状態 |
|---|---|---|
| 0 | 監査 | ✅ 完了（2026-11-23）`docs/MIGRATION_AUDIT.md` |
| 1 | Firebase初期構築・認証・Firestore・同期 | 🟢 保存・別ブラウザー復元を実機確認。Hostingプレビュー未実施 |
| 2 | Functions移行（analyze/screener/chart） | ⬜ 最新版への差し替えと財務ロジック修正が必要 |
| 3 | 画面統合 | ⬜ |
| 4 | 既存機能保護（リバランス・ピラミッディング） | 🟡 既存テストで保護中。弾(A/B/C)の同期が未対応 |
| 5 | セキュリティ・費用 | 🟡 maxInstances=1等は設定済。Blaze・予算アラートは承認待ち |
| 6 | CI/CD | 🟡 プレビュー/本番ワークフローと承認ゲート作成済。デプロイ用SA（本人操作）待ち |
| 7 | 総合検証 | ⬜ |
| 8 | 本番切替 | 🟡 Portfolio Managerのみ本番公開（2026-11-23）。Stock Analyzer未移行・旧サイトは維持 |

## 2026-11-23 セッション1 の実施内容

1. リポジトリをクローンし、PR #16を監査（`docs/MIGRATION_AUDIT.md`）。
2. **Firestoreルールを許可UID方式に変更**: `/allowlist/{uid}`（`enabled: true`）に登録されたGoogleアカウントだけが、自分の`users/{uid}/...`を読み書きできる。allowlist自体はクライアントから書込・一覧不可。
3. 上書き前のクラウド側バックアップ`users/{uid}/backups/{id}`（追記専用・削除不可）を追加。
4. **ルールのEmulatorテスト12件**（`tests/emulator/firestore-rules.test.mjs`、`npm run test:rules`）。demo-プロジェクトなので実Firebaseに触れない。
5. 同期クライアント（`app/firebase-cloud.mjs`）を8手順に補強: 自動JSONバックアップ、保存状態の検査、サーバー再読込、差分表示、明示的な採用選択、サーバー側バックアップ、リビジョン照合トランザクション、保存後の一致照合。ログイン時にUIDと許可状態を表示。
6. Functions: 許可UID判定（Firestore allowlist、60秒キャッシュ）、`verifyIdToken(…, checkRevoked=true)`、個人データを含まない構造化ログ（API名・ステータス・処理時間・エラー分類）を追加（`functions/src/auth.js`）。chartはSEC連絡先未設定でも停止しないよう分離。
7. CIにJava 21＋Firestoreルールテストを追加。

## テスト結果（2026-11-23、ローカル Windows）

| テスト | 結果 |
|---|---|
| `npm test`（node:test） | 60/60 成功 |
| `npm run test:rules`（Firestore Emulator） | 12/12 成功 |
| `npx playwright test --workers=1` | 26成功・12スキップ（端末別）・0失敗 |

注: Windowsローカルでは並列実行時に`python3 -m http.server`が接続拒否を起こすことがある（CI=Linuxでは発生しない）。EmulatorはWindowsで`JAVA_TOOL_OPTIONS=-Djdk.net.unixdomain.tmpdir=C:/Users/<user>/.uds`が必要な場合がある。

## Firebase実環境の状態（2026-11-23 確認、CLIは個人アカウント maruyasu.jomu@gmail.com）

- Firebase CLI: このディレクトリは`firebase login:use maruyasu.jomu@gmail.com`で個人アカウントに固定（会社アカウントは別プロジェクト用）
- Webアプリ: 「Finance Base Web」`1:472264087274:web:af5ac46e3e19c34f466993` 登録済み → `app/firebase-config.js`に実値を反映
- Hosting: サイト`finance-base-edcc7`（https://finance-base-edcc7.web.app）存在。未デプロイ
- Firestore: ✅ 2026-11-23 ユーザー承認のうえ作成。`(default)`／Native／Standard／**asia-northeast1**。`firestore.rules`をデプロイ済み
  - 実機確認: 未認証の読み取り（users/allowlist/任意パス）と未認証のallowlist書き込みはすべてHTTP 403
  - 削除保護: ✅ 有効（2026-11-23 ユーザー承認）
- Authentication: ✅ Googleプロバイダー有効（ユーザーがConsoleで設定）
- 許可UID: ✅ 本人（Googleログイン、2026-11-23）を`allowlist`に登録。登録・無効化は`node scripts/allowlist-uid.mjs <uid> [--disable]`（CLIログイン必須、Auth上のGoogleユーザーであることを検証してから書込）
- gcloud: 個人アカウント未ログイン（予算アラート設定時に必要）
- ローカル確認: SDKが実プロジェクトに接続し「未ログイン」表示、コンソールエラーなし

## 実機検証（本番Firestore、localhost:4173、2026-11-23）

| 項目 | 結果 |
|---|---|
| 許可UID前のログイン | 「まだ許可されていません」と表示、保存ボタン無効 ✅ |
| 未認証REST（読取・allowlist書込） | すべて403 ✅ |
| 初回保存（Chrome通常、22ロット） | 自動JSONバックアップ→保存→再読込照合一致、リビジョン1（11:27:01 JST） ✅ サーバー側でも確認 |
| 別ブラウザー復元（Chromeシークレット＝別PC相当、0件から） | 差分「保有ロット 0 → 22 件」表示→承認で22件復元 ✅ |
| 同時更新の競合検知 | Emulatorテストで検証済。本番では余計なリビジョンを作らないため未実施 |

気付いた点:
- 取込後も同期欄の表示が「差分確認ダイアログを開きました」のまま（承認後の文言更新が必要）
- 自動バックアップのファイル名が旧名`portfolio-manager-v2.3.json`（日付入りに変更予定）
- 取込データは参考データのため全22ロットが「口座未確認」、現金0。`MOD`は原価¥0（要確認）

## CI/CD（2026-11-23 セッション1後半）

- プレビューチャネル`preview`へCLIから手動デプロイ: https://finance-base-edcc7--preview-es1ecisz.web.app （30日失効）。ソース類（rules/package.json）は404、本番URLは未公開(404)のまま。チャネルドメインはAuthの承認済みドメインに自動登録されていた（`scripts/auth-domains.mjs`で確認）
- `verify.yml`に`preview`ジョブ（テスト成功後・同一リポジトリのみ・固定チャネル）
- `firebase-production.yml`: 手動実行＋`DEPLOY`入力＋`main`限定＋GitHub環境`production`（必須レビュアー taka-invest、`main`ブランチのみ）
- 手順・ロールバック: `docs/DEPLOYMENT.md`
- デプロイ用サービスアカウント作成はClaude Codeの安全設定でブロック → 本人が`firebase init hosting:github`で作成する
- 同期UX修正: クラウド取込承認後の表示、バックアップファイル名を`portfolio-manager-backup-YYYYMMDDHHmm.json`に

## 本番公開（Portfolio Managerのみ）2026-11-23 12:00頃 JST

- ユーザーの明示的承認（「本番公開してよい」）を受けてCLIから`firebase deploy --only hosting`
- デプロイ元: `feature/firebase-foundation-phase1` @ `9cb5954`（PR #16は未マージ。マージ後は本番ワークフロー経由に移行）
- 事前テスト: 単体62／ルール12／Playwright 26成功・12スキップ
- 本番 https://finance-base-edcc7.web.app : アプリ・app/*・research/library.html は200、firestore.rules / firebase.json / package.json / functions / tests / .github / docs / .firebaserc は404。X-Frame-Options DENY・nosniff・HTMLはno-store
- 画面: SDKが接続し「未ログイン」表示。コンソールエラーは既存の第三者CORSプロキシ（allorigins等、Fear&Greed取得）由来のみ → Phase 2で自前Functionsに置換
- **本番実機確認（ユーザー、11:53 JST）**: 本番URLでGoogleログイン→許可UIDでFirestore読込→差分「0 → 22件」→承認→保有資産に22件表示 ✅
- ロールバック: Console → Hosting → リリース履歴、または`docs/DEPLOYMENT.md`
- GitHub Pages / Netlify は維持（停止は最終工程で別途承認）

## ユーザー対応待ち（ブロッカー）

1. ~~CLI再認証~~ ✅ ／ ~~Webアプリ構成値~~ ✅
2. ~~Firestore作成~~ ✅ ／ ~~Google認証~~ ✅
2b. `firebase init hosting:github`（デプロイ用SA＋GitHub Secret）は**保留**。GitHub認可で会社アカウント(maruyasushonan)が選ばれやすいため、承認URLは最初からtaka-investでログインしたシークレットウィンドウで開くこと。1回目は反映遅れで失敗し、未使用SA `github-action-1261182527@` が残存（鍵なし、後で削除）
3. ~~本人UIDの登録~~ ✅（画面表示のUIDは l/I の判別が難しいため、`firebase auth:export`で正確な値を確認してから登録した）
4. **SEC_USER_AGENT**: 実際の運用連絡先（例:「FinanceBase 氏名 連絡先メール」）の指定。
5. **Blazeプランへの変更**（Cloud Functionsのデプロイに必須）と予算アラート額の承認。

## 未解決事項

- 段階買付の現在の弾（`pm-staged-funding-stage`）が主ステート外 → 別PCで不一致になる。
- `validate()`が未知キーを捨てる → スキーマ拡張時にバージョンを上げる運用が必要。
- CRDOは通常リバランスでは`wait=true`だが段階買付では購入対象（仕様どおりか要確認）。
- Yahoo v7/v10はcrumb必須。代替データ源の比較が必要（Phase 2）。
- `eps-revisions.js`（Finvizスクレイピング）の移植可否（利用条件）。

## 次の作業

0. （本人）本番URLで証券口座と照合しロット・現金・MOD原価を修正 →「実保有・現金を確認」→ クラウド保存（リビジョン2、リビジョン1は自動でクラウドバックアップ）

1. （再認証後）Firebase側の現状確認 → Webアプリ構成値の反映 → `.firebaserc`。
2. Hostingプレビューチャネル用のGitHub Actions（PR時、手動承認なしで本番に出ない構成）。
3. Phase 2: `masya_app`最新版の`analyze.js`/`screener.js`/`eps-revisions.js`/`sec-8k-guidance.js`を取込 → Q4合成・年次重複除去・FCF・欠損の扱いを修正し、SEC公式値のフィクスチャテストを作成。
