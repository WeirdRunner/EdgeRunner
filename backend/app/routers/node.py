"""The edge node API: lets the EdgeRunner web app (and its coding agent) work in project folders on this machine.

Every path is relative to a project folder the user added (config.json → projects); nothing outside those
folders can be read or written through here. Commands run in a login shell inside the project, and on macOS
under sandbox-exec so they can only write to the project, temp folders and package-manager caches
(EDGERUNNER_SANDBOX=0 turns that off). All of it sits behind the token middleware in core/auth.py.
"""
from __future__ import annotations

import base64
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.core import store

router = APIRouter(prefix="/node", tags=["node"])

MAX_OUTPUT = 30_000
MAX_READ = 2_000_000
SKIP = {"node_modules", ".git", ".venv", "venv", "__pycache__", ".next", ".DS_Store"}
ANSI = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07|\r(?!\n)")
HOME = Path.home()

SANDBOX_PROFILE = """(version 1)
(allow default)
(deny file-write*)
(allow file-write*
  (subpath (param "ROOT"))
  (subpath "/private/tmp") (subpath "/private/var/folders") (subpath "/dev")
  (subpath (string-append (param "HOME") "/.npm"))
  (subpath (string-append (param "HOME") "/.cache"))
  (subpath (string-append (param "HOME") "/.bun"))
  (subpath (string-append (param "HOME") "/.cargo/registry"))
  (subpath (string-append (param "HOME") "/Library/Caches"))
  (subpath (string-append (param "HOME") "/Library/pnpm"))
  (subpath (string-append (param "HOME") "/.local/share/pnpm")))
"""


def sandboxed() -> bool:
    return sys.platform == "darwin" and os.getenv("EDGERUNNER_SANDBOX", "1") != "0" and shutil.which("sandbox-exec") is not None


def _root(project: Optional[str]) -> Path:
    try:
        return store.project_root(project)
    except LookupError as e:
        raise HTTPException(404, str(e))


def _safe(root: Path, rel: str) -> Path:
    """Resolve `rel` inside `root`; refuses anything that escapes it (.., absolute paths, symlinks out)."""
    rel = rel.strip()
    target = (Path(rel) if rel.startswith("/") else root / rel).resolve()   # absolute paths must point inside too
    try:
        target.relative_to(root)
    except ValueError:
        raise HTTPException(403, f"{rel!r} is outside the project folder.")
    return target


def _clip(s: str) -> str:
    s = ANSI.sub("", s)
    if len(s) <= MAX_OUTPUT:
        return s
    half = MAX_OUTPUT // 2
    return f"{s[:half]}\n… [{len(s) - MAX_OUTPUT} characters cut] …\n{s[-half:]}"


def _argv(root: Path, command: str) -> list[str]:
    shell = os.getenv("SHELL") or "/bin/zsh"
    argv = [shell, "-lc", command]
    if sandboxed():
        profile = Path(tempfile.gettempdir()) / "edgerunner-sandbox.sb"
        if not profile.exists() or profile.read_text() != SANDBOX_PROFILE:
            profile.write_text(SANDBOX_PROFILE)
        argv = ["sandbox-exec", "-f", str(profile), "-D", f"ROOT={root}", "-D", f"HOME={HOME}", *argv]
    return argv


# ---- info & projects -----------------------------------------------------------------------------

@router.get("/info")
def info() -> dict:
    return {"platform": sys.platform, "sandbox": sandboxed(), "projects": store.projects(),
            "approval": store.load().get("approval", "ask")}


class ProjectIn(BaseModel):
    path: str
    name: Optional[str] = None


@router.post("/projects")
def add_project(req: ProjectIn) -> dict:
    try:
        return store.add_project(req.path, req.name)
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.delete("/projects/{project_id}")
def remove_project(project_id: str) -> dict:
    store.remove_project(project_id)
    return {"ok": True}


# ---- files ---------------------------------------------------------------------------------------

@router.get("/fs/list")
def fs_list(project: Optional[str] = None, path: str = ".") -> list[dict]:
    root = _root(project)
    d = _safe(root, path)
    if not d.is_dir():
        raise HTTPException(404, f"Not a folder: {path}")
    out = [{"name": e.name, "path": str(e.relative_to(root)), "dir": e.is_dir()} for e in d.iterdir() if e.name != ".DS_Store"]
    return sorted(out, key=lambda e: (not e["dir"], e["name"].lower()))


@router.get("/fs/stat")
def fs_stat(path: str, project: Optional[str] = None) -> dict:
    f = _safe(_root(project), path)
    return {"exists": f.exists(), "dir": f.is_dir()}


@router.get("/fs/walk")
def fs_walk(project: Optional[str] = None, path: str = ".", limit: int = 5000) -> list[str]:
    root = _root(project)
    base = _safe(root, path)
    out: list[str] = []
    for dirpath, dirnames, filenames in os.walk(base):
        dirnames[:] = sorted(n for n in dirnames if n not in SKIP)
        for f in sorted(filenames):
            if f in SKIP:
                continue
            out.append(str((Path(dirpath) / f).relative_to(root)))
            if len(out) >= limit:
                return out
    return out


