#!/usr/bin/env node
/**
 * YouTube / note の新規投稿を検知して data/updates.json に自動追加する。
 *
 * GitHub Actions（.github/workflows/auto-updates.yml）から30分おきに実行される。
 * 書き込みは git ではなく GitHub Contents API 経由で行う（管理ページと同じ方式）。
 * git commit/push を使うと既存の stash / rebase 運用と競合するため、それを避けている。
 *
 * YouTube は「通常動画 / ショート / 配信アーカイブ」を判別する。
 *   - 前回記録した動画より新しい RSS エントリをすべて判定する（短時間に複数投稿されても取りこぼさない）。
 *   - 視聴ページのプレーヤー情報（isLiveContent / liveBroadcastDetails）で配信かどうかを見る。
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

// ── YouTube 配信アーカイブ判定 ─────────────────────────
/**
 * 視聴ページに埋め込まれている ytInitialPlayerResponse（YouTube の再生プレーヤーが使う JSON）を取り出す。
 * 文字列中の { } を誤カウントしないよう、引用符とエスケープを考慮して対応する } を探す。
 */
export function extractPlayerResponse(html) {
  const marker = 'ytInitialPlayerResponse';
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
    const pr = extractPlayerResponse(await res.text());
    if (!pr) return { kind: 'unknown', reason: 'プレーヤー情報を読み取れない' };
    return classifyPlayerResponse(pr, videoId);
  } catch (e) {
    return { kind: 'unknown', reason: `視聴ページ取得失敗(${e.message})` };
  }
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

  for (const item of items.values()) {
    if (notifiedIds.has(item.videoId)) {
      log(`  ${item.videoId}: 既にお知らせ済みのためスキップ`);
      continue;
    }
    const r = await inspect(item.videoId);
    log(`  ${item.videoId}: ${r.kind}（${r.reason}）`);

    if (r.kind === 'archive') {
      entries.push({
        sortKey: r.endTime || item.published || nowIso,
        entry: { date: jstDate(now), text: TEXT.youtubeArchive, link: `https://youtu.be/${item.videoId}`, source: 'auto' },
      });
      notifiedIds.add(item.videoId);
      continue;
    }
    if (r.kind === 'video') {
      const format = await detectFormat(item);
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
    if (next.unknownCount >= MAX_UNKNOWN_ATTEMPTS) {
      gaveUp.push({ ...next, why: `判定に必要な情報を ${next.unknownCount} 回続けて取得できませんでした` });
    } else if (ageDays > PENDING_MAX_DAYS) {
      gaveUp.push({ ...next, why: `${PENDING_MAX_DAYS} 日を過ぎてもアーカイブ公開を確認できませんでした` });
    } else {
      stillPending.push(next);
    }
  }

  entries.sort((a, b) => String(b.sortKey).localeCompare(String(a.sortKey)));
  return {
    newEntries: entries.map(e => e.entry),
    pending: stillPending.slice(0, MAX_PENDING),
    gaveUp,
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
  let nextPending = prevPending;
  let gaveUp = [];
  if (!seedYoutube) {
    const candidates = ytEntries ? pickNewYoutubeEntries(ytEntries, lastVideoId) : [];
    if (candidates.length || prevPending.length) {
      log(`YouTube 判定対象: 新着 ${candidates.length}件 / 判定待ち ${prevPending.length}件`);
      const r = await processYoutubeCandidates({
        candidates,
        pending: prevPending,
        notifiedIds,
        inspect: inspectYoutubeVideo,
        detectFormat: detectYoutubeFormat,
      });
      newEntries.push(...r.newEntries);
      nextPending = r.pending;
      gaveUp = r.gaveUp;
      if (nextPending.length) log(`判定待ちとして持ち越し: ${nextPending.map(p => `${p.videoId}(${p.lastStatus})`).join(', ')}`);
    }
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
    lastYoutubeVideoId: ytEntries && ytEntries[0] ? ytEntries[0].videoId : lastVideoId,
    lastNoteUrl:        note ? note.link : lastNoteUrl,
    pendingYoutube:     nextPending,
  };

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
    );
    if (wrote) log('updates.json を更新しました。');
  }

  // 状態を更新（updates.json の更新可否にかかわらず、最新を覚える）
  // 既存の項目（将来追加されるものを含む）を消さないよう、現在の内容に重ねて書く。
  await ghUpdateJson(STATE_PATH, {}, (cur) => ({ ...(cur || {}), ...nextState }), 'update automation state');
  log('automation-state.json を更新しました。');

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
