from __future__ import annotations

import cv2
from fastapi import APIRouter, Request
from fastapi.responses import Response

router = APIRouter()


@router.get("/capture.png")
async def capture_png(request: Request) -> Response:
    camera = request.app.state.camera
    frame = await __import__("asyncio").get_event_loop().run_in_executor(
        None, camera.capture_frame
    )
    bgr = cv2.cvtColor(frame, cv2.COLOR_YUV420p2BGR)
    ok, buf = cv2.imencode(".png", bgr)
    if not ok:
        return Response(status_code=500)
    return Response(
        content=buf.tobytes(),
        media_type="image/png",
        headers={"Content-Disposition": 'attachment; filename="capture.png"'},
    )
