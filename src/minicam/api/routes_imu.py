from __future__ import annotations

import asyncio
import json
import logging
import time

from fastapi import APIRouter, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse

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
            "q":   [round(v, 5) for v in q],
            "alpha": round(alpha, 2),
            "beta":  round(beta, 2),
            "gamma": round(gamma, 2),
            "t":   int(time.time() * 1000),
            "sid": streamer.session_id,
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


# ---------------------------------------------------------------------------
# Accelerometer calibration endpoints
# ---------------------------------------------------------------------------

@router.post("/imu/calibration/start")
async def calibration_start(req: Request) -> JSONResponse:
    """Clear sample buffer and start collecting accelerometer samples.

    Move the telescope slowly to 8-10 diverse positions (different altitudes
    and azimuths) over ~2-3 minutes, then call /finish.
    """
    req.app.state.imu.calibration_start()
    return JSONResponse({"ok": True, "msg": "Collection started — move scope to diverse orientations"})


@router.get("/imu/calibration/status")
async def calibration_status(req: Request) -> JSONResponse:
    """Return current calibration state and sample count."""
    return JSONResponse(req.app.state.imu.calibration_status())


@router.post("/imu/calibration/finish")
async def calibration_finish(req: Request) -> JSONResponse:
    """Fit ellipsoid to collected samples, apply and persist calibration.

    Returns offset (m/s²), scale (dimensionless), rms_mg (quality metric).
    rms_mg < 20 is good; < 10 is excellent.
    """
    loop = asyncio.get_event_loop()
    try:
        result = await loop.run_in_executor(None, req.app.state.imu.calibration_finish)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    return JSONResponse({"ok": True, **result})


@router.post("/imu/calibration/reset")
async def calibration_reset(req: Request) -> JSONResponse:
    """Remove calibration file and revert to raw (identity) accelerometer readings."""
    req.app.state.imu.calibration_reset()
    return JSONResponse({"ok": True, "msg": "Calibration reset to identity"})


@router.get("/imu/calibration")
async def calibration_get(req: Request) -> JSONResponse:
    """Return current calibration parameters."""
    return JSONResponse(req.app.state.imu.calibration_status())


# ---------------------------------------------------------------------------
# Inclinometer calibration endpoints
# ---------------------------------------------------------------------------

@router.post("/imu/incl_cal/sample")
async def incl_cal_sample(req: Request) -> JSONResponse:
    """Capture ~1.5 s of raw accelerometer data while scope is held still.

    Returns mean raw acc [x, y, z] in m/s² (before any calibration).
    The caller provides the known elevation angle (from inclinometer).
    """
    imu  = req.app.state.imu
    loop = asyncio.get_event_loop()
    imu.incl_capture_start(75)   # 75 samples @ 50 Hz = 1.5 s
    try:
        mean = await loop.run_in_executor(None, imu.incl_capture_wait)
    except TimeoutError as exc:
        raise HTTPException(status_code=504, detail=str(exc))
    return JSONResponse({"acc_mean": [round(float(v), 6) for v in mean]})


@router.post("/imu/incl_cal/apply")
async def incl_cal_apply(req: Request) -> JSONResponse:
    """Apply and persist an inclinometer-fitted calibration.

    Body: {"offset": [ox, oy, oz], "scale": [sx, sy, sz]}
    """
    body = await req.json()
    try:
        offset = body["offset"]
        scale  = body["scale"]
    except KeyError as exc:
        raise HTTPException(status_code=422, detail=f"Missing field: {exc}")
    req.app.state.imu.apply_calibration(offset, scale)
    return JSONResponse({"ok": True})


@router.post("/imu/restart")
async def imu_restart(req: Request) -> JSONResponse:
    """Restart the Mahony filter (reset integral + re-calibrate gyro bias).

    Must be called after inclinometer calibration to flush the stale Mahony
    integral term that was trained on the old accelerometer readings.
    Blocks ~2 s while the new loop calibrates gyro bias.
    """
    loop = asyncio.get_event_loop()
    imu  = req.app.state.imu
    await loop.run_in_executor(None, imu.restart_filter)
    return JSONResponse({"ok": True, "session_id": imu.session_id})
