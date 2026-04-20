from __future__ import annotations

import json
import logging
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field

log = logging.getLogger(__name__)
router = APIRouter()


class SetGain(BaseModel):
    cmd: str = "set_gain"
    value: float = Field(gt=0, le=64)


class SetExposure(BaseModel):
    cmd: str = "set_exposure"
    value_ms: float = Field(gt=0, le=30000)


class Ping(BaseModel):
    cmd: str = "ping"


def _handle(camera: Any, msg: dict[str, Any]) -> dict[str, Any]:
    cmd = msg.get("cmd")
    if cmd == "ping":
        return {"cmd": "pong"}
    if cmd == "set_gain":
        camera.set_gain(float(msg["value"]))
        return {"cmd": "ack", "gain": camera.gain}
    if cmd == "set_exposure":
        camera.set_exposure_ms(float(msg["value_ms"]))
        return {"cmd": "ack", "exposure_us": camera.exposure_us}
    if cmd == "status":
        return {"cmd": "status", **camera.status()}
    return {"cmd": "error", "detail": f"unknown command: {cmd}"}


@router.get("/status")
async def status() -> dict[str, Any]:
    return {"ok": True}


@router.get("/healthz")
async def healthz() -> dict[str, str]:
    return {"status": "ok"}


@router.websocket("/ws/control")
async def ws_control(websocket: WebSocket) -> None:
    await websocket.accept()
    camera = websocket.app.state.camera
    log.info("WS client connected")
    try:
        while True:
            raw = await websocket.receive_text()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                await websocket.send_text(json.dumps({"cmd": "error", "detail": "invalid json"}))
                continue
            response = _handle(camera, msg)
            await websocket.send_text(json.dumps(response))
    except WebSocketDisconnect:
        log.info("WS client disconnected")
