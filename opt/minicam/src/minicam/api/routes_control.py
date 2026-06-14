from __future__ import annotations

import asyncio
import json
import logging
import subprocess
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse
from minicam.api.routes_preview import start_capture_loop
from minicam.api.routes_timelapse import run_timelapse

log = logging.getLogger(__name__)
router = APIRouter()


def _handle(camera: Any, msg: dict[str, Any], app: Any = None) -> dict[str, Any] | None:
    cmd = msg.get("cmd")
    if cmd == "ping":
        return {"cmd": "pong"}
    if cmd == "set_gain":
        camera.set_gain(float(msg["value"]))
        return {"cmd": "ack", "gain": camera.gain}
    if cmd == "set_exposure":
        camera.set_exposure_ms(float(msg["value_ms"]))
        return {"cmd": "ack", "exposure_us": camera.exposure_us, "exposure_ms": camera.exposure_us / 1000}
    if cmd == "set_wb":
        camera.set_wb(float(msg["red"]), float(msg["blue"]))
        return {"cmd": "ack", "wb_red": camera.wb_red, "wb_blue": camera.wb_blue}
    if cmd == "set_isp":
        camera.set_isp_controls(
            float(msg.get("contrast",        camera.contrast)),
            float(msg.get("sharpness",       camera.sharpness)),
            float(msg.get("saturation",      camera.saturation)),
            float(msg.get("brightness",      camera.brightness)),
            int(msg.get("noise_reduction",   camera.noise_reduction)),
        )
        return {
            "cmd": "ack",
            "contrast": camera.contrast,
            "sharpness": camera.sharpness,
            "saturation": camera.saturation,
            "brightness": camera.brightness,
            "noise_reduction": camera.noise_reduction,
        }
    if cmd == "set_resolution":
        try:
            camera.set_resolution(str(msg["value"]))
        except ValueError as e:
            return {"cmd": "error", "detail": str(e)}
        return {"cmd": "ack", "resolution": camera.resolution}
    if cmd == "status":
        return {"cmd": "status", **camera.status()}
    if cmd == "start_indi":
        if app is None:
            return {"cmd": "error", "detail": "no app context"}
        if app.state.indi_mode:
            return {"cmd": "error", "detail": "INDI already running"}
        asyncio.create_task(_start_indi(app))
        return {"cmd": "ack", "detail": "INDI starting"}
    if cmd == "stop_indi":
        if app is None:
            return {"cmd": "error", "detail": "no app context"}
        if not app.state.indi_mode:
            return {"cmd": "error", "detail": "INDI not running"}
        asyncio.create_task(_stop_indi(app))
        return {"cmd": "ack", "detail": "INDI stopping"}
    if cmd == "indi_status":
        running = app.state.indi_mode if app else False
        return {"cmd": "indi_status", "running": running}
    if cmd == "start_timelapse":
        if app is None:
            return {"cmd": "error", "detail": "no app context"}
        if getattr(app.state, "tl_running", False):
            return {"cmd": "error", "detail": "timelapse already running"}
        if app.state.indi_mode:
            return {"cmd": "error", "detail": "INDI mode active"}
        app.state.tl_task = asyncio.create_task(run_timelapse(camera, app, msg))
        return {"cmd": "ack", "detail": "timelapse started"}
    if cmd == "stop_timelapse":
        if app:
            app.state.tl_running = False
            if app.state.tl_task:
                app.state.tl_task.cancel()
        return {"cmd": "ack", "detail": "stop requested"}
    if cmd == "timelapse_status":
        running = getattr(app.state, "tl_running", False) if app else False
        session = getattr(app.state, "tl_session", None) if app else None
        return {"cmd": "tl_status", "running": running, "session": session}
    return {"cmd": "error", "detail": f"unknown command: {cmd}"}



async def _start_indi(app: Any) -> None:
    loop = asyncio.get_event_loop()
    try:
        if app.state.capture_task:
            app.state.capture_task.cancel()
            app.state.capture_task = None
        await loop.run_in_executor(None, app.state.camera.close)
        log_file = open("/tmp/indiserver.log", "w")
        proc = await asyncio.create_subprocess_exec(
            "/usr/bin/indiserver", "-v", "/home/admin/.local/bin/indi_pylibcamera",
            stdout=log_file,
            stderr=log_file,
        )
        app.state.indi_proc = proc
        app.state.indi_mode = True
        await _broadcast(app, {"cmd": "indi_started"})
        log.info("INDI server started (pid %d)", proc.pid)
    except Exception as e:
        log.error("INDI start error: %s", e)
        await _broadcast(app, {"cmd": "indi_error", "detail": str(e)})
        try:
            await loop.run_in_executor(None, app.state.camera.open)
            start_capture_loop(app)
        except Exception:
            pass


