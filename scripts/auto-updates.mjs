#!/usr/bin/env node
/**
 * YouTube / note の新規投稿を検知して data/updates.json に自動追加する。
 *
 * GitHub Actions（.github/workflows/auto-updates.yml）から30分おきに実行される。
 * 書き込みは git ではなく GitHub Contents API 経由で行う（管理ページと同じ方式）。
 * git commit/push を使うと既存の stash / rebase 運用と競合するため、それを避けている。
 *
 * YouTube は「通常動画 / ショート / 配信アーカイブ」を判別する。
 *   - RSS のうち、確認済み（seenYoutubeIds）でもお知らせ済みでもない動画をすべて判定する
 *     （配信アーカイブは RSS の並び順が後から入れ替わるため、位置ではなくIDで新着を見分ける）。
 *   - 視聴ページのプレーヤー情報（isLiveContent / liveBroadcastDetails）で配信かどうかを見る。
 *     GitHub Actions からは視聴ページがボット確認で欠けることがあるため、判定できなければ
 *     チャンネルの「ライブ / 動画 / ショート」タブの一覧で判定する。
 *   - 予約中・配信中・アーカイブ処理中・判定失敗の動画は通知せず、automation-state.json の
 *     pendingYoutube に残して次回以降に再確認する（lastYoutubeVideoId が進んでも消えない）。
 *
 * ローカル確認用:
 *   node scripts/auto-updates.mjs --dry-run
 *     → GitHub には一切書き込まず、ローカルの data/*.json を読んで判定結果だけ表示する。
 */

import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

// ── 設定 ────────────────────────────────────────────────
const YOUTUBE_FEED = 'https://www.youtube.com/feeds/videos.xml?channel_id=UCcuunZ9BIdaoLhQo1dVIj_A';
const NOTE_FEED    = 'https://note.com/toki_murasaki/rss';

const UPDATES_PATH = 'data/updates.json';
const STATE_PATH   = 'data/automation-state.json';

const MAX_UPDATES  = 100;   // 保存件数の上限（管理ページ側と同じルール）

// 追加される文言。変更したい場合はここだけ直せばよい。
const TEXT = {
  youtubeLong:    'YouTubeに動画が投稿されました。',
  youtubeShort:   'YouTubeにショート動画が投稿されました。',
  youtubeArchive: 'YouTubeに配信アーカイブが公開されました。',
  note:           'noteに記事を公開しました。',
};

// 判定待ち（予約中・配信中・アーカイブ処理中・判定失敗）の動画の扱い。
// 予約〜配信終了までは数週間かかることもあるため長めに待つ。
const PENDING_MAX_DAYS     = 30;  // 予約・配信中・処理中のまま、この日数を過ぎたら追跡をやめる
const MAX_UNKNOWN_ATTEMPTS = 16;  // 情報を取得できない状態がこの回数続いたら追跡をやめる（Actions の実発火で1〜2日程度）
const MAX_PENDING          = 30;  // 判定待ちとして保持する最大件数

const DRY_RUN = process.argv.includes('--dry-run');

const TOKEN  = process.env.GITHUB_TOKEN;
const REPO   = process.env.GITHUB_REPOSITORY;          // "owner/repo"
const BRANCH = process.env.TARGET_BRANCH || 'main';

const UA = 'Mozilla/5.0 (compatible; toki-portfolio-bot/1.0)';

// ── ちいさなユーティリティ ──────────────────────────────
function log(...args) { console.log(...args); }

