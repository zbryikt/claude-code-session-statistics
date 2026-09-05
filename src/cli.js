/** ccs — Claude Code session 總覽 / 摘要 / 統計 / 備份。 */
import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { connect } from './db.js';
import * as scan from './scan.js';
import * as summarize from './summarize.js';
import * as backupMod from './backup.js';
import { ago, human, pad, trunc, width } from './util.js';

const SESSIONS_DIR = join(homedir(), '.claude/sessions');
const COMMANDS = ['ls', 'sum', 'sync', 'stats', 'resume', 'backup', 'help'];

/**
 * { sessionId: {pid, status} }，只含進程還活著的。
 * ~/.claude/sessions/<pid>.json 只反映當下（進程結束就清掉），所以它是
 * 「還開著嗎」的來源，歷史一律看 transcript。
 */
function liveSessions() {
  const out = new Map();
  let names = [];
  try { names = readdirSync(SESSIONS_DIR).filter((n) => n.endsWith('.json')); } catch { return out; }
  for (const name of names) {
    try {
      const d = JSON.parse(readFileSync(join(SESSIONS_DIR, name), 'utf8'));
      process.kill(d.pid, 0);                 // 探活，死了會丟例外
      out.set(d.sessionId, { pid: d.pid, status: d.status ?? '?' });
    } catch { /* 進程沒了或檔案壞了，略過 */ }
  }
  return out;
}

function fetchRows(db, { pattern, live, limit } = {}) {
  let rows = db.prepare(`
    SELECT s.*, m.doing, m.next_step
    FROM sessions s LEFT JOIN summaries m ON m.sid = s.sid
    ORDER BY s.last_at DESC`).all();

  const alive = liveSessions();
  rows = rows.map((r) => ({ ...r, live: alive.get(r.sid) ?? null }));
  rows.sort((a, b) => (a.live ? 0 : 1) - (b.live ? 0 : 1) || (b.last_at ?? 0) - (a.last_at ?? 0));

  if (live) rows = rows.filter((r) => r.live);
  if (pattern) {
    const p = pattern.toLowerCase();
    rows = rows.filter((r) => [r.cwd, r.last_prompt, r.doing]
      .some((v) => (v ?? '').toLowerCase().includes(p)));
  }
  return limit ? rows.slice(0, limit) : rows;
}

// ---------- 子指令 ----------

function cmdSync(db, opts) {
  const t0 = Date.now();
  const { files, lines } = scan.sync(db, { verbose: opts.verbose });
  const n = db.prepare('SELECT COUNT(*) c FROM sessions').get().c;
  console.log(`掃描完成：${files} 個檔案有新增，共 ${lines} 行，` +
              `${((Date.now() - t0) / 1000).toFixed(1)}s（資料庫共 ${n} 個 session）`);
}

function cmdLs(db, opts) {
  const rows = fetchRows(db, { pattern: opts.pattern, live: opts.live,
                               limit: opts.all ? null : opts.n });
  const home = homedir();
  console.log(`${'#'.padStart(3)} ${pad('STATUS', 8)} ${pad('IDLE', 6)} ` +
              `${pad('PROJECT', 36)} ${opts.summary ? 'SUMMARY' : 'LAST PROMPT'}`);
  console.log('-'.repeat(118));

  rows.forEach((r, i) => {
    const st = r.live ? `● ${r.live.status}` : '· closed';
    let proj = (r.cwd ?? '?').replace(home, '~');
    if (width(proj) > 36) proj = '…' + proj.slice(-35);
    const head = `${String(i + 1).padStart(3)} ${pad(st, 8)} ${pad(ago(r.last_at), 6)} ${pad(proj, 36)} `;
    if (opts.summary) {
      if (!r.doing) return console.log(head + '(尚未摘要，跑 ccs sum)');
      console.log(head + trunc(r.doing, 46));
      if (r.next_step) console.log(' '.repeat(58) + '↳ ' + trunc(r.next_step, 44));
    } else {
      console.log(head + trunc(r.last_prompt, 46));
    }
  });

  const total = db.prepare('SELECT COUNT(*) c FROM sessions').get().c;
  console.log('-'.repeat(118));
  console.log(`共 ${total} 個 session（${rows.filter((r) => r.live).length} 執行中），顯示 ${rows.length} 筆`);
}

