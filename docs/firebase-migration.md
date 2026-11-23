# Firebaseへの一本化：Phase 1 設定と安全なデータ移行

作成: 2026-11-23

## 現在の状態

このブランチは**Firebaseへ切り替えるためのコード準備**であり、まだFirebaseプロジェクトを作成・課金・デプロイしていません。GitHub Pages/Netlifyの旧サイトは引き続き稼働させます。

### 構成

- GitHub: ソースコード／PR／コードレビュー／GitHub Actions自動テスト
- Firebase Hosting: Portfolio Managerと投資リサーチの静的ファイル配信
- Firebase Authentication: Googleログイン
- Cloud Firestore: \`users/{uid}/workspaces/portfolio\` にPortfolio Managerのバージョン3 JSONを保存
- Cloud Functions v2 (Phase 2): Stock AnalyzerのSEC財務分析・スクリーナー・チャートAPIの移行（**ソース移植と認証ゲートは本PRで用意済み、未デプロイ**）
- Cloud Logging (Phase 2): APIエラー・実行時間などの運用ログ（**金融資産やAPIキーはログに書かない**）

このPhase 1のFirestore同期は**オプトインの手動バックアップ／手動復元**。初回起動、ブラウザー間の移動、別タブの復元でデータが自動上書きされることはありません。

## Firebase Consoleでの手動準備

1. https://console.firebase.google.com/ で**金融アプリ専用の新規Firebaseプロジェクト**を作成。既存のBodyCompやTripCraftとは分離する。
2. アプリ用のWeb登録を行い、Firebase Consoleの「プロジェクト設定 → マイアプリ」にある**Web設定**を取得。ブラウザー用の \`apiKey\` はSDK識別子であり**サーバー秘密鍵ではない**が、サービスアカウントJSONや第三者APIキーは絶対に公開しない。
3. Authentication → Sign-in method → **Google** を有効にする。HostingのURL／後に利用する独自ドメインが必要に応じて承認済みドメインに入っていることを確認。
4. Firestore Databaseを**東京 \`asia-northeast1\`**に作成し、初期状態は拒否ルールとする。テストモードの公開ルールをそのまま運用しない。
5. Google Cloud Billingの予算アラートとCloud Functionsの最大インスタンス数などの支出管理を設定。**予算アラートは課金を強制停止する仕組みではない。**
6. Cloud Functionsをデプロイする段階で**Blaze従量課金プラン**が必要。Phase 1のHosting/FirestoreとPhase 2のAPIを同日に切り替える必要はない。

## 開発環境での手順

\`\`\`sh
npm ci
npm test
npm run test:browser
npm run build:firebase
# 以下は本人の Firebase プロジェクト作成・ログイン・設定後のみ
npm install -g firebase-tools
firebase login
firebase use --add
# ファイル app/firebase-config.js 内の PMFirebaseWebConfig = null を
# Firebase Webアプリからコピーした構成値で置換
npm run build:firebase
firebase deploy --only hosting,firestore:rules
\`\`\`

- \`firebase.json\` が静的配信を \`dist/firebase\` に限定。GitHubの全ファイルを公開しない。
- \`app/firebase-config.js\` は初期値\`null\`なので、**未設定ではGoogleログイン・クラウド同期が使用不可**。従来のJSON保存とGitHub Pagesがそのまま動く。
- \`.firebaserc\` は個人プロジェクトIDを含むローカル環境用としてgitignore済み。\`.firebaserc.example\`は雛形。
- FirebaseのWeb設定は秘密のサービスアカウント鍵とは違うが、IAMの編集・APIキー制限、App Check、Firestore Rulesは重要。
- **公開前の最終承認を経ずにFirebaseへ自動デプロイするGitHub Actionsはまだ追加していない**。レビュー→テスト→承認のポリシーを維持する。

## 旧PC／別オリジンからFirestoreへ移行

1. 旧GitHub Pages版でロット・現金・取得原価を証券口座と照合し、\`JSONを書き出す\`。別の保存場所にもバックアップ。
2. Firebase Hosting版でGoogleログインし、先に\`クラウド → このPC（差分確認）\`で既存バックアップの有無を確認する。
3. 必要なら\`JSONを選択\`から旧バックアップを手動インポートし、差分を確認して承認。保有確認フラグは取り込み後に**未確認**となる。
4. 保有株数／取得原価／円ドル現金を確認し、\`実保有・現金を確認\`。
5. \`このPC → クラウドに保存\`を押し、警告を読み、承認するとFirestoreへアップロード。別端末で更新されていたらリビジョン不一致エラーで停止。
6. 別PCではGoogleログインして\`クラウド → このPC（差分確認）\`を押し、既存JSON比較を確認して受け入れる。**自動で上書きしない**。
7. クラウド保存先のURLが変わっても、\`users/{uid}/workspaces/portfolio\`のUIDが一致すれば同じワークスペースを参照する。

### 並行編集

Phase 1は**自動リアルタイム同期ではない**。2台で同時編集した場合は手動で取り込み・アップロードする。クラウドへの書き込みにはFirestoreトランザクションで現在のリビジョンを照合する。自動マージは行わず、整合しない場合は停止する。ローカルデータはFirestoreへ保存成功したからといって書き換えない。

## アクセス制御

\`firestore.rules\` はGoogle認証された本人UIDだけが \`users/{uid}/workspaces/portfolio\` を読めることを確認し、他ユーザーの情報・他のFirestoreパスへのアクセスは拒否する。保存ペイロードはバージョン3・ロット数等を検証。削除操作は拒否。

この制限は**各ユーザーを自分のデータに閉じ込めるルール**であり、アプリ全体を一人しか使えないようにするルールとは異なる。本人専用のプロジェクトにするなら、ログインUIDの固定ホワイトリストやApp Checkの追加も検討する。

## Phase 2: Netlify Functionsの移行（ソース移植済み、実機検証・公開待ち）

- 受領したNetlify関数を `functions/src/legacy/` にコピーし、SEC取得処理は `functions/src/sec-gateway.js` に共通化した。
- `functions/src/index.js` にCloud Functions v2の `analyzeApi`, `screenerApi`, `chartApi` を実装。Bearer Firebase ID tokenを検証し、Google認証以外は拒否する。各関数は最大1インスタンス、同時1リクエストとしてSECへの過剰アクセスを抑える。
- SEC User-Agentは `SEC_USER_AGENT` 環境変数が未設定なら503とする。**本番担当者の実際の連絡先が設定されるまではAPIは稼働させない**。
- Hostingの `/api/*` リライトは**まだ追加していない**。財務数値の検証、SEC利用規約・デプロイ権限・Firebaseプロジェクト準備後に実施する。
- functionsパッケージはNode22と `firebase-functions` / `firebase-admin` に依存する。初回デプロイ前に `npm install --prefix functions` を実行し、生成した `functions/package-lock.json` をコードレビューしてコミットする。


受領済みソース：\`analyze.js\`、\`screener.js\`、\`chart.js\`。

1. Node 22のCloud Functions v2（例：\`asia-northeast1\`）に、関数を新設（**Netlify固有のhandler I/OをExpress HTTP形式に変換**）。
2. \`/api/analyze\`／\`/api/screener\`／\`/api/chart\`をFirebase Hostingからリライト。Auth検証とリクエストサイズ／Ticker入力制限を実装。
3. SECへの識別用User-Agentは運用者の実際の連絡先をサーバー側で設定（\`contact@example.com\`のまま利用しない）。
4. SECの合計10 req/s制約に十分余裕を持つレート制限・キャッシュ（company_tickers/companyfactsの重複取得を抑制）。
5. Yahoo Finance依存APIは保証されないことがある。提供条件と代替を検討。API欠損をゼロ値で埋めない。
6. 財務計算の定義（PER、TTM、会計期間、YoY、IFRS/US GAAP）を公式データと照合。最初は元Netlifyと新Cloud Functionsを並行稼働して差分を保存。
7. Netlifyへ依存するAPI呼び出しが0になり、バックアップ復元、PC/スマホ、リバランス回帰試験が全合格してから旧サイト廃止。

## 次のユーザー側操作（後戻り可能なものだけ）

**Firebaseの新プロジェクトを作り、Web設定とプロジェクトIDを確認**。Google認証とFirestoreの初期設定はFirebase Consoleで行う。サービスアカウントの秘密鍵を会話へ貼る必要はない。

Cloud FunctionsとNetlifyの置換が完了し、Firebase版の運用が安定するまでGitHub Pages／Netlifyは削除しない。
