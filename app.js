// 画像どこかな検索 ― 画面の動き
const VERSION = "1.4.0";
const SUPA = "https://kifnzvktwbomxthzvvgy.supabase.co";
// 公開用の anon key（かるわかGAMES の SDK と同じ。公開しても問題ないキー）
const ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtpZm56dmt0d2JvbXh0aHp2dmd5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc4MzgxMzgsImV4cCI6MjA5MzQxNDEzOH0.M7nXP-u--6J_6rRpgz1cJj21_7KX6MtfTmZy77Xf_IE";
const FN = `${SUPA}/functions/v1/imd-api`;

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const token = () => (window.KaAccount && KaAccount.token()) || null;

let toastTimer;
function toast(msg, ms = 3200) {
  const t = $("#toast");
  t.textContent = msg; t.classList.add("on");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("on"), ms);
}

// ---------- サーバー ----------
async function api(action, args = {}) {
  try {
    const res = await fetch(FN, {
      method: "POST",
      headers: { apikey: ANON, Authorization: "Bearer " + ANON, "Content-Type": "application/json" },
      body: JSON.stringify({ action, ka_token: token(), ...args }),
    });
    return await res.json();
  } catch (e) { return { ok: false, reason: "network" }; }
}
async function rpc(fn, args = {}) {
  const res = await fetch(`${SUPA}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: { apikey: ANON, Authorization: "Bearer " + ANON, "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  if (!res.ok) throw new Error("http " + res.status);
  return res.json();
}

function reasonText(r) {
  const map = {
    banned: "このアカウント・端末・ネットワークからの検索は止められています",
    too_fast: "続けて検索しすぎです。1分ほど待ってからもう一度どうぞ",
    multi_account: "同じ端末やネットワークで、たくさんのアカウントが使われています。いつものアカウントで検索してください",
    origin: "このページ以外からは検索できません",
    captcha: "ロボットでないことの確認が必要です",
    captcha_fail: "ロボットでないことの確認に失敗しました。もう一度ためしてください",
    captcha_load: "確認画面（CAPTCHA）を読み込めませんでした。広告ブロックなどを止めてもう一度ためしてください",
    bad_request: "送ったデータが正しくありません",
    auth: "検索するには、かるわかGAMES アカウントでログインしてください",
    admin_only: "いまは管理者だけが使えます",
    limit: "今日の検索回数の上限に達しました。明日またどうぞ",
    too_big: "画像が大きすぎます（10MB まで）", not_image: "画像として読み込めませんでした（JPEG・PNG・WebP・GIF）",
    empty: "画像を選んでください", bad_url: "その URL は使えません", expired: "時間がたちすぎました。もう一度検索してください",
    used: "このエンジンでは検索済みです", disabled: "このエンジンは使えない設定です", network: "通信できませんでした",
    forbidden: "権限がありません", no_key: "API キーが設定されていません", pixiv_noimage: "pixiv の画像を取れませんでした",
    pixiv_404: "pixiv の作品が見つかりません（非公開・削除済み・R-18 は読み込めません）",
  };
  if (!r) return "通信できませんでした";
  if (map[r]) return map[r];
  if (/^fetch_/.test(r)) return "その URL から画像を取れませんでした（" + r.slice(6) + "）";
  if (/_timeout$/.test(r)) return "時間切れになりました";
  if (/_(401|403)\b/.test(r)) return "API キーが正しくないか、権限がありません（" + r.slice(0, 60) + "）";
  if (/_429\b/.test(r) || /limit|quota|credits|searches/i.test(r)) return "API の回数上限に達しました（" + r.slice(0, 60) + "）";
  return "エラー：" + r.slice(0, 120);
}

// ---------- 不正対策：端末 ID とブラウザの特徴 ----------
// 端末 ID はこのブラウザに保存した乱数。ブラウザの特徴は画面の大きさ・言語・時間帯などをまとめたハッシュ
// （どちらも個人を特定するものではなく、同じ端末からの使いすぎ・アカウントの作りすぎを見つけるため）
function deviceId() {
  try {
    let v = localStorage.getItem("imd_device");
    if (!/^[0-9a-f]{32}$/.test(v || "")) {
      v = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
      localStorage.setItem("imd_device", v);
    }
    return v;
  } catch { return ""; }
}
let FP = "";
async function fingerprint() {
  if (FP) return FP;
  try {
    const parts = [navigator.userAgent, navigator.language, (navigator.languages || []).join(","), navigator.platform,
      screen.width + "x" + screen.height + "x" + screen.colorDepth, devicePixelRatio, Intl.DateTimeFormat().resolvedOptions().timeZone,
      navigator.hardwareConcurrency, navigator.deviceMemory, navigator.maxTouchPoints];
    const c = document.createElement("canvas"); c.width = 220; c.height = 30;
    const g = c.getContext("2d");
    g.textBaseline = "top"; g.font = "16px 'Arial'"; g.fillStyle = "#f60"; g.fillRect(100, 1, 60, 20);
    g.fillStyle = "#069"; g.fillText("画像どこかな🔎 fp", 2, 4);
    parts.push(c.toDataURL());
    const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(parts.join("|")));
    FP = [...new Uint8Array(h)].slice(0, 16).map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch { FP = ""; }
  return FP;
}

// ---------- CAPTCHA（hCaptcha ／ reCAPTCHA。見えないタイプで、あやしいときだけ問題が出る） ----------
let capWidget = null, capLoaded = null, capResolve = null;
function loadScript(src) {
  return new Promise((ok, ng) => { const sc = document.createElement("script"); sc.src = src; sc.async = true; sc.onload = ok; sc.onerror = ng; document.head.appendChild(sc); });
}
async function captchaToken(ci) {
  if (!ci || ci.provider === "off" || !ci.sitekey) return "";
  const box = document.getElementById("captchaBox") || Object.assign(document.body.appendChild(document.createElement("div")), { id: "captchaBox" });
  try {
    if (ci.provider === "hcaptcha") {
      capLoaded = capLoaded || loadScript("https://js.hcaptcha.com/1/api.js?render=explicit&recaptchacompat=off&hl=ja");
      await capLoaded;
      for (let i = 0; i < 50 && !window.hcaptcha?.render; i++) await sleep(100);
      if (capWidget === null) capWidget = hcaptcha.render(box, { sitekey: ci.sitekey, size: "invisible" });
      else hcaptcha.reset(capWidget);
      const r = await hcaptcha.execute(capWidget, { async: true });
      return r?.response || "";
    }
    if (ci.provider === "recaptcha3") {
      capLoaded = capLoaded || loadScript("https://www.google.com/recaptcha/api.js?render=" + encodeURIComponent(ci.sitekey) + "&hl=ja");
      await capLoaded;
      await new Promise((ok) => grecaptcha.ready(ok));
      return await grecaptcha.execute(ci.sitekey, { action: "search" });
    }
    // reCAPTCHA v2（見えないタイプ）
    capLoaded = capLoaded || loadScript("https://www.google.com/recaptcha/api.js?render=explicit&hl=ja");
    await capLoaded;
    for (let i = 0; i < 50 && !window.grecaptcha?.render; i++) await sleep(100);
    return await new Promise((ok, ng) => {
      capResolve = ok;
      if (capWidget === null) capWidget = grecaptcha.render(box, { sitekey: ci.sitekey, size: "invisible", callback: (t) => capResolve && capResolve(t), "error-callback": () => ng(new Error("captcha")) });
      else grecaptcha.reset(capWidget);
      grecaptcha.execute(capWidget);
    });
  } catch (e) {
    // 問題を閉じた・読み込めなかった
    return null;
  }
}

// ---------- エンジン・サイトの見た目 ----------
const ENGINE_LABEL = { saucenao: "SauceNAO", tracemoe: "trace.moe", animetrace: "AnimeTrace", iqdb: "IQDB", fluffle: "Fluffle", serpapi: "SerpApi", searchapi: "SearchApi", serper: "Serper", scrapingdog: "Scrapingdog", vision: "Google Vision", tineye: "TinEye", ris: "Reverse Image Search API" };
const ENGINE_ORDER = ["saucenao", "tracemoe", "animetrace", "iqdb", "fluffle", "serpapi", "searchapi", "serper", "scrapingdog", "vision", "tineye", "ris"];
// はじめは外しておくエンジン（Fluffle はケモノ系専用なので）
const DEFAULT_OFF = ["fluffle"];
const SITES = [
  { key: "pixiv", label: "pixiv", re: /(^|\.)pixiv\.net$|(^|\.)pximg\.net$|fanbox\.cc$/ },
  { key: "x", label: "X（Twitter）", re: /(^|\.)(twitter|x)\.com$|twimg\.com$|fxtwitter|vxtwitter/ },
  { key: "danbooru", label: "Danbooru など", re: /danbooru|gelbooru|yande\.re|konachan|sankaku|safebooru|zerochan|e-shuushuu|anime-pictures/ },
  { key: "anime", label: "アニメ", re: /anilist\.co|myanimelist\.net|trace\.moe|annict/ },
  { key: "furry", label: "ケモノ系", re: /e621\.net|e926\.net|furaffinity\.net|weasyl\.com|inkbunny\.net|furrynetwork|sofurry/ },
  { key: "nico", label: "ニコニコ", re: /nicovideo\.jp|nicoseiga|seiga\.nicovideo/ },
  { key: "art", label: "DeviantArt・ArtStation", re: /deviantart|artstation|behance/ },
  { key: "sns", label: "SNS", re: /instagram|facebook|threads\.net|bsky|misskey|tumblr|reddit|pinterest|weibo|lofter/ },
  { key: "shop", label: "ショップ", re: /booth\.pm|skeb\.jp|amazon\.|rakuten|melonbooks|toranoana|dlsite|fantia/ },
];
function siteOf(it) {
  // AnimeTrace はキャラクター名の結果（リンク先は pixiv のタグ検索）
  if (it.site === "AnimeTrace") return { key: "chara", label: "キャラ名", host: "AnimeTrace" };
  if (it.site === "Google Vision") return { key: "hint", label: "キーワード", host: "Google Vision" };
  let h = "";
  try { h = new URL(it.url).hostname.replace(/^www\./, ""); } catch { /* 無視 */ }
  for (const s of SITES) if (s.re.test(h)) return { ...s, host: h };
  return { key: "other", label: "そのほか", host: h };
}
const pxThumb = (u) => (u && /i\.pximg\.net/.test(u) ? `${FN}?pximg=${encodeURIComponent(u)}` : u);

// ---------- 状態 ----------
let INFO = null;
let picked = null;      // { kind: "file", dataUrl, w, h, size } または { kind: "url", url }
let running = false;
let results = {};        // engine -> { state, items, reason, cached }
let view = { tab: "all", site: "all" };
let pixivInfo = {};
let searchAdult = "hide";  // 検索したときの成人向けの設定（hide のときはサーバーも成人向けを取ってこない）

// ---------- 成人向けの表示設定（hide=隠す／blur=ぼかす／show=表示する） ----------
const AKEY = "imd_adult", AOK = "imd_adult_ok";
function adultAllowed() {
  const m = INFO?.adult_mode || "login";
  return m === "all" || (m === "login" && !!INFO?.user);
}
function adultPref() {
  const v = localStorage.getItem(AKEY);
  return adultAllowed() && (v === "blur" || v === "show") ? v : "hide";
}
// いま表示に使う設定（サーバーが取ってこなかったものは出せないので、検索時の設定もみる）
const adultView = () => (searchAdult === "hide" ? "hide" : adultPref());
function renderAdult() {
  const row = $("#adultRow");
  if (!row || !INFO) return;
  const m = INFO.adult_mode || "login";
  const ok = adultAllowed(), cur = adultPref();
  row.classList.toggle("locked", !ok);
  $$("#adultRow [data-adult]").forEach((b) => {
    b.classList.toggle("on", b.dataset.adult === cur);
    b.setAttribute("aria-checked", b.dataset.adult === cur ? "true" : "false");
    b.disabled = !ok && b.dataset.adult !== "hide";
  });
  $("#adultNote").textContent = m === "hide" ? "管理者の設定で、成人向けの結果は表示しません"
    : !ok ? "ログインすると選べます（18歳以上の方のみ）"
    : cur !== "hide" ? "R-18 の印が付くのは SauceNAO・trace.moe・IQDB・Fluffle・pixiv の結果だけです"
    : "Google レンズなどの結果は判定できないため、まれに成人向けが出ることがあります";
}
$$("#adultRow [data-adult]").forEach((b) => b.onclick = () => {
  const v = b.dataset.adult;
  if (!adultAllowed() && v !== "hide") return;
  if (v !== "hide" && localStorage.getItem(AOK) !== "1") {
    if (!confirm("成人向け（R-18）の結果は、18歳以上の方だけが見られます。\nあなたは18歳以上ですか？")) return;
    localStorage.setItem(AOK, "1");
  }
  localStorage.setItem(AKEY, v);
  renderAdult();
  if (v !== "hide" && searchAdult === "hide" && Object.keys(results).length) toast("成人向けの結果は、次の検索から含まれます");
  if (Object.keys(results).length) { renderResults(); renderPixiv(); }
});
const isAdult = (it) => !!(it.adult || (it.pixiv_id && pixivInfo[it.pixiv_id]?.adult));

// ---------- 画面の切りかえ ----------
function go(name) {
  $$(".screen").forEach((s) => s.classList.toggle("on", s.id === name));
  if (name === "history") renderHistory();
  if (name === "admin") renderAdmin();
  window.scrollTo({ top: 0 });
}
function route() {
  const h = location.hash.replace("#", "");
  go(["history", "admin"].includes(h) ? h : "home");
}
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-go]");
  if (!b) return;
  e.preventDefault();
  const n = b.dataset.go;
  if (n === "home") { history.pushState(null, "", location.pathname); route(); }
  else location.hash = n;
});
window.addEventListener("hashchange", route);
window.addEventListener("popstate", route);

// ---------- アカウント ----------
function renderAcct() {
  const u = window.KaAccount && KaAccount.user();
  const btn = $("#acctBtn");
  btn.textContent = u ? (u.display_name || u.username || "アカウント") : "ログイン";
  $("#adminLink").classList.toggle("hide", !(INFO && INFO.user && INFO.user.is_admin));
}
$("#acctBtn").onclick = () => {
  if (!window.KaAccount) return toast("アカウント機能を読み込めませんでした");
  KaAccount.isLoggedIn() ? KaAccount.openPanel() : KaAccount.login("login");
};

async function loadInfo() {
  const r = await api("info");
  if (!r.ok) { $("#quota").textContent = "サーバーに接続できませんでした"; return; }
  INFO = r;
  ENGINE_LABEL.ris = r.labels?.ris || ENGINE_LABEL.ris;
  renderAcct();
  renderEngines();
  renderQuota();
  renderAdult();
  const n = $("#notice");
  n.textContent = r.notice || "";
  n.classList.toggle("hide", !r.notice);
  if (location.hash === "#admin") renderAdmin();
}
function renderQuota(used) {
  if (!INFO) return;
  if (used != null) INFO.used = used;
  const q = $("#quota");
  if (INFO.access === "admin" && !INFO.user?.is_admin) q.textContent = "いまは管理者だけが使えます";
  else if (INFO.access === "login" && !INFO.user) q.innerHTML = `検索するには <a href="#" id="qLogin">ログイン</a> が必要です（かるわかGAMES アカウント）`;
  else if (INFO.user?.is_admin) q.textContent = "管理者なので回数の上限はありません";
  else q.textContent = `今日の検索：${INFO.used} ／ ${INFO.limit} 回` + (INFO.user ? "" : "（ログインすると増えます）");
  const ql = $("#qLogin");
  if (ql) ql.onclick = (e) => { e.preventDefault(); KaAccount?.login("login"); };
}

// エンジンのチェックボックス
const pickKey = "imd_engines";
function chosenEngines() {
  return $$("#enginePick input:checked").map((i) => i.value);
}
function renderEngines() {
  const on = new Set(INFO?.engines || []);
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(pickKey) || "null"); } catch { /* 無視 */ }
  $("#enginePick").innerHTML = ENGINE_ORDER.map((e) => {
    const ok = on.has(e);
    const checked = ok && (saved ? !saved.off?.includes(e) && !(DEFAULT_OFF.includes(e) && !saved.seen?.includes(e)) : !DEFAULT_OFF.includes(e));
    return `<label class="eng ${ok ? "" : "off"}" title="${ok ? "" : "管理者がまだ設定していません"}">
      <input type="checkbox" value="${e}" ${checked ? "checked" : ""} ${ok ? "" : "disabled"}>${esc(ENGINE_LABEL[e])}${ok ? "" : "（未設定）"}</label>`;
  }).join("");
  $$("#enginePick input").forEach((i) => i.onchange = () => {
    const off = $$("#enginePick input:not(:checked):not(:disabled)").map((x) => x.value);
    localStorage.setItem(pickKey, JSON.stringify({ off, seen: ENGINE_ORDER }));
    updateSearchBtn();
  });
  updateSearchBtn();
}
function updateSearchBtn() {
  $("#searchBtn").disabled = running || !picked || !!crop || !chosenEngines().length;
}

// ---------- 画像を選ぶ ----------
const drop = $("#drop");
drop.addEventListener("click", (e) => { if (!picked && !e.target.closest("button")) $("#file").click(); });
drop.addEventListener("keydown", (e) => { if ((e.key === "Enter" || e.key === " ") && !picked) { e.preventDefault(); $("#file").click(); } });
$("#file").onchange = (e) => { const f = e.target.files[0]; if (f) useFile(f); e.target.value = ""; };
["dragenter", "dragover"].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add("over"); }));
["dragleave", "drop"].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
drop.addEventListener("drop", (e) => {
  const f = [...(e.dataTransfer?.files || [])].find((x) => x.type.startsWith("image/"));
  if (f) return useFile(f);
  const u = e.dataTransfer?.getData("text/uri-list") || e.dataTransfer?.getData("text/plain");
  if (u && /^https?:\/\//.test(u.trim())) useUrl(u.trim());
});
document.addEventListener("paste", (e) => {
  if (!$("#home").classList.contains("on")) return;
  if (e.target?.closest?.("input, textarea")) return;
  const f = [...(e.clipboardData?.files || [])].find((x) => x.type.startsWith("image/"));
  if (f) { e.preventDefault(); useFile(f); return; }
  const t = e.clipboardData?.getData("text") || "";
  if (/^https?:\/\/\S+$/.test(t.trim())) { e.preventDefault(); useUrl(t.trim()); }
});
$("#urlForm").onsubmit = (e) => {
  e.preventDefault();
  const u = $("#urlInput").value.trim();
  if (!/^https?:\/\//.test(u)) return toast("http(s):// で始まる URL を入れてください");
  useUrl(u);
};
$("#clearBtn").onclick = (e) => { e.stopPropagation(); clearPick(); };

function clearPick() {
  resetCrop();
  picked = null;
  $("#dropEmpty").classList.remove("hide");
  $("#dropPreview").classList.add("hide");
  drop.classList.remove("has");
  updateCropButtons();
  updateSearchBtn();
}
function showPreview(src, info) {
  // 切り取りのときに元の画像を使えるよう、表示した画像と説明を覚えておく
  if (picked) { picked.previewSrc = src; picked.info = info; }
  $("#previewImg").onerror = null;
  $("#previewImg").src = src;
  $("#previewInfo").textContent = info;
  updateCropButtons();
  $("#dropEmpty").classList.add("hide");
  $("#dropPreview").classList.remove("hide");
  drop.classList.add("has");
  updateSearchBtn();
}

// 大きい画像は縮めて送る（長い辺 2400px・4MB まで。小さければそのまま）
function readAsDataUrl(blob) {
  return new Promise((ok, ng) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = ng; r.readAsDataURL(blob); });
}
function loadImg(src) {
  return new Promise((ok, ng) => { const i = new Image(); i.onload = () => ok(i); i.onerror = ng; i.src = src; });
}
async function useFile(f) {
  if (!f.type.startsWith("image/")) return toast("画像ファイルを選んでください");
  resetCrop();
  if (f.size > 40 * 1024 * 1024) return toast("画像が大きすぎます（40MB まで）");
  let dataUrl = await readAsDataUrl(f);
  let img;
  try { img = await loadImg(dataUrl); } catch { return toast("この画像は読み込めませんでした（HEIC などは JPEG に変換してください）"); }
  const MAXS = 2400;
  const okType = /^image\/(jpeg|png|webp|gif)$/.test(f.type);
  if (!okType || f.size > 4 * 1024 * 1024 || Math.max(img.width, img.height) > MAXS) {
    const sc = Math.min(1, MAXS / Math.max(img.width, img.height));
    const c = document.createElement("canvas");
    c.width = Math.round(img.width * sc); c.height = Math.round(img.height * sc);
    const g = c.getContext("2d");
    g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height);
    g.drawImage(img, 0, 0, c.width, c.height);
    dataUrl = c.toDataURL("image/jpeg", 0.92);
  }
  picked = { kind: "file", dataUrl, w: img.width, h: img.height, name: f.name };
  showPreview(dataUrl, `${f.name || "貼り付けた画像"} ・ ${img.width}×${img.height} ・ ${(f.size / 1024 / 1024).toFixed(1)}MB`);
}
async function useUrl(u) {
  resetCrop();
  picked = { kind: "url", url: u };
  $("#urlInput").value = u;
  const pid = /pixiv\.net/.test(u) && !/pximg/.test(u) ? (u.match(/artworks\/(\d+)/) || u.match(/illust_id=(\d+)/) || [])[1] : null;
  if (pid) {
    showPreview("icon.svg", "pixiv の作品を読み込み中…");
    const r = await api("pixiv", { ids: [pid] });
    const it = r.items?.[pid];
    if (picked?.url !== u) return;
    if (!it || it.error) { showPreview("icon.svg", "pixiv の作品の情報を取れませんでした（そのまま検索はできます）"); return; }
    showPreview(pxThumb(it.regular || it.thumb), `pixiv「${it.title}」 ／ ${it.user}`);
    picked.pixivSelf = pid;   // 自分で指定した作品は、結果の「いちばん有力」から外す
    return;
  }
  showPreview(/pximg\.net/.test(u) ? pxThumb(u) : u, "URL から読み込みます");
  $("#previewImg").onerror = () => {
    $("#previewImg").onerror = null; $("#previewImg").src = "icon.svg";
    if (picked?.url === u) { picked.previewSrc = "icon.svg"; updateCropButtons(); }
    $("#previewInfo").textContent = "プレビューは出せませんが、そのまま検索できます";
  };
}

// ---------- 画像の一部を切り取る ----------
// 範囲は画像の大きさを 1 とした割合（0〜1）で持つ。切り取りはいつも元の画像から行う
let crop = null;       // 切り取り中：{ img, rect: { x, y, w, h } }
let lastRect = null;   // 前に選んだ範囲（もう一度切り取るときに使う）
let cropDrag = null;
const cropWrap = $("#cropWrap"), cropBox = $("#cropBox");
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

function updateCropButtons() {
  const src = (picked?.original || picked)?.previewSrc;
  const can = !!picked && !!src && !/icon\.svg$/.test(src);
  $("#cropBtn").classList.toggle("hide", !can || !!crop);
  $("#uncropBtn").classList.toggle("hide", !picked?.original || !!crop);
  $("#clearBtn").classList.toggle("hide", !!crop);
  $("#cropBar").classList.toggle("hide", !crop);
}
function resetCrop() {
  if (crop) endCrop();
  lastRect = null;
}
function endCrop() {
  crop = null; cropDrag = null;
  cropWrap.classList.remove("cropping");
  cropBox.classList.add("hide");
  updateCropButtons(); updateSearchBtn();
}
function drawCrop() {
  const r = crop.rect;
  Object.assign(cropBox.style, { left: r.x * 100 + "%", top: r.y * 100 + "%", width: r.w * 100 + "%", height: r.h * 100 + "%" });
  $("#cropSize").textContent = `${Math.round(r.w * crop.img.naturalWidth)}×${Math.round(r.h * crop.img.naturalHeight)}`;
}
$("#cropBtn").onclick = async (e) => {
  e.stopPropagation();
  const base = picked?.original || picked;
  if (!base?.previewSrc) return;
  // ほかのサイトの画像は、許可されていないと切り取れない（pixiv はこちらの中継を通すので切り取れる）
  const img = new Image();
  img.crossOrigin = "anonymous";
  try {
    await new Promise((ok, ng) => { img.onload = ok; img.onerror = ng; img.src = base.previewSrc; });
    const c = document.createElement("canvas"); c.width = c.height = 1;
    const g = c.getContext("2d"); g.drawImage(img, 0, 0, 1, 1); g.getImageData(0, 0, 1, 1);
  } catch { return toast("この URL の画像は切り取れません。画像を保存してから選ぶと切り取れます", 4500); }
  crop = { img, rect: { ...(lastRect || { x: 0.1, y: 0.1, w: 0.8, h: 0.8 }) } };
  $("#previewImg").src = base.previewSrc;
  $("#previewInfo").textContent = `${base.info || "元の画像"} から切り取り中`;
  cropWrap.classList.add("cropping");
  cropBox.classList.remove("hide");
  drawCrop(); updateCropButtons(); updateSearchBtn();
};
function cropPoint(e) {
  const b = $("#previewImg").getBoundingClientRect();
  return { x: clamp((e.clientX - b.left) / b.width, 0, 1), y: clamp((e.clientY - b.top) / b.height, 0, 1) };
}
const normRect = (x1, y1, x2, y2) => ({ x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) });
cropWrap.addEventListener("pointerdown", (e) => {
  if (!crop) return;
  e.preventDefault(); e.stopPropagation();
  const pt = cropPoint(e), h = e.target.dataset?.h;
  const r0 = { ...crop.rect };
  if (h) cropDrag = { mode: h, pt, r0 };
  else if (e.target.closest("#cropBox")) cropDrag = { mode: "move", pt, r0 };
  else { cropDrag = { mode: "new", pt, r0 }; crop.rect = { x: pt.x, y: pt.y, w: 0, h: 0 }; drawCrop(); }
  cropWrap.setPointerCapture(e.pointerId);
});
cropWrap.addEventListener("pointermove", (e) => {
  if (!crop || !cropDrag) return;
  const p = cropPoint(e), { mode, pt, r0 } = cropDrag;
  if (mode === "new") crop.rect = normRect(pt.x, pt.y, p.x, p.y);
  else if (mode === "move") crop.rect = { ...r0, x: clamp(r0.x + p.x - pt.x, 0, 1 - r0.w), y: clamp(r0.y + p.y - pt.y, 0, 1 - r0.h) };
  else {
    let x1 = r0.x, y1 = r0.y, x2 = r0.x + r0.w, y2 = r0.y + r0.h;
    if (mode.includes("w")) x1 = p.x;
    if (mode.includes("e")) x2 = p.x;
    if (mode.includes("n")) y1 = p.y;
    if (mode.includes("s")) y2 = p.y;
    crop.rect = normRect(x1, y1, x2, y2);
  }
  drawCrop();
});
function endCropDrag() {
  if (!crop || !cropDrag) return;
  // 小さすぎる範囲（ただのクリックなど）は、元の範囲に戻す
  if (crop.rect.w < 0.02 || crop.rect.h < 0.02) { crop.rect = cropDrag.r0; drawCrop(); }
  cropDrag = null;
}
cropWrap.addEventListener("pointerup", endCropDrag);
cropWrap.addEventListener("pointercancel", endCropDrag);
cropWrap.addEventListener("click", (e) => { if (crop) e.stopPropagation(); });

function applyCrop() {
  const { img, rect } = crop;
  const sx = Math.round(rect.x * img.naturalWidth), sy = Math.round(rect.y * img.naturalHeight);
  const sw = Math.round(rect.w * img.naturalWidth), sh = Math.round(rect.h * img.naturalHeight);
  if (sw < 24 || sh < 24) return toast("範囲が小さすぎます。もう少し大きく選んでください");
  const c = document.createElement("canvas");
  c.width = sw; c.height = sh;
  const g = c.getContext("2d");
  g.fillStyle = "#fff"; g.fillRect(0, 0, sw, sh);
  g.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
  let dataUrl;
  try { dataUrl = c.toDataURL("image/jpeg", 0.92); } catch { return toast("この画像は切り取れませんでした"); }
  const base = picked.original || picked;
  lastRect = { ...rect };
  endCrop();
  picked = { kind: "file", dataUrl, w: sw, h: sh, name: base.name || "切り取った画像", original: base, pixivSelf: base.pixivSelf };
  showPreview(dataUrl, `切り取った画像 ・ ${sw}×${sh}`);
  toast("切り取りました。「出どころを探す」で検索できます");
}
$("#cropOk").onclick = (e) => { e.stopPropagation(); applyCrop(); };
$("#cropCancel").onclick = (e) => { e.stopPropagation(); endCrop(); $("#previewImg").src = picked.previewSrc; $("#previewInfo").textContent = picked.info || ""; };
$("#uncropBtn").onclick = (e) => {
  e.stopPropagation();
  const base = picked?.original;
  if (!base) return;
  picked = base;
  showPreview(base.previewSrc, base.info);
};
document.addEventListener("keydown", (e) => {
  if (!crop || e.target.closest?.("input, textarea")) return;
  if (e.key === "Escape") { e.preventDefault(); $("#cropCancel").click(); }
  else if (e.key === "Enter") { e.preventDefault(); applyCrop(); }
});

// ---------- 検索 ----------
$("#searchBtn").onclick = search;
async function search() {
  if (running || !picked) return;
  const engines = chosenEngines();
  if (!engines.length) return toast("検索エンジンを1つ以上選んでください");
  if (INFO?.access === "login" && !INFO.user) { KaAccount?.login("login"); return toast(reasonText("auth")); }
  running = true; updateSearchBtn();
  results = {}; pixivInfo = {}; pixivIds = []; view = { tab: "all", site: "all" };
  searchAdult = adultPref();
  engines.forEach((e) => results[e] = { state: "wait", items: [] });
  $("#results").classList.remove("hide");
  $("#best").classList.add("hide"); $("#pixivBox").classList.add("hide");
  renderResults();
  $("#results").scrollIntoView({ behavior: "smooth", block: "start" });

  const btn = $("#searchBtn");
  const label = btn.innerHTML;
  btn.innerHTML = "画像を送っています…";
  const payload = picked.kind === "file" ? { image: picked.dataUrl } : { url: picked.url };
  payload.device = deviceId();
  payload.fp = await fingerprint();
  let up;
  // CAPTCHA が要るとわかっているときは先に、サーバーに求められたときはその場で1回だけ
  let ci = INFO?.captcha?.need ? INFO.captcha : null;
  for (let tries = 0; tries < 2; tries++) {
    if (ci) {
      btn.innerHTML = "ロボットでないか確認しています…";
      const t = await captchaToken(ci);
      if (t === null || !t) { up = { ok: false, reason: t === null ? "captcha_load" : "captcha" }; break; }
      payload.captcha = t;
    }
    btn.innerHTML = "画像を送っています…";
    up = await api("upload", payload);
    if (up.ok || !(up.reason === "captcha" || up.reason === "captcha_fail") || !up.captcha) break;
    ci = up.captcha;
  }
  btn.innerHTML = label;
  if (!up.ok) {
    running = false; updateSearchBtn();
    $("#results").classList.add("hide");
    if (up.reason === "auth") KaAccount?.login("login");
    return toast(reasonText(up.reason), 5000);
  }
  renderQuota(up.used);
  const list = engines.filter((e) => up.engines.includes(e));
  engines.filter((e) => !list.includes(e)).forEach((e) => results[e] = { state: "ng", items: [], reason: "disabled" });
  list.forEach((e) => results[e].state = "run");
  renderResults();

  await Promise.all(list.map(async (e) => {
    const r = await api("search", { id: up.id, engine: e, adult: searchAdult !== "hide" });
    results[e] = r.ok ? { state: "ok", items: r.items || [], cached: r.cached } : { state: "ng", items: [], reason: r.reason };
    renderResults();
  }));
  api("done", { id: up.id });
  running = false; updateSearchBtn();
  await loadPixiv();
  saveHistory();
}

// ---------- 結果の表示 ----------
function allItems() {
  // エンジンごとの結果をまとめ、同じ URL は1つに（見つけたエンジンを並べる）
  const map = new Map();
  for (const e of ENGINE_ORDER) {
    const r = results[e];
    if (!r || r.state !== "ok") continue;
    r.items.forEach((it, idx) => {
      const key = it.pixiv_id ? "px:" + it.pixiv_id : it.url.replace(/^https?:\/\/(www\.)?/, "").replace(/[#?].*$/, "").replace(/\/$/, "");
      const cur = map.get(key);
      if (cur) {
        if (!cur.engines.includes(e)) cur.engines.push(e);
        if ((it.similarity ?? -1) > (cur.similarity ?? -1)) cur.similarity = it.similarity;
        if (!cur.thumb && it.thumb) cur.thumb = it.thumb;
        if (!cur.author && it.author) cur.author = it.author;
      } else map.set(key, { ...it, engines: [e], rank: idx });
    });
  }
  let arr = [...map.values()];
  if (adultView() === "hide") arr = arr.filter((x) => !isAdult(x));
  const score = (x) => (x.similarity ?? 55 - x.rank) + (x.engines.length - 1) * 8 + (x.pixiv_id ? 4 : 0);
  return arr.sort((a, b) => score(b) - score(a));
}
function bestItem(items) {
  // 似ている度が高い（85% 以上）SauceNAO・trace.moe の結果、または複数のエンジンが見つけたもの
  const c = items.filter((x) => !x.pixiv_id || x.pixiv_id !== picked?.pixivSelf);
  return c.find((x) => (x.similarity ?? 0) >= 85 && (x.engines.includes("saucenao") || x.engines.includes("tracemoe")))
    || c.find((x) => x.engines.length >= 2) || null;
}

function renderResults() {
  // 進み具合
  $("#progress").innerHTML = Object.entries(results).map(([e, r]) => {
    const t = r.state === "wait" ? "待機" : r.state === "run" ? "検索中…" : r.state === "ok" ? `${r.items.length}件${r.cached ? "（保存済み）" : ""}` : "失敗";
    return `<span class="pg ${r.state}" title="${esc(r.reason ? reasonText(r.reason) : "")}"><span class="dot"></span>${esc(ENGINE_LABEL[e])} <small>${esc(t)}</small></span>`;
  }).join("");

  const items = allItems();
  // いちばん有力
  const best = running ? null : bestItem(items);
  const b = $("#best");
  if (best) {
    const s = siteOf(best);
    const px = best.pixiv_id && pixivInfo[best.pixiv_id];
    const title = px && !px.error ? px.title : best.title;
    const author = px && !px.error ? px.user : best.author;
    const bAdult = isAdult(best);
    b.innerHTML = `<img class="${bAdult && adultView() === "blur" ? "blurred" : ""}" src="${esc(pxThumb((px && !px.error && px.thumb) || best.thumb || ""))}" alt="" referrerpolicy="no-referrer" onerror="this.style.visibility='hidden'">
      <div><span class="label">いちばん有力</span>${bAdult ? ' <span class="badge r18">R-18</span>' : ""}
        <h3>${esc(title)}</h3>
        <p>${esc(s.label === "そのほか" ? s.host : s.label)}${author ? " ・ " + esc(author) : ""}${best.similarity != null ? ` ・ 似ている度 ${best.similarity}%` : ""}${best.engines.length > 1 ? ` ・ ${best.engines.length}つのエンジンが一致` : ""}</p>
        ${best.note ? `<p>${esc(best.note)}</p>` : ""}
        <a class="btn sm" href="${esc(best.url)}" target="_blank" rel="noopener noreferrer">開く ↗</a></div>`;
    b.classList.remove("hide");
  } else b.classList.add("hide");

  // タブ
  const counts = { all: items.length };
  for (const e of Object.keys(results)) counts[e] = results[e].items.length;
  $("#tabs").innerHTML = [["all", "まとめ"], ...Object.keys(results).map((e) => [e, ENGINE_LABEL[e]])]
    .map(([k, l]) => `<button class="tab ${view.tab === k ? "on" : ""}" data-tab="${k}">${esc(l)}<small>${counts[k] ?? 0}</small></button>`).join("");
  $$("#tabs .tab").forEach((t) => t.onclick = () => { view.tab = t.dataset.tab; view.site = "all"; renderResults(); });

  let shown = view.tab === "all" ? items : (results[view.tab]?.items || []).map((x) => ({ ...x, engines: [view.tab] }));
  if (view.tab !== "all" && adultView() === "hide") shown = shown.filter((x) => !isAdult(x));
  // サイトのしぼりこみ
  const siteCount = {};
  shown.forEach((x) => { const k = siteOf(x).key; siteCount[k] = (siteCount[k] || 0) + 1; });
  const siteList = [...SITES, { key: "chara", label: "キャラ名" }, { key: "hint", label: "キーワード" }, { key: "other", label: "そのほか" }].filter((s) => siteCount[s.key]);
  $("#siteChips").innerHTML = siteList.length > 1
    ? [`<button class="chip ${view.site === "all" ? "on" : ""}" data-site="all">すべて</button>`, ...siteList.map((s) => `<button class="chip ${view.site === s.key ? "on" : ""}" data-site="${s.key}">${esc(s.label)} ${siteCount[s.key]}</button>`)].join("")
    : "";
  $$("#siteChips .chip").forEach((c) => c.onclick = () => { view.site = c.dataset.site; renderResults(); });
  if (view.site !== "all") shown = shown.filter((x) => siteOf(x).key === view.site);

  // 一覧
  const tab = view.tab !== "all" ? results[view.tab] : null;
  $("#list").innerHTML = shown.map(card).join("");
  const em = $("#emptyMsg");
  const busy = Object.values(results).some((r) => r.state === "run" || r.state === "wait");
  em.textContent = tab && tab.state === "ng" ? reasonText(tab.reason) : busy ? "検索しています…" : "見つかりませんでした。別のエンジンや、画像の一部を切り取って試してみてください。";
  em.classList.toggle("hide", shown.length > 0);
}

function card(it) {
  const s = siteOf(it);
  const sim = it.similarity;
  const simCls = sim == null ? "" : sim >= 80 ? "" : sim >= 60 ? "mid" : "low";
  const px = it.pixiv_id && pixivInfo[it.pixiv_id] && !pixivInfo[it.pixiv_id].error ? pixivInfo[it.pixiv_id] : null;
  const title = px ? px.title : it.title;
  const author = px ? px.user : it.author;
  const thumb = pxThumb(it.thumb || (px && px.thumb) || "");
  const oldest = it.engines.includes("tineye") && it.date;
  const adult = isAdult(it), blur = adult && adultView() === "blur";
  return `<a class="card" href="${esc(it.url)}" target="_blank" rel="noopener noreferrer">
    ${thumb ? `<img class="th${blur ? " blurred" : ""}" src="${esc(thumb)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.outerHTML='<div class=&quot;th none&quot;>?</div>'">` : `<div class="th none">?</div>`}
    <div class="body">
      <div class="title">${esc(title)}</div>
      <div class="meta">
        ${adult ? `<span class="badge r18">R-18</span>` : ""}
        <span class="badge site-${s.key}">${esc(s.key === "other" ? s.host || "そのほか" : s.label)}</span>
        ${sim != null ? `<span class="sim ${simCls}"><i><b style="width:${Math.max(4, Math.min(100, sim))}%"></b></i>${sim}%</span>` : ""}
        ${author ? `<span>✎ ${esc(author)}</span>` : ""}
        ${oldest ? `<span class="badge old">掲載 ${esc(it.date)}</span>` : it.date ? `<span>${esc(it.date)}</span>` : ""}
        ${it.engines.map((e) => `<span class="badge eng">${esc(ENGINE_LABEL[e])}</span>`).join("")}
      </div>
      ${it.note ? `<div class="note">${esc(it.note)}</div>` : ""}
      <div class="url">${esc(it.url)}</div>
    </div></a>`;
}

// pixiv の作品の情報（タイトル・作者・タグ）をまとめて取る
async function loadPixiv() {
  const ids = [...new Set(allItems().map((x) => x.pixiv_id).filter(Boolean))].filter((id) => id !== picked?.pixivSelf).slice(0, 8);
  if (!ids.length) { renderResults(); return; }
  const r = await api("pixiv", { ids });
  if (r.ok) pixivInfo = r.items || {};
  pixivIds = ids;
  renderPixiv();
  renderResults();
}
let pixivIds = [];
function renderPixiv() {
  const box = $("#pixivBox");
  const mode = adultView();
  const all = Object.values(results).flatMap((r) => r.items || []).filter((x) => x.pixiv_id);
  const from = (id) => all.find((x) => x.pixiv_id === id) || {};
  const ids = pixivIds.filter((id) => mode !== "hide" || !(pixivInfo[id]?.adult || from(id).adult));
  if (!ids.length) { box.classList.add("hide"); return; }
  $("#pixivList").innerHTML = ids.map((id) => {
    const p = pixivInfo[id] || {};
    const fromItem = from(id);
    const ok = p && !p.error;
    const adult = !!(p.adult || fromItem.adult);
    const img = ok && p.thumb ? pxThumb(p.thumb) : (fromItem.thumb || "");
    return `<a class="px-card" href="https://www.pixiv.net/artworks/${id}" target="_blank" rel="noopener noreferrer">
      ${img ? `<img class="${adult && mode === "blur" ? "blurred" : ""}" src="${esc(img)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : `<div class="r18">pixiv</div>`}
      <div class="t">${adult ? '<span class="badge r18">R-18</span> ' : ""}${esc(ok ? p.title : fromItem.title || "作品 " + id)}</div>
      <div class="u">${esc(ok ? p.user : fromItem.author || "")}${ok && p.date ? " ・ " + esc(p.date) : ""}</div></a>`;
  }).join("");
  box.classList.remove("hide");
}

