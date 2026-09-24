"""EdgeRunner FastAPI application.

Runs on the GPU node (e.g. Kaggle) and is reached by the frontend over a
tunnelled URL. Every request needs the access token (app/core/auth.py); CORS allows only EdgeRunner's own
origins plus any in ALLOWED_ORIGINS.
"""

from __future__ import annotations

import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app import __version__, workspace
from app.core import store
from app.core.auth import TokenAuth, allowed_origins
from app.routers import catalog, chat, files, models, passthrough, session, terminal


def _truthy(value: str | None) -> bool:
    return (value or "").strip().lower() in ("1", "true", "yes", "on")


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Initialize workspace sandbox directory
    workspace.ensure_workspace()
    if not os.getenv("EDGERUNNER_NO_AUTH"):
        print(f"\n  EdgeRunner edge node — access token: {store.load()['token']}\n"
              f"  (paste it into EdgeRunner → Settings → Connection; stored in {store.HOME / 'config.json'})\n", flush=True)

    # Only the Kaggle worker self-terminates; never the local orchestrator.
    if _truthy(os.getenv("EDGERUNNER_WATCHDOG")):
        from app.session import watchdog

        watchdog.start()
    yield


app = FastAPI(title="EdgeRunner", version=__version__, lifespan=lifespan)

# Only your own EdgeRunner pages may call this server, and every call must carry this machine's token
# (app/core/auth.py). Otherwise any website open in your browser could run commands here.
app.add_middleware(TokenAuth)
app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins(),
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(catalog.router, prefix="/api")
app.include_router(chat.router, prefix="/api")
app.include_router(models.router, prefix="/api")
app.include_router(terminal.router, prefix="/api")
app.include_router(files.router, prefix="/api")
app.include_router(session.router, prefix="/api")  # worker: heartbeat/shutdown
app.include_router(passthrough.router)  # /v1/* -> local llama-server


@app.get("/api/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "version": __version__}