async def _stop_indi(app: Any) -> None:
    loop = asyncio.get_event_loop()
    try:
        if app.state.indi_proc:
            try:
                app.state.indi_proc.terminate()
                await asyncio.wait_for(app.state.indi_proc.wait(), timeout=5.0)
            except (ProcessLookupError, asyncio.TimeoutError):
                try:
                    app.state.indi_proc.kill()
                    await asyncio.wait_for(app.state.indi_proc.wait(), timeout=3.0)
                except Exception:
                    pass
            app.state.indi_proc = None
        app.state.indi_mode = False

        # Le kernel peut mettre quelques secondes à libérer le device camera
        # après la fin du process indiserver — on attend puis on retente.
        await asyncio.sleep(2.0)
        last_exc: Exception | None = None
        for attempt in range(4):
            try:
                await loop.run_in_executor(None, app.state.camera.open)
                last_exc = None
                break
            except Exception as e:
                last_exc = e
                log.warning("Camera reopen attempt %d/4 failed: %s", attempt + 1, e)
                await asyncio.sleep(1.5)
        if last_exc:
            raise last_exc

        start_capture_loop(app)
        await _broadcast(app, {"cmd": "indi_stopped"})
        log.info("INDI server stopped, camera reopened")
    except Exception as e:
        log.error("INDI stop error: %s", e)
        await _broadcast(app, {"cmd": "indi_error", "detail": str(e)})


async def _broadcast(app: Any, event: dict[str, Any]) -> None:
    for q in list(app.state.seq_subscribers):
        await q.put(event)



@router.get("/status")
async def status() -> dict[str, Any]:
    return {"ok": True}


@router.get("/healthz")
async def healthz() -> dict[str, str]:
    return {"status": "ok"}


@router.post("/system/reboot")
async def system_reboot() -> JSONResponse:
    asyncio.get_event_loop().call_later(1.0, lambda: subprocess.Popen(["sudo", "systemctl", "reboot"]))
    log.info("Reboot requested via HTTP")
    return JSONResponse({"ok": True, "action": "reboot"})


@router.post("/system/shutdown")
async def system_shutdown() -> JSONResponse:
    asyncio.get_event_loop().call_later(1.0, lambda: subprocess.Popen(["sudo", "systemctl", "poweroff"]))
    log.info("Shutdown requested via HTTP")
    return JSONResponse({"ok": True, "action": "shutdown"})


@router.websocket("/ws/control")
async def ws_control(websocket: WebSocket) -> None:
    await websocket.accept()
    camera = websocket.app.state.camera
    queue: asyncio.Queue = asyncio.Queue()
    websocket.app.state.seq_subscribers.append(queue)
    log.info("WS client connected")

    async def recv_loop() -> None:
        while True:
            try:
                raw = await websocket.receive_text()
            except WebSocketDisconnect:
                return
            except Exception as e:
                log.error("recv_loop receive error: %s", e)
                return
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                await websocket.send_text(json.dumps({"cmd": "error", "detail": "invalid json"}))
                continue
            try:
                resp = _handle(camera, msg, websocket.app)
            except Exception as e:
                log.error("_handle error for cmd=%r: %s", msg.get("cmd"), e)
                resp = {"cmd": "error", "detail": str(e)}
            if resp is not None:
                try:
                    await websocket.send_text(json.dumps(resp))
                except Exception as e:
                    log.error("recv_loop send error (cmd=%r): %s", msg.get("cmd"), e)
                    return

    async def push_loop() -> None:
        try:
            while True:
                event = await queue.get()
                await websocket.send_text(json.dumps(event))
        except Exception:
            pass

    recv_task = asyncio.create_task(recv_loop())
    push_task = asyncio.create_task(push_loop())
    await asyncio.wait({recv_task, push_task}, return_when=asyncio.FIRST_COMPLETED)
    recv_task.cancel()
    push_task.cancel()
    websocket.app.state.seq_subscribers.remove(queue)
    log.info("WS client disconnected")