@router.get("/fs/read")
def fs_read(path: str, project: Optional[str] = None) -> dict:
    f = _safe(_root(project), path)
    if not f.is_file():
        raise HTTPException(404, f"No such file: {path}")
    if f.stat().st_size > MAX_READ:
        raise HTTPException(413, f"{path} is larger than {MAX_READ // 1_000_000} MB.")
    data = f.read_bytes()
    try:
        return {"content": data.decode("utf-8"), "encoding": "utf-8"}
    except UnicodeDecodeError:
        return {"content": base64.b64encode(data).decode(), "encoding": "base64"}


class WriteIn(BaseModel):
    path: str
    content: str
    encoding: str = "utf-8"
    project: Optional[str] = None


@router.post("/fs/write")
def fs_write(req: WriteIn) -> dict:
    f = _safe(_root(req.project), req.path)
    f.parent.mkdir(parents=True, exist_ok=True)
    data = base64.b64decode(req.content) if req.encoding == "base64" else req.content.encode("utf-8")
    f.write_bytes(data)
    return {"ok": True, "bytes": len(data)}


class PathIn(BaseModel):
    path: str
    project: Optional[str] = None


@router.post("/fs/rm")
def fs_rm(req: PathIn) -> dict:
    root = _root(req.project)
    f = _safe(root, req.path)
    if f == root:
        raise HTTPException(403, "Won't delete the project folder itself.")
    if f.is_dir():
        shutil.rmtree(f)
    elif f.exists():
        f.unlink()
    return {"ok": True}


@router.post("/fs/mkdir")
def fs_mkdir(req: PathIn) -> dict:
    _safe(_root(req.project), req.path).mkdir(parents=True, exist_ok=True)
    return {"ok": True}


# ---- commands ------------------------------------------------------------------------------------

class ExecIn(BaseModel):
    command: str = Field(..., min_length=1)
    project: Optional[str] = None
    cwd: str = "."
    timeout: int = Field(120, ge=1, le=900)


@router.post("/exec")
def exec_command(req: ExecIn) -> dict:
    root = _root(req.project)
    cwd = _safe(root, req.cwd)
    started = time.monotonic()
    proc = subprocess.Popen(_argv(root, req.command), cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            stdin=subprocess.DEVNULL, start_new_session=True, env={**os.environ, "CI": "1", "FORCE_COLOR": "0"})
    timed_out = False
    try:
        out, _ = proc.communicate(timeout=req.timeout)
    except subprocess.TimeoutExpired:
        timed_out = True
        os.killpg(proc.pid, signal.SIGKILL)
        out, _ = proc.communicate()
    return {"output": _clip(out.decode("utf-8", "replace")).rstrip(), "code": 124 if timed_out else proc.returncode,
            "timed_out": timed_out, "ms": int((time.monotonic() - started) * 1000)}


class _Bg:
    def __init__(self, proc: subprocess.Popen):
        self.proc = proc
        self.out = ""
        threading.Thread(target=self._pump, daemon=True).start()

    def _pump(self):
        for chunk in iter(lambda: self.proc.stdout.read1(4096), b""):   # type: ignore[union-attr]
            if len(self.out) < MAX_OUTPUT:
                self.out += chunk.decode("utf-8", "replace")


_background: dict[str, _Bg] = {}
URL = re.compile(r"https?://(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):\d+[^\s\"')]*")


class StartIn(ExecIn):
    wait: int = Field(20, ge=1, le=120)


@router.post("/start")
def start(req: StartIn) -> dict:
    """Start a long-running command (dev server, watcher) and leave it running; returns its first output."""
    root = _root(req.project)
    cwd = _safe(root, req.cwd)
    key = f"{root}::{req.cwd}::{req.command}"
    if key in _background:
        _stop(_background.pop(key))
    proc = subprocess.Popen(_argv(root, req.command), cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            stdin=subprocess.DEVNULL, start_new_session=True, env={**os.environ, "FORCE_COLOR": "0"})
    bg = _Bg(proc)
    _background[key] = bg
    deadline = time.monotonic() + req.wait
    url = None
    while time.monotonic() < deadline and proc.poll() is None:
        m = URL.search(ANSI.sub("", bg.out))
        if m:
            url = m.group(0).replace("0.0.0.0", "localhost")
            time.sleep(0.3)
            break
        time.sleep(0.2)
    code = proc.poll()
    if code is not None:
        _background.pop(key, None)
    return {"output": _clip(bg.out).rstrip(), "url": url, "exited": code}


def _stop(bg: _Bg) -> None:
    try:
        os.killpg(bg.proc.pid, signal.SIGTERM)
        bg.proc.wait(timeout=5)
    except Exception:
        try:
            os.killpg(bg.proc.pid, signal.SIGKILL)
        except Exception:
            pass


@router.post("/stop")
def stop_all() -> dict:
    n = len(_background)
    for bg in _background.values():
        _stop(bg)
    _background.clear()
    return {"stopped": n}
