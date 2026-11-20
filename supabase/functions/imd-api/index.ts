// 画像どこかな検索の API（各検索エンジンを、キーを隠したまま使うための中継）
// API キーはブラウザに出さない。かるわかGAMES の管理者が admin 画面で設定し、DB に暗号化して保存される。
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPA_URL = Deno.env.get("SUPABASE_URL")!;
const sb = createClient(SUPA_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const BUCKET = "imd-temp";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const clip = (s: unknown, n: number) => String(s ?? "").slice(0, n);

type Config = { secrets: Record<string, string>; settings: Record<string, string> };
type Acc = { id: string; username: string; display_name: string; is_admin: boolean; created_at?: string } | null;

async function config(): Promise<Config> {
  const { data, error } = await sb.rpc("imd_internal_config");
  if (error) throw new Error("config");
  return data as Config;
}
async function account(token: unknown): Promise<Acc> {
  if (typeof token !== "string" || token.length < 32) return null;
  const { data } = await sb.rpc("imd_internal_account", { p_token: token });
  return (data as Acc) || null;
}
async function sha256(buf: Uint8Array) {
  const h = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const clientIp = (req: Request) => (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "unknown";
const hashText = async (t: string) => (await sha256(new TextEncoder().encode("imd-salt|" + t))).slice(0, 24);
async function ipHash(req: Request) {
  return "ip:" + (await hashText(clientIp(req)));
}

// ---------- 不正対策 ----------
// 照合に使うもの：IP（ハッシュ）、ネットワーク（IP の前半のハッシュ）、端末 ID（ブラウザに保存した乱数）、
// ブラウザの特徴（画面の大きさ・言語・時間帯などのハッシュ）、アカウント。IP はそのまま保存しない
type Ident = { ip: string; net: string; device: string; fp: string };
async function ident(req: Request, body: Record<string, unknown>): Promise<Ident> {
  const ip = clientIp(req);
  const net = ip.includes(":") ? ip.split(":").slice(0, 4).join(":") : ip.split(".").slice(0, 3).join(".");
  const device = typeof body.device === "string" && /^[0-9a-f]{32}$/.test(body.device) ? body.device : "";
  const fp = typeof body.fp === "string" && /^[0-9a-f]{16,64}$/.test(body.fp) ? body.fp.slice(0, 32) : "";
  return { ip: await hashText(ip), net: "n" + (await hashText("net|" + net)), device, fp };
}
const DEFAULT_ORIGINS = "https://kaikomziu.github.io,http://localhost:8820";
function originOk(cfg: Config, req: Request) {
  const o = req.headers.get("origin") || "";
  const list = (cfg.settings.allowed_origins || DEFAULT_ORIGINS).split(",").map((x) => x.trim()).filter(Boolean);
  return !!o && list.includes(o);
}
function captchaInfo(cfg: Config) {
  const provider = cfg.settings.captcha_provider || "off";
  const sitekey = provider === "hcaptcha" ? cfg.settings.hcaptcha_sitekey : provider.startsWith("recaptcha") ? cfg.settings.recaptcha_sitekey : "";
  const secret = provider === "hcaptcha" ? cfg.secrets.hcaptcha_secret : provider.startsWith("recaptcha") ? cfg.secrets.recaptcha_secret : "";
  if (provider === "off" || !sitekey || !secret) return { provider: "off", sitekey: "", mode: "off" };
  return { provider, sitekey, mode: cfg.settings.captcha_mode || "risky" };
}
// CAPTCHA の答えをサーバーで確かめる（画面の判定は信用しない）
async function verifyCaptcha(cfg: Config, token: unknown, req: Request): Promise<{ ok: boolean; err?: string }> {
  const ci = captchaInfo(cfg);
  if (ci.provider === "off") return { ok: true };
  if (typeof token !== "string" || token.length < 20 || token.length > 5000) return { ok: false, err: "no_token" };
  const fd = new URLSearchParams({ response: token, remoteip: clientIp(req) });
  let url = "";
  if (ci.provider === "hcaptcha") { url = "https://api.hcaptcha.com/siteverify"; fd.set("secret", cfg.secrets.hcaptcha_secret); fd.set("sitekey", ci.sitekey); }
  else { url = "https://www.google.com/recaptcha/api/siteverify"; fd.set("secret", cfg.secrets.recaptcha_secret); }
  try {
    const d = await (await fetch(url, { method: "POST", body: fd })).json();
    if (!d.success) return { ok: false, err: clip((d["error-codes"] || []).join(","), 80) || "fail" };
    if (ci.provider === "recaptcha3") {
      const min = Number(cfg.settings.recaptcha_min_score || 0.5);
      if (Number(d.score) < min) return { ok: false, err: "score " + d.score };
      if (d.action && d.action !== "search") return { ok: false, err: "action" };
    }
    return { ok: true };
  } catch (_e) { return { ok: false, err: "verify_error" }; }
}
async function stat(engine: string, kind: "call" | "cached" | "error", info?: string) {
  try { await sb.rpc("imd_internal_stat", { p_engine: engine, p_kind: kind, p_info: info ?? null }); } catch (_e) { /* 無視 */ }
}

// ---------- エンジンの一覧 ----------
export const ENGINES = ["saucenao", "tracemoe", "animetrace", "iqdb", "fluffle", "serpapi", "searchapi", "serper", "scrapingdog", "vision", "tineye", "ris"] as const;
type Engine = typeof ENGINES[number];
// それぞれの API キーの名前（trace.moe・AnimeTrace・IQDB・Fluffle はキーなしでも使える）
const KEY_OF: Record<Engine, string> = {
  saucenao: "saucenao_key", tracemoe: "tracemoe_key", animetrace: "", iqdb: "", fluffle: "",
  serpapi: "serpapi_key", searchapi: "searchapi_key", serper: "serper_key", scrapingdog: "scrapingdog_key",
  vision: "vision_key", tineye: "tineye_key", ris: "ris_key",
};
const NO_KEY: Engine[] = ["tracemoe", "animetrace", "iqdb", "fluffle"];
const enabled = (cfg: Config, e: Engine) => {
  if ((cfg.settings["engine_" + e] || "on") === "off") return false;
  if (NO_KEY.includes(e)) return true;
  if (e === "ris" && !cfg.settings.ris_endpoint) return false;
  return !!cfg.secrets[KEY_OF[e]];
};

// ---------- 結果の形をそろえる ----------
type Item = {
  title: string; url: string; thumb?: string; site?: string; similarity?: number | null;
  author?: string; author_url?: string; note?: string; date?: string; pixiv_id?: string; video?: string;
  adult?: boolean;   // 成人向けの印（SauceNAO・trace.moe だけが教えてくれる）
};

// URL から pixiv の作品 ID を取り出す
export function pixivId(u: string): string | undefined {
  const m = u.match(/pixiv\.net\/(?:[a-z]{2}\/)?artworks\/(\d+)/) || u.match(/illust_id=(\d+)/) ||
    u.match(/pximg\.net\/.*\/(\d+)_p\d+/) || u.match(/pixiv\.net\/i\/(\d+)/);
  return m ? m[1] : undefined;
}
const host = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };
const isHttp = (u: unknown) => typeof u === "string" && /^https?:\/\//.test(u);

function item(o: Partial<Item> & { url: string }): Item {
  const it: Item = { title: clip(o.title || host(o.url) || o.url, 300), url: clip(o.url, 1000) };
  if (o.thumb && isHttp(o.thumb)) it.thumb = clip(o.thumb, 1500);
  it.site = o.site || host(o.url);
  if (o.similarity != null && isFinite(o.similarity)) it.similarity = Math.round(o.similarity * 10) / 10;
  if (o.author) it.author = clip(o.author, 120);
  if (o.author_url && isHttp(o.author_url)) it.author_url = clip(o.author_url, 500);
  if (o.note) it.note = clip(o.note, 200);
  if (o.date) it.date = clip(o.date, 40);
  if (o.video && isHttp(o.video)) it.video = clip(o.video, 1500);
  const pid = o.pixiv_id || pixivId(o.url);
  if (pid) it.pixiv_id = String(pid);
  if (o.adult) it.adult = true;
  return it;
}

async function getJson(url: string, init: RequestInit = {}, engine = "") {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 45000);
  try {
    const res = await fetch(url, { ...init, signal: ctl.signal });
    const text = await res.text();
    let data: unknown = null;
    try { data = JSON.parse(text); } catch { /* JSON ではない */ }
    if (!res.ok) {
      const msg = (data && typeof data === "object" && ((data as Record<string, unknown>).error || (data as Record<string, unknown>).message)) || text.slice(0, 120);
      throw new Error(`${engine}_${res.status}: ${clip(typeof msg === "string" ? msg : JSON.stringify(msg), 160)}`);
    }
    if (data == null) throw new Error(`${engine}_parse`);
    return data as Record<string, unknown>;
  } catch (e) {
    if ((e as Error).name === "AbortError") throw new Error(`${engine}_timeout`);
    throw e;
  } finally { clearTimeout(t); }
}

// ---- 成人向けの扱い ----
// 管理者の設定 adult_mode: hide=だれにも出さない／login=ログインした人が選べる／all=だれでも選べる
// 利用者が「ぼかす」「表示する」を選んだときだけ、成人向けの結果も取ってくる（この検索のあいだだけ cfg に印をつける）
function adultMode(cfg: Config) {
  const m = cfg.settings.adult_mode;
  if (m === "hide" || m === "login" || m === "all") return m;
  return cfg.settings.hide_adult === "off" ? "all" : "login";
}
const showAdult = (cfg: Config) => cfg.settings._adult === "1";

// ---- SauceNAO（イラスト・pixiv・Danbooru など） ----
async function saucenao(cfg: Config, imgUrl: string): Promise<Item[]> {
  const hide = showAdult(cfg) ? 0 : 3;
  const q = new URLSearchParams({ output_type: "2", numres: "16", db: "999", hide: String(hide), api_key: cfg.secrets.saucenao_key, url: imgUrl });
  const d = await getJson(`https://saucenao.com/search.php?${q}`, { headers: { "User-Agent": UA } }, "saucenao");
  const header = d.header as Record<string, unknown> | undefined;
  if (header && Number(header.status) < 0) throw new Error("saucenao_" + clip(header.message, 120));
  const out: Item[] = [];
  for (const r of (d.results as Record<string, Record<string, unknown>>[]) || []) {
    const h = r.header || {}, x = r.data || {};
    const urls = ((x.ext_urls as string[]) || []).filter(isHttp);
    const src = isHttp(x.source) ? String(x.source) : "";
    let url = urls[0] || src;
    if (x.pixiv_id) url = `https://www.pixiv.net/artworks/${x.pixiv_id}`;
    if (!url) continue;
    const creator = Array.isArray(x.creator) ? (x.creator as string[]).join(", ") : x.creator;
    const index = String(h.index_name || "").replace(/^Index #\d+:\s*/, "").replace(/\s*-\s*.*$/, "");
    const chars = clip(x.characters, 100), mat = clip(x.material, 100);
    const adult = Number(h.hidden) > 0;
    out.push(item({
      url, title: String(x.title || x.jp_name || x.eng_name || (!src && x.source) || mat || index),
      thumb: String(h.thumbnail || ""), similarity: parseFloat(String(h.similarity)),
      author: String(x.member_name || x.author_name || creator || x.artist || "") || undefined,
      author_url: x.member_id && x.pixiv_id ? `https://www.pixiv.net/users/${x.member_id}` : undefined,
      note: [index, mat && `作品: ${mat}`, chars && `キャラ: ${chars}`, src && src !== url ? `出典: ${src}` : ""].filter(Boolean).join(" ／ "),
      pixiv_id: x.pixiv_id ? String(x.pixiv_id) : undefined, adult,
    }));
    // ext_urls が複数ある（Danbooru と pixiv など）ときは、2つ目以降も別の行で出す
    for (const u2 of urls.slice(1, 3)) if (u2 !== url) out.push(item({ url: u2, title: index, thumb: String(h.thumbnail || ""), similarity: parseFloat(String(h.similarity)), adult }));
  }
  const min = Number(cfg.settings.min_similarity || 0);
  return out.filter((i) => i.similarity == null || i.similarity >= min);
}

// ---- trace.moe（アニメの場面） ----
const tm = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
async function tracemoe(cfg: Config, imgUrl: string): Promise<Item[]> {
  const headers: Record<string, string> = {};
  if (cfg.secrets.tracemoe_key) headers["x-trace-key"] = cfg.secrets.tracemoe_key;
  const d = await getJson(`https://api.trace.moe/search?anilistInfo&cutBorders&url=${encodeURIComponent(imgUrl)}`, { headers }, "tracemoe");
  if (d.error) throw new Error("tracemoe_" + clip(d.error, 120));
  const hideAdult = !showAdult(cfg);
  const out: Item[] = [];
  for (const r of ((d.result as Record<string, unknown>[]) || []).slice(0, 10)) {
    const al = (r.anilist || {}) as Record<string, unknown>;
    if (hideAdult && al.isAdult) continue;
    const t = (al.title || {}) as Record<string, string>;
    const ep = r.episode != null ? `第${Array.isArray(r.episode) ? (r.episode as unknown[]).join("・") : r.episode}話` : "";
    out.push(item({
      url: al.id ? `https://anilist.co/anime/${al.id}` : String(r.video || ""),
      title: t.native || t.romaji || t.english || String(r.filename || "不明なアニメ"),
      thumb: String(r.image || ""), video: String(r.video || ""), site: "trace.moe",
      similarity: Number(r.similarity) * 100, adult: !!al.isAdult,
      note: [ep, `${tm(Number(r.from) || 0)} ごろ`, t.romaji && t.romaji !== t.native ? t.romaji : ""].filter(Boolean).join(" ／ "),
    }));
  }
  return out.filter((i) => (i.similarity ?? 0) >= 87);   // trace.moe は 87% 未満だと別の作品のことが多い
}

// ---- SerpApi / SearchApi / 汎用 API の結果から、リンクの一覧を取り出す ----
const LIST_KEYS = ["lens_results", "organic", "visual_results", "exact_matches", "visual_matches", "image_results", "pages_with_matching_images", "inline_images", "image_sources", "organic_results", "similar_images", "related_content", "results", "matches", "data", "items"];
function pick(o: Record<string, unknown>, ...ks: string[]) {
  for (const k of ks) {
    const v = k.split(".").reduce<unknown>((a, p) => (a && typeof a === "object" ? (a as Record<string, unknown>)[p] : undefined), o);
    if (typeof v === "string" && v) return v;
  }
  return "";
}
function linksFrom(d: unknown, depth = 0): Item[] {
  const out: Item[] = [];
  if (!d || typeof d !== "object" || depth > 3) return out;
  const obj = d as Record<string, unknown>;
  const lists: unknown[][] = [];
  if (Array.isArray(d)) lists.push(d);
  else for (const k of LIST_KEYS) if (Array.isArray(obj[k])) lists.push(obj[k] as unknown[]);
  for (const list of lists) {
    for (const r of list.slice(0, 40)) {
      if (!r || typeof r !== "object") continue;
      const o = r as Record<string, unknown>;
      const url = pick(o, "link", "page_url", "url", "source_url", "backlink", "page", "website", "pageUrl", "sourceUrl");
      if (!isHttp(url)) { out.push(...linksFrom(o, depth + 1)); continue; }
      out.push(item({
        url, title: pick(o, "title", "name", "snippet", "source"),
        thumb: pick(o, "thumbnail", "image.link", "image", "original", "image_url", "thumbnailUrl", "imageUrl"),
        site: pick(o, "source", "domain", "displayed_link") || undefined,
        date: pick(o, "date", "crawl_date") || undefined,
        similarity: typeof o.similarity === "number" ? (o.similarity <= 1 ? o.similarity * 100 : o.similarity) : typeof o.score === "number" && o.score <= 100 ? o.score : null,
      }));
    }
  }
  return out;
}
function dedupe(items: Item[]) {
  const seen = new Set<string>();
  return items.filter((i) => { const k = i.url.replace(/[#?].*$/, "").replace(/\/$/, ""); if (seen.has(k)) return false; seen.add(k); return true; });
}

// ---- SerpApi ----
async function serpapi(cfg: Config, imgUrl: string): Promise<Item[]> {
  const mode = cfg.settings.serpapi_engine || "google_lens";
  const q = new URLSearchParams({ api_key: cfg.secrets.serpapi_key, hl: "ja" });
  if (mode === "google_lens" || mode === "google_lens_exact") { q.set("engine", "google_lens"); q.set("url", imgUrl); if (mode === "google_lens_exact") q.set("type", "exact_matches"); }
  else if (mode === "google_reverse_image") { q.set("engine", "google_reverse_image"); q.set("image_url", imgUrl); }
  else if (mode === "yandex_images") { q.set("engine", "yandex_images"); q.set("url", imgUrl); q.delete("hl"); }
  else if (mode === "bing_reverse_image") { q.set("engine", "bing_reverse_image"); q.set("image_url", imgUrl); q.delete("hl"); }
  else throw new Error("serpapi_engine");
  const d = await getJson(`https://serpapi.com/search.json?${q}`, {}, "serpapi");
  if (d.error) throw new Error("serpapi_" + clip(d.error, 140));
  return dedupe(linksFrom(d)).slice(0, 40);
}

// ---- SearchApi ----
async function searchapi(cfg: Config, imgUrl: string): Promise<Item[]> {
  const mode = cfg.settings.searchapi_engine || "google_lens";
  const q = new URLSearchParams({ url: imgUrl });
  if (mode === "google_lens") { q.set("engine", "google_lens"); q.set("search_type", "visual_matches"); q.set("hl", "ja"); }
  else if (mode === "google_lens_exact") { q.set("engine", "google_lens"); q.set("search_type", "exact_matches"); q.set("hl", "ja"); }
  else if (mode === "google_reverse_image" || mode === "yandex_reverse_image" || mode === "bing_reverse_image") q.set("engine", mode);
  else throw new Error("searchapi_engine");
  const d = await getJson(`https://www.searchapi.io/api/v1/search?${q}`, { headers: { Authorization: "Bearer " + cfg.secrets.searchapi_key } }, "searchapi");
  if (d.error) throw new Error("searchapi_" + clip(d.error, 140));
  return dedupe(linksFrom(d)).slice(0, 40);
}

// ---- TinEye（同じ画像が載っているページ。いちばん古い掲載が元の可能性が高い） ----
async function tineye(cfg: Config, imgUrl: string): Promise<Item[]> {
  const q = new URLSearchParams({ image_url: imgUrl, limit: "30", sort: "crawl_date", order: "asc" });
  const d = await getJson(`https://api.tineye.com/rest/search/?${q}`, { headers: { "x-api-key": cfg.secrets.tineye_key } }, "tineye");
  const res = (d.results || {}) as Record<string, unknown>;
  const out: Item[] = [];
  for (const m of (res.matches as Record<string, unknown>[]) || []) {
    const bls = ((m.backlinks as Record<string, string>[]) || []).slice().sort((a, b) => String(a.crawl_date).localeCompare(String(b.crawl_date)));
    const first = bls[0];
    const url = first?.backlink || first?.url || String(m.image_url || "");
    if (!isHttp(url)) continue;
    out.push(item({
      url, title: first?.image_name || String(m.domain || host(url)),
      thumb: String(m.image_url || first?.url || ""), site: String(m.domain || ""),
      date: first?.crawl_date ? String(first.crawl_date).slice(0, 10) : undefined,
      similarity: typeof m.score === "number" ? Math.min(100, Number(m.score)) : null,
      note: [m.width && m.height ? `${m.width}×${m.height}` : "", bls.length > 1 ? `ほか ${bls.length - 1} ページ` : ""].filter(Boolean).join(" ／ "),
    }));
  }
  return out;
}

// ---- 汎用の Reverse Image Search API（管理画面で URL と認証のしかたを決める） ----
async function ris(cfg: Config, imgUrl: string): Promise<Item[]> {
  const tpl = cfg.settings.ris_endpoint || "";
  if (!/^https:\/\//.test(tpl)) throw new Error("ris_endpoint");
  const key = cfg.secrets.ris_key || "";
  let url = tpl.replaceAll("{url}", encodeURIComponent(imgUrl)).replaceAll("{key}", encodeURIComponent(key));
  if (!tpl.includes("{url}")) url += (url.includes("?") ? "&" : "?") + "url=" + encodeURIComponent(imgUrl);
  const headers: Record<string, string> = { Accept: "application/json" };
  const auth = cfg.settings.ris_auth || "bearer";
  if (key && !tpl.includes("{key}")) {
    if (auth === "bearer") headers.Authorization = "Bearer " + key;
    else if (auth.startsWith("header:")) {
      const name = auth.slice(7).trim();
      headers[name] = key;
      // RapidAPI のときは Host ヘッダーも要る
      if (/^x-rapidapi-key$/i.test(name)) headers["x-rapidapi-host"] = new URL(url).hostname;
    } else if (auth.startsWith("query:")) url += (url.includes("?") ? "&" : "?") + encodeURIComponent(auth.slice(6).trim()) + "=" + encodeURIComponent(key);
  }
  const d = await getJson(url, { headers }, "ris");
  return dedupe(linksFrom(d)).slice(0, 40);
}

// 一時置き場の画像そのもの（ファイルで送る API 用）
async function imageBytes(imgUrl: string) {
  const res = await fetch(imgUrl);
  if (!res.ok) throw new Error("storage_" + res.status);
  const buf = new Uint8Array(await res.arrayBuffer());
  return { buf, mime: sniff(buf) || "image/jpeg" };
}
const stripTags = (h: unknown) => String(h ?? "").replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim();

// ---- AnimeTrace（アニメ・ゲームのキャラクターを当てる。出どころではなく「だれが写っているか」） ----
async function animetrace(cfg: Config, imgUrl: string): Promise<Item[]> {
  const fd = new FormData();
  fd.set("url", imgUrl);
  fd.set("model", cfg.settings.animetrace_model || "animetrace_high_beta");
  fd.set("ai_detect", "1");
  const d = await getJson("https://api.animetrace.com/v1/search", { method: "POST", body: fd, headers: { "User-Agent": UA } }, "animetrace");
  if (Number(d.code) !== 0) throw new Error("animetrace_" + d.code);
  const out: Item[] = [];
  const ai = d.ai === true;
  for (const [bi, box] of ((d.data as Record<string, unknown>[]) || []).slice(0, 6).entries()) {
    const chars = ((box.character as Record<string, string>[]) || []).slice(0, 3);
    chars.forEach((c, ci) => {
      if (!c.character) return;
      out.push(item({
        // 出どころの URL はないので、pixiv のタグ検索へ（同じキャラの絵を探せる）
        url: `https://www.pixiv.net/tags/${encodeURIComponent(c.character)}/artworks`,
        title: `${c.character}${c.work ? `（${c.work}）` : ""}`, site: "AnimeTrace",
        note: [ (d.data as unknown[]).length > 1 ? `${bi + 1}人目` : "", ci > 0 ? `候補${ci + 1}` : "",
          box.not_confident ? "自信なし" : "", ai && bi === 0 && ci === 0 ? "AI で作られた画像の可能性あり" : "",
          "pixiv でこのキャラの絵を探す" ].filter(Boolean).join(" ／ "),
      }));
    });
  }
  return out;
}

// ---- IQDB（Danbooru・Gelbooru・yande.re などのイラスト。キー不要。混んでいると遅い） ----
// IQDB はときどき「結果を読めません、もう一度」と返すので、そのときは1回だけやり直す
async function iqdb(cfg: Config, imgUrl: string): Promise<Item[]> {
  const { buf, mime } = await imageBytes(imgUrl);
  try { return await iqdbOnce(buf, mime); }
  catch (e) {
    if (!/try again/i.test(String((e as Error).message))) throw e;
    await new Promise((r) => setTimeout(r, 1500));
    return await iqdbOnce(buf, mime);
  }
}
async function iqdbOnce(buf: Uint8Array, mime: string): Promise<Item[]> {
  // 最初にクッキーをもらう（ないと 307 で戻される）
  const first = await fetch("https://iqdb.org/", { headers: { "User-Agent": UA }, redirect: "manual" });
  const cookie = (first.headers.get("set-cookie") || "").split(";")[0];
  await first.body?.cancel();
  const fd = new FormData();
  fd.set("file", new Blob([buf], { type: mime }), "image." + mime.split("/")[1]);
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 100000);
  let html = "";
  try {
    const res = await fetch("https://iqdb.org/", { method: "POST", body: fd, headers: { "User-Agent": UA, ...(cookie ? { Cookie: cookie } : {}) }, signal: ctl.signal });
    if (!res.ok) throw new Error("iqdb_" + res.status);
    html = await res.text();
  } catch (e) {
    if ((e as Error).name === "AbortError") throw new Error("iqdb_timeout");
    throw e;
  } finally { clearTimeout(t); }
  if (/class='err'/.test(html) && !/class='pages'/.test(html)) throw new Error("iqdb_" + clip(stripTags(html.match(/class='err'>([\s\S]*?)<\/div>/)?.[1]), 80));
  const pages = html.split("<div class='pages'>")[1] || "";
  const out: Item[] = [];
  for (const block of pages.split("<div><table>").slice(1)) {
    if (/Your image/.test(block)) continue;
    const sim = Number(block.match(/(\d+)% similarity/)?.[1] || 0);
    const href = block.match(/<td class='image'><a href="([^"]+)"/)?.[1];
    if (!href || sim < 75) continue;   // 75% 未満は別の絵のことが多い
    const url = href.startsWith("//") ? "https:" + href : href;
    const src = block.match(/<img src='([^']+)'/)?.[1] || "";
    const alt = block.match(/alt="([^"]*)"/)?.[1] || "";
    const rating = alt.match(/Rating: (\w)/)?.[1] || "";
    const size = stripTags(block.match(/<td>(\d+\D\d+ \[[^\]]*\])<\/td>/)?.[1]).replace(/\D(?=\d+ \[)/, "×");
    const tags = alt.replace(/^.*Tags: /, "").split(" ").slice(0, 8).join(" ");
    out.push(item({
      url, title: tags ? tags.replace(/_/g, " ") : host(url),
      thumb: src ? (src.startsWith("http") ? src : "https://iqdb.org" + src) : "",
      similarity: sim, adult: rating === "q" || rating === "e",
      note: [size, tags ? "タグ: " + tags : ""].filter(Boolean).join(" ／ "),
    }));
  }
  return out;
}

// ---- Fluffle（ケモノ系のイラスト。e621・Fur Affinity など。キー不要） ----
async function fluffle(cfg: Config, imgUrl: string): Promise<Item[]> {
  const { buf, mime } = await imageBytes(imgUrl);
  if (mime === "image/gif") throw new Error("fluffle_gif");
  const fd = new FormData();
  fd.set("File", new Blob([buf], { type: mime }), "image." + mime.split("/")[1]);
  fd.set("Limit", "16");
  const d = await getJson("https://api.fluffle.xyz/exact-search-by-file", { method: "POST", body: fd, headers: { "User-Agent": "gazou-doko-search/1.2 (https://kaikomziu.github.io/gazou-doko/)" } }, "fluffle");
  const out: Item[] = [];
  const list = (d.results as Record<string, unknown>[]) || [];
  // 「たぶん一致」がたくさん出るときは、単純な絵で似たものが多いだけなので出さない（3件以下なら別バージョンとして出す）
  const probableOk = list.filter((r) => r.match === "probable").length <= 3;
  for (const r of list) {
    if (r.match === "unlikely" || (r.match === "probable" && !probableOk)) continue;
    const platform = String(r.platform || "");
    const authors = ((r.authors as Record<string, string>[]) || []).map((a) => a.name).filter(Boolean).join(", ");
    out.push(item({
      url: String(r.url || ""), title: `${platform}${authors ? " ・ " + authors : ""}`,
      thumb: String((r.thumbnail as Record<string, string>)?.url || ""), author: authors || undefined,
      similarity: r.match === "exact" ? 95 : 75,
      note: r.match === "exact" ? "完全に一致" : "たぶん一致（別バージョンの可能性）",
      // Twitter などは成人向けかどうかを教えてくれないので、印を付けない
      adult: r.isSfw === false && !/twitter|^x$/i.test(platform),
    }));
  }
  return out.filter((i) => isHttp(i.url));
}

// ---- Serper.dev（Google レンズ） ----
async function serper(cfg: Config, imgUrl: string): Promise<Item[]> {
  const d = await getJson("https://google.serper.dev/lens", {
    method: "POST", headers: { "X-API-KEY": cfg.secrets.serper_key, "Content-Type": "application/json" },
    body: JSON.stringify({ url: imgUrl, gl: "jp", hl: "ja" }),
  }, "serper");
  if (d.message && !d.organic) throw new Error("serper_" + clip(d.message, 140));
  return dedupe(linksFrom(d)).slice(0, 40);
}

// ---- Scrapingdog（Google レンズ） ----
async function scrapingdog(cfg: Config, imgUrl: string): Promise<Item[]> {
  const q = new URLSearchParams({ api_key: cfg.secrets.scrapingdog_key, url: "https://lens.google.com/uploadbyurl?url=" + encodeURIComponent(imgUrl) });
  const d = await getJson(`https://api.scrapingdog.com/google_lens?${q}`, {}, "scrapingdog");
  if (d.error || d.message && !d.lens_results) throw new Error("scrapingdog_" + clip(d.error || d.message, 140));
  return dedupe(linksFrom(d)).slice(0, 40);
}

// ---- Google Cloud Vision（Web Detection：同じ画像が載っているページ・推測されるキーワード） ----
async function vision(cfg: Config, imgUrl: string): Promise<Item[]> {
  const body = { requests: [{ image: { source: { imageUri: imgUrl } }, features: [{ type: "WEB_DETECTION", maxResults: 30 }], imageContext: { webDetectionParams: { includeGeoResults: false } } }] };
  const d = await getJson(`https://vision.googleapis.com/v1/images:annotate?key=${encodeURIComponent(cfg.secrets.vision_key)}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }, "vision");
  const r0 = ((d.responses as Record<string, unknown>[]) || [])[0] || {};
  if (r0.error) throw new Error("vision_" + clip((r0.error as Record<string, unknown>).message, 140));
  const w = (r0.webDetection || {}) as Record<string, unknown>;
  const out: Item[] = [];
  for (const pg of (w.pagesWithMatchingImages as Record<string, unknown>[]) || []) {
    const full = (pg.fullMatchingImages as Record<string, string>[]) || [];
    const part = (pg.partialMatchingImages as Record<string, string>[]) || [];
    out.push(item({
      url: String(pg.url || ""), title: stripTags(pg.pageTitle) || host(String(pg.url || "")),
      thumb: (full[0] || part[0])?.url, similarity: full.length ? 95 : part.length ? 75 : null,
      note: full.length ? "同じ画像が載っています" : part.length ? "一部が同じ画像が載っています" : "",
    }));
  }
  // 推測されるキーワード（作品名・キャラ名など）は、Google 検索へのリンクとして最後に足す
  const guess = ((w.bestGuessLabels as Record<string, string>[]) || []).map((x) => x.label).filter(Boolean);
  const ents = ((w.webEntities as Record<string, unknown>[]) || []).filter((x) => x.description).slice(0, 6).map((x) => String(x.description));
  const words = [...new Set([...guess, ...ents])];
  if (words.length) out.push(item({
    url: `https://www.google.com/search?q=${encodeURIComponent(guess[0] || ents[0])}`,
    title: `推測：${guess[0] || ents[0]}`, site: "Google Vision", note: "関連するキーワード: " + words.slice(0, 7).join("、"),
  }));
  return out.filter((i) => isHttp(i.url));
}

const RUN: Record<Engine, (cfg: Config, url: string) => Promise<Item[]>> = {
  saucenao, tracemoe, animetrace, iqdb, fluffle, serpapi, searchapi, serper, scrapingdog, vision, tineye, ris,
};

// ---------- pixiv ----------
// 作品ページ URL → 画像 URL（公開作品だけ。R-18 などは取れない）
async function pixivInfo(id: string) {
  const res = await fetch(`https://www.pixiv.net/ajax/illust/${id}`, { headers: { "User-Agent": UA, Referer: "https://www.pixiv.net/", "Accept-Language": "ja" } });
  if (!res.ok) throw new Error("pixiv_" + res.status);
  const d = await res.json();
  if (d.error) throw new Error("pixiv_" + clip(d.message, 80));
  const b = d.body || {};
  return {
    id, title: clip(b.title, 200), user: clip(b.userName, 100), user_id: String(b.userId || ""),
    date: clip(b.createDate, 10), tags: ((b.tags?.tags || []) as Record<string, string>[]).slice(0, 12).map((t) => t.tag),
    thumb: clip(b.urls?.small || b.urls?.thumb || "", 500), regular: clip(b.urls?.regular || "", 500),
    adult: Number(b.xRestrict) > 0, likes: Number(b.likeCount) || 0, views: Number(b.viewCount) || 0,
  };
}

// ---------- 画像の受け取り ----------
const MAX = 10 * 1024 * 1024;
function sniff(b: Uint8Array): string | null {
  if (b[0] === 0xff && b[1] === 0xd8) return "image/jpeg";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "image/gif";
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45) return "image/webp";
  return null;
}
// 社内ネットワークなどへのアクセスを防ぐ（SSRF 対策）
function safeUrl(u: string) {
  let x: URL;
  try { x = new URL(u); } catch { return false; }
  if (x.protocol !== "https:" && x.protocol !== "http:") return false;
  const h = x.hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal") || h === "metadata.google.internal") return false;
  if (/^(10|127|0)\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || h.includes(":")) return false;
  return true;
}
async function fetchImage(u: string): Promise<Uint8Array> {
  // pixiv の作品ページなら、作品の画像に置きかえる
  const pid = /pixiv\.net/.test(u) && !/pximg/.test(u) ? pixivId(u) : undefined;
  if (pid) { const info = await pixivInfo(pid); if (!info.regular) throw new Error("pixiv_noimage"); u = info.regular; }
  if (!safeUrl(u)) throw new Error("bad_url");
  const headers: Record<string, string> = { "User-Agent": UA, Accept: "image/*" };
  if (/pximg\.net$/.test(host(u))) headers.Referer = "https://www.pixiv.net/";
  const res = await fetch(u, { headers, redirect: "follow" });
  if (!res.ok) throw new Error("fetch_" + res.status);
  if (Number(res.headers.get("content-length") || 0) > MAX) throw new Error("too_big");
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.length > MAX) throw new Error("too_big");
  return buf;
}

