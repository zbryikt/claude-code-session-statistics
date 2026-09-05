"""ccs - Claude Code session 總覽 / 摘要 / 統計."""
import argparse
import json
import os
import re
import sys
import time
from pathlib import Path

from ccstat import db, scan, summarize

SESSIONS_DIR = Path.home() / ".claude/sessions"


# ---------- 存活狀態 ----------

def live_sessions():
    """{sessionId: {pid, status}}, 只含進程還活著的.

    ~/.claude/sessions/<pid>.json 只反映當下 (進程結束就清掉), 所以它是
    「還開著嗎」的來源, 歷史一律看 transcript.
    """
    out = {}
    for f in SESSIONS_DIR.glob("*.json"):
        try:
            d = json.loads(f.read_text())
            os.kill(d["pid"], 0)
        except Exception:
            continue
        out[d.get("sessionId")] = {"pid": d["pid"], "status": d.get("status", "?")}
    return out


# ---------- 顯示工具 ----------

def ago(ts):
    if not ts:
        return "-"
    s = time.time() - ts
    for u, d in (("d", 86400), ("h", 3600), ("m", 60)):
        if s >= d:
            return f"{int(s // d)}{u}"
    return "now"


def w(s):
    return sum(2 if ord(c) > 0x2E80 else 1 for c in s)


def pad(s, n):
    return s + " " * max(0, n - w(s))


def trunc(s, n):
    if not s:
        return "-"
    s = re.sub(r"\s+", " ", str(s)).strip()
    out, acc = [], 0
    for ch in s:
        cw = 2 if ord(ch) > 0x2E80 else 1
        if acc + cw > n:
            out.append("…")
            break
        out.append(ch)
        acc += cw
    return "".join(out)


def human(n):
    n = n or 0
    for unit, div in (("B", 1e9), ("M", 1e6), ("K", 1e3)):
        if n >= div:
            return f"{n / div:.1f}{unit}"
    return str(int(n))


# ---------- 查詢 ----------

def fetch(con, pattern=None, live_only=False, limit=None):
    rows = [dict(r) for r in con.execute("""
        SELECT s.*, m.doing, m.next_step
        FROM sessions s LEFT JOIN summaries m ON m.sid = s.sid
        ORDER BY s.last_at DESC
    """)]
    alive = live_sessions()
    for r in rows:
        r["live"] = alive.get(r["sid"])
    rows.sort(key=lambda r: (r["live"] is None, -(r["last_at"] or 0)))

    if live_only:
        rows = [r for r in rows if r["live"]]
    if pattern:
        p = pattern.lower()
        rows = [r for r in rows
                if p in (r["cwd"] or "").lower()
                or p in (r["last_prompt"] or "").lower()
                or p in (r["doing"] or "").lower()]
    return rows[:limit] if limit else rows


# ---------- 子指令 ----------

def cmd_sync(con, args):
    t0 = time.time()
    n_files, n_lines = scan.sync(con, verbose=args.verbose)
    n_sess = con.execute("SELECT COUNT(*) c FROM sessions").fetchone()["c"]
    print(f"掃描完成: {n_files} 個檔案有新增, 共 {n_lines} 行, "
          f"{time.time() - t0:.1f}s (資料庫共 {n_sess} 個 session)")


def cmd_ls(con, args):
    rows = fetch(con, args.pattern, args.live, None if args.all else args.n)
    home = str(Path.home())
    col = "SUMMARY" if args.summary else "LAST PROMPT"
    print(f'{"#":>3} {pad("STATUS",8)} {pad("IDLE",6)} {pad("PROJECT",36)} {col}')
    print("-" * 118)
    for i, r in enumerate(rows, 1):
        st = ("● " + r["live"]["status"]) if r["live"] else "· closed"
        proj = (r["cwd"] or "?").replace(home, "~")
        if w(proj) > 36:
            proj = "…" + proj[-35:]
        head = f'{i:>3} {pad(st,8)} {pad(ago(r["last_at"]),6)} {pad(proj,36)} '
        if args.summary:
            if not r["doing"]:
                print(head + "(尚未摘要, 跑 ccs sum)")
            else:
                print(head + trunc(r["doing"], 46))
                if r["next_step"]:
                    print(" " * 58 + "↳ " + trunc(r["next_step"], 44))
        else:
            print(head + trunc(r["last_prompt"], 46))

    total = con.execute("SELECT COUNT(*) c FROM sessions").fetchone()["c"]
    n_live = sum(1 for r in rows if r["live"])
    print("-" * 118)
    print(f"共 {total} 個 session ({n_live} 執行中), 顯示 {len(rows)} 筆")


def cmd_sum(con, args):
    rows = fetch(con, args.pattern, args.live, None if args.all else args.n)
    todo = summarize.pending(con, [(r["sid"], Path(r["path"])) for r in rows])
    if not todo:
        print("摘要都是最新的, 沒有要產生的")
        return
    print(f"產生 {len(todo)} 筆摘要 (model={args.model}, {args.workers} 並行)…")

    def progress(i, total, sid, good):
        mark = "✓" if good else "✗"
        print(f"  {mark} [{i}/{total}] {sid[:8]}")

    ok = summarize.generate(con, todo, model=args.model,
                            workers=args.workers, on_done=progress)
    print(f"完成 {ok}/{len(todo)}")


