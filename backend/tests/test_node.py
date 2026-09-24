"""Edge node API: project scoping, file ops, commands and the macOS write sandbox."""
import shlex
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.core import store
from app.main import app
from app.routers import node


@pytest.fixture()
def project(tmp_path, monkeypatch):
    monkeypatch.setattr(store, "HOME", tmp_path / "home")
    root = tmp_path / "my project"            # a space in the path, on purpose
    root.mkdir()
    (root / "a.txt").write_text("hello\n")
    item = store.add_project(str(root))
    return item["id"], root


client = TestClient(app)


def test_info_lists_projects(project):
    pid, root = project
    info = client.get("/api/node/info").json()
    assert info["projects"][0]["id"] == pid and info["projects"][0]["path"] == str(root.resolve())


def test_read_write_list_walk_rm(project):
    pid, root = project
    assert client.get("/api/node/fs/read", params={"project": pid, "path": "a.txt"}).json()["content"] == "hello\n"
    assert client.post("/api/node/fs/write", json={"project": pid, "path": "src/b.js", "content": "x"}).json()["ok"]
    assert (root / "src" / "b.js").read_text() == "x"
    names = [e["name"] for e in client.get("/api/node/fs/list", params={"project": pid}).json()]
    assert names == ["src", "a.txt"]                       # folders first
    (root / "node_modules" / "pkg").mkdir(parents=True)
    (root / "node_modules" / "pkg" / "i.js").write_text("")
    assert sorted(client.get("/api/node/fs/walk", params={"project": pid}).json()) == ["a.txt", "src/b.js"]
    client.post("/api/node/fs/rm", json={"project": pid, "path": "src"})
    assert not (root / "src").exists()


def test_stat(project):
    pid, root = project
    assert client.get("/api/node/fs/stat", params={"project": pid, "path": "a.txt"}).json() == {"exists": True, "dir": False}
    assert client.get("/api/node/fs/stat", params={"project": pid, "path": "."}).json() == {"exists": True, "dir": True}
    assert client.get("/api/node/fs/stat", params={"project": pid, "path": "nope"}).json()["exists"] is False


def test_binary_round_trip(project):
    pid, root = project
    import base64
    blob = bytes(range(256))
    client.post("/api/node/fs/write", json={"project": pid, "path": "x.bin", "content": base64.b64encode(blob).decode(), "encoding": "base64"})
    r = client.get("/api/node/fs/read", params={"project": pid, "path": "x.bin"}).json()
    assert r["encoding"] == "base64" and base64.b64decode(r["content"]) == blob


@pytest.mark.parametrize("bad", ["../outside.txt", "/etc/passwd", "a/../../x"])
def test_paths_cannot_escape_the_project(project, bad):
    pid, _ = project
    assert client.get("/api/node/fs/read", params={"project": pid, "path": bad}).status_code in (403, 404)
    assert client.post("/api/node/fs/write", json={"project": pid, "path": bad, "content": "x"}).status_code == 403


def test_symlink_out_is_refused(project, tmp_path):
    pid, root = project
    (tmp_path / "secret.txt").write_text("s")
    (root / "link").symlink_to(tmp_path / "secret.txt")
    assert client.get("/api/node/fs/read", params={"project": pid, "path": "link"}).status_code == 403


def test_cannot_delete_project_root(project):
    pid, root = project
    assert client.post("/api/node/fs/rm", json={"project": pid, "path": "."}).status_code == 403
    assert root.exists()


def test_absolute_path_inside_project_is_fine(project):
    pid, root = project
    r = client.get("/api/node/fs/read", params={"project": pid, "path": str(root.resolve() / "a.txt")})
    assert r.json()["content"] == "hello\n"


def test_exec_runs_in_project_with_spaces(project):
    pid, root = project
    r = client.post("/api/node/exec", json={"project": pid, "command": "pwd && cat a.txt"}).json()
    assert r["code"] == 0 and str(root.resolve()) in r["output"] and "hello" in r["output"]


def test_exec_timeout(project):
    pid, _ = project
    r = client.post("/api/node/exec", json={"project": pid, "command": "sleep 5", "timeout": 1}).json()
    assert r["timed_out"] and r["code"] == 124


def test_unknown_project_is_404(project):
    assert client.get("/api/node/fs/list", params={"project": "nope"}).status_code == 404


@pytest.mark.skipif(not node.sandboxed(), reason="macOS sandbox-exec only")
def test_sandbox_blocks_writes_outside_project(project, tmp_path):
    pid, root = project
    outside = Path.home() / ".edgerunner-sandbox-probe"
    r = client.post("/api/node/exec", json={"project": pid, "command": f"touch inside.txt && touch '{outside}'"}).json()
    assert (root / "inside.txt").exists()
    assert not outside.exists(), "sandbox let a command write to the home folder"
    assert r["code"] != 0


def test_background_server_reports_url(project):
    pid, _ = project
    cmd = f"{shlex.quote(sys.executable)} -u -m http.server 8765 --bind 127.0.0.1"
    try:
        r = client.post("/api/node/start", json={"project": pid, "command": cmd, "wait": 10}).json()
        assert r["exited"] is None and r["url"] and ":8765" in r["url"]
    finally:
        client.post("/api/node/stop")


def test_private_network_preflight_allows_hosted_app():
    r = client.options("/api/node/info", headers={
        "Origin": "https://deveshpat.github.io", "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Private-Network": "true", "Access-Control-Request-Headers": "authorization"})
    assert r.headers.get("access-control-allow-private-network") == "true"
    assert r.headers.get("access-control-allow-origin") == "https://deveshpat.github.io"


def test_private_network_preflight_rejects_other_sites():
    r = client.options("/api/node/info", headers={
        "Origin": "https://evil.example", "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Private-Network": "true"})
    assert r.headers.get("access-control-allow-origin") is None
