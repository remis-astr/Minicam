from __future__ import annotations

import asyncio
import io

import cv2
import numpy as np
from fastapi import APIRouter, Request
from fastapi.responses import Response

router = APIRouter()


@router.get("/capture.png")
async def capture_png(request: Request) -> Response:
    camera = request.app.state.camera
    frame = await asyncio.get_event_loop().run_in_executor(None, camera.capture_frame)
    bgr = cv2.cvtColor(frame, cv2.COLOR_YUV420p2BGR)
    ok, buf = cv2.imencode(".png", bgr)
    if not ok:
        return Response(status_code=500)
    return Response(
        content=buf.tobytes(),
        media_type="image/png",
        headers={"Content-Disposition": 'attachment; filename="capture.png"'},
    )


@router.get("/capture.npy")
async def capture_raw(request: Request) -> Response:
    camera = request.app.state.camera
    raw, _meta = await asyncio.get_event_loop().run_in_executor(None, camera.capture_raw)
    buf = io.BytesIO()
    np.save(buf, raw)
    return Response(
        content=buf.getvalue(),
        media_type="application/octet-stream",
        headers={"Content-Disposition": 'attachment; filename="capture_raw.npy"'},
    )