async function cmdSum(db, opts) {
  const rows = fetchRows(db, { pattern: opts.pattern, live: opts.live,
                               limit: opts.all ? null : opts.n });
  const todo = summarize.pending(db, rows.map((r) => ({ sid: r.sid, path: r.path })));
  if (!todo.length) return console.log('摘要都是最新的，沒有要產生的');

  console.log(`產生 ${todo.length} 筆摘要（model=${opts.model}，${opts.workers} 並行）…`);
  const ok = await summarize.generate(db, todo, {
    model: opts.model, workers: opts.workers,
    onDone: (i, n, sid, good) => console.log(`  ${good ? '✓' : '✗'} [${i}/${n}] ${sid.slice(0, 8)}`),
  });
  console.log(`完成 ${ok}/${todo.length}`);
}

function table(title, header, rows, fmt) {
  console.log(`\n=== ${title} ===`);
  console.log(header);
  for (const r of rows) console.log(fmt(r));
}

function cmdStats(db) {
  table('每日用量（最近 14 天）',
    `${pad('日期', 12)}${'session'.padStart(8)}${'訊息'.padStart(9)}` +
    `${'輸入'.padStart(11)}${'輸出'.padStart(11)}${'快取讀'.padStart(11)}`,
    db.prepare(`SELECT day, COUNT(DISTINCT sid) s, COUNT(*) n,
                  SUM(input) i, SUM(output) o, SUM(cache_read) cr
                FROM usage WHERE day IS NOT NULL
                GROUP BY day ORDER BY day DESC LIMIT 14`).all(),
    (r) => `${pad(r.day, 12)}${String(r.s).padStart(8)}${String(r.n).padStart(9)}` +
           `${human(r.i).padStart(11)}${human(r.o).padStart(11)}${human(r.cr).padStart(11)}`);

  table('各專案（依輸出 token）',
    `${pad('專案', 34)}${'session'.padStart(8)}${'訊息'.padStart(9)}` +
    `${'輸出'.padStart(11)}${'快取讀'.padStart(11)}`,
    db.prepare(`SELECT s.project p, COUNT(DISTINCT s.sid) c, COUNT(u.uuid) n,
                  SUM(u.output) o, SUM(u.cache_read) cr
                FROM sessions s JOIN usage u ON u.sid = s.sid
                GROUP BY s.project ORDER BY o DESC LIMIT 15`).all(),
    (r) => `${pad(trunc(r.p, 32), 34)}${String(r.c).padStart(8)}${String(r.n).padStart(9)}` +
           `${human(r.o).padStart(11)}${human(r.cr).padStart(11)}`);

  table('各模型',
    `${pad('模型', 28)}${'訊息'.padStart(9)}${'輸入'.padStart(11)}` +
    `${'輸出'.padStart(11)}${'快取讀'.padStart(11)}`,
    db.prepare(`SELECT model, COUNT(*) n, SUM(input) i, SUM(output) o, SUM(cache_read) cr
                FROM usage WHERE model IS NOT NULL
                GROUP BY model ORDER BY o DESC`).all(),
    (r) => `${pad(trunc(r.model, 26), 28)}${String(r.n).padStart(9)}${human(r.i).padStart(11)}` +
           `${human(r.o).padStart(11)}${human(r.cr).padStart(11)}`);

  const t = db.prepare(`SELECT COUNT(*) n, SUM(input) i, SUM(output) o,
                          SUM(cache_read) cr, SUM(cache_create) cc FROM usage`).get();
  console.log(`\n總計：${t.n} 則助理訊息 / 輸入 ${human(t.i)} / 輸出 ${human(t.o)}` +
              ` / 快取讀 ${human(t.cr)} / 快取寫 ${human(t.cc)}`);
}

