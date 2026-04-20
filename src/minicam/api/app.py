from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from typing import AsyncGenerator

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from minicam.camera.controller import CameraController
from minicam.api.routes_capture import router as capture_router
from minicam.api.routes_control import router as control_router
from minicam.api.routes_preview import router as preview_router
from minicam.api.routes_static import router as static_router

log = logging.getLogger(__name__)

camera: CameraController | None = None


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    global camera
    camera = CameraController()
    camera.open()
    app.state.camera = camera
    log.info("Camera ready")
    yield
    camera.close()
    log.info("Camera closed")


def create_app() -> FastAPI:
    app = FastAPI(title="minicam", version="0.1.0", lifespan=lifespan)
    app.include_router(static_router)
    app.include_router(control_router)
    app.include_router(preview_router)
    app.include_router(capture_router)
    app.mount("/static", StaticFiles(directory="/opt/minicam/web"), name="static")
    return app