/** JST の YYYY-MM-DD。Actions は UTC で動くため明示的に +9h する。 */
function jstDate(d = new Date()) {
  return new Date(d.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** XML のテキストノードを取り出す（CDATA と基本的な実体参照に対応）。 */
function unwrapText(raw) {
  if (!raw) return '';
  const cdata = raw.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  const s = cdata ? cdata[1] : raw;
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();
}

async function fetchText(url) {
  const res = await fetch(url, { headers: { 'user-agent': UA } });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.text();
}

// ── RSS パース ─────────────────────────────────────────
// 対象は2つの固定フィードだけなので、依存パッケージを増やさず正規表現で読む。

/** YouTube（Atom）の全エントリ。フィードの並び（新しい順）のまま返す。 */
function parseYoutubeEntries(xml) {
  return String(xml || '').split('<entry>').slice(1).map(chunk => {
    const entry = chunk.split('</entry>')[0];
    const videoId = entry.match(/<yt:videoId>([^<]+)<\/yt:videoId>/)?.[1];
    if (!videoId) return null;
    const rssLink   = entry.match(/<link[^>]+rel="alternate"[^>]+href="([^"]+)"/)?.[1] || '';
    const title     = unwrapText(entry.match(/<title>([\s\S]*?)<\/title>/)?.[1]);
    const published = entry.match(/<published>([^<]+)<\/published>/)?.[1] || '';
    return { videoId, rssLink, title, published };
  }).filter(Boolean);
}

/** YouTube（Atom）の最新1件。 */
function parseYoutubeLatest(xml) {
  return parseYoutubeEntries(xml)[0] || null;
}

/**
 * 前回記録した動画より新しいエントリを返す（新しい順）。
 * 前回の動画がフィードに見当たらない場合（削除・非公開など）は、
 * 過去分をまとめて通知しないよう従来どおり最新1件だけを対象にする。
 */
export function pickNewYoutubeEntries(entries, lastVideoId) {
  if (!entries.length) return [];
  const idx = entries.findIndex(e => e.videoId === lastVideoId);
  if (idx === -1) return entries[0].videoId === lastVideoId ? [] : [entries[0]];
  return entries.slice(0, idx);
}

const MAX_SEEN_IDS = 200;   // 確認済みとして覚えておく動画IDの上限（RSS は最新15件なので十分）

/**
 * 判定対象にする新着エントリを選ぶ。
 *
 * 配信アーカイブは処理が終わると RSS の published が更新されて並び順が入れ替わるため、
 * 「前回の最新より上にあるもの」という位置での判定だと新着を取りこぼすことがある。
 * そこで「確認済みID（seenIds）にも、お知らせ済みにも無いもの」を新着とする。
 * seenIds が無い（この方式になって初回の）場合だけ、従来の位置による判定を使う。
 */
export function pickYoutubeCandidates(entries, { lastVideoId, seenIds, notifiedIds }) {
  if (!Array.isArray(seenIds)) return pickNewYoutubeEntries(entries, lastVideoId);
  const seen = new Set(seenIds);
  return entries.filter(e => !seen.has(e.videoId) && !notifiedIds.has(e.videoId));
}

/** 今回の RSS に載っている動画を確認済みに加える（新しいものを先頭に、上限まで）。 */
export function nextSeenIds(entries, prevSeen) {
  const ids = [...entries.map(e => e.videoId), ...(Array.isArray(prevSeen) ? prevSeen : [])];
  return [...new Set(ids)].slice(0, MAX_SEEN_IDS);
}

// ── YouTube 配信アーカイブ判定 ─────────────────────────
/**
 * 視聴ページに埋め込まれている ytInitialPlayerResponse（YouTube の再生プレーヤーが使う JSON）を取り出す。
 * 文字列中の { } を誤カウントしないよう、引用符とエスケープを考慮して対応する } を探す。
 */
export function extractPlayerResponse(html) {
  return extractJsonAfter(html, 'ytInitialPlayerResponse');
}

/** チャンネルページに埋め込まれている ytInitialData（一覧の表示用 JSON）を取り出す。 */
export function extractInitialData(html) {
  return extractJsonAfter(html, 'ytInitialData');
}

/** html 中の `marker = {...}` の JSON 部分を取り出す。 */
function extractJsonAfter(html, marker) {
  html = String(html || '');
  let pos = 0;
  while ((pos = html.indexOf(marker, pos)) !== -1) {
    pos += marker.length;
    const m = html.slice(pos, pos + 10).match(/^\s*=\s*\{/);
    if (!m) continue;
    const start = pos + m[0].length - 1;
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < html.length; i++) {
      const c = html[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) {
        try { return JSON.parse(html.slice(start, i + 1)); } catch { return null; }
      }
    }
    return null;
  }
  return null;
}

/**
 * プレーヤー情報から動画の状態を判定する（純粋関数。テストしやすいよう通信と分離）。
 *
 * 使う項目（YouTube Data API の liveStreamingDetails / liveBroadcastContent に相当する情報）:
 *   videoDetails.isLiveContent  … ライブ配信として作られた動画なら true（終了後のアーカイブも true）
 *   videoDetails.isUpcoming     … 予約中（配信・プレミア公開の開始前）
 *   videoDetails.isLive / liveBroadcastDetails.isLiveNow … 配信中
 *   liveBroadcastDetails.endTimestamp … 配信が終了した時刻
 *   playabilityStatus.status    … "OK" なら視聴可能
 *
 * @returns {{kind: 'archive'|'video'|'upcoming'|'live'|'processing'|'unknown', reason: string, endTime?: string}}
 *   archive    … 配信終了済みで、アーカイブとして視聴できる
 *   video      … ライブ配信ではない通常のアップロード動画（ショート判定はこの後で別途行う）
 *   upcoming / live / processing … まだ通知しない（判定待ちとして次回以降に再確認）
 *   unknown    … 判定に必要な情報が取れなかった（再試行）
 */
export function classifyPlayerResponse(pr, videoId) {
  const vd = pr?.videoDetails;
  if (!vd) return { kind: 'unknown', reason: 'videoDetails なし' };
  if (videoId && vd.videoId && vd.videoId !== videoId) return { kind: 'unknown', reason: '別の動画の情報' };

  const lbd    = pr.microformat?.playerMicroformatRenderer?.liveBroadcastDetails;
  const status = pr.playabilityStatus?.status || '';

  if (vd.isUpcoming === true || status === 'LIVE_STREAM_OFFLINE') {
    return { kind: 'upcoming', reason: '予約中（開始前）' };
  }
  if (vd.isLive === true || lbd?.isLiveNow === true) {
    return { kind: 'live', reason: '配信中' };
  }

  if (vd.isLiveContent === true) {
    if (!lbd?.endTimestamp) return { kind: 'processing', reason: '配信は開始前・中でないが終了時刻が未確定' };
    if (status === 'OK')    return { kind: 'archive', reason: `配信終了(${lbd.endTimestamp})・視聴可能`, endTime: lbd.endTimestamp };
    if (status === 'UNPLAYABLE') return { kind: 'processing', reason: `配信終了済みだがまだ視聴できない(${status})` };
    return { kind: 'unknown', reason: `配信終了済みだが視聴可否を判定できない(${status || '不明'})` };
  }
  if (vd.isLiveContent === false) {
    // プレミア公開も終了後はここ（isLiveContent=false）に来るため「動画」として扱う。
    return { kind: 'video', reason: 'ライブ配信ではない動画' };
  }
  return { kind: 'unknown', reason: 'isLiveContent なし' };
}

/** 視聴ページを取得して状態を判定する。通信・解析の失敗はすべて unknown にする。 */
export async function inspectYoutubeVideo(videoId) {
  try {
    const res = await fetch(`https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&hl=ja`, {
      headers: { 'user-agent': UA, 'accept-language': 'ja,en;q=0.8' },
    });
    if (!res.ok) return { kind: 'unknown', reason: `視聴ページ HTTP ${res.status}` };
    const html = await res.text();
    const pr = extractPlayerResponse(html);
    if (!pr) return { kind: 'unknown', reason: `プレーヤー情報を読み取れない(HTML ${html.length}文字)` };
    const r = classifyPlayerResponse(pr, videoId);
    if (r.kind === 'unknown' && !pr.videoDetails) {
      // GitHub Actions のサーバーからだと、ボット確認（LOGIN_REQUIRED 等）で videoDetails が欠けたページが返る。
      // 原因を追えるよう、YouTube が返した状態をログ用に添える（認証情報は含まれない）。
      const ps = pr.playabilityStatus || {};
      r.reason += `(playability=${ps.status || '不明'}${ps.reason ? `: ${String(ps.reason).slice(0, 60)}` : ''})`;
    }
    return r;
  } catch (e) {
    return { kind: 'unknown', reason: `視聴ページ取得失敗(${e.message})` };
  }
}

// ── チャンネル一覧（ライブ / 動画 / ショート タブ）による補助判定 ─────
// 視聴ページは GitHub Actions のサーバーからだとボット確認でプレーヤー情報が欠けることがある
// （2026-11-15〜22 に実際に発生し、全動画が判定不能で止まった）。
// チャンネルの各タブは同じ条件でも取得できるため、視聴ページで判定できなかった場合はこちらで判定する。
//   ライブタブに載っている → ライブ配信（再生時間が付いていれば視聴可能なアーカイブ）
//   動画タブに載っている   → 通常動画（プレミア公開を含む）
//   ショートタブに載っている → ショート
const CHANNEL_ID = YOUTUBE_FEED.match(/channel_id=([\w-]+)/)[1];
const CHANNEL_TABS = ['streams', 'videos', 'shorts'];

/**
 * チャンネルの1タブ分の ytInitialData から、載っている動画の状態を読む（純粋関数）。
 * @returns {Map<string, {duration: string, live: boolean, upcoming: boolean, membersOnly: boolean}>}
 */
export function parseChannelTab(data) {
  const out = new Map();
  const seen = new WeakSet();
  const flags = (node) => {
    const s = JSON.stringify(node);
    return {
      live:        /BADGE_STYLE_LIVE|BADGE_STYLE_TYPE_LIVE_NOW|"LIVE"|"ライブ"/.test(s),
      upcoming:    /upcomingEventData|UPCOMING|"近日公開"|公開予定|"予定"/.test(s),
      membersOnly: /MEMBERS_ONLY|メンバー限定|Members only/i.test(s),
    };
  };
  const isDuration = (t) => /^\d{1,2}(:\d{2}){1,2}$/.test(String(t || '').trim());
  const add = (id, info) => { if (id && !out.has(id)) out.set(id, info); };

  (function walk(o) {
    if (!o || typeof o !== 'object' || seen.has(o)) return;
    seen.add(o);
    if (o.lockupViewModel?.contentId) {
      const l = o.lockupViewModel;
      let duration = '';
      (function badges(x) {
        if (!x || typeof x !== 'object') return;
        const b = x.thumbnailBadgeViewModel;
        if (b && !duration && isDuration(b.text) && !/LIVE/.test(b.badgeStyle || '')) duration = b.text.trim();
        for (const v of Object.values(x)) badges(v);
      })(l.contentImage);
      add(l.contentId, { duration, ...flags(l) });
      return;
    }
    const vr = o.videoRenderer || o.gridVideoRenderer;   // 旧形式の一覧
    if (vr?.videoId) {
      const t = vr.lengthText?.simpleText || '';
      add(vr.videoId, { duration: isDuration(t) ? t : '', ...flags(vr) });
      return;
    }
    const sid = o.shortsLockupViewModel?.onTap?.innertubeCommand?.reelWatchEndpoint?.videoId
             || o.reelItemRenderer?.videoId;
    if (sid) { add(sid, { duration: '', live: false, upcoming: false, membersOnly: false }); return; }
    for (const v of Object.values(o)) walk(v);
  })(data);
  return out;
}

/**
 * タブの内容から動画の状態を判定する（純粋関数）。
 * @param {{streams: Map|null, videos: Map|null, shorts: Map|null}} tabs  取得失敗したタブは null
 * @returns {{kind: string, reason: string, format?: 'short'|'long'}}
 */
export function classifyFromChannelTabs(videoId, tabs) {
  const s = tabs?.streams?.get(videoId);
  if (s) {
    if (s.membersOnly) return { kind: 'processing', reason: 'メンバー限定の配信（一般公開されていない）' };
    if (s.live)        return { kind: 'live',       reason: '配信中（ライブタブ）' };
    if (s.upcoming)    return { kind: 'upcoming',   reason: '予約中（ライブタブ）' };
    if (s.duration)    return { kind: 'archive',    reason: `配信アーカイブ（ライブタブ・${s.duration}）` };
    return { kind: 'processing', reason: 'ライブタブにあるが再生時間が未確定（アーカイブ処理中）' };
  }
  if (tabs?.shorts?.has(videoId)) return { kind: 'video', reason: 'ショート（ショートタブ）', format: 'short' };
  const v = tabs?.videos?.get(videoId);
  if (v) {
    if (v.membersOnly) return { kind: 'processing', reason: 'メンバー限定の動画（一般公開されていない）' };
    if (v.live)        return { kind: 'live',       reason: 'プレミア公開中（動画タブ）' };
    if (v.upcoming)    return { kind: 'upcoming',   reason: 'プレミア公開の予約中（動画タブ）' };
    if (v.duration)    return { kind: 'video',      reason: `通常動画（動画タブ・${v.duration}）`, format: 'long' };
    return { kind: 'processing', reason: '動画タブにあるが再生時間が未確定' };
  }
  const failed = CHANNEL_TABS.filter(t => !tabs?.[t]);
  if (failed.length === CHANNEL_TABS.length) return { kind: 'unknown', reason: 'チャンネル一覧を取得できない' };
  // ライブタブが取れていないなら、配信の可能性を否定できないので判定不能のまま。
  return { kind: 'unknown', reason: `チャンネル一覧に見当たらない${failed.length ? `（取得失敗: ${failed.join(',')}）` : ''}` };
}

/** チャンネルの各タブを取得する。失敗したタブは null。1回の実行で1度だけ取得するよう呼び出し側でキャッシュする。 */
export async function fetchChannelTabs() {
  const tabs = {};
  for (const t of CHANNEL_TABS) {
    try {
      const res = await fetch(`https://www.youtube.com/channel/${CHANNEL_ID}/${t}?hl=ja`, {
        headers: { 'user-agent': UA, 'accept-language': 'ja,en;q=0.8' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = extractInitialData(await res.text());
      if (!data) throw new Error('ytInitialData を読み取れない');
      tabs[t] = parseChannelTab(data);
      log(`  [チャンネル一覧] ${t}: ${tabs[t].size}件`);
    } catch (e) {
      tabs[t] = null;
      log(`  [チャンネル一覧] ${t}: 取得失敗(${e.message})`);
    }
  }
  return tabs;
}

/**
 * 視聴ページで判定し、判定不能ならチャンネル一覧で判定する。
 * @param {() => Promise<object>} loadTabs  チャンネル一覧を返す関数（キャッシュ付き）
 */
export async function inspectYoutubeVideoWithFallback(videoId, loadTabs, inspectWatch = inspectYoutubeVideo) {
  const w = await inspectWatch(videoId);
  if (w.kind !== 'unknown') return { ...w, source: '視聴ページ' };
  const t = classifyFromChannelTabs(videoId, await loadTabs());
  if (t.kind !== 'unknown') return { ...t, source: 'チャンネル一覧', reason: `${t.reason} ／視聴ページ: ${w.reason}` };
  return { kind: 'unknown', source: '-', reason: `視聴ページ: ${w.reason} ／チャンネル一覧: ${t.reason}` };
}

/** 1回の実行で1度だけチャンネル一覧を取得するローダー。 */
export function createTabsLoader(fetcher = fetchChannelTabs) {
  let p = null;
  return () => (p ||= fetcher());
}

/** updates.json のリンクから YouTube の動画IDを取り出す（youtu.be / shorts / watch / live 形式）。 */
export function youtubeIdFromLink(link) {
  const s = String(link || '');
  const m = s.match(/(?:youtu\.be\/|youtube\.com\/(?:shorts\/|live\/|embed\/|watch\?(?:.*&)?v=))([\w-]{11})/);
  return m ? m[1] : '';
}

/** note（RSS 2.0）の最新1件。 */
function parseNoteLatest(xml) {
  const item = xml.split('<item>')[1]?.split('</item>')[0];
  if (!item) return null;

  // <description> 内にも <a href> が入るため、description を除いてから <link> を探す。
  const skeleton = item.replace(/<description>[\s\S]*?<\/description>/, '');
  const link  = unwrapText(skeleton.match(/<link>([\s\S]*?)<\/link>/)?.[1]);
  if (!link) return null;

  const title = unwrapText(skeleton.match(/<title>([\s\S]*?)<\/title>/)?.[1]);
  return { link, title };
}

// ── YouTube 長尺 / ショート判定 ────────────────────────
/**
 * 動画がショートかどうかを判定する。差し替えやすいようこの関数に閉じてある。
 *
 * 主判定: https://www.youtube.com/shorts/{id} にアクセスしてリダイレクト挙動を見る。
 *   - 200 のまま（リダイレクトされない） → ショート
 *   - 3xx で /watch?v= に飛ばされる       → 長尺
 * 補助:   主判定が不確実だった場合のみ、RSS の alternate link が /shorts/ かどうかを見る。
 *
 * 判定できない・失敗した・例外が出た場合は必ず「長尺」に倒す。
 * （ショートを長尺と書くのは許容、長尺をショートと誤記するのは避けたいため）
 *
 * @returns {Promise<'short'|'long'>}
 */
export async function detectYoutubeFormat({ videoId, rssLink, title }) {
  try {
    const res = await fetch(`https://www.youtube.com/shorts/${videoId}`, {
      method: 'GET',
      redirect: 'manual',
      headers: { 'user-agent': UA },
    });

    if (res.status === 200) {
      log(`  [判定] /shorts/ が 200 → ショート`);
      return 'short';
    }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location') || '';
      if (loc.includes('/watch')) {
        log(`  [判定] /watch へリダイレクト → 長尺`);
        return 'long';
      }
      log(`  [判定] 想定外のリダイレクト先(${loc}) → 補助判定へ`);
    } else {
      log(`  [判定] 想定外のステータス(${res.status}) → 補助判定へ`);
    }
  } catch (e) {
    log(`  [判定] アクセス失敗(${e.message}) → 補助判定へ`);
  }

  // 補助判定。ショートだと明示されている場合のみショート扱い、それ以外は長尺。
  if (/\/shorts\//.test(rssLink) || /#shorts/i.test(title || '')) {
    log('  [判定] RSS がショートを示している → ショート');
    return 'short';
  }
  log('  [判定] 決め手なし → 長尺（安全側）');
  return 'long';
}

// ── updates.json のマージ ──────────────────────────────
/**
 * 既存の更新情報に新規項目を先頭から差し込む。
 * 同じ URL が既にある項目は足さない（状態ファイルとは別の、重複防止の二重の備え）。
 * 保存件数は上限まで間引く。
 *
 * @returns {{list: any[], added: any[]}} 追加後の配列と、実際に追加された項目
 */
export function mergeUpdates(existing, newEntries, max = MAX_UPDATES) {
  const list  = Array.isArray(existing) ? existing : [];
  // URL の完全一致に加え、YouTube は動画IDでも照合する
  // （同じ動画が youtu.be/… と youtube.com/shorts/… の別形式で二重に入るのを防ぐ）。
  const known = new Set();
  const remember = (link) => {
    if (!link) return;
    known.add(link);
    const id = youtubeIdFromLink(link);
    if (id) known.add(`yt:${id}`);
  };
  const isKnown = (link) => known.has(link) || (youtubeIdFromLink(link) && known.has(`yt:${youtubeIdFromLink(link)}`));
  list.forEach(u => remember(u && u.link));
  const added = [];
  for (const e of newEntries) {
    if (isKnown(e.link)) continue;
    added.push(e);
    remember(e.link);
  }
  return { list: [...added, ...list].slice(0, max), added };
}

/**
 * YouTube の判定対象（新着＋前回からの判定待ち）を1件ずつ判定し、
 * 通知する項目と、次回に持ち越す判定待ちリストを返す。
 *
 * @param {object}   p
 * @param {Array}    p.candidates  [{videoId, title, rssLink, published}]（新着）
 * @param {Array}    p.pending     state.pendingYoutube（前回からの判定待ち）
 * @param {Set}      p.notifiedIds updates.json に既に載っている動画ID（重複防止）
 * @param {Function} p.inspect     (videoId) => Promise<{kind, reason, endTime?}>
 * @param {Function} p.detectFormat (entry) => Promise<'short'|'long'>
 * @param {Date}     p.now
 */
export async function processYoutubeCandidates({ candidates, pending, notifiedIds, inspect, detectFormat, now = new Date() }) {
  const nowIso = now.toISOString();
  const items  = new Map();
  // 判定待ちを先に並べ、新着で同じIDがあれば初回検出時刻などは判定待ち側を引き継ぐ。
  for (const p of (Array.isArray(pending) ? pending : [])) {
    if (p && p.videoId && !items.has(p.videoId)) items.set(p.videoId, { ...p });
  }
  for (const c of candidates) {
    const prev = items.get(c.videoId);
    items.set(c.videoId, {
      videoId:   c.videoId,
      title:     c.title || prev?.title || '',
      rssLink:   c.rssLink || prev?.rssLink || '',
      published: c.published || prev?.published || '',
      firstSeen: prev?.firstSeen || nowIso,
      unknownCount: prev?.unknownCount || 0,
    });
  }

  const entries = [];     // 通知する項目（sortKey 付き）
  const stillPending = [];
  const gaveUp = [];
  const stats = { checked: 0, archive: 0, video: 0, short: 0, pending: 0, unknown: 0, gaveUp: 0, skipped: 0 };

  for (const item of items.values()) {
    if (notifiedIds.has(item.videoId)) {
      log(`  ${item.videoId}: 既にお知らせ済みのためスキップ`);
      stats.skipped++;
      continue;
    }
    stats.checked++;
    const r = await inspect(item.videoId);
    log(`  ${item.videoId}: ${r.kind}${r.source ? `［${r.source}］` : ''}（${r.reason}）`);

    if (r.kind === 'archive') {
      entries.push({
        sortKey: r.endTime || item.published || nowIso,
        entry: { date: jstDate(now), text: TEXT.youtubeArchive, link: `https://youtu.be/${item.videoId}`, source: 'auto' },
      });
      notifiedIds.add(item.videoId);
      stats.archive++;
      continue;
    }
    if (r.kind === 'video') {
      // チャンネル一覧で判定した場合は、どのタブに載っていたかでショートかどうかも分かっている。
      const format = r.format || await detectFormat(item);
      stats[format === 'short' ? 'short' : 'video']++;
      entries.push({
        sortKey: item.published || nowIso,
        entry: {
          date: jstDate(now),
          text: format === 'short' ? TEXT.youtubeShort : TEXT.youtubeLong,
          link: format === 'short' ? `https://youtube.com/shorts/${item.videoId}` : `https://youtu.be/${item.videoId}`,
          source: 'auto',
        },
      });
      notifiedIds.add(item.videoId);
      continue;
    }

    // ここから先は「まだ通知しない」。判定待ちとして次回に持ち越す。
    const next = {
      ...item,
      lastStatus: r.kind,
      lastReason: r.reason,
      lastChecked: nowIso,
      unknownCount: r.kind === 'unknown' ? (item.unknownCount || 0) + 1 : 0,
    };
    const ageDays = (now.getTime() - Date.parse(next.firstSeen || nowIso)) / 86400000;
    stats[r.kind === 'unknown' ? 'unknown' : 'pending']++;
    if (next.unknownCount >= MAX_UNKNOWN_ATTEMPTS) {
      gaveUp.push({ ...next, why: `判定に必要な情報を ${next.unknownCount} 回続けて取得できませんでした` });
      stats.gaveUp++;
    } else if (ageDays > PENDING_MAX_DAYS) {
      gaveUp.push({ ...next, why: `${PENDING_MAX_DAYS} 日を過ぎてもアーカイブ公開を確認できませんでした` });
      stats.gaveUp++;
    } else {
      stillPending.push(next);
    }
  }

  entries.sort((a, b) => String(b.sortKey).localeCompare(String(a.sortKey)));
  return {
    newEntries: entries.map(e => e.entry),
    pending: stillPending.slice(0, MAX_PENDING),
    gaveUp,
    stats,
  };
}

// ── GitHub Contents API ────────────────────────────────
function ghHeaders() {
  return {
    'Authorization': `Bearer ${TOKEN}`,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': UA,
  };
}

/** ファイルを取得。存在しなければ null。 */
async function ghGetJson(path) {
  const res = await fetch(
    `https://api.github.com/repos/${REPO}/contents/${path}?ref=${BRANCH}`,
    { headers: ghHeaders() }
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GET ${path} -> HTTP ${res.status} ${await res.text()}`);
  const json = await res.json();
  const text = Buffer.from(json.content.replace(/\n/g, ''), 'base64').toString('utf8');
  return { data: JSON.parse(text), sha: json.sha };
}

/** ファイルを書き込む。 */
async function ghPutJson(path, data, message, sha) {
  const content = Buffer.from(JSON.stringify(data, null, 2) + '\n', 'utf8').toString('base64');
  const body = { message, content, branch: BRANCH };
  if (sha) body.sha = sha;

  const res = await fetch(`https://api.github.com/repos/${REPO}/contents/${path}`, {
    method: 'PUT',
    headers: { ...ghHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`PUT ${path} -> HTTP ${res.status} ${await res.text()}`);
  return res.json();
}

/**
 * 取得 → 加工 → 書き込み。管理ページからの保存と衝突（409）したら取り直して再試行する。
 * mutate(data) は書き込む内容を返す。null を返した場合は書き込みをスキップ。
 */
async function ghUpdateJson(path, fallback, mutate, message, attempts = 3) {
  for (let i = 1; i <= attempts; i++) {
    const current = await ghGetJson(path);
    const next = mutate(current ? current.data : fallback);
    if (next === null) return false;
    try {
      await ghPutJson(path, next, message, current?.sha);
      return true;
    } catch (e) {
      if (/HTTP 409/.test(e.message) && i < attempts) {
        log(`  競合を検知（${i}回目）。取り直して再試行します。`);
        continue;
      }
      throw e;
    }
  }
  return false;
}

// ── メイン ─────────────────────────────────────────────
async function main() {
  if (!DRY_RUN && (!TOKEN || !REPO)) {
    throw new Error('GITHUB_TOKEN / GITHUB_REPOSITORY が設定されていません');
  }

  // 現在の状態を読む
  let state;
  if (DRY_RUN) {
    state = JSON.parse(await readFile(STATE_PATH, 'utf8').catch(() => '{}'));
  } else {
    state = (await ghGetJson(STATE_PATH))?.data ?? {};
  }
  const lastVideoId = state.lastYoutubeVideoId || '';
  const lastNoteUrl = state.lastNoteUrl || '';
  log(`前回の状態: youtube=${lastVideoId || '(未設定)'} / note=${lastNoteUrl || '(未設定)'}`);

  // 各フィードの最新1件を取る。片方が落ちてももう片方は処理する。
  let ytEntries = null, note = null;
  try {
    ytEntries = parseYoutubeEntries(await fetchText(YOUTUBE_FEED));
    const yt = ytEntries[0];
    log(`YouTube 最新: ${yt ? `${yt.videoId} / ${yt.title}` : '(取得できず)'}`);
    if (!yt) ytEntries = null;
  } catch (e) {
    console.error(`YouTube RSS の取得に失敗: ${e.message}`);
  }
  try {
    note = parseNoteLatest(await fetchText(NOTE_FEED));
    log(`note 最新: ${note ? `${note.link} / ${note.title}` : '(取得できず)'}`);
  } catch (e) {
    console.error(`note RSS の取得に失敗: ${e.message}`);
  }

  // 初回（状態が空）は「今の最新」を覚えるだけで投稿はしない。
  // 過去の投稿をまとめて追加してしまうのを防ぐため。
  // 判定は YouTube / note それぞれ独立に行う。
  // 片方の RSS 取得に失敗して状態が空のまま残っても、次回それを新規投稿と誤認しないようにするため。
  const seedYoutube = !lastVideoId;
  const seedNote    = !lastNoteUrl;
  if (seedYoutube) log('YouTube の状態が空のため、今回は現在の最新を記録するだけにします。');
  if (seedNote)    log('note の状態が空のため、今回は現在の最新を記録するだけにします。');

  // 既にお知らせ済みの動画ID（重複通知の防止に使う）。
  let currentUpdates = [];
  try {
    currentUpdates = DRY_RUN
      ? JSON.parse(await readFile(UPDATES_PATH, 'utf8').catch(() => '[]'))
      : ((await ghGetJson(UPDATES_PATH))?.data ?? []);
  } catch (e) {
    // 読めなくても書き込み時に mergeUpdates が URL・動画IDで重複を弾くので続行する。
    console.error(`updates.json の事前読み込みに失敗: ${e.message}`);
  }
  const notifiedIds = new Set(
    (Array.isArray(currentUpdates) ? currentUpdates : []).map(u => youtubeIdFromLink(u && u.link)).filter(Boolean)
  );

  const newEntries = [];

  // YouTube: 新着（前回の最新より新しいもの全部）＋前回からの判定待ちを判定する。
  // 予約中・配信中・処理中・判定失敗の動画は pendingYoutube に残し、
  // lastYoutubeVideoId が先へ進んでも検出対象から消えないようにする。
  const prevPending = Array.isArray(state.pendingYoutube) ? state.pendingYoutube : [];
  const prevSeen    = Array.isArray(state.seenYoutubeIds) ? state.seenYoutubeIds : null;
  let nextPending = prevPending;
  let seenIds     = prevSeen;
  let ytOk        = !!ytEntries;   // YouTube 側の処理が最後まで済んだか（失敗時は状態を進めない）
  let gaveUp = [];
  log(`[集計] YouTube RSS: ${ytEntries ? `${ytEntries.length}件取得` : '取得失敗'}`);
  if (!seedYoutube && ytEntries) {
    // YouTube 側で想定外の例外が出ても note の処理は続ける。
    try {
      const candidates = pickYoutubeCandidates(ytEntries, { lastVideoId, seenIds: prevSeen, notifiedIds });
      log(`[集計] YouTube 新規検出: ${candidates.length}件${candidates.length ? `（${candidates.map(c => c.videoId).join(', ')}）` : ''} / 前回からの判定待ち: ${prevPending.length}件`);
      if (candidates.length || prevPending.length) {
        const loadTabs = createTabsLoader();
        const r = await processYoutubeCandidates({
          candidates,
          pending: prevPending,
          notifiedIds,
          inspect: (id) => inspectYoutubeVideoWithFallback(id, loadTabs),
          detectFormat: detectYoutubeFormat,
        });
        newEntries.push(...r.newEntries);
        nextPending = r.pending;
        gaveUp = r.gaveUp;
        const s = r.stats;
        log(`[集計] YouTube 判定: 対象 ${s.checked}件 → 成功 ${s.archive + s.video + s.short}件（配信アーカイブ ${s.archive} / 動画 ${s.video} / ショート ${s.short}）` +
            ` / 保留 ${s.pending}件 / 判定不能 ${s.unknown}件 / 打ち切り ${s.gaveUp}件 / お知らせ済みでスキップ ${s.skipped}件`);
        for (const p of nextPending) log(`  [保留] ${p.videoId} ${p.lastStatus}: ${p.lastReason}`);
      }
      seenIds = nextSeenIds(ytEntries, prevSeen);
    } catch (e) {
      ytOk = false;
      console.error(`::error::YouTube の判定処理で例外が発生しました（note の処理は続行します）: ${e.message}`);
      process.exitCode = 1;
    }
  } else if (seedYoutube && ytEntries) {
    seenIds = nextSeenIds(ytEntries, prevSeen);
  }

  if (note && note.link !== lastNoteUrl && !seedNote) {
    newEntries.push({
      date: jstDate(),
      text: TEXT.note,
      link: note.link,
      source: 'auto',
    });
  }

  const nextState = {
    lastYoutubeVideoId: ytOk && ytEntries[0] ? ytEntries[0].videoId : lastVideoId,
    lastNoteUrl:        note ? note.link : lastNoteUrl,
    pendingYoutube:     nextPending,
  };
  if (seenIds) nextState.seenYoutubeIds = seenIds;

  log(`[集計] 通知追加予定: ${newEntries.length}件（YouTube ${newEntries.filter(e => /YouTube/.test(e.text)).length} / note ${newEntries.filter(e => e.text === TEXT.note).length}）`);
  if (newEntries.length === 0) {
    log('新しい投稿はありませんでした。');
  } else {
    log(`追加する項目: ${newEntries.length}件`);
    newEntries.forEach(e => log(`  - ${e.text} ${e.link}`));
  }

  if (DRY_RUN) {
    // 実際の書き込みはせず、ローカルの updates.json に対してマージ結果だけ確認する。
    const local = JSON.parse(await readFile(UPDATES_PATH, 'utf8').catch(() => '[]'));
    const { list, added } = mergeUpdates(local, newEntries);
    log('\n--- dry-run のためここで終了（GitHub には書き込みません） ---');
    log(`updates.json: ${local.length}件 → ${list.length}件（実際に追加 ${added.length}件）`);
    if (added.length !== newEntries.length) {
      log('  ※ URL が既に存在する項目は重複防止でスキップされました。');
    }
    log('先頭3件:', JSON.stringify(list.slice(0, 3), null, 2));
    log('次の状態:', JSON.stringify(nextState));
    reportGaveUp(gaveUp);
    return;
  }

  // updates.json を更新
  // 失敗した場合は状態を保存せずに終了する（次回、同じ動画・記事を改めて通知できるように）。
  if (newEntries.length > 0) {
    const wrote = await ghUpdateJson(
      UPDATES_PATH, [],
      (updates) => {
        const { list, added } = mergeUpdates(updates, newEntries);
        if (added.length === 0) {
          log('  updates.json に既に存在するため追加をスキップします。');
          return null;
        }
        return list;
      },
      'add update (auto)'
    ).catch(e => {
      console.error(`::error::[保存] updates.json の保存に失敗しました: ${e.message}`);
      throw e;
    });
    log(wrote ? '[保存] updates.json: 成功' : '[保存] updates.json: 追加なし（既に存在）');
  }

  // 状態を更新（最新を覚える）
  // 既存の項目（将来追加されるものを含む）を消さないよう、現在の内容に重ねて書く。
  await ghUpdateJson(STATE_PATH, {}, (cur) => ({ ...(cur || {}), ...nextState }), 'update automation state')
    .catch(e => {
      console.error(`::error::[保存] automation-state.json の保存に失敗しました: ${e.message}`);
      throw e;
    });
  log('[保存] automation-state.json: 成功');

  reportGaveUp(gaveUp);
}

/**
 * 追跡を打ち切った動画を Actions のエラーとして表示し、実行を失敗扱いにする。
 * 誤通知を避けるため自動では通知しないので、GitHub からの失敗メールで気付けるようにする。
 * （状態は書き込み済みなので、同じ動画で何度も失敗することはない）
 */
function reportGaveUp(gaveUp) {
  if (!gaveUp.length) return;
  for (const g of gaveUp) {
    console.error(`::error::YouTube ${g.videoId}「${g.title}」の判定を打ち切りました: ${g.why}。` +
      `必要なら管理ページから手動でお知らせを追加してください。最後の状態: ${g.lastStatus}（${g.lastReason}）`);
  }
  process.exitCode = 1;
}

// 判定ロジックだけを個別に試せるよう、パースも公開しておく。
export { parseYoutubeLatest, parseYoutubeEntries, parseNoteLatest, main };

// 直接実行されたときだけ動かす（テストから import しても main は走らない）。
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => {
    console.error('エラー:', e.message);
    process.exit(1);
  });
}