// ---------- 履歴（この端末だけ） ----------
const HKEY = "imd_history";
function loadHist() { try { return JSON.parse(localStorage.getItem(HKEY) || "[]"); } catch { return []; } }
async function saveHistory() {
  const items = allItems();
  const best = bestItem(items) || items[0];
  let thumb = "";
  try {
    const src = picked?.kind === "file" ? picked.dataUrl : null;
    if (src) {
      const img = await loadImg(src);
      const c = document.createElement("canvas"); const sz = 96;
      const sc = Math.max(sz / img.width, sz / img.height);
      c.width = sz; c.height = sz;
      c.getContext("2d").drawImage(img, (sz - img.width * sc) / 2, (sz - img.height * sc) / 2, img.width * sc, img.height * sc);
      thumb = c.toDataURL("image/jpeg", 0.7);
    }
  } catch { /* 無視 */ }
  const h = loadHist();
  h.unshift({
    at: Date.now(), thumb, src: picked?.kind === "url" ? picked.url : "", count: items.length,
    best: best ? { title: (best.pixiv_id && pixivInfo[best.pixiv_id]?.title) || best.title, url: best.url, site: siteOf(best).label } : null,
  });
  try { localStorage.setItem(HKEY, JSON.stringify(h.slice(0, 30))); } catch { /* 容量オーバーは無視 */ }
}
function renderHistory() {
  const h = loadHist();
  $("#histList").innerHTML = h.length ? h.map((x) => `<div class="hist-item">
      <img src="${esc(x.thumb || "icon.svg")}" alt="">
      <div><div class="t">${x.best ? esc(x.best.title) : "見つかりませんでした"}</div>
        <div class="d">${new Date(x.at).toLocaleString("ja-JP")} ・ ${x.count}件${x.best ? " ・ " + esc(x.best.site) : ""}</div>
        ${x.best ? `<a href="${esc(x.best.url)}" target="_blank" rel="noopener noreferrer">開く ↗</a>` : ""}</div></div>`).join("")
    : `<p class="fine">まだ履歴はありません。</p>`;
}
$("#histClear").onclick = () => { if (confirm("履歴をすべて消しますか？")) { localStorage.removeItem(HKEY); renderHistory(); } };

