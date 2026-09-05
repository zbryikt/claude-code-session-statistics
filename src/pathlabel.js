/**
 * 把 cwd 壓成簡明標籤。
 *
 * 規則從實際的 70 個路徑歸納而來：
 *   ~/workspace/<scope>/<kind>/<name>   kind 是組織用的分類詞，不帶識別資訊
 *   ~/workspace/<scope>/<name>
 *   ~/ai/<year>/<MMDD>-<topic>
 *   ~/ai/topics/<topic>
 *
 * 刻意用規則而非 LLM：零成本、零延遲，而且同一路徑永遠得到同一標籤——
 * 這是一個要用眼睛掃的欄位，措辭浮動比不夠聰明更礙事。
 * 規則涵蓋不到的（~/Dropbox/... 之類）退回「最後兩段」。
 */
import { homedir } from 'node:os';

/** 第三層若是這些字，是分類而非名稱，顯示時略過。 */
const KINDS = new Set(['projects', 'project', 'boards', 'board', 'blocks',
                       'block', 'case', 'cases', 'modules', 'packages']);

const HOME = homedir();

/**
 * 更深的層級保留首尾兩段而不是只留首段加省略號——實測發現只留首段會撞名，
 * 例如 case/taicca/movie 與 case/taicca/2026/activity-crawler 會變成同一個標籤。
 */
function tail(parts) {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts[0]}/${parts[parts.length - 1]}`;
}

export function pathLabel(cwd) {
  if (!cwd) return '-';
  const rel = cwd.startsWith(HOME) ? cwd.slice(HOME.length + 1) : cwd;
  const seg = rel.split('/').filter(Boolean);
  if (!seg.length) return '~';

  if (seg[0] === 'workspace' && seg.length >= 3) {
    const scope = seg[1];
    const rest = seg.slice(2);
    // 略過分類詞，取其後的名稱
    const i = KINDS.has(rest[0]) && rest.length > 1 ? 1 : 0;
    return `${scope}:${tail(rest.slice(i))}`;
  }
  if (seg[0] === 'workspace' && seg.length === 2) return `${seg[1]}:`;

  if (seg[0] === 'ai' && seg.length >= 3) {
    // 2026/0901-tinypng -> ai:0901 tinypng；topics/cpu -> ai:cpu
    const m = seg[2].match(/^(\d{4})-(.+)$/);
    const head = m ? `${m[1]} ${m[2]}` : seg[2];
    return `ai:${tail([head, ...seg.slice(3)])}`;
  }

  return seg.slice(-2).join(':');
}
