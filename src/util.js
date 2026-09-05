/** 顯示用的小工具：東亞字元寬度、截斷、時間與數字格式化。*/

/** 顯示寬度：CJK 佔兩格，其餘一格。 */
export function width(s) {
  let n = 0;
  for (const ch of String(s ?? '')) n += ch.codePointAt(0) > 0x2e80 ? 2 : 1;
  return n;
}

export function pad(s, n) {
  return String(s ?? '') + ' '.repeat(Math.max(0, n - width(s)));
}

export function trunc(s, n) {
  if (s === null || s === undefined || s === '') return '-';
  const flat = String(s).replace(/\s+/g, ' ').trim();
  let acc = 0, out = '';
  for (const ch of flat) {
    const w = ch.codePointAt(0) > 0x2e80 ? 2 : 1;
    if (acc + w > n) return out + '…';
    out += ch;
    acc += w;
  }
  return out;
}

export function ago(ts) {
  if (!ts) return '-';
  const s = Date.now() / 1000 - ts;
  for (const [u, d] of [['d', 86400], ['h', 3600], ['m', 60]]) {
    if (s >= d) return `${Math.floor(s / d)}${u}`;
  }
  return 'now';
}

export function human(n) {
  n = Number(n || 0);
  for (const [u, d] of [['B', 1e9], ['M', 1e6], ['K', 1e3]]) {
    if (n >= d) return `${(n / d).toFixed(1)}${u}`;
  }
  return String(Math.round(n));
}

/** YYYY-MM-DD，本地時區。 */
export function localDay(ts) {
  const d = new Date(ts * 1000);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 以固定並行數跑完所有工作，保持輸入順序回傳結果。 */
export async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}
