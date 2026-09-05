/**
 * 把 ~/.claude/projects 備份到 GCS。
 *
 * 用 `gcloud storage rsync`（不是 gh——那是 GitHub 的 CLI，碰不到 gs://）。
 * 認證與權限由使用者自行處理：沒登入或沒權限時直接把 gcloud 的錯誤透出來，
 * 並提示 `gcloud auth login`，這裡不代為處理憑證。
 *
 * 備份兩份東西：
 *   projects/    transcript 本體，唯一無可取代的資料
 *   ccstat.db    摘要與統計，理論上可重算，但摘要是花 LLM 額度換來的
 */
import { spawn, spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DB_PATH, getConfig, setConfig } from './db.js';

export const PROJECTS = join(homedir(), '.claude/projects');
const CONFIG_KEY = 'backup.dest';

export function normalizeDest(dest) {
  if (!/^gs:\/\/[^/]+/.test(dest)) {
    throw new Error(`目的地要是 gs://bucket/path/ 的形式，收到：${dest}`);
  }
  return dest.replace(/\/+$/, '');
}

function hasGcloud() {
  return spawnSync('gcloud', ['--version'], { stdio: 'ignore' }).status === 0;
}

function run(args, { dryRun }) {
  return new Promise((resolve, reject) => {
    const full = dryRun ? [...args, '--dry-run'] : args;
    console.log(`  $ gcloud ${full.join(' ')}`);
    const p = spawn('gcloud', full, { stdio: 'inherit' });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(
      new Error(`gcloud 結束碼 ${code}`))));
  });
}

/** WAL 模式下 .db 檔可能不含最新資料，先 checkpoint 再備份。 */
function checkpoint(db) {
  try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* 沒 WAL 也無妨 */ }
}

export async function backup(db, { dest, dryRun = false, dbOnly = false } = {}) {
  const target = dest ? normalizeDest(dest) : getConfig(db, CONFIG_KEY);
  if (!target) {
    throw new Error(
      '還沒設定備份目的地。第一次請給：ccs backup gs://your-bucket/claude/\n' +
      '（之後會記住，直接跑 ccs backup 就好）');
  }
  if (!hasGcloud()) {
    throw new Error('找不到 gcloud。請先安裝 Google Cloud SDK。');
  }
  if (dest) setConfig(db, CONFIG_KEY, target);

  console.log(`備份目的地：${target}${dryRun ? '  (dry-run)' : ''}`);
  checkpoint(db);

  try {
    if (!dbOnly) {
      console.log('\n[1/2] transcript');
      await run(['storage', 'rsync', '--recursive', '--delete-unmatched-destination-objects',
                 PROJECTS, `${target}/projects`], { dryRun });
    }
    console.log(`\n[${dbOnly ? '1/1' : '2/2'}] 資料庫`);
    await run(['storage', 'cp', DB_PATH, `${target}/ccstat.db`], { dryRun });
  } catch (e) {
    throw new Error(
      `${e.message}\n\n` +
      '若是認證或權限問題，請自行先處理好再重跑：\n' +
      '  gcloud auth login\n' +
      '  gcloud config set project <你的專案>\n' +
      `  gcloud storage ls ${target.split('/').slice(0, 3).join('/')}`);
  }

  console.log(dryRun ? '\ndry-run 結束，沒有實際寫入。' : '\n備份完成。');
}

export function showDest(db) {
  return getConfig(db, CONFIG_KEY);
}
