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
| 1 | Firebase初期構築・認証・Firestore・同期 | 🟡 Web構成値反映済。Firestore未作成（承認待ち） |
| 2 | Functions移行（analyze/screener/chart） | ⬜ 最新版への差し替えと財務ロジック修正が必要 |
| 3 | 画面統合 | ⬜ |
| 4 | 既存機能保護（リバランス・ピラミッディング） | 🟡 既存テストで保護中。弾(A/B/C)の同期が未対応 |
| 5 | セキュリティ・費用 | 🟡 maxInstances=1等は設定済。Blaze・予算アラートは承認待ち |
| 6 | CI/CD | 🟡 ルールテストをCIに追加。プレビュー・本番ワークフロー未作成 |
| 7 | 総合検証 | ⬜ |
| 8 | 本番切替 | ⬜ |

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
- Firestore: **未作成**（Cloud Firestore API未有効）
- Authentication: Googleプロバイダーの有効化は未確認
- gcloud: 個人アカウント未ログイン（予算アラート設定時に必要）
- ローカル確認: SDKが実プロジェクトに接続し「未ログイン」表示、コンソールエラーなし

## ユーザー対応待ち（ブロッカー）

1. ~~CLI再認証~~ ✅ ／ ~~Webアプリ構成値~~ ✅
2. **Firestore作成の承認**（`asia-northeast1`、作成後はリージョン変更不可）とAuthenticationでGoogleプロバイダー有効化。
3. **本人UIDの登録**: Googleログイン後、設定画面に表示されるUIDを、Firebase Console → Firestore → `allowlist`コレクション → ドキュメントID=UID、フィールド`enabled`（boolean）=`true`で作成。
4. **SEC_USER_AGENT**: 実際の運用連絡先（例:「FinanceBase 氏名 連絡先メール」）の指定。
5. **Blazeプランへの変更**（Cloud Functionsのデプロイに必須）と予算アラート額の承認。

## 未解決事項

- 段階買付の現在の弾（`pm-staged-funding-stage`）が主ステート外 → 別PCで不一致になる。
- `validate()`が未知キーを捨てる → スキーマ拡張時にバージョンを上げる運用が必要。
- CRDOは通常リバランスでは`wait=true`だが段階買付では購入対象（仕様どおりか要確認）。
- Yahoo v7/v10はcrumb必須。代替データ源の比較が必要（Phase 2）。
- `eps-revisions.js`（Finvizスクレイピング）の移植可否（利用条件）。

## 次の作業

1. （再認証後）Firebase側の現状確認 → Webアプリ構成値の反映 → `.firebaserc`。
2. Hostingプレビューチャネル用のGitHub Actions（PR時、手動承認なしで本番に出ない構成）。
3. Phase 2: `masya_app`最新版の`analyze.js`/`screener.js`/`eps-revisions.js`/`sec-8k-guidance.js`を取込 → Q4合成・年次重複除去・FCF・欠損の扱いを修正し、SEC公式値のフィクスチャテストを作成。