// ---------- admin ----------
const ENGINE_ADMIN = [
  { e: "saucenao", key: "saucenao_key", link: "https://saucenao.com/user.php?page=search-api", desc: "イラスト・pixiv・Danbooru・漫画向け。無料アカウントでもキーがもらえます（1日の回数に上限あり）。" },
  { e: "tracemoe", key: "tracemoe_key", link: "https://soruly.github.io/trace.moe-api/", desc: "アニメの場面検索。キーなしでも使えます（回数が少なめ）。キーを入れると上限が増えます。", optional: true },
  { e: "animetrace", key: "", link: "https://www.animetrace.com/", desc: "アニメ・ゲームのキャラクター名を当てます（出どころではなく「だれが写っているか」）。結果は pixiv のタグ検索につながります。キー不要。", nokey: true, mode: "animetrace_model",
    modes: [["animetrace_high_beta", "アニメ（高精度・ベータ）"], ["pre_stable", "アニメ（安定版）"], ["full_game_model_kira", "ゲーム"]], modeDef: "animetrace_high_beta" },
  { e: "iqdb", key: "", link: "https://iqdb.org/", desc: "Danbooru・Gelbooru・yande.re・Zerochan などのイラストを探します。キー不要。混んでいると1分以上かかることがあります。", nokey: true },
  { e: "fluffle", key: "", link: "https://fluffle.xyz/", desc: "ケモノ系のイラスト専用（e621・Fur Affinity・Weasyl など）。キー不要。検索画面でははじめはチェックを外しています。", nokey: true },
  { e: "serpapi", key: "serpapi_key", link: "https://serpapi.com/manage-api-key", desc: "Google レンズなどを API で使えます。", mode: "serpapi_engine",
    modes: [["google_lens", "Google レンズ（似た画像）"], ["google_lens_exact", "Google レンズ（完全一致）"], ["google_reverse_image", "Google 逆画像検索"], ["yandex_images", "Yandex 画像"], ["bing_reverse_image", "Bing 逆画像（Enterprise のみ）"]] },
  { e: "searchapi", key: "searchapi_key", link: "https://www.searchapi.io/", desc: "SerpApi と同じく、Google レンズなどを使えます。", mode: "searchapi_engine",
    modes: [["google_lens", "Google レンズ（似た画像）"], ["google_lens_exact", "Google レンズ（完全一致）"], ["google_reverse_image", "Google 逆画像検索"], ["yandex_reverse_image", "Yandex 逆画像"], ["bing_reverse_image", "Bing 逆画像"]] },
  { e: "serper", key: "serper_key", link: "https://serper.dev/api-key", desc: "Google レンズの結果。登録すると無料の回数がもらえます。" },
  { e: "scrapingdog", key: "scrapingdog_key", link: "https://www.scrapingdog.com/", desc: "Google レンズの結果。1回の検索で10クレジット使います。" },
  { e: "vision", key: "vision_key", link: "https://console.cloud.google.com/apis/credentials", desc: "Google Cloud Vision の Web Detection。同じ画像が載っているページと、推測される作品名・キーワードを出します。月1,000回まで無料（Google Cloud で Vision API を有効にして API キーを作る。キーは Vision API だけに制限するのがおすすめ）。" },
  { e: "tineye", key: "tineye_key", link: "https://services.tineye.com/TinEyeAPI", desc: "同じ画像が載っているページを、掲載の古い順に出します。元の投稿を探すのに便利（有料）。" },
  { e: "ris", key: "ris_key", link: "", desc: "そのほかの逆画像検索 API（RapidAPI・Zyla など）。URL のひな形と認証のしかたを決めると使えます。結果の形は自動で読み取ります。", ris: true },
];

