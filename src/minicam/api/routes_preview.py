from __future__ import annotations

import asyncio
import io
import logging
from typing import Any, AsyncGenerator

import cv2
import numpy as np
from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse

log = logging.getLogger(__name__)
router = APIRouter()

BOUNDARY = b"--frame"
MJPEG_QUALITY = 70
TARGET_FPS = 15


async def _mjpeg_generator(camera: Any) -> AsyncGenerator[bytes, None]:
    interval = 1.0 / TARGET_FPS
    while True:
        t0 = asyncio.get_event_loop().time()
        try:
            frame = await asyncio.get_event_loop().run_in_executor(None, camera.capture_frame)
            # YUV420 → BGR
            bgr = cv2.cvtColor(frame, cv2.COLOR_YUV420p2BGR)
            ok, buf = cv2.imencode(".jpg", bgr, [cv2.IMWRITE_JPEG_QUALITY, MJPEG_QUALITY])
            if not ok:
                continue
            data = buf.tobytes()
            yield (
                BOUNDARY + b"\r\n"
                b"Content-Type: image/jpeg\r\n"
                b"Content-Length: " + str(len(data)).encode() + b"\r\n\r\n"
                + data + b"\r\n"
            )
        except Exception as e:
            log.warning("Preview frame error: %s", e)
            await asyncio.sleep(0.5)
            continue
        elapsed = asyncio.get_event_loop().time() - t0
        wait = interval - elapsed
        if wait > 0:
            await asyncio.sleep(wait)


@router.get("/preview.mjpg")
async def preview_mjpg(request: Request) -> StreamingResponse:
    camera = request.app.state.camera
    return StreamingResponse(
        _mjpeg_generator(camera),
        media_type="multipart/x-mixed-replace; boundary=frame",
    )