// 古いアップロード（30分すぎ）を片づける
async function sweep() {
  try {
    const { data } = await sb.rpc("imd_internal_expired");
    const paths = (data as string[]) || [];
    if (paths.length) await sb.storage.from(BUCKET).remove(paths);
  } catch (_e) { /* 無視 */ }
}

// 管理画面の「テスト」で使う見本の画像（200×200 の図形。一時置き場の test/ に置き、片づけの対象にはしない）
const TEST_PNG = "iVBORw0KGgoAAAANSUhEUgAAAMgAAADICAIAAAAiOjnJAAAClElEQVR42u3dsU1FQRRDwe2EnB7IqIbayZBIQdTA4/Nsj3Qq8J1493x+vEuXd0wgsASWwJLAElgCSwJLYAksCSyBJbAksASWwJLAElgCSwJLYAksCSyBJbAksASWwJLAElgCSwJLYAksCSyBdcu+3l5+kwHBugwTZGA9whNho7Ae5mlc2EEKL7CySU3xOkjhBVYPqXpeBym8wKpV1WfrUMUWWM2kyngdqtgCa0VVga1DFVtgbamKtnWoYgusRVWhtg5VbIG1qyrO1qGKLbDAAouqbVuHKrZGYWGUaAsssCZhARRqCyyw9mChk2sLLLDGYEETbQsssJZg4ZJuCyywZmCBUmALLLDAElhUjdsCCyywBBZV47bAAgssgQUWWFSxBZbAAgsssMACS2CBBRZYYIElsMACCyywwBJYYIEFFlhgCSywwAILLLAEFlhggQUWWAILLLDYogosgQUWWGCB5bUZeW0GLLDAAssbpFSBBRZYYIHlZwqqwAILLLaoAgsssNhqVQUWWJOw2ApVBRZYq7DYSlQFFljDsNiKUxUDi60sVUmw2ApSBRZYYLGVoyoP1rKtrDPlwdq0FXejSFhrthIPlAprx1bodYJhLdjKPU02rG5b0XeJh9VqK/0oDbD6bBVcpARWDa+aW1TBSrfVdIg2WLm2yq5QCCuOV+X+tbAieBUvXw7rtrzqN5+AdSteI2sPwfp3XlM7z8F6vLDNeXdh/bWw8VXBuhKZAcESWAJLAktgCSzpB9bT86t0eWAJLIElsKwgsASWwJLAElgCSwJLYAksCSyBJbAksASWwJLAElgCSwJLYAksCSyBJbAksASWwJLAElgCSwJLYAksCSyBJbAksASWwJLAElgCSwJLYKmvb3EqfIMz40CFAAAAAElFTkSuQmCC";
const TEST_PATH = "test/sample.png";
async function testImageUrl() {
  const url = `${SUPA_URL}/storage/v1/object/public/${BUCKET}/${TEST_PATH}`;
  const head = await fetch(url, { method: "HEAD" });
  if (!head.ok) {
    const buf = Uint8Array.from(atob(TEST_PNG), (c) => c.charCodeAt(0));
    await sb.storage.from(BUCKET).upload(TEST_PATH, buf, { contentType: "image/png", upsert: true });
  }
  return url;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  // pixiv の画像はリファラーが要るので、ここで中継する（i.pximg.net だけ）
  if (req.method === "GET") {
    const u = new URL(req.url).searchParams.get("pximg") || "";
    if (!/^https:\/\/i\.pximg\.net\/[\w\-/.]+\.(jpg|jpeg|png|gif|webp)$/i.test(u)) return new Response("bad", { status: 400, headers: CORS });
    const r = await fetch(u, { headers: { Referer: "https://www.pixiv.net/", "User-Agent": UA } });
    if (!r.ok) return new Response("ng", { status: r.status, headers: CORS });
    return new Response(r.body, { headers: { ...CORS, "Content-Type": r.headers.get("content-type") || "image/jpeg", "Cache-Control": "public, max-age=86400" } });
  }
  if (req.method !== "POST") return json({ ok: false, reason: "method" }, 405);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ ok: false, reason: "json" }, 400); }
  const action = String(body.action || "");
  try {
    const cfg = await config();
    const acc = await account(body.ka_token);
    const who = acc ? "acc:" + acc.id : await ipHash(req);
    const access = cfg.settings.access || "login";
    // できたばかり（24時間以内）のアカウントは回数を少なくする（使い捨てアカウント対策）
    const isNew = !!acc && !acc.is_admin && !!acc.created_at && Date.now() - Date.parse(acc.created_at) < 86400e3;
    const limit = acc?.is_admin ? 0 : isNew ? Number(cfg.settings.new_account_limit || 5) : acc ? Number(cfg.settings.daily_limit || 20) : Number(cfg.settings.guest_daily_limit || 3);

    // ---- 画面の初期情報 ----
    if (action === "info") {
      const { data: used } = await sb.rpc("imd_internal_usage", { p_who: who });
      return json({
        ok: true, access, limit, used: Number(used) || 0,
        user: acc ? { name: acc.display_name, is_admin: acc.is_admin } : null,
        engines: ENGINES.filter((e) => enabled(cfg, e)),
        labels: { ris: cfg.settings.ris_label || "Reverse Image Search API" },
        modes: { serpapi: cfg.settings.serpapi_engine || "google_lens", searchapi: cfg.settings.searchapi_engine || "google_lens" },
        notice: cfg.settings.notice || "", adult_mode: adultMode(cfg),
        captcha: (() => {
          const ci = captchaInfo(cfg);
          const need = ci.mode === "all" || (ci.mode === "guest" && !acc) || (ci.mode === "risky" && (!acc || isNew));
          return { ...ci, need: ci.provider !== "off" && !acc?.is_admin && need };
        })(),
      });
    }

    // ---- pixiv の作品の情報 ----
    if (action === "pixiv") {
      const ids = (Array.isArray(body.ids) ? body.ids : []).map(String).filter((x) => /^\d{1,12}$/.test(x)).slice(0, 8);
      const out: Record<string, unknown> = {};
      await Promise.all(ids.map(async (id) => { try { out[id] = await pixivInfo(id); } catch (e) { out[id] = { id, error: String((e as Error).message) }; } }));
      return json({ ok: true, items: out });
    }

    // ---- 検索の準備：画像を受け取って一時置き場に置く ----
    if (action === "upload") {
      if (access === "admin" && !acc?.is_admin) return json({ ok: false, reason: "admin_only" });
      if (access === "login" && !acc) return json({ ok: false, reason: "auth" });
      // ---- 不正対策：このサイト以外からの呼び出し・CAPTCHA・ブロック・回数をまとめて照合 ----
      const id = await ident(req, body);
      const logBase = { account: acc?.id || "", ip: id.ip, net: id.net, device: id.device, fp: id.fp };
      if (!acc?.is_admin && !originOk(cfg, req)) {
        await sb.rpc("imd_internal_log", { p: { ...logBase, reason: "origin:" + clip(req.headers.get("origin") || "none", 80) } });
        return json({ ok: false, reason: "origin" });
      }
      let captchaOk = false;
      if (body.captcha) {
        const v = await verifyCaptcha(cfg, body.captcha, req);
        if (!v.ok) {
          await sb.rpc("imd_internal_log", { p: { ...logBase, reason: "captcha_fail:" + v.err } });
          return json({ ok: false, reason: "captcha_fail", captcha: captchaInfo(cfg) });
        }
        captchaOk = true;
      }
      const ci = captchaInfo(cfg);
      const { data: gate, error: gerr } = await sb.rpc("imd_internal_gate", { p: {
        ...logBase, is_admin: !!acc?.is_admin, is_new: isNew, who, limit,
        burst: Number(cfg.settings.burst_per_min || 4), ip_daily: Number(cfg.settings.ip_daily_limit ?? 60),
        device_daily: Number(cfg.settings.device_daily_limit ?? 40), multi: Number(cfg.settings.multi_account_limit || 3),
        captcha_mode: ci.mode, captcha_ok: captchaOk,
      } });
      if (gerr) throw new Error("gate");
      const g = gate as { ok: boolean; reason?: string; count?: number; until?: string };
      if (!g.ok) return json({ ok: false, reason: g.reason, until: g.until, captcha: g.reason === "captcha" ? ci : undefined });
      let buf: Uint8Array;
      if (typeof body.image === "string" && body.image) {
        const b64 = body.image.replace(/^data:[^,]*,/, "");
        if (b64.length > MAX * 1.37) return json({ ok: false, reason: "too_big" });
        buf = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      } else if (typeof body.url === "string" && body.url) {
        buf = await fetchImage(clip(body.url, 2000).trim());
      } else return json({ ok: false, reason: "empty" });
      const mime = sniff(buf);
      if (!mime) return json({ ok: false, reason: "not_image" });
      if (buf.length > MAX) return json({ ok: false, reason: "too_big" });
      sweep();
      const sha = await sha256(buf);
      const path = `${crypto.randomUUID()}.${mime.split("/")[1]}`;
      const up = await sb.storage.from(BUCKET).upload(path, buf, { contentType: mime, upsert: false });
      if (up.error) throw new Error("storage");
      const { data: row, error } = await sb.from("imd_uploads").insert({ path, sha, who }).select("id").single();
      if (error) throw new Error("db");
      return json({ ok: true, id: row.id, engines: ENGINES.filter((e) => enabled(cfg, e)), used: g.count || 0, limit });
    }

    // ---- 1つのエンジンで検索 ----
    if (action === "search") {
      const engine = String(body.engine) as Engine;
      if (!ENGINES.includes(engine)) return json({ ok: false, reason: "engine" });
      if (!enabled(cfg, engine)) return json({ ok: false, reason: "disabled" });
      const id = String(body.id || "");
      if (!/^[0-9a-f-]{36}$/.test(id)) return json({ ok: false, reason: "expired" });
      const { data: cl } = await sb.rpc("imd_internal_claim", { p_id: id, p_engine: engine });
      const claim = cl as { ok: boolean; reason?: string; path: string; sha: string };
      if (!claim?.ok) return json({ ok: false, reason: claim?.reason || "expired" });
      // 成人向け：管理者が許していて、利用者が選んだときだけ
      const am = adultMode(cfg);
      const wantAdult = body.adult === true && (am === "all" || (am === "login" && !!acc));
      cfg.settings._adult = wantAdult ? "1" : "";
      const mode = engine === "serpapi" ? cfg.settings.serpapi_engine || "" : engine === "searchapi" ? cfg.settings.searchapi_engine || "" : engine === "ris" ? cfg.settings.ris_endpoint || "" : engine === "animetrace" ? cfg.settings.animetrace_model || "" : "";
      const ckey = engine + (mode ? ":" + mode.slice(0, 80) : "") + (wantAdult ? ":a" : "");
      const days = Number(cfg.settings.cache_days ?? 7);
      if (days > 0) {
        const { data: hit } = await sb.from("imd_cache").select("result, created_at").eq("sha", claim.sha).eq("engine", ckey).maybeSingle();
        if (hit && Date.now() - new Date(hit.created_at).getTime() < days * 86400e3) {
          await stat(engine, "cached");
          return json({ ok: true, engine, items: hit.result, cached: true });
        }
      }
      const imgUrl = `${SUPA_URL}/storage/v1/object/public/${BUCKET}/${claim.path}`;
      await stat(engine, "call");
      try {
        const items = (await RUN[engine](cfg, imgUrl)).slice(0, 40);
        if (days > 0) await sb.from("imd_cache").upsert({ sha: claim.sha, engine: ckey, result: items, created_at: new Date().toISOString() });
        return json({ ok: true, engine, items });
      } catch (e) {
        await stat(engine, "error", String((e as Error).message));
        throw e;
      }
    }

    // ---- 検索が終わったら画像を消す ----
    if (action === "done") {
      const id = String(body.id || "");
      if (/^[0-9a-f-]{36}$/.test(id)) {
        const { data } = await sb.from("imd_uploads").delete().eq("id", id).select("path").maybeSingle();
        if (data?.path) await sb.storage.from(BUCKET).remove([data.path]);
      }
      return json({ ok: true });
    }

    // ---- ここから管理者だけ ----
    if (!acc?.is_admin) return json({ ok: false, reason: "forbidden" }, 403);
    if (action === "admin_test") {
      const engine = String(body.engine) as Engine;
      if (!ENGINES.includes(engine)) return json({ ok: false, reason: "engine" });
      if (!NO_KEY.includes(engine) && engine !== "ris" && !cfg.secrets[KEY_OF[engine]]) return json({ ok: false, reason: "no_key" });
      const t0 = Date.now();
      try {
        const items = await RUN[engine](cfg, await testImageUrl());
        return json({ ok: true, count: items.length, ms: Date.now() - t0, sample: items.slice(0, 3) });
      } catch (e) { return json({ ok: false, reason: String((e as Error).message), ms: Date.now() - t0 }); }
    }
    return json({ ok: false, reason: "action" }, 400);
  } catch (e) {
    return json({ ok: false, reason: clip((e as Error).message || e, 300) }, 200);
  }
});
