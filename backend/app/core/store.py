"""Persistent settings for this machine: ~/.edgerunner/config.json (EDGERUNNER_HOME to move it).

  token      the secret every browser request must carry (made on first start, shown once in the console)
  providers  API keys (OpenRouter today); never sent back to the browser, only whether one is set
  projects   folders the agent may work in — nothing outside them is readable or writable through the API
  approval   "ask" (approve every edit and command), "edits" (edits auto, commands ask), "auto"
"""
from __future__ import annotations

import json
import os
import secrets
import threading
from pathlib import Path
from typing import Any

HOME = Path(os.getenv("EDGERUNNER_HOME") or Path.home() / ".edgerunner")
_LOCK = threading.Lock()
DEFAULTS: dict[str, Any] = {"token": "", "providers": {}, "projects": [], "approval": "ask", "default_model": None}


def _path() -> Path:
    return HOME / "config.json"


def load() -> dict[str, Any]:
    with _LOCK:
        try:
            data = json.loads(_path().read_text())
        except (OSError, ValueError):
            data = {}
        cfg = {**DEFAULTS, **data}
        if not cfg["token"]:
            cfg["token"] = secrets.token_urlsafe(24)
            _write(cfg)
        return cfg


def _write(cfg: dict[str, Any]) -> None:
    HOME.mkdir(parents=True, exist_ok=True)
    tmp = _path().with_suffix(".tmp")
    tmp.write_text(json.dumps(cfg, indent=2))
    os.chmod(tmp, 0o600)                                      # keys live here: owner-only
    tmp.replace(_path())


def update(**changes: Any) -> dict[str, Any]:
    cfg = load()
    with _LOCK:
        cfg.update(changes)
        _write(cfg)
    return cfg


def provider_key(name: str) -> str | None:
    env = {"openrouter": "OPENROUTER_API_KEY"}.get(name)
    return (os.getenv(env) if env else None) or (load()["providers"].get(name) or {}).get("api_key") or None


def set_provider_key(name: str, key: str | None) -> None:
    cfg = load()
    providers = dict(cfg["providers"])
    if key:
        providers[name] = {**providers.get(name, {}), "api_key": key.strip()}
    else:
        providers.pop(name, None)
    update(providers=providers)


def projects() -> list[dict[str, str]]:
    return [p for p in load()["projects"] if Path(p["path"]).is_dir()]


def project_root(project_id: str | None) -> Path:
    """The folder for a project id (or the first project). Raises if there are none."""
    ps = projects()
    if not ps:
        raise LookupError("No project folder yet — add one in Settings → Projects.")
    p = next((p for p in ps if p["id"] == project_id), None) if project_id else ps[0]
    if p is None:
        raise LookupError(f"Unknown project {project_id!r}.")
    return Path(p["path"]).resolve()


def add_project(path: str, name: str | None = None) -> dict[str, str]:
    root = Path(os.path.expanduser(path)).resolve()
    if not root.is_dir():
        raise ValueError(f"Not a folder: {root}")
    if root == Path.home().resolve() or root == Path("/"):
        raise ValueError("Pick a project folder, not your whole home folder.")
    cfg = load()
    items = [p for p in cfg["projects"] if Path(p["path"]).resolve() != root]
    item = {"id": secrets.token_hex(4), "name": name or root.name, "path": str(root)}
    update(projects=[item, *items])
    return item


def remove_project(project_id: str) -> None:
    update(projects=[p for p in load()["projects"] if p["id"] != project_id])
