/** 顯示用的小工具：東亞字元寬度、截斷、時間與數字格式化。*/

/**
 * 真正佔兩格的區段。用明確範圍而不是 `> 0x2E80`——後者會把「東亞模糊寬度」
 * 字元（…、●、↳、— 之類）誤判成兩格，終端機實際只給它們一格，欄位就會歪掉。
 */
const WIDE = [
  [0x1100, 0x115f], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf],
  [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xac00, 0xd7a3], [0xf900, 0xfaff],
  [0xfe30, 0xfe6f], [0xff00, 0xff60], [0xffe0, 0xffe6],
  [0x1f300, 0x1f64f], [0x1f900, 0x1f9ff], [0x20000, 0x2fffd],
];

export function isWide(cp) {
  for (const [lo, hi] of WIDE) if (cp >= lo && cp <= hi) return true;
  return false;
}

/** 顯示寬度：CJK 佔兩格，其餘一格。 */
export function width(s) {
  let n = 0;
  for (const ch of String(s ?? '')) n += isWide(ch.codePointAt(0)) ? 2 : 1;
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
    const w = isWide(ch.codePointAt(0)) ? 2 : 1;
    if (acc + w > n) {
      // 省略號本身也佔一格：先退到放得下它為止，否則截出來會比 n 寬一格
      while (acc + 1 > n && out.length) {
        const last = [...out].pop();
        out = out.slice(0, -last.length);
        acc -= isWide(last.codePointAt(0)) ? 2 : 1;
      }
      return out + '…';
    }
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
