"""Every API request must carry this machine's token; browsers may only call from allowed origins.

Without this, any web page open in your browser could reach the local backend and run commands on your
machine. The token lives in ~/.edgerunner/config.json; the frontend sends it as `Authorization: Bearer …`
(or `?token=` for the terminal WebSocket, which can't set headers).
"""
from __future__ import annotations

import hmac
import os

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse

from app.core import store

OPEN_PATHS = {"/api/health"}
DEFAULT_ORIGINS = ["http://localhost:3000", "http://localhost:3100", "http://127.0.0.1:3000", "http://127.0.0.1:3100",
                   "https://deveshpat.github.io"]


def allowed_origins() -> list[str]:
    extra = [o.strip() for o in os.getenv("ALLOWED_ORIGINS", "").split(",") if o.strip() and o.strip() != "*"]
    return DEFAULT_ORIGINS + extra


def token_ok(given: str | None) -> bool:
    if os.getenv("EDGERUNNER_NO_AUTH") == "1":            # tests only
        return True
    return bool(given) and hmac.compare_digest(given, store.load()["token"])


class TokenAuth(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        path = request.url.path
        if request.method == "OPTIONS" or path in OPEN_PATHS or not path.startswith(("/api", "/v1")):
            return await call_next(request)
        header = request.headers.get("authorization", "")
        given = header[7:] if header.lower().startswith("bearer ") else request.query_params.get("token")
        if not token_ok(given):
            return JSONResponse({"detail": "EdgeRunner needs this machine's access token (see Settings → Connection)."},
                                status_code=401)
        return await call_next(request)


class PrivateNetworkAccess:
    """Lets the hosted app (https://deveshpat.github.io) reach this server on localhost: Chrome first asks the
    server, in the CORS preflight, whether public pages may call it. Origins are still limited by CORS above."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        wants = scope["type"] == "http" and scope["method"] == "OPTIONS" and any(
            k == b"access-control-request-private-network" for k, _ in scope["headers"])
        if not wants:
            return await self.app(scope, receive, send)

        async def send_with_header(message):
            if message["type"] == "http.response.start":
                message["headers"] = [*message.get("headers", []), (b"access-control-allow-private-network", b"true")]
            await send(message)

        await self.app(scope, receive, send_with_header)
