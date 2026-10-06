from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import subprocess
import time
from pathlib import Path

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from typing import Any

from minicam.api.routes_preview import start_capture_loop
from minicam.api.routes_timelapse import run_timelapse
from minicam.camera.sensors import SENSOR_PROFILES, get_sensor_profile
from minicam.config import load_config

log = logging.getLogger(__name__)
router = APIRouter()

_CAMERA_CONFIG_PATH = Path("/etc/minicam/config.toml")
_BOOT_CONFIG_PATH = Path("/boot/firmware/config.txt")
_OVERLAY_RE = re.compile(r"^dtoverlay=imx\d+.*$", re.MULTILINE)


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
    if cmd == "set_mode":
        try:
            camera.set_mode(str(msg["value"]))
        except ValueError as e:
            return {"cmd": "error", "detail": str(e)}
        return {"cmd": "ack", "raw_mode": camera.raw_mode}
    if cmd == "status":
        resp = {"cmd": "status", **camera.status()}
        resp["camera_error"] = getattr(app.state, "camera_error", None) if app is not None else None
        return resp
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


_LED_PATHS = ["/sys/class/leds/ACT", "/sys/class/leds/led0"]


def _led_sysfs() -> str | None:
    return next((p for p in _LED_PATHS if os.path.isdir(p)), None)


@router.get("/system/led")
async def system_led_status() -> JSONResponse:
    path = _led_sysfs()
    if path is None:
        return JSONResponse({"ok": False, "detail": "LED not found"}, status_code=404)
    try:
        brightness = open(f"{path}/brightness").read().strip()
        return JSONResponse({"ok": True, "on": brightness != "0"})
    except OSError as e:
        return JSONResponse({"ok": False, "detail": str(e)}, status_code=500)


@router.post("/system/led/{state}")
async def system_led_set(state: str) -> JSONResponse:
    if state not in ("on", "off"):
        return JSONResponse({"ok": False, "detail": "use 'on' or 'off'"}, status_code=400)
    path = _led_sysfs()
    if path is None:
        return JSONResponse({"ok": False, "detail": "LED not found"}, status_code=404)
    brightness = "1" if state == "on" else "0"
    try:
        subprocess.run(
            ["sudo", "sh", "-c", f"echo none > {path}/trigger && echo {brightness} > {path}/brightness"],
            check=True, capture_output=True,
        )
    except subprocess.CalledProcessError as e:
        return JSONResponse({"ok": False, "detail": e.stderr.decode().strip()}, status_code=500)
    log.info("LED set to %s", state)
    return JSONResponse({"ok": True, "on": state == "on"})


def _write_camera_sensor_config(sensor: str) -> None:
    """Update (or create) the [camera] sensor key in /etc/minicam/config.toml."""
    text = _CAMERA_CONFIG_PATH.read_text() if _CAMERA_CONFIG_PATH.exists() else ""
    if "[camera]" not in text:
        prefix = text.rstrip() + "\n\n" if text.strip() else ""
        text = prefix + f'[camera]\nsensor = "{sensor}"\n'
    elif re.search(r'^\s*sensor\s*=', text, re.MULTILINE):
        text = re.sub(r'^\s*sensor\s*=.*$', f'sensor = "{sensor}"', text, count=1, flags=re.MULTILINE)
    else:
        text = re.sub(r'(\[camera\]\s*\n)', rf'\1sensor = "{sensor}"\n', text, count=1)
    subprocess.run(
        ["sudo", "mkdir", "-p", str(_CAMERA_CONFIG_PATH.parent)],
        check=True, capture_output=True,
    )
    subprocess.run(
        ["sudo", "tee", str(_CAMERA_CONFIG_PATH)],
        input=text.encode(), check=True, capture_output=True,
    )


