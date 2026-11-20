# 画像どこかな検索 v1.0.0

画像を選ぶと、いくつもの逆画像検索エンジンでまとめて出どころ（ソース）を探す Web サービス。作者：かるわか。

## 使っている検索エンジン
- SauceNAO（イラスト・pixiv・Danbooru・漫画）
- trace.moe（アニメの場面。キーなしでも動く）
- SerpApi（Google レンズ ほか）
- SearchApi（Google レンズ ほか）
- TinEye（同じ画像の掲載ページ。古い順）
- Reverse Image Search API（汎用。admin 画面で URL のひな形と認証方式を設定）

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
