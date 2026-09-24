from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from typing import AsyncGenerator

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request

from minicam.camera.controller import CameraController
from minicam.imu import IMUStreamer
from minicam.api.routes_capture import router as capture_router
from minicam.api.routes_control import router as control_router
from minicam.api.routes_guide import router as guide_router
from minicam.api.routes_imu import router as imu_router
from minicam.api.routes_preview import router as preview_router, start_capture_loop
from minicam.api.routes_raw_stream import router as raw_router
from minicam.api.routes_static import router as static_router
from minicam.api.routes_timelapse import router as timelapse_router

log = logging.getLogger(__name__)

camera: CameraController | None = None


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    global camera
    camera = CameraController()
    camera.open()
    app.state.camera = camera
    app.state.seq_subscribers: list = []
    app.state.last_preview_jpeg = None
    app.state.indi_mode = False
    app.state.indi_proc = None
    app.state.raw_clients = 0
    app.state.tl_running = False
    app.state.tl_task = None
    app.state.tl_last_jpeg = None
    app.state.tl_session = None
    imu = IMUStreamer()
    imu.start()
    app.state.imu = imu
    start_capture_loop(app)
    log.info("Camera ready")
    yield
    imu.stop()
    if app.state.tl_task:
        app.state.tl_task.cancel()
    if app.state.capture_task:
        app.state.capture_task.cancel()
    if app.state.indi_proc:
        try:
            app.state.indi_proc.terminate()
        except Exception:
            pass
    if not app.state.indi_mode:
        camera.close()
    log.info("Camera closed")


class _COOPCOEPMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        response = await call_next(request)
        response.headers["Cross-Origin-Opener-Policy"] = "same-origin"
        response.headers["Cross-Origin-Embedder-Policy"] = "require-corp"
        return response


def create_app() -> FastAPI:
    app = FastAPI(title="minicam", version="0.1.0", lifespan=lifespan)
    app.add_middleware(_COOPCOEPMiddleware)
    app.include_router(static_router)
    app.include_router(control_router)
    app.include_router(preview_router)
    app.include_router(capture_router)
    app.include_router(guide_router)
    app.include_router(raw_router)
    app.include_router(imu_router)
    app.include_router(timelapse_router)
    app.mount("/static", StaticFiles(directory="/opt/minicam/web"), name="static")
    app.mount("/astrohopper", StaticFiles(directory="/opt/minicam/web/astrohopper", html=True), name="astrohopper")
    return app
