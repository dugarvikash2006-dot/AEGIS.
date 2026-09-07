"""AEGIS backend app assembly.

Run: `uvicorn backend.main:app --host 0.0.0.0 --port 8000 --workers 1`
(exactly one worker — the live NetworkState is in process memory).
"""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from backend.api import errors, routes, ws
from backend.api.context import AppContext

# Comma-separated list of allowed browser origins. Default keeps the Vite dev
# server working with no configuration; containers pass AEGIS_CORS_ORIGINS.
_DEFAULT_CORS_ORIGINS = (
    "http://localhost:5173,"
    "http://127.0.0.1:5173,"
    "https://aegis-77d2-8v1568z2r-butter-byte-6186.vercel.app"
)


def _cors_origins() -> list[str]:
    raw = os.getenv("AEGIS_CORS_ORIGINS", _DEFAULT_CORS_ORIGINS)
    return [origin.strip() for origin in raw.split(",") if origin.strip()]


@asynccontextmanager
async def lifespan(app: FastAPI):
    drift_task = None
    if hasattr(app.state, "ctx") and hasattr(app.state.ctx, "start_background_drift"):
        drift_task = asyncio.create_task(app.state.ctx.start_background_drift())
    try:
        yield
    finally:
        if drift_task:
            drift_task.cancel()
            try:
                await drift_task
            except (asyncio.CancelledError, Exception):
                pass


def create_app() -> FastAPI:
    app = FastAPI(title="AEGIS", version="0.1.0", lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=_cors_origins(),
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.state.ctx = AppContext.build()
    errors.install(app)
    app.include_router(routes.router)
    app.include_router(ws.router)
    return app


app = create_app()
