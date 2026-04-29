from __future__ import annotations

import asyncio
import logging
from typing import Any, AsyncGenerator

import cv2
from fastapi import APIRouter, Request
from fastapi.responses import Response, StreamingResponse

log = logging.getLogger(__name__)
router = APIRouter()

BOUNDARY = b"--frame"
MJPEG_QUALITY = 70
TARGET_FPS = 15


async def _capture_loop(camera: Any, state: Any) -> None:
    """Background task: one capture loop shared by all clients."""
    interval = 1.0 / TARGET_FPS
    while True:
        raw_cli = getattr(state, "raw_clients", 0)
        if raw_cli > 0:
            log.debug("[preview] throttle: raw_clients=%d — sleeping 0.1s", raw_cli)
            await asyncio.sleep(0.1)
            continue
        t0 = asyncio.get_event_loop().time()
        try:
            frame = await asyncio.get_event_loop().run_in_executor(None, camera.capture_frame)
            bgr = cv2.cvtColor(frame, cv2.COLOR_YUV420p2BGR)
            ok, buf = cv2.imencode(".jpg", bgr, [cv2.IMWRITE_JPEG_QUALITY, MJPEG_QUALITY])
            if ok:
                state.last_preview_jpeg = buf.tobytes()
        except Exception as e:
            log.warning("Capture loop error: %s", e)
            await asyncio.sleep(0.5)
            continue
        elapsed = asyncio.get_event_loop().time() - t0
        wait = interval - elapsed
        if wait > 0:
            await asyncio.sleep(wait)


async def _capture_loop_guarded(camera: Any, state: Any) -> None:
    """Wrapper that restarts _capture_loop if it exits unexpectedly."""
    while True:
        try:
            await _capture_loop(camera, state)
        except asyncio.CancelledError:
            raise  # propagate cancellation (shutdown)
        except Exception as e:
            log.error("[preview] _capture_loop crashed (%s) — restarting in 1s", e)
            await asyncio.sleep(1.0)


def start_capture_loop(app: Any) -> None:
    app.state.capture_task = asyncio.create_task(
        _capture_loop_guarded(app.state.camera, app.state)
    )


async def _mjpeg_generator(state: Any) -> AsyncGenerator[bytes, None]:
    """Stream cached frames — zero additional camera captures."""
    interval = 1.0 / TARGET_FPS
    last_data: bytes | None = None
    while True:
        t0 = asyncio.get_event_loop().time()
        data = state.last_preview_jpeg
        if data is not None and data is not last_data:
            last_data = data
            yield (
                BOUNDARY + b"\r\n"
                b"Content-Type: image/jpeg\r\n"
                b"Content-Length: " + str(len(data)).encode() + b"\r\n\r\n"
                + data + b"\r\n"
            )
        elapsed = asyncio.get_event_loop().time() - t0
        wait = interval - elapsed
        if wait > 0:
            await asyncio.sleep(wait)


@router.get("/preview_frame.jpg")
async def preview_frame(request: Request) -> Response:
    data: bytes | None = request.app.state.last_preview_jpeg
    if data is None:
        return Response(status_code=503)
    return Response(content=data, media_type="image/jpeg",
                    headers={"Cache-Control": "no-store"})


@router.get("/preview.mjpg")
async def preview_mjpg(request: Request) -> StreamingResponse:
    return StreamingResponse(
        _mjpeg_generator(request.app.state),
        media_type="multipart/x-mixed-replace; boundary=frame",
    )
