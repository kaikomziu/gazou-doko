# 画像どこかな検索 v1.5.0

画像を選ぶと、いくつもの逆画像検索エンジンでまとめて出どころ（ソース）を探す Web サービス。作者：かるわか。

## 使っている検索エンジン
- SauceNAO（イラスト・pixiv・Danbooru・漫画）
- trace.moe（アニメの場面。キーなしでも動く）
- AnimeTrace（キャラクター名。キー不要）
- IQDB（Danbooru など。キー不要。HTML を読み取る）
- Fluffle（ケモノ系。キー不要）
- Serper.dev（Google レンズ）
- Scrapingdog（Google レンズ）
- Google Cloud Vision（Web Detection）
- SerpApi（Google レンズ ほか）
- SearchApi（Google レンズ ほか）
- TinEye（同じ画像の掲載ページ。古い順）
- Reverse Image Search API（汎用。admin 画面で URL のひな形と認証方式を設定）

切り取り：プレビューで「一部を切り取る」を押し、範囲をドラッグで選んでその部分だけで検索できる（URL の画像は、そのサイトが許可しているときと pixiv だけ）。

不正対策：IP（ハッシュ）・ネットワーク・端末 ID・ブラウザの特徴・アカウントを照合（imd_internal_gate）。ブロック（imd_bans）、連続アクセス・複数アカウント・IP／端末ごとの1日の回数、できたばかりのアカウントの回数制限、Origin の確認、hCaptcha ／ reCAPTCHA（admin で選ぶ）。記録は imd_log（30日）。プロキシ・VPN・Tor・データセンター・時間帯のずれは proxycheck.io → ip-api.com と Tor の出口一覧で判定（imd_ipinfo に24時間、imd_tor）。

pixiv：結果の pixiv 作品は、タイトル・作者を pixiv から取って「pixiv で見つかった作品」にまとめる。pixiv の作品ページの URL を入れて検索することもできる（公開作品のみ）。

## しくみ
- 静的サイト（`index.html` / `style.css` / `app.js`）。ログインは かるわかGAMES 共通 SDK（`window.KaAccount`）。
- Supabase（`kifnzvktwbomxthzvvgy`、ほかのゲームと共用）の `imd_*`。テーブルは RLS で全拒否、RPC と Edge Function だけで操作。
- Edge Function `imd-api`（`supabase/functions/imd-api/index.ts`）：画像を一時バケット `imd-temp` に置き（30分以内に削除）、その URL を各エンジンに渡す。結果は画像の SHA-256 ごとに `imd_cache` で使い回す。
- API キーは admin 画面（かるわかGAMES の管理者だけ）で入れ、Vault の `imd_master_key` で暗号化して `imd_secrets` に保存。コードには書かない。

## デプロイ
```
npx -y supabase functions deploy imd-api --project-ref kifnzvktwbomxthzvvgy --no-verify-jwt --use-api --yes
```
SQL は Supabase のマイグレーション `imd_init`（テーブル・RPC・Vault の鍵 `imd_master_key`・バケット `imd-temp`）。

## バージョンの上げ方
`index.html` の `?v=` 2か所とフッターの `.ver`、`app.js` の `VERSION`、この README の見出し。
