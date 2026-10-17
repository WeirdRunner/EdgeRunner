"""`edgerunner-node`: run the edge node so the EdgeRunner web app can work in project folders on this machine.

    edgerunner-node                      # http://127.0.0.1:8100, prints the access token
    edgerunner-node --add ~/code/myapp   # allow a project folder first
"""
from __future__ import annotations

import argparse
import os


def main() -> None:
    ap = argparse.ArgumentParser(prog="edgerunner-node", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", type=int, default=int(os.getenv("EDGERUNNER_PORT", "8100")))
    ap.add_argument("--host", default="127.0.0.1", help="keep 127.0.0.1 unless you know you need otherwise")
    ap.add_argument("--add", metavar="FOLDER", action="append", default=[], help="add a project folder the agent may work in")
    ap.add_argument("--token", action="store_true", help="print the access token and exit")
    args = ap.parse_args()

    from app.core import store
    for folder in args.add:
        p = store.add_project(folder)
        print(f"  added project {p['name']}: {p['path']}")
    if args.token:
        print(store.load()["token"])
        return
    projects = store.projects()
    print(f"  projects: {', '.join(p['name'] for p in projects) or 'none yet (add with --add FOLDER or in Settings)'}")
    print(f"  open EdgeRunner → ⚙ Settings → Mac node, and use http://{args.host}:{args.port}")

    import uvicorn
    uvicorn.run("app.main:app", host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
