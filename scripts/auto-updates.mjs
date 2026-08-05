#!/usr/bin/env node
/**
 * YouTube / note の新規投稿を検知して data/updates.json に自動追加する。
 *
 * GitHub Actions（.github/workflows/auto-updates.yml）から30分おきに実行される。
 * 書き込みは git ではなく GitHub Contents API 経由で行う（管理ページと同じ方式）。
 * git commit/push を使うと既存の stash / rebase 運用と競合するため、それを避けている。
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
  youtubeLong:  'YouTubeに動画が投稿されました。',
  youtubeShort: 'YouTubeにショート動画が投稿されました。',
  note:         'noteに記事を公開しました。',
};

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

/** YouTube（Atom）の最新1件。 */
function parseYoutubeLatest(xml) {
  const entry = xml.split('<entry>')[1]?.split('</entry>')[0];
  if (!entry) return null;

  const videoId = entry.match(/<yt:videoId>([^<]+)<\/yt:videoId>/)?.[1];
  if (!videoId) return null;

  const rssLink = entry.match(/<link[^>]+rel="alternate"[^>]+href="([^"]+)"/)?.[1] || '';
  const title   = unwrapText(entry.match(/<title>([\s\S]*?)<\/title>/)?.[1]);

  return { videoId, rssLink, title };
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
  const known = new Set(list.map(u => u && u.link).filter(Boolean));
  const added = newEntries.filter(e => !known.has(e.link));
  return { list: [...added, ...list].slice(0, max), added };
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
  let yt = null, note = null;
  try {
    yt = parseYoutubeLatest(await fetchText(YOUTUBE_FEED));
    log(`YouTube 最新: ${yt ? `${yt.videoId} / ${yt.title}` : '(取得できず)'}`);
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

  const newEntries = [];

  if (yt && yt.videoId !== lastVideoId && !seedYoutube) {
    const format = await detectYoutubeFormat(yt);
    newEntries.push({
      date: jstDate(),
      text: format === 'short' ? TEXT.youtubeShort : TEXT.youtubeLong,
      link: format === 'short'
        ? `https://youtube.com/shorts/${yt.videoId}`
        : `https://youtu.be/${yt.videoId}`,
      source: 'auto',
    });
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
    lastYoutubeVideoId: yt ? yt.videoId : lastVideoId,
    lastNoteUrl:        note ? note.link : lastNoteUrl,
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
  await ghUpdateJson(STATE_PATH, {}, () => nextState, 'update automation state');
  log('automation-state.json を更新しました。');
}

// 判定ロジックだけを個別に試せるよう、パースも公開しておく。
export { parseYoutubeLatest, parseNoteLatest };

// 直接実行されたときだけ動かす（テストから import しても main は走らない）。
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => {
    console.error('エラー:', e.message);
    process.exit(1);
  });
}
