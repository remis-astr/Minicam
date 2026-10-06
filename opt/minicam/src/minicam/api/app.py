from __future__ import annotations

import errno
import logging
import time
from contextlib import asynccontextmanager
from typing import AsyncGenerator

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request

from minicam.camera.controller import CameraController
from minicam.config import STATE_PATH, load_config
from minicam.imu import IMUStreamer
from minicam.api.routes_capture import router as capture_router
from minicam.api.routes_control import router as control_router
from minicam.api.routes_guide import router as guide_router
from minicam.api.routes_imu import router as imu_router
from minicam.api.routes_photos import router as photos_router
from minicam.api.routes_preview import router as preview_router, start_capture_loop
from minicam.api.routes_raw_stream import router as raw_router
from minicam.api.routes_static import router as static_router
from minicam.api.routes_timelapse import router as timelapse_router
from minicam.api.routes_wifi import router as wifi_router

log = logging.getLogger(__name__)

# Relances du processus après un échec d'allocation CMA (voir lifespan()).
_CMA_RETRY_PATH = STATE_PATH.parent / "cma_retries"
_CMA_MAX_RETRIES = 3
_CMA_RETRY_WINDOW_S = 300


def _is_cma_alloc_error(exc: BaseException) -> bool:
    while exc is not None:
        if isinstance(exc, OSError) and exc.errno in (errno.ENOMEM, errno.EBUSY):
            return True
        exc = exc.__cause__ or exc.__context__
    return False


def _cma_retry_count() -> int:
    """Relances déjà faites dans la fenêtre courante (0 si fichier vieux/absent)."""
    try:
        if time.time() - _CMA_RETRY_PATH.stat().st_mtime > _CMA_RETRY_WINDOW_S:
            return 0
        return int(_CMA_RETRY_PATH.read_text())
    except (OSError, ValueError):
        return 0

camera: CameraController | None = None


def _imu_enabled() -> bool:
    return bool(load_config().get("imu", {}).get("enabled", True))


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    global camera
    camera = CameraController()
    app.state.camera = camera
    app.state.camera_error = None
    app.state.seq_subscribers: list = []
    app.state.last_preview_jpeg = None
    app.state.indi_mode = False
    app.state.indi_proc = None
    app.state.raw_clients = 0
    app.state.tl_running = False
    app.state.tl_task = None
    app.state.tl_last_jpeg = None
    app.state.tl_session = None
    app.state.capture_task = None
    app.state.imu = None
    if _imu_enabled():
        app.state.imu = IMUStreamer()
        app.state.imu.start()
    # Camera init failure (wrong/missing sensor, transient DMA alloc error) must
    # not take the whole web server down with it — the UI (incl. the sensor
    # switch controls) needs to stay reachable so it can be used to recover.
    #
    # NOTE: retrying camera.open() in-process was tried and made things WORSE.
    # A failed configure() can leave some stream buffers allocated in the CMA
    # pool; Picamera2.close() does not reliably release them while the
    # process stays alive (confirmed via /sys/kernel/debug/dma_buf/bufinfo —
    # buffers only actually freed once the whole process exits). Each retry
    # then has *less* free/contiguous CMA than the last, so 3 in-process
    # retries left ~130 MB permanently stuck instead of helping. A real fix
    # would need a full process restart (fresh CMA state) between attempts,
    # not a loop within lifespan(). So on a CMA alloc error (ENOMEM/EBUSY) the
    # startup is aborted: uvicorn exits, systemd (Restart=on-failure) starts a
    # fresh process. Capped at _CMA_MAX_RETRIES per window, then the server
    # comes up without camera as before. Other errors (wrong sensor…) never
    # trigger a restart.
    try:
        camera.open()
    except Exception as exc:
        log.exception("Camera failed to open")
        app.state.camera_error = str(exc)
        retries = _cma_retry_count()
        if _is_cma_alloc_error(exc) and retries < _CMA_MAX_RETRIES:
            try:
                _CMA_RETRY_PATH.parent.mkdir(parents=True, exist_ok=True)
                _CMA_RETRY_PATH.write_text(str(retries + 1))
            except OSError:
                log.warning("Compteur %s non écrit, pas de relance", _CMA_RETRY_PATH)
            else:
                log.warning("Échec d'allocation CMA — relance du processus (%d/%d)",
                            retries + 1, _CMA_MAX_RETRIES)
                raise RuntimeError("CMA alloc failed, restart for a fresh CMA state") from exc
    else:
        _CMA_RETRY_PATH.unlink(missing_ok=True)
        start_capture_loop(app)
    log.info("Camera ready" if app.state.camera_error is None else "Camera unavailable")
    yield
    if app.state.imu:
        app.state.imu.stop()
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
        # routes_static.py only sets no-store on 3 hand-picked files
        # (index.html/app.js/style.css) — everything else under /static
        # (lucky_stack.html, stacker.js, the analyze/stack workers, etc.)
        # falls through to FastAPI's generic StaticFiles mount, which lets
        # browsers cache indefinitely. A stale cached worker script showing
        # old (already-fixed-on-disk) behavior is exactly the kind of bug
        # that's invisible from the server side — cover the whole static
        # tree here instead of hand-listing every file.
        if request.url.path == "/" or request.url.path.startswith("/static/"):
            response.headers["Cache-Control"] = "no-store"
        return response


def create_app() -> FastAPI:
    app = FastAPI(title="minicam", version="0.1.0", lifespan=lifespan)
    app.add_middleware(_COOPCOEPMiddleware)
    app.include_router(static_router)
    app.include_router(control_router)
    app.include_router(preview_router)
    app.include_router(capture_router)
    app.include_router(guide_router)
    app.include_router(photos_router)
    app.include_router(raw_router)
    app.include_router(timelapse_router)
    app.include_router(wifi_router)
    app.mount("/static", StaticFiles(directory="/opt/minicam/web"), name="static")
    if _imu_enabled():
        app.include_router(imu_router)
        app.mount("/astrohopper", StaticFiles(directory="/opt/minicam/web/astrohopper", html=True), name="astrohopper")
    return app
