from __future__ import annotations

import asyncio
import json
import logging
import struct
import time

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from minicam.api.routes_capture import _unpack_raw12

log = logging.getLogger(__name__)
router = APIRouter()

_DEFAULT_FPS = 5
_MAX_FPS = 15


def _capture_and_encode(camera) -> tuple[bytes, int, int, dict]:
    """Capture + unpack + encode — runs in thread pool, never blocks asyncio loop."""
    t_cap = time.monotonic()
    raw_arr, meta = camera.capture_raw()
    t_unpack = time.monotonic()
    data_u16 = (_unpack_raw12(raw_arr) << 4).astype("uint16")
    h, w = data_u16.shape
    t_tobytes = time.monotonic()
    payload = data_u16.tobytes()
    t_done = time.monotonic()
    timing = {
        "capture_ms": (t_unpack - t_cap) * 1000,
        "unpack_ms": (t_tobytes - t_unpack) * 1000,
        "tobytes_ms": (t_done - t_tobytes) * 1000,
        "payload_bytes": len(payload),
    }
    return payload, h, w, timing


@router.websocket("/ws/raw")
async def ws_raw(websocket: WebSocket) -> None:
    await websocket.accept()
    app = websocket.app

    if app.state.indi_mode:
        await websocket.send_text(json.dumps({"cmd": "error", "detail": "INDI mode active"}))
        await websocket.close()
        return

    app.state.raw_clients += 1
    log.info("[ws/raw] client CONNECTED — raw_clients now=%d", app.state.raw_clients)

    fps = float(_DEFAULT_FPS)
    running = True
    loop = asyncio.get_event_loop()
    _frame_count = 0

    async def recv_loop() -> None:
        nonlocal fps, running
        try:
            while True:
                raw = await websocket.receive_text()
                try:
                    msg = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                if msg.get("cmd") == "set_rate":
                    fps = max(0.1, min(_MAX_FPS, float(msg.get("fps", _DEFAULT_FPS))))
                elif msg.get("cmd") == "stop":
                    running = False
        except (WebSocketDisconnect, asyncio.CancelledError):
            pass
        except Exception as e:
            log.warning("Raw WS recv error: %s", e)

    recv_task = asyncio.create_task(recv_loop())

    try:
        while running:
            if app.state.indi_mode:
                await websocket.send_text(json.dumps({"cmd": "error", "detail": "INDI mode active"}))
                break

            t0 = loop.time()
            try:
                camera = app.state.camera

                # Capture + unpack + tobytes dans le thread pool (ne bloque pas l'event loop)
                payload, h, w, timing = await loop.run_in_executor(
                    None, _capture_and_encode, camera
                )

                meta_json = json.dumps({
                    "w": w,
                    "h": h,
                    "gain": camera.gain,
                    "exposure_us": camera.exposure_us,
                    "ExposureTime": camera.exposure_us,
                    "AnalogueGain": camera.gain,
                    "ts": t0,
                }).encode()

                t_send_start = loop.time()
                header = struct.pack(">I", len(meta_json))
                await websocket.send_bytes(header + meta_json + payload)
                t_send_end = loop.time()

                _frame_count += 1
                if _frame_count <= 5 or _frame_count % 20 == 0:
                    send_ms = (t_send_end - t_send_start) * 1000
                    total_ms = (t_send_end - t0) * 1000
                    log.info(
                        "[WS/raw] frame #%d: cap=%.0fms unpack=%.0fms tobytes=%.0fms "
                        "send=%.0fms total=%.0fms size=%.1fkB fps_target=%.1f",
                        _frame_count,
                        timing["capture_ms"],
                        timing["unpack_ms"],
                        timing["tobytes_ms"],
                        send_ms,
                        total_ms,
                        timing["payload_bytes"] / 1024,
                        fps,
                    )

            except WebSocketDisconnect:
                break
            except RuntimeError as e:
                # Starlette/ASGI lève RuntimeError quand on tente d'envoyer sur un
                # WebSocket déjà fermé par le client ("Unexpected ASGI message
                # 'websocket.send'..."). Traiter comme une déconnexion normale.
                if "websocket" in str(e).lower():
                    log.info("[ws/raw] WebSocket fermé côté client (ASGI RuntimeError) — arrêt propre")
                    break
                log.warning("Raw WS capture RuntimeError (non-WS): %s", e)
                await asyncio.sleep(0.5)
                continue
            except Exception as e:
                log.warning("Raw WS capture error: %s", e)
                await asyncio.sleep(0.5)
                continue

            elapsed = loop.time() - t0
            wait = (1.0 / fps) - elapsed
            if wait > 0:
                await asyncio.sleep(wait)
    finally:
        recv_task.cancel()
        before = app.state.raw_clients
        app.state.raw_clients = max(0, app.state.raw_clients - 1)
        log.info("[ws/raw] client DISCONNECTED — raw_clients %d→%d", before, app.state.raw_clients)
