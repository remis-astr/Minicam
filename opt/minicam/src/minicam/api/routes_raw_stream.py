from __future__ import annotations

import asyncio
import json
import logging
import struct
import time

import cv2
from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from minicam.api import zstd
from minicam.api.routes_capture import raw_msb8, unpack_raw_box

log = logging.getLogger(__name__)
router = APIRouter()

_DEFAULT_FPS = 5
_MAX_FPS = 120

_capture_lock = asyncio.Lock()
# Captures d'avance d'un client parti : référencées jusqu'à leur fin (asyncio
# ne garde qu'une référence faible sur les tâches).
_orphans: set[asyncio.Task] = set()


def _discard_orphan(task: asyncio.Task) -> None:
    _orphans.discard(task)
    if not task.cancelled() and task.exception() is not None:
        log.info("[ws/raw] capture d'avance abandonnée : %s", task.exception())
_JPEG_QUALITY = 90


def _center_box(w_full: int, h_full: int, roi: tuple[int, int] | None) -> tuple[int, int, int, int]:
    """(x0, y0, w, h) of the centered ROI crop — even offsets keep the Bayer phase."""
    if roi is None:
        return 0, 0, w_full, h_full
    roi_w = min(roi[0], w_full)
    roi_h = min(roi[1], h_full)
    x0 = ((w_full - roi_w) // 2) & ~1
    y0 = ((h_full - roi_h) // 2) & ~1
    return x0, y0, roi_w, roi_h


def _center_crop(arr, roi: tuple[int, int] | None):
    """Centered crop on an array's first two axes (H, W[, C]) — shared by
    both the RAW and ISP encode paths below."""
    x0, y0, w, h = _center_box(arr.shape[1], arr.shape[0], roi)
    return arr[y0 : y0 + h, x0 : x0 + w]


def _black_level(meta, camera=None) -> float | None:
    """Niveau de noir (échelle 16 bits) : celui que libcamera renvoie pour
    l'image, sinon celui du profil du capteur."""
    levels = (meta or {}).get("SensorBlackLevels")
    if levels:
        return sum(levels) / len(levels)
    fallback = getattr(getattr(camera, "profile", None), "black_level", 0)
    return float(fallback) if fallback else None


def _capture_and_encode(
    camera,
    roi: tuple[int, int] | None = None,
    bit_depth: int = 16,
    compression: str = "none",
) -> tuple[bytes, int, int, dict]:
    """Capture + unpack + crop ROI centré + encode — thread pool, jamais asyncio.
    compression="zstd" : charge utile compressée sans perte (trame zstd)."""
    t_cap = time.monotonic()
    raw_arr, meta = camera.capture_raw()
    t_unpack = time.monotonic()
    bits = camera.raw_bits
    box = _center_box(camera.raw_size[0], raw_arr.shape[0], roi)
    if bit_depth == 8:
        # MSB bytes gathered straight from the packed frame, ROI included —
        # same bytes as the top byte of the left-shifted 16-bit unpack.
        data = raw_msb8(raw_arr, bits, *box)
    else:
        # Seulement la boîte du ROI est décompressée (unpack_raw_box)
        data = (unpack_raw_box(raw_arr, bits, *box) << (16 - bits)).astype("uint16")

    h, w = data.shape
    t_tobytes = time.monotonic()
    payload = data.tobytes()
    t_compress = time.monotonic()
    if compression == "zstd":
        payload = zstd.compress(payload)
    t_done = time.monotonic()
    timing = {
        # Niveau de noir du capteur (libcamera, échelle 16 bits comme les
        # pixels envoyés) — à soustraire avant toute calibration couleur.
        "black_level": _black_level(meta, camera),
        "capture_ms": (t_unpack - t_cap) * 1000,
        "unpack_ms": (t_tobytes - t_unpack) * 1000,
        "tobytes_ms": (t_compress - t_tobytes) * 1000,
        "compress_ms": (t_done - t_compress) * 1000,
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
    # Compression sans perte du RAW (optionnelle) : "none" = historique.
    compression = "none"
    loop = asyncio.get_event_loop()
    _frame_count = 0

    async def recv_loop() -> None:
        nonlocal fps, running, roi, bit_depth, img_format, credits, compression
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
                elif msg.get("cmd") == "set_compression":
                    codec = msg.get("codec", "none")
                    if codec == "zstd" and not zstd.available():
                        codec = "none"
                    compression = codec if codec == "zstd" else "none"
                    log.info("[ws/raw] compression → %s", compression)
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

    async def produce() -> tuple[bytes, dict, float]:
        """Capture + encode one frame and build the full WS message."""
        t0 = loop.time()
        camera = app.state.camera

        # Snapshot the mutable settings ONCE for this frame — roi/
        # bit_depth/img_format are updated concurrently by recv_loop()
        # while we're awaiting the executor below. Re-reading them
        # afterward (for meta_json) instead of using this snapshot
        # would let the label flip to a new value mid-flight while the
        # payload was actually captured/encoded with the old one —
        # a real, observed bug during testing, not just a theoretical
        # race (caught e.g. a "format":"raw" frame whose payload was
        # still PNG bytes from the previous setting).
        cur_roi, cur_bit_depth, cur_format = roi, bit_depth, img_format
        cur_compression = compression if cur_format == "raw" else "none"

        # Capture + encode dans le thread pool (ne bloque pas l'event loop) —
        # RAW (Bayer, débayerisé client-side) ou ISP JPEG/PNG (déjà débayerisé
        # matériellement — voir _capture_and_encode_isp).
        # Une seule capture à la fois, tous clients /ws/raw confondus :
        # deux flux capturant en parallèle ont figé la caméra
        # (« Camera frontend has timed out », threads bloqués).
        async with _capture_lock:
            if cur_format == "raw":
                payload, h, w, timing = await loop.run_in_executor(
                    None, _capture_and_encode, camera, cur_roi, cur_bit_depth, cur_compression
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
            "compression": cur_compression,
            "black_level": timing.get("black_level"),
            "ts": t0,
        }).encode()

        # Pad JSON to even length so rawOffset = 4+jsonLen is Uint16-aligned
        if len(meta_json) % 2:
            meta_json += b" "
        return struct.pack(">I", len(meta_json)) + meta_json + payload, timing, t0

    async def take_credit() -> bool:
        """Mode crédits : attend un crédit et le consomme. False = arrêt."""
        nonlocal credits
        while credits <= 0 and running and not recv_task.done():
            credit_event.clear()
            try:
                await asyncio.wait_for(credit_event.wait(), timeout=1.0)
            except asyncio.TimeoutError:
                pass
        if not running or recv_task.done():
            return False
        credits -= 1
        return True

    # Mode crédits : l'image suivante est capturée/encodée (thread pool)
    # pendant l'envoi de la précédente, s'il reste un crédit — capteur, CPU
    # (extraction, zstd) et liaison travaillent en même temps au lieu de se
    # succéder. Cadence fixe : une image à la fois, comme avant.
    pending: asyncio.Task | None = None
    try:
        while running:
            if app.state.indi_mode:
                await websocket.send_text(json.dumps({"cmd": "error", "detail": "INDI mode active"}))
                break

            if pending is None:
                if credits is not None and not await take_credit():
                    break
                pending = asyncio.create_task(produce())

            try:
                task, pending = pending, None
                # shield : annuler ce handler ne doit pas annuler la capture
                # (même raison que dans le finally ci-dessous).
                message, timing, t0 = await asyncio.shield(task)
            except asyncio.CancelledError:
                pending = task
                raise
            except Exception as e:
                log.warning("Raw WS capture error: %s", e)
                await asyncio.sleep(0.5)
                continue

            if credits is not None and credits > 0 and running and not recv_task.done():
                credits -= 1
                pending = asyncio.create_task(produce())

            try:
                t_send_start = loop.time()
                await websocket.send_bytes(message)
                t_send_end = loop.time()

                _frame_count += 1
                if _frame_count <= 5 or _frame_count % 20 == 0:
                    send_ms = (t_send_end - t_send_start) * 1000
                    total_ms = (t_send_end - t0) * 1000
                    log.info(
                        "[WS/raw] frame #%d: cap=%.0fms unpack=%.0fms tobytes=%.0fms "
                        "zstd=%.0fms send=%.0fms total=%.0fms size=%.1fkB %s",
                        _frame_count,
                        timing["capture_ms"],
                        timing["unpack_ms"],
                        timing["tobytes_ms"],
                        timing.get("compress_ms", 0.0),
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
                log.warning("Raw WS send RuntimeError (non-WS): %s", e)
                await asyncio.sleep(0.5)
                continue

            if credits is None:
                elapsed = loop.time() - t0
                wait = (1.0 / fps) - elapsed
                if wait > 0:
                    await asyncio.sleep(wait)
    finally:
        recv_task.cancel()
        if pending is not None:
            # Ne pas annuler une capture d'avance : annulée, elle rendrait le
            # verrou caméra alors que le thread capture encore. On la laisse
            # finir (quelques ms) et on jette son image.
            _orphans.add(pending)
            pending.add_done_callback(_discard_orphan)
        before = app.state.raw_clients
        app.state.raw_clients = max(0, app.state.raw_clients - 1)
        log.info("[ws/raw] client DISCONNECTED — raw_clients %d→%d", before, app.state.raw_clients)
