"""掃描 ~/.claude/projects 的 transcript 進資料庫.

核心是增量: transcript 是 append-only 的 jsonl, 所以只要記住上次讀到第幾個
位元組, 下次 seek 過去讀新增的部分就好. 不需要算檔案 hash —— 對 400MB 的
資料來說, 每次重算 md5 只是為了確認「沒變」, 成本比直接讀新增內容還高.

唯一要防的是檔案被改寫 (縮短): 這時 offset 失效, 整檔重讀.
"""
import json
import time
from datetime import datetime
from pathlib import Path

PROJECTS = Path.home() / ".claude/projects"

SKIP_PREFIX = ("<task-notification>", "<local-command", "<system-reminder>")


def iter_transcripts(root=PROJECTS):
    for f in Path(root).rglob("*.jsonl"):
        if "subagents" in f.parts:      # 子代理的紀錄不是獨立 session
            continue
        yield f


def _text(content):
    """把 message.content 攤成純文字, 丟掉 tool_use / tool_result 區塊."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(b.get("text", "") for b in content
                         if isinstance(b, dict) and b.get("type") == "text")
    return ""


def _ts(rec):
    t = rec.get("timestamp")
    if not t:
        return None
    try:
        return datetime.fromisoformat(t.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def read_delta(path, offset):
    """從 offset 讀到最後一個完整的行. 回傳 (行串列, 新 offset)."""
    size = path.stat().st_size
    if offset > size:               # 檔案被改寫過, 重來
        offset = 0
    if offset == size:
        return [], offset
    with path.open("rb") as fh:
        fh.seek(offset)
        blob = fh.read(size - offset)
    # 尾巴若不是完整一行就留著, 下次連同後續內容一起讀
    cut = blob.rfind(b"\n")
    if cut < 0:
        return [], offset
    text = blob[:cut].decode("utf-8", "replace")
    return text.splitlines(), offset + cut + 1


def scan_file(con, path):
    """掃一個 transcript 的新增部分, 寫進 db. 回傳新增的行數."""
    sid = path.stem
    row = con.execute("SELECT size FROM files WHERE path=?", (str(path),)).fetchone()
    offset = row["size"] if row else 0
    if offset and offset > path.stat().st_size:
        # 檔案縮短 = 被改寫, 該 session 的累計數字重來
        con.execute("DELETE FROM usage WHERE sid=?", (sid,))
        con.execute("UPDATE sessions SET n_user=0, n_assistant=0 WHERE sid=?", (sid,))
        offset = 0

    lines, new_offset = read_delta(path, offset)
    if not lines:
        return 0

    cwd = branch = last_prompt = None
    started = last = None
    n_user = n_asst = 0
    usage_rows = []

    for line in lines:
        try:
            rec = json.loads(line)
        except Exception:
            continue
        typ = rec.get("type")
        ts = _ts(rec)
        if ts:
            started = ts if started is None else min(started, ts)
            last = ts if last is None else max(last, ts)

        if typ == "user":
            cwd = rec.get("cwd") or cwd
            branch = rec.get("gitBranch") or branch
            if rec.get("userType") == "external" and not rec.get("isMeta"):
                s = _text(rec.get("message", {}).get("content")).strip()
                if s and not s.startswith(SKIP_PREFIX):
                    n_user += 1
                    last_prompt = s

        elif typ == "assistant":
            n_asst += 1
            msg = rec.get("message", {})
            u = msg.get("usage") or {}
            uid = rec.get("uuid")
            if uid:
                usage_rows.append((
                    uid, sid, ts,
                    datetime.fromtimestamp(ts).strftime("%Y-%m-%d") if ts else None,
                    msg.get("model"),
                    u.get("input_tokens", 0), u.get("output_tokens", 0),
                    u.get("cache_read_input_tokens", 0),
                    u.get("cache_creation_input_tokens", 0),
                ))

        elif typ == "last-prompt":
            last_prompt = rec.get("lastPrompt") or last_prompt

    if not cwd:      # 檔尾沒有 user 記錄時, 從目錄名還原
        cwd = "/" + path.parent.name.lstrip("-").replace("-", "/")

    con.execute("""
        INSERT INTO sessions (sid, path, cwd, project, branch, started_at, last_at,
                              n_user, n_assistant, last_prompt)
        VALUES (?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(sid) DO UPDATE SET
          path=excluded.path,
          cwd=COALESCE(excluded.cwd, sessions.cwd),
          project=COALESCE(excluded.project, sessions.project),
          branch=COALESCE(excluded.branch, sessions.branch),
          started_at=MIN(COALESCE(sessions.started_at, excluded.started_at),
                         COALESCE(excluded.started_at, sessions.started_at)),
          last_at=MAX(COALESCE(sessions.last_at, 0), COALESCE(excluded.last_at, 0)),
          n_user=sessions.n_user + excluded.n_user,
          n_assistant=sessions.n_assistant + excluded.n_assistant,
          last_prompt=COALESCE(excluded.last_prompt, sessions.last_prompt)
    """, (sid, str(path), cwd, Path(cwd).name if cwd else None, branch,
          started, last, n_user, n_asst, last_prompt))

    if usage_rows:
        con.executemany(
            "INSERT OR IGNORE INTO usage "
            "(uuid,sid,ts,day,model,input,output,cache_read,cache_create) "
            "VALUES (?,?,?,?,?,?,?,?,?)", usage_rows)

    con.execute("""
        INSERT INTO files (path, sid, size, mtime, scanned_at) VALUES (?,?,?,?,?)
        ON CONFLICT(path) DO UPDATE SET
          size=excluded.size, mtime=excluded.mtime, scanned_at=excluded.scanned_at
    """, (str(path), sid, new_offset, path.stat().st_mtime, int(time.time())))

    return len(lines)


def sync(con, root=PROJECTS, verbose=False):
    """掃過所有 transcript. 回傳 (掃到的檔數, 新增行數)."""
    n_files = n_lines = 0
    for path in iter_transcripts(root):
        try:
            got = scan_file(con, path)
        except Exception as e:
            if verbose:
                print(f"  略過 {path.name}: {e}")
            continue
        if got:
            n_files += 1
            n_lines += got
    con.commit()
    return n_files, n_lines