def _write_boot_overlay(dtoverlay: str) -> None:
    """Swap the active camera dtoverlay line in /boot/firmware/config.txt.

    Only takes effect after a reboot — the kernel driver bound to the CSI
    port is fixed at boot. Refuses to guess if the active-overlay line isn't
    found exactly once, rather than risk corrupting the boot config.
    """
    text = _BOOT_CONFIG_PATH.read_text()
    matches = _OVERLAY_RE.findall(text)
    if len(matches) != 1:
        raise ValueError(
            f"{len(matches)} ligne(s) dtoverlay=imx* active(s) trouvée(s) dans "
            f"{_BOOT_CONFIG_PATH} (attendu: 1) — édition manuelle requise"
        )
    new_text = _OVERLAY_RE.sub(f"dtoverlay={dtoverlay}", text, count=1)
    subprocess.run(
        ["sudo", "cp", str(_BOOT_CONFIG_PATH), str(_BOOT_CONFIG_PATH) + ".bak"],
        check=True, capture_output=True,
    )
    subprocess.run(
        ["sudo", "tee", str(_BOOT_CONFIG_PATH)],
        input=new_text.encode(), check=True, capture_output=True,
    )


class _SensorBody(BaseModel):
    sensor: str


@router.get("/system/sensor")
async def system_sensor_status() -> JSONResponse:
    cfg = load_config()
    current = cfg["camera"].get("sensor", "imx327")
    return JSONResponse({"ok": True, "sensor": current, "sensors": list(SENSOR_PROFILES)})


@router.post("/system/sensor")
async def system_sensor_set(body: _SensorBody) -> JSONResponse:
    try:
        profile = get_sensor_profile(body.sensor)
    except ValueError as e:
        return JSONResponse({"ok": False, "detail": str(e)}, status_code=400)
    try:
        _write_camera_sensor_config(profile.name)
        _write_boot_overlay(profile.dtoverlay)
    except (subprocess.CalledProcessError, ValueError, OSError) as e:
        detail = e.stderr.decode().strip() if isinstance(e, subprocess.CalledProcessError) else str(e)
        return JSONResponse({"ok": False, "detail": detail}, status_code=500)
    asyncio.get_event_loop().call_later(1.0, lambda: subprocess.Popen(["sudo", "systemctl", "reboot"]))
    log.info("Sensor switch to %s requested — rebooting", profile.name)
    return JSONResponse({"ok": True, "sensor": profile.name, "action": "reboot"})


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


class _TimeBody(BaseModel):
    epoch_ms: int


# En mode hotspot (le Pi héberge son propre point d'accès Wi-Fi), il n'a
# jamais accès à Internet et ne peut donc jamais faire de synchro NTP — sans
# RTC matérielle, son horloge reste bloquée sur la dernière valeur connue.
# Le navigateur qui s'y connecte a en général l'heure correcte (téléphone en
# 4G, laptop synchronisé plus tôt), donc on la lui emprunte.
_CLOCK_SKEW_TOLERANCE_S = 5.0


@router.get("/system/time")
async def system_time_status() -> JSONResponse:
    synced = subprocess.run(
        ["timedatectl", "show", "-p", "NTPSynchronized", "--value"],
        capture_output=True, text=True,
    ).stdout.strip() == "yes"
    return JSONResponse({"ok": True, "synchronized": synced, "epoch_ms": round(time.time() * 1000)})


@router.post("/system/time")
async def system_time_set(body: _TimeBody) -> JSONResponse:
    client_s = body.epoch_ms / 1000
    if abs(client_s - time.time()) <= _CLOCK_SKEW_TOLERANCE_S:
        return JSONResponse({"ok": True, "action": "unchanged"})
    try:
        subprocess.run(
            ["sudo", "date", "-s", f"@{client_s:.3f}"],
            check=True, capture_output=True,
        )
    except subprocess.CalledProcessError as e:
        return JSONResponse({"ok": False, "detail": e.stderr.decode().strip()}, status_code=500)
    log.info("System clock set from client browser to epoch %.3f", client_s)
    return JSONResponse({"ok": True, "action": "set", "epoch_ms": round(time.time() * 1000)})


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