async function renderAdmin() {
  const body = $("#adminBody");
  if (!token()) { body.innerHTML = `<div class="panel"><p>admin 画面を使うには、管理者の かるわかGAMES アカウントでログインしてください。</p><button class="btn" id="admLogin">ログイン</button></div>`; $("#admLogin").onclick = () => KaAccount?.login("login"); return; }
  const r = await rpc("imd_admin_get", { p_token: token() }).catch(() => null);
  if (!r || !r.ok) { body.innerHTML = `<div class="panel"><p>${r && r.reason === "forbidden" ? "このアカウントは管理者ではありません。" : "読み込めませんでした。"}</p></div>`; return; }
  const st = r.settings || {}, sec = r.secrets || {};
  const secretInput = (name, ph) => `<label>API キー ${sec[name] ? `<span class="set">設定済み ${esc(sec[name])}</span>` : `<span class="unset">未設定</span>`}
    <span class="row"><input class="grow" type="password" autocomplete="new-password" data-k="${name}" placeholder="${esc(ph || (sec[name] ? "変えるときだけ入力" : "キーを貼り付け"))}">
    <button class="btn sm" data-save="${name}">保存</button>${sec[name] ? `<button class="btn ghost sm" data-del="${name}">削除</button>` : ""}</span></label>`;
  const textInput = (name, label, ph, hint = "") => `<label>${label}${hint ? `<span class="hint">${hint}</span>` : ""}<span class="row"><input class="grow" type="text" data-k="${name}" value="${esc(st[name] || "")}" placeholder="${esc(ph)}"><button class="btn sm" data-save="${name}">保存</button></span></label>`;
  const sel = (name, label, opts, def) => `<label>${label}<span class="row"><select data-k="${name}" data-autosave>${opts.map(([v, l]) => `<option value="${v}" ${(st[name] || def) === v ? "selected" : ""}>${esc(l)}</option>`).join("")}</select></span></label>`;

  const engines = ENGINE_ADMIN.map((x) => {
    const onv = (st["engine_" + x.e] || "on") !== "off";
    return `<div class="eng-admin">
      <header><h3>${esc(x.e === "ris" ? (st.ris_label || ENGINE_LABEL.ris) : ENGINE_LABEL[x.e])}${x.link ? `<a href="${x.link}" target="_blank" rel="noopener">キーの取得 ↗</a>` : ""}</h3>
        <label class="switch"><input type="checkbox" data-engine-on="${x.e}" ${onv ? "checked" : ""}>使う</label></header>
      <p class="fine" style="margin:0">${esc(x.desc)}</p>
      <div class="kv">
        ${x.ris ? textInput("ris_label", "表示名", "Reverse Image Search API") + textInput("ris_endpoint", "URL のひな形", "https://example.com/search?url={url}", "{url} が画像の URL に置きかわります（{key} も使えます）") +
          sel("ris_auth", "キーの渡し方", [["bearer", "Authorization: Bearer キー"], ["header:X-API-Key", "ヘッダー X-API-Key"], ["header:x-rapidapi-key", "RapidAPI（x-rapidapi-key）"], ["query:api_key", "URL に ?api_key=キー"], ["query:key", "URL に ?key=キー"]], "bearer") : ""}
        ${x.nokey ? "" : secretInput(x.key, x.optional ? "（なくても使えます）" : "")}
        ${x.mode ? sel(x.mode, x.e === "animetrace" ? "使うモデル" : "検索のしかた", x.modes, x.modeDef || "google_lens") : ""}
      </div>
      <div class="row"><button class="btn ghost sm" data-test="${x.e}">テストする</button><span class="fine">${x.e === "tracemoe" || x.nokey ? "" : "※ テストでも1回分の回数を使います"}</span></div>
      <div class="test-out hide" data-out="${x.e}"></div>
    </div>`;
  }).join("");

  const stats = r.stats || [];
  body.innerHTML = `
    <div class="grid2">
      <div class="panel"><p class="fine">今日の検索</p><div class="big-n">${r.searches_today}</div></div>
      <div class="panel"><p class="fine">7日間に使った人（ゲストは IP ごと）</p><div class="big-n">${r.searchers_7d}</div></div>
      <div class="panel"><p class="fine">保存済みの結果（同じ画像は API を使わない）</p><div class="big-n">${r.cache}</div><button class="btn ghost sm" id="clearCache">保存済みの結果を消す</button></div>
    </div>
    <div class="panel"><h2>検索エンジン</h2><p class="fine">API キーは暗号化してサーバーに保存されます。画面やブラウザには最後の4文字しか出ません。</p>
      <div class="kv">${engines}</div></div>
    <div class="panel"><h2>使える人・回数</h2><div class="kv">
      ${sel("access", "検索できる人", [["login", "ログインした人だけ（おすすめ）"], ["all", "だれでも（ゲストも）"], ["admin", "管理者だけ"]], "login")}
      ${textInput("daily_limit", "ログインした人の1日の回数", "20", "0 にすると無制限。1回の検索で選んだエンジンを全部使います")}
      ${textInput("guest_daily_limit", "ゲストの1日の回数（IP ごと）", "3")}
      ${textInput("cache_days", "同じ画像の結果を使い回す日数", "7", "0 にすると毎回 API を呼びます")}
      ${textInput("min_similarity", "SauceNAO の似ている度の下限（%）", "0", "これより低い結果は出しません")}
      ${sel("adult_mode", "成人向けの結果", [["login", "ログインした人が選べる（はじめは隠す）"], ["all", "だれでも選べる（ゲストも）"], ["hide", "だれにも表示しない"]], st.hide_adult === "off" ? "all" : "login")}
      <p class="fine" style="margin:-6px 0 0">選べるようにすると、検索画面に「隠す／ぼかす／表示する」が出ます（はじめて選ぶときに18歳以上かを確認）。成人向けの判定ができるのは SauceNAO・trace.moe・IQDB・Fluffle・pixiv の作品だけです。</p>
      <label>お知らせ（検索画面の上に出ます）<span class="row"><textarea class="grow" rows="2" data-k="notice" placeholder="なし">${esc(st.notice || "")}</textarea><button class="btn sm" data-save="notice">保存</button></span></label>
    </div></div>
    <div class="panel"><h2>不正対策の設定</h2>
      <p class="fine">IP・ネットワーク・端末 ID・ブラウザの特徴・アカウントを照合して、使いすぎ・アカウントの作りすぎ・連続アクセスを止めます。IP はそのまま保存せず、ハッシュ（暗号のような文字列）で照合します。</p>
      <div class="kv">
        ${sel("captcha_provider", "CAPTCHA（ロボット確認）", [["off", "使わない"], ["hcaptcha", "hCaptcha（おすすめ）"], ["recaptcha2", "reCAPTCHA v2（見えないタイプ）"], ["recaptcha3", "reCAPTCHA v3（スコア）"]], "off")}
        ${sel("captcha_mode", "CAPTCHA を出す相手", [["risky", "あやしいときだけ（ゲスト・できたばかりのアカウント・最近止められた人）"], ["guest", "ゲストだけ"], ["all", "全員（毎回）"]], "risky")}
        <p class="fine" style="margin:-6px 0 0">hCaptcha ${st.hcaptcha_sitekey ? '<span class="set">サイトキー設定済み</span>' : '<span class="unset">サイトキー未設定</span>'} ${sec.hcaptcha_secret ? '<span class="set">シークレット設定済み</span>' : '<span class="unset">シークレット未設定</span>'} ／ reCAPTCHA ${st.recaptcha_sitekey ? '<span class="set">サイトキー設定済み</span>' : '<span class="unset">サイトキー未設定</span>'} ${sec.recaptcha_secret ? '<span class="set">シークレット設定済み</span>' : '<span class="unset">シークレット未設定</span>'}<br>CAPTCHA の管理画面で、ドメインに kaikomziu.github.io を登録しておいてください。</p>
        ${textInput("hcaptcha_sitekey", "hCaptcha のサイトキー", "")}
        ${secretInput("hcaptcha_secret", "hCaptcha のシークレット").replace("API キー", "hCaptcha のシークレット")}
        ${textInput("recaptcha_sitekey", "reCAPTCHA のサイトキー", "")}
        ${secretInput("recaptcha_secret", "reCAPTCHA のシークレット").replace("API キー", "reCAPTCHA のシークレット")}
        ${textInput("recaptcha_min_score", "reCAPTCHA v3 の合格スコア（0〜1）", "0.5")}
        ${textInput("burst_per_min", "1分に検索できる回数", "4", "超えると待ってもらいます。10分で5倍を超えると、その IP と端末を1時間自動ブロック")}
        ${textInput("ip_daily_limit", "1つの IP の1日の合計", "60", "アカウントを作り直しても増えません。0 で無制限（学校や家族で同じ IP のことがあるので多め）")}
        ${textInput("device_daily_limit", "1つの端末の1日の合計", "40", "0 で無制限")}
        ${textInput("multi_account_limit", "同じ端末で使えるアカウントの数（24時間）", "3", "これを超えた別のアカウントは検索できません。同じ IP では2倍まで")}
        ${textInput("new_account_limit", "できたばかり（24時間以内）のアカウントの1日の回数", "5")}
        ${textInput("allowed_origins", "検索を受け付けるページ（カンマ区切り）", "https://kaikomziu.github.io,http://localhost:8820", "ほかのサイトから API を勝手に使われるのを防ぎます")}
      </div></div>
    <div class="panel"><h2>あやしい動き・ブロック</h2><div id="secBody"><p class="fine">読み込み中…</p></div></div>
    <div class="panel"><h2>この7日間のエンジン別</h2>
      ${stats.length ? `<table class="stats"><tr><th>日付</th><th>エンジン</th><th>API 呼び出し</th><th>使い回し</th><th>失敗</th></tr>${stats.map((s) => `<tr><td>${esc(s.day)}</td><td>${esc(ENGINE_LABEL[s.engine] || s.engine)}</td><td class="n">${s.calls}</td><td class="n">${s.cached}</td><td class="n">${s.errors}</td></tr>`).join("")}</table>` : `<p class="fine">まだ記録はありません。</p>`}
    </div>
    <div class="panel"><h2>最近のエラー</h2>
      ${(r.errors || []).length ? `<table class="stats">${r.errors.map((x) => `<tr><td>${new Date(x.at).toLocaleString("ja-JP")}</td><td>${esc(ENGINE_LABEL[x.engine] || x.engine)}</td><td>${esc(x.info)}</td></tr>`).join("")}</table>` : `<p class="fine">ありません。</p>`}
    </div>
    <p class="fine">v${VERSION}</p>`;

  const save = async (name, value) => {
    const x = await rpc("imd_admin_set", { p_token: token(), p_name: name, p_value: value }).catch(() => null);
    if (x && x.ok) { toast("保存しました"); return true; }
    toast("保存できませんでした" + (x?.reason ? "（" + x.reason + "）" : "")); return false;
  };
  $$("[data-save]", body).forEach((b) => b.onclick = async () => {
    const k = b.dataset.save, inp = $(`[data-k="${k}"]`, body);
    if (inp.type === "password" && !inp.value.trim()) return toast("キーを入力してください");
    if (await save(k, inp.value)) { renderAdmin(); loadInfo(); }
  });
  $$("[data-del]", body).forEach((b) => b.onclick = async () => {
    if (!confirm("このキーを削除しますか？")) return;
    if (await save(b.dataset.del, "")) { renderAdmin(); loadInfo(); }
  });
  $$("[data-autosave]", body).forEach((s) => s.onchange = async () => { if (await save(s.dataset.k, s.value)) loadInfo(); });
  $$("[data-engine-on]", body).forEach((c) => c.onchange = async () => { if (await save("engine_" + c.dataset.engineOn, c.checked ? "on" : "off")) loadInfo(); });
  $("#clearCache").onclick = async () => { if (confirm("保存済みの結果をすべて消しますか？")) { await save("clear_cache", "1"); renderAdmin(); } };
  renderSecurity();
  $$("[data-test]", body).forEach((b) => b.onclick = async () => {
    const e = b.dataset.test, out = $(`[data-out="${e}"]`, body);
    out.classList.remove("hide"); out.textContent = "テスト中…（見本の画像で検索しています）";
    b.disabled = true;
    const x = await api("admin_test", { engine: e });
    b.disabled = false;
    out.textContent = x.ok
      ? `✅ 動きました（${x.count}件・${(x.ms / 1000).toFixed(1)}秒）\n` + (x.sample || []).map((s) => `・${s.title}  ${s.url}`).join("\n")
      : `❌ ${reasonText(x.reason)}\n${x.reason || ""}`;
  });
}

