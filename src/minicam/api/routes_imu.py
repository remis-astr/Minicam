from __future__ import annotations

import asyncio
import json
import logging
import time

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

log = logging.getLogger(__name__)
router = APIRouter()


@router.websocket("/ws/imu")
async def ws_imu(websocket: WebSocket) -> None:
    await websocket.accept()
    streamer = websocket.app.state.imu
    loop     = asyncio.get_event_loop()
    queue: asyncio.Queue[str] = asyncio.Queue(maxsize=5)

    def on_angles(alpha: float, beta: float, gamma: float) -> None:
        q = streamer.q  # [w,x,y,z] — snapshot written atomically under GIL
        msg = json.dumps({
            "q": [round(v, 5) for v in q],
            "alpha": round(alpha, 2),
            "beta":  round(beta, 2),
            "gamma": round(gamma, 2),
            "t": int(time.time() * 1000),
        })
        try:
            loop.call_soon_threadsafe(queue.put_nowait, msg)
        except asyncio.QueueFull:
            pass   # client too slow — drop frame

    streamer.add_callback(on_angles)
    log.info("IMU WebSocket client connected")
    try:
        while True:
            msg = await queue.get()
            await websocket.send_text(msg)
    except WebSocketDisconnect:
        pass
    finally:
        streamer.remove_callback(on_angles)
        log.info("IMU WebSocket client disconnected")