def cmd_stats(con, args):
    print("=== 每日用量 (最近 14 天) ===")
    print(f'{"日期":<12} {"session":>8} {"訊息":>7} {"輸入":>9} {"輸出":>9} {"快取讀":>9}')
    for r in con.execute("""
        SELECT day, COUNT(DISTINCT sid) s, COUNT(*) n,
               SUM(input) i, SUM(output) o, SUM(cache_read) cr
        FROM usage WHERE day IS NOT NULL
        GROUP BY day ORDER BY day DESC LIMIT 14
    """):
        print(f'{r["day"]:<12} {r["s"]:>8} {r["n"]:>7} '
              f'{human(r["i"]):>9} {human(r["o"]):>9} {human(r["cr"]):>9}')

    print("\n=== 各專案 (依輸出 token) ===")
    print(f'{"專案":<34} {"session":>8} {"訊息":>7} {"輸出":>9} {"快取讀":>9}')
    for r in con.execute("""
        SELECT s.project p, COUNT(DISTINCT s.sid) c, COUNT(u.uuid) n,
               SUM(u.output) o, SUM(u.cache_read) cr
        FROM sessions s JOIN usage u ON u.sid = s.sid
        GROUP BY s.project ORDER BY o DESC LIMIT 15
    """):
        print(f'{pad(trunc(r["p"], 32), 34)} {r["c"]:>8} {r["n"]:>7} '
              f'{human(r["o"]):>9} {human(r["cr"]):>9}')

    print("\n=== 各模型 ===")
    print(f'{"模型":<28} {"訊息":>8} {"輸入":>9} {"輸出":>9} {"快取讀":>9}')
    for r in con.execute("""
        SELECT model, COUNT(*) n, SUM(input) i, SUM(output) o, SUM(cache_read) cr
        FROM usage WHERE model IS NOT NULL
        GROUP BY model ORDER BY o DESC
    """):
        print(f'{pad(trunc(r["model"], 26), 28)} {r["n"]:>8} '
              f'{human(r["i"]):>9} {human(r["o"]):>9} {human(r["cr"]):>9}')

    t = con.execute("""
        SELECT COUNT(*) n, SUM(input) i, SUM(output) o,
               SUM(cache_read) cr, SUM(cache_create) cc FROM usage
    """).fetchone()
    print(f'\n總計: {t["n"]} 則助理訊息 / 輸入 {human(t["i"])} / 輸出 {human(t["o"])} '
          f'/ 快取讀 {human(t["cr"])} / 快取寫 {human(t["cc"])}')


def cmd_resume(con, args):
    rows = fetch(con, args.pattern, False, None)
    try:
        r = rows[int(args.n) - 1]
    except (ValueError, IndexError):
        sys.exit("找不到對應的 session")
    print(f'cd {r["cwd"]} && claude --resume {r["sid"]}')


# ---------- 進入點 ----------

def main():
    ap = argparse.ArgumentParser(
        prog="ccs", description="Claude Code session 總覽 / 摘要 / 統計")
    ap.add_argument("--db", help="資料庫路徑 (預設 ~/.local/state/ccstat/ccstat.db)")
    ap.add_argument("--no-sync", action="store_true", help="跳過自動增量掃描")
    sub = ap.add_subparsers(dest="cmd")

    def add_filters(p):
        p.add_argument("pattern", nargs="?", help="用路徑或內容過濾")
        p.add_argument("-n", type=int, default=30, help="筆數 (預設 30)")
        p.add_argument("-a", "--all", action="store_true", help="不限筆數")
        p.add_argument("-l", "--live", action="store_true", help="只看執行中")

    p = sub.add_parser("ls", help="列出 session (預設指令)")
    add_filters(p)
    p.add_argument("-s", "--summary", action="store_true", help="顯示摘要而非最後 prompt")

    p = sub.add_parser("sum", help="產生缺少或過期的摘要")
    add_filters(p)
    p.add_argument("--model", default=summarize.MODEL)
    p.add_argument("--workers", type=int, default=summarize.WORKERS)

    p = sub.add_parser("sync", help="只做增量掃描")
    p.add_argument("-v", "--verbose", action="store_true")

    sub.add_parser("stats", help="token 用量統計")

    p = sub.add_parser("resume", help="印出指定編號的 resume 指令")
    p.add_argument("n")
    p.add_argument("pattern", nargs="?")

    # 沒給子指令時當成 ls, 讓 `ccs`, `ccs foo`, `ccs -s` 都能用
    argv = sys.argv[1:]
    known = {"ls", "sum", "sync", "stats", "resume"}
    if not argv or (argv[0] not in known and not argv[0].startswith("-")):
        argv = ["ls"] + argv
    elif argv and argv[0].startswith("-") and argv[0] not in ("-h", "--help"):
        if not any(a in known for a in argv):
            argv = ["ls"] + argv
    args = ap.parse_args(argv)
    if not args.cmd:
        args.cmd = "ls"

    con = db.connect(args.db)
    if not args.no_sync and args.cmd != "sync":
        scan.sync(con)          # 增量, 沒新東西時幾乎不花時間

    {"ls": cmd_ls, "sum": cmd_sum, "sync": cmd_sync,
     "stats": cmd_stats, "resume": cmd_resume}[args.cmd](con, args)
    con.close()