function cmdResume(db, opts) {
  const rows = fetchRows(db, { pattern: opts.pattern });
  const r = rows[Number(opts.index) - 1];
  if (!r) { console.error('找不到對應的 session'); process.exit(1); }
  console.log(`cd ${r.cwd} && claude --resume ${r.sid}`);
}

async function cmdBackup(db, opts) {
  if (opts.show) {
    const d = backupMod.showDest(db);
    return console.log(d ? `目前的備份目的地：${d}` : '尚未設定備份目的地');
  }
  await backupMod.backup(db, { dest: opts.dest, dryRun: opts.dryRun, dbOnly: opts.dbOnly });
}

// ---------- 進入點 ----------

const HELP = `ccs — Claude Code session 總覽

用法：
  ccs [pattern]            列出 session（執行中的排前面），自動增量掃描
  ccs -s                   顯示 LLM 摘要而非最後一句 prompt
  ccs -l                   只看還開著的
  ccs -a                   不限筆數（預設 30）

  ccs sum [pattern]        產生缺少或過期的摘要
  ccs stats                token 用量：每日 / 各專案 / 各模型
  ccs sync                 只做增量掃描
  ccs resume <n>           印出該筆的 cd + claude --resume 指令

  ccs backup gs://bucket/path/   備份 transcript 與資料庫到 GCS（會記住目的地）
  ccs backup                     用記住的目的地再備份一次
  ccs backup --show              顯示目前設定的目的地
  ccs backup --dry-run           只看會傳什麼，不實際寫入

選項：
  -n <num>     顯示筆數      --model <id>   摘要用的模型
  --db <path>  資料庫路徑     --workers <n>  摘要並行數
  --no-sync    跳過自動掃描
`;

async function main() {
  const argv = process.argv.slice(2);
  const cmd = COMMANDS.includes(argv[0]) ? argv.shift() : 'ls';
  if (cmd === 'help' || argv.includes('-h') || argv.includes('--help')) {
    return console.log(HELP);
  }

  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        n: { type: 'string', default: '30' },
        all: { type: 'boolean', short: 'a', default: false },
        live: { type: 'boolean', short: 'l', default: false },
        summary: { type: 'boolean', short: 's', default: false },
        model: { type: 'string', default: summarize.MODEL },
        workers: { type: 'string', default: String(summarize.WORKERS) },
        db: { type: 'string' },
        'no-sync': { type: 'boolean', default: false },
        verbose: { type: 'boolean', short: 'v', default: false },
        'dry-run': { type: 'boolean', default: false },
        'db-only': { type: 'boolean', default: false },
        show: { type: 'boolean', default: false },
      },
    });
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }

  const { values: v, positionals: pos } = parsed;
  const db = connect(v.db);
  if (!v['no-sync'] && cmd !== 'sync') scan.sync(db);   // 增量，沒新東西幾乎不花時間

  const opts = {
    pattern: cmd === 'resume' ? pos[1] : pos[0],
    index: pos[0], dest: pos[0],
    n: Number(v.n), all: v.all, live: v.live, summary: v.summary,
    model: v.model, workers: Number(v.workers), verbose: v.verbose,
    dryRun: v['dry-run'], dbOnly: v['db-only'], show: v.show,
  };

  try {
    if (cmd === 'ls') cmdLs(db, opts);
    else if (cmd === 'sum') await cmdSum(db, opts);
    else if (cmd === 'sync') cmdSync(db, opts);
    else if (cmd === 'stats') cmdStats(db);
    else if (cmd === 'resume') cmdResume(db, opts);
    else if (cmd === 'backup') await cmdBackup(db, opts);
  } catch (e) {
    console.error(`\n${e.message}`);
    process.exit(1);
  } finally {
    db.close();
  }
}

await main();
