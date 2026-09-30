from __future__ import annotations

import asyncio
import json
import logging
import struct
import time

import cv2
from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from minicam.api.routes_capture import unpack_raw

log = logging.getLogger(__name__)
router = APIRouter()

_DEFAULT_FPS = 5
_MAX_FPS = 120

_capture_lock = asyncio.Lock()
_JPEG_QUALITY = 90


def _center_crop(arr, roi: tuple[int, int] | None):
    """Centered crop on an array's first two axes (H, W[, C]) — shared by
    both the RAW and ISP encode paths below."""
    if roi is None:
        return arr
    h_full, w_full = arr.shape[0], arr.shape[1]
    roi_w, roi_h = roi
    roi_w = min(roi_w, w_full)
    roi_h = min(roi_h, h_full)
    x0 = ((w_full - roi_w) // 2) & ~1
    y0 = ((h_full - roi_h) // 2) & ~1
    return arr[y0 : y0 + roi_h, x0 : x0 + roi_w]


def _capture_and_encode(
    camera,
    roi: tuple[int, int] | None = None,
    bit_depth: int = 16,
) -> tuple[bytes, int, int, dict]:
    """Capture + unpack + crop ROI centré + encode — thread pool, jamais asyncio."""
    t_cap = time.monotonic()
    raw_arr, meta = camera.capture_raw()
    t_unpack = time.monotonic()
    bits = camera.raw_bits
    data_u16 = (unpack_raw(raw_arr, bits, camera.raw_size[0]) << (16 - bits)).astype("uint16")
    data_u16 = _center_crop(data_u16, roi)

    h, w = data_u16.shape
    t_tobytes = time.monotonic()
    if bit_depth == 8:
        # data_u16 is already left-shifted to fill the full 16-bit range
        # regardless of source depth, so the top byte is always the MSBs.
        payload = (data_u16 >> 8).astype("uint8").tobytes()
    else:
        payload = data_u16.tobytes()
    t_done = time.monotonic()
    timing = {
        "capture_ms": (t_unpack - t_cap) * 1000,
        "unpack_ms": (t_tobytes - t_unpack) * 1000,
        "tobytes_ms": (t_done - t_tobytes) * 1000,
        "payload_bytes": len(payload),
    }
    return payload, h, w, timing


def _capture_and_encode_isp(
    camera,
    roi: tuple[int, int] | None = None,
    img_format: str = "jpeg",
) -> tuple[bytes, int, int, dict]:
    """Capture the ISP-processed ("main") RGB frame, crop ROI centré, encode
    as JPEG/PNG — thread pool, jamais asyncio. Sibling of _capture_and_encode
    above but for the hardware-debayered stream instead of raw Bayer data:
    no client-side debayer/Bayer-pattern needed (sidesteps the still-unverified
    IMX327 bayer= label — see minicam-planetary-fast-modes memory), at the
    cost of the ISP's gain/NR/contrast processing and (for jpeg) lossy
    compression, both of which are unwanted for precise stacking but fine for
    a lighter-weight/daylight alternative — hence offering both, not
    replacing RAW.
    """
    t_cap = time.monotonic()
    # picamera2's "RGB888" format is actually byte-order BGR, matching what
    # cv2.imencode expects directly — no cvtColor needed (see routes_preview.py,
    # which already relies on this for the live JPEG preview).
    frame = camera.capture_frame()
    t_capture_done = time.monotonic()
    frame = _center_crop(frame, roi)
    h, w = frame.shape[0], frame.shape[1]
    ext = ".png" if img_format == "png" else ".jpg"
    params = [] if img_format == "png" else [cv2.IMWRITE_JPEG_QUALITY, _JPEG_QUALITY]
    ok, buf = cv2.imencode(ext, frame, params)
    t_done = time.monotonic()
    if not ok:
        raise RuntimeError(f"échec encodage {img_format}")
    payload = buf.tobytes()
    timing = {
        "capture_ms": (t_capture_done - t_cap) * 1000,
        "unpack_ms": 0.0,
        "tobytes_ms": (t_done - t_capture_done) * 1000,
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
    # Contrôle de flux par crédits (optionnel) : None = cadence fixe `fps`
    # (comportement historique). Dès que le client envoie {"cmd": "credit",
    # "n": k}, une image est capturée/envoyée par crédit, sans plafond de
    # cadence : on tourne au rythme du maillon le plus lent (caméra, Pi,
    # liaison, navigateur) sans envoyer d'images que le client jetterait.
    credits: int | None = None
    credit_event = asyncio.Event()
    running = True
    roi: tuple[int, int] | None = None
    bit_depth: int = 16
    img_format = "raw"
    loop = asyncio.get_event_loop()
    _frame_count = 0

    async def recv_loop() -> None:
        nonlocal fps, running, roi, bit_depth, img_format, credits
        try:
            while True:
                raw = await websocket.receive_text()
                try:
                    msg = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                if msg.get("cmd") == "credit":
                    try:
                        credits = (credits or 0) + max(0, int(msg.get("n", 1)))
                        credit_event.set()
                    except (ValueError, TypeError):
                        pass
                elif msg.get("cmd") == "set_rate":
                    fps = max(0.1, min(_MAX_FPS, float(msg.get("fps", _DEFAULT_FPS))))
                elif msg.get("cmd") == "set_roi":
                    try:
                        rw = int(msg["w"]) if msg.get("w") else None
                        rh = int(msg["h"]) if msg.get("h") else None
                        roi = (rw & ~1, rh & ~1) if (rw and rh and rw > 0 and rh > 0) else None
                        log.info("[ws/raw] ROI → %s", roi)
                    except (KeyError, ValueError, TypeError):
                        pass
                elif msg.get("cmd") == "set_bitdepth":
                    try:
                        bd = int(msg.get("bit_depth", 16))
                        bit_depth = 8 if bd == 8 else 16
                        log.info("[ws/raw] bit_depth → %d", bit_depth)
                    except (ValueError, TypeError):
                        pass
                elif msg.get("cmd") == "set_format":
                    fmt = msg.get("format", "raw")
                    img_format = fmt if fmt in ("raw", "jpeg", "png") else "raw"
                    log.info("[ws/raw] format → %s", img_format)
                elif msg.get("cmd") == "stop":
                    running = False
        except (WebSocketDisconnect, asyncio.CancelledError):
            pass
        except Exception as e:
            log.warning("Raw WS recv error: %s", e)

    recv_task = asyncio.create_task(recv_loop())
    # Laisser recv_loop traiter les commandes initiales (set_roi, set_rate…)
    # avant de démarrer la capture — évite la race condition.
    await asyncio.sleep(0.05)

    try:
        while running:
            if app.state.indi_mode:
                await websocket.send_text(json.dumps({"cmd": "error", "detail": "INDI mode active"}))
                break

            if credits is not None:
                while credits <= 0 and running and not recv_task.done():
                    credit_event.clear()
                    try:
                        await asyncio.wait_for(credit_event.wait(), timeout=1.0)
                    except asyncio.TimeoutError:
                        pass
                if not running or recv_task.done():
                    break
                credits -= 1

            t0 = loop.time()
            try:
                camera = app.state.camera

                # Snapshot the mutable settings ONCE for this iteration — roi/
                # bit_depth/img_format are updated concurrently by recv_loop()
                # while we're awaiting the executor below. Re-reading them
                # afterward (for meta_json) instead of using this snapshot
                # would let the label flip to a new value mid-flight while the
                # payload was actually captured/encoded with the old one —
                # a real, observed bug during testing, not just a theoretical
                # race (caught e.g. a "format":"raw" frame whose payload was
                # still PNG bytes from the previous setting).
                cur_roi, cur_bit_depth, cur_format = roi, bit_depth, img_format

                # Capture + encode dans le thread pool (ne bloque pas l'event loop) —
                # RAW (Bayer, débayerisé client-side) ou ISP JPEG/PNG (déjà débayerisé
                # matériellement — voir _capture_and_encode_isp).
                # Une seule capture à la fois, tous clients /ws/raw confondus :
                # deux flux capturant en parallèle ont figé la caméra
                # (« Camera frontend has timed out », threads bloqués).
                async with _capture_lock:
                    if cur_format == "raw":
                        payload, h, w, timing = await loop.run_in_executor(
                            None, _capture_and_encode, camera, cur_roi, cur_bit_depth
                        )
                    else:
                        payload, h, w, timing = await loop.run_in_executor(
                            None, _capture_and_encode_isp, camera, cur_roi, cur_format
                        )

                meta_json = json.dumps({
                    # Legacy fields — kept for RPiCamera2 / minicam.py compat
                    "w": w,
                    "h": h,
                    "ExposureTime": camera.exposure_us,
                    "AnalogueGain": camera.gain,
                    # Canonical fields — used by the JS stacker (ws_frame_receiver.js)
                    "width": w,
                    "height": h,
                    "gain": camera.gain,
                    "exposure_us": camera.exposure_us,
                    "exposure_ms": round(camera.exposure_us / 1000, 3),
                    "bayer": camera.bayer_pattern,
                    "bit_depth": cur_bit_depth,
                    "format": cur_format,
                    "ts": t0,
                }).encode()

                # Pad JSON to even length so rawOffset = 4+jsonLen is Uint16-aligned
                if len(meta_json) % 2:
                    meta_json += b" "
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
                        "send=%.0fms total=%.0fms size=%.1fkB %s",
                        _frame_count,
                        timing["capture_ms"],
                        timing["unpack_ms"],
                        timing["tobytes_ms"],
                        send_ms,
                        total_ms,
                        timing["payload_bytes"] / 1024,
                        f"fps_target={fps:.1f}" if credits is None else "flux=crédits",
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

            if credits is None:
                elapsed = loop.time() - t0
                wait = (1.0 / fps) - elapsed
                if wait > 0:
                    await asyncio.sleep(wait)
    finally:
        recv_task.cancel()
        before = app.state.raw_clients
        app.state.raw_clients = max(0, app.state.raw_clients - 1)
        log.info("[ws/raw] client DISCONNECTED — raw_clients %d→%d", before, app.state.raw_clients)