// ---------- admin：あやしい動き・ブロック ----------
const KIND_LABEL = { account: "アカウント", ip: "IP", net: "ネットワーク", device: "端末", fp: "ブラウザの特徴" };
const RESULT_LABEL = { ok: "検索", blocked: "止めた" };
const REASON_LABEL = {
  too_fast: "連続アクセス", multi_account: "複数アカウント", ip_limit: "IP の回数切れ", device_limit: "端末の回数切れ", limit: "回数切れ",
  "ban:account": "ブロック中（アカウント）", "ban:ip": "ブロック中（IP）", "ban:net": "ブロック中（ネットワーク）", "ban:device": "ブロック中（端末）", "ban:fp": "ブロック中（ブラウザ）",
};
const short = (v) => (v ? String(v).slice(0, 8) : "—");
const reasonLabel = (r) => !r ? "" : REASON_LABEL[r] || (r.startsWith("captcha_fail") ? "CAPTCHA 失敗" : r.startsWith("origin") ? "ほかのサイトから" : r);
async function renderSecurity() {
  const box = $("#secBody");
  if (!box) return;
  const r = await rpc("imd_admin_security", { p_token: token() }).catch(() => null);
  if (!r || !r.ok) { box.innerHTML = `<p class="fine">読み込めませんでした。</p>`; return; }
  const banBtns = (kind, value, label) => value ? `<button class="btn ghost sm" data-ban="${kind}" data-v="${esc(value)}" title="${esc(KIND_LABEL[kind])}をブロック">${label || "止める"}</button>` : "";
  box.innerHTML = `
    <h3 style="margin:6px 0">ブロック中（${r.bans.length}）</h3>
    ${r.bans.length ? `<table class="stats"><tr><th>種類</th><th>対象</th><th>理由</th><th>期限</th><th></th></tr>${r.bans.map((b) => `<tr>
      <td>${esc(KIND_LABEL[b.kind])}</td><td>${esc(b.username || short(b.value))}</td><td>${esc(b.reason || "")}${b.created_by === "auto" ? "" : ` <span class="fine">（${esc(b.created_by || "")}）</span>`}</td>
      <td>${b.until ? new Date(b.until).toLocaleString("ja-JP") : "ずっと"}</td><td><button class="btn ghost sm" data-unban="${b.id}">解除</button></td></tr>`).join("")}</table>` : `<p class="fine">ありません。</p>`}
    <div class="row" style="margin:10px 0">
      <select id="banKind">${Object.entries(KIND_LABEL).map(([k, l]) => `<option value="${k}">${l}</option>`).join("")}</select>
      <input class="grow" id="banValue" type="text" placeholder="ユーザー名、または一覧の値">
      <select id="banHours"><option value="1">1時間</option><option value="24" selected>1日</option><option value="168">1週間</option><option value="0">ずっと</option></select>
      <input id="banReason" type="text" placeholder="理由（任意）" style="width:140px">
      <button class="btn sm" id="banAdd">ブロック</button>
    </div>
    <h3 style="margin:14px 0 6px">あやしい IP（24時間）</h3>
    <p class="fine" style="margin-top:0">止められた回数がある・複数のアカウントが使われている・10回以上検索した IP。</p>
    ${r.suspects.length ? `<table class="stats"><tr><th>IP</th><th>検索</th><th>止めた</th><th>アカウント</th><th>端末</th><th>使った人</th><th></th></tr>${r.suspects.map((x) => `<tr>
      <td title="${esc(x.ip)}">${short(x.ip)}</td><td class="n">${x.total}</td><td class="n">${x.blocked}</td><td class="n">${x.accounts}</td><td class="n">${x.devices}</td>
      <td>${esc(x.usernames || "ゲスト")}</td><td>${banBtns("ip", x.ip, "IP を止める")} ${banBtns("net", x.net, "ネットワークごと")}</td></tr>`).join("")}</table>` : `<p class="fine">ありません。</p>`}
    <h3 style="margin:14px 0 6px">最近の記録</h3>
    <div style="overflow-x:auto"><table class="stats"><tr><th>時刻</th><th>結果</th><th>理由</th><th>アカウント</th><th>IP</th><th>端末</th><th></th></tr>${r.recent.map((x) => `<tr>
      <td>${new Date(x.at).toLocaleString("ja-JP")}</td><td>${x.result === "ok" ? "検索" : '<span class="unset">止めた</span>'}</td><td>${esc(reasonLabel(x.reason))}</td>
      <td>${esc(x.username || "ゲスト")}</td><td title="${esc(x.ip)}">${short(x.ip)}</td><td title="${esc(x.device || "")}">${short(x.device)}</td>
      <td>${x.account ? banBtns("account", x.account, "人") : ""}${banBtns("ip", x.ip, "IP")}${banBtns("device", x.device, "端末")}</td></tr>`).join("")}</table></div>`;
  const ban = async (kind, value, hours, reason) => {
    const x = await rpc("imd_admin_ban", { p_token: token(), p_kind: kind, p_value: value, p_hours: hours, p_reason: reason }).catch(() => null);
    if (x?.ok) { toast("ブロックしました"); renderSecurity(); }
    else toast(x?.reason === "admin" ? "管理者はブロックできません" : x?.reason === "notfound" ? "そのユーザー名は見つかりません" : "ブロックできませんでした");
  };
  $$("[data-ban]", box).forEach((b) => b.onclick = () => {
    const h = prompt(`${KIND_LABEL[b.dataset.ban]}「${short(b.dataset.v)}」を何時間ブロックしますか？（0 でずっと）`, "24");
    if (h === null) return;
    ban(b.dataset.ban, b.dataset.v, Math.max(0, parseInt(h, 10) || 0), "管理者が手動で");
  });
  $$("[data-unban]", box).forEach((b) => b.onclick = async () => {
    const x = await rpc("imd_admin_unban", { p_token: token(), p_id: Number(b.dataset.unban) }).catch(() => null);
    if (x?.ok) { toast("解除しました"); renderSecurity(); } else toast("解除できませんでした");
  });
  $("#banAdd").onclick = () => {
    const v = $("#banValue").value.trim();
    if (!v) return toast("ブロックする相手を入れてください");
    ban($("#banKind").value, v, Number($("#banHours").value), $("#banReason").value.trim() || "管理者が手動で");
  };
}

// ---------- 起動 ----------
(async function start() {
  route();
  deviceId(); fingerprint();
  if (window.KaAccount) {
    await Promise.race([KaAccount.ready, sleep(4000)]).catch(() => {});
    KaAccount.onChange(() => { renderAcct(); loadInfo(); });
  }
  renderAcct();
  await loadInfo();
})();
