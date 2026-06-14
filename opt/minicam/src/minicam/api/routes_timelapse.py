from __future__ import annotations

import asyncio
import json
import logging
import shutil
import time
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

import cv2
import numpy as np
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, Response

from minicam.api.routes_capture import _unpack_raw12, _write_fits

log = logging.getLogger(__name__)
router = APIRouter()
TIMELAPSE_DIR = Path("/var/lib/minicam/timelapse")


@router.get("/timelapse/last.jpg")
async def timelapse_last_jpg(request: Request) -> Response:
    jpeg = getattr(request.app.state, "tl_last_jpeg", None)
    if jpeg is None:
        return Response(status_code=404)
    return Response(
        content=jpeg,
        media_type="image/jpeg",
        headers={"Cache-Control": "no-store"},
    )


@router.get("/timelapse/status")
async def timelapse_http_status(request: Request) -> JSONResponse:
    return JSONResponse({
        "running": getattr(request.app.state, "tl_running", False),
        "session": getattr(request.app.state, "tl_session", None),
    })


@router.get("/timelapse/sessions")
async def list_sessions() -> JSONResponse:
    sessions = []
    if TIMELAPSE_DIR.exists():
        for d in sorted(TIMELAPSE_DIR.iterdir(), reverse=True):
            if not d.is_dir():
                continue
            info_file = d / "session_info.json"
            info: dict = {}
            if info_file.exists():
                try:
                    info = json.loads(info_file.read_text())
                except Exception:
                    pass
            files = [f for f in d.iterdir() if f.suffix in (".jpg", ".png", ".fits")]
            total_size = sum(f.stat().st_size for f in files)
            sessions.append({
                "session_id": d.name,
                "mode": info.get("mode", "unknown"),
                "started_at": info.get("started_at", ""),
                "end_time": info.get("end_time", ""),
                "frame_count": len(files),
                "size_mb": round(total_size / 1_000_000, 1),
                "has_preview": (d / "preview.jpg").exists(),
            })
    return JSONResponse(sessions)


@router.get("/timelapse/sessions/{sid}/preview.jpg")
async def session_preview(sid: str) -> Response:
    path = TIMELAPSE_DIR / sid / "preview.jpg"
    if not path.exists():
        return Response(status_code=404)
    return Response(
        content=path.read_bytes(),
        media_type="image/jpeg",
        headers={"Cache-Control": "no-store"},
    )


@router.delete("/timelapse/sessions/{sid}")
async def delete_session(sid: str) -> JSONResponse:
    # Sanitize: session_id must be a single directory name, no path traversal
    if "/" in sid or "\\" in sid or ".." in sid:
        return JSONResponse({"error": "invalid session_id"}, status_code=400)
    path = TIMELAPSE_DIR / sid
    if not path.is_dir():
        return JSONResponse({"error": "not found"}, status_code=404)
    shutil.rmtree(path)
    return JSONResponse({"deleted": sid})


@router.get("/timelapse/disk")
async def timelapse_disk() -> JSONResponse:
    usage = shutil.disk_usage(TIMELAPSE_DIR if TIMELAPSE_DIR.exists() else "/")
    return JSONResponse({
        "total_gb": round(usage.total / 1e9, 1),
        "free_gb":  round(usage.free  / 1e9, 1),
        "used_pct": round(usage.used  / usage.total * 100),
    })


@router.delete("/timelapse/sessions")
async def delete_all_sessions() -> JSONResponse:
    if not TIMELAPSE_DIR.exists():
        return JSONResponse({"deleted": 0})
    count = 0
    for d in TIMELAPSE_DIR.iterdir():
        if d.is_dir():
            shutil.rmtree(d)
            count += 1
    return JSONResponse({"deleted": count})


def _session_files(path: Path) -> list[Path]:
    """Return sorted list of image files (jpg/png/fits) in a session dir."""
    return sorted(
        f for f in path.iterdir()
        if f.suffix in (".jpg", ".png", ".fits") and f.stem.isdigit()
    )


def _fits_to_jpeg(filepath: Path) -> bytes:
    """Debayer a FITS file (written by _write_fits) and return JPEG bytes."""
    raw = filepath.read_bytes()
    naxis1, naxis2 = 0, 0
    header_end = 0
    for block_start in range(0, len(raw), 2880):
        block = raw[block_start:block_start + 2880]
        for card_start in range(0, 2880, 80):
            card = block[card_start:card_start + 80].decode("ascii", errors="replace")
            if card.startswith("NAXIS1"):
                naxis1 = int(card[10:30].strip())
            elif card.startswith("NAXIS2"):
                naxis2 = int(card[10:30].strip())
            elif card.startswith("END "):
                header_end = block_start + 2880
                break
        if header_end:
            break
    if not (header_end and naxis1 and naxis2):
        raise ValueError("Cannot parse FITS header")
    data_bytes = raw[header_end:header_end + naxis2 * naxis1 * 2]
    data_u16 = (np.frombuffer(data_bytes, dtype=">i2").astype(np.int32) + 32768).astype(np.uint16)
    data_u16 = data_u16.reshape(naxis2, naxis1)
    scaled = np.clip(data_u16 >> 4, 0, 255).astype(np.uint8)
    h, w = scaled.shape
    if w > 1280:
        scaled = cv2.resize(scaled, (1280, int(h * 1280 / w)))
    rgb = cv2.cvtColor(scaled, cv2.COLOR_BAYER_RG2RGB)
    ok, buf = cv2.imencode(".jpg", rgb, [cv2.IMWRITE_JPEG_QUALITY, 85])
    if not ok:
        raise ValueError("JPEG encode failed")
    return buf.tobytes()


@router.get("/timelapse/sessions/{sid}/frames")
async def session_frame_list(sid: str) -> JSONResponse:
    if "/" in sid or ".." in sid:
        return JSONResponse({"error": "invalid"}, status_code=400)
    path = TIMELAPSE_DIR / sid
    if not path.is_dir():
        return JSONResponse({"error": "not found"}, status_code=404)
    info: dict = {}
    info_file = path / "session_info.json"
    if info_file.exists():
        try:
            info = json.loads(info_file.read_text())
        except Exception:
            pass
    files = _session_files(path)
    return JSONResponse({"count": len(files), "mode": info.get("mode", "unknown")})


@router.get("/timelapse/sessions/{sid}/frame/{idx}")
async def session_frame_image(sid: str, idx: int) -> Response:
    if "/" in sid or ".." in sid:
        return Response(status_code=400)
    path = TIMELAPSE_DIR / sid
    if not path.is_dir():
        return Response(status_code=404)
    files = _session_files(path)
    if idx < 1 or idx > len(files):
        return Response(status_code=404)
    filepath = files[idx - 1]
    loop = asyncio.get_event_loop()
    try:
        if filepath.suffix == ".fits":
            jpeg = await loop.run_in_executor(None, _fits_to_jpeg, filepath)
        elif filepath.suffix == ".jpg":
            jpeg = await loop.run_in_executor(None, filepath.read_bytes)
        else:  # png → convert to jpeg for fast browser display
            def _png_to_jpeg(p: Path) -> bytes:
                img = cv2.imread(str(p))
                ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 90])
                return buf.tobytes() if ok else b""
            jpeg = await loop.run_in_executor(None, _png_to_jpeg, filepath)
        return Response(
            content=jpeg,
            media_type="image/jpeg",
            headers={"Cache-Control": "max-age=3600"},
        )
    except Exception as e:
        log.error("frame serve error %s/%d: %s", sid, idx, e)
        return Response(status_code=500)


def _end_datetime(end_str: str) -> datetime:
    h, m = map(int, end_str.split(":"))
    now = datetime.now()
    end_dt = now.replace(hour=h, minute=m, second=0, microsecond=0)
    if end_dt <= now:
        end_dt += timedelta(days=1)
    return end_dt


def _save_frame_sync(data: Any, idx: int, mode: str, session_dir: Path, app: Any) -> None:
    try:
        jpeg_bytes: bytes | None = None

        if mode == "isp_jpeg":
            # data = YUV420 array from ISP (hardware debayer + NR applied)
            img = cv2.cvtColor(data, cv2.COLOR_YUV420p2RGB)
            ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 95])
            if ok:
                jpeg_bytes = buf.tobytes()
                (session_dir / f"{idx:08d}.jpg").write_bytes(jpeg_bytes)

        elif mode == "isp_png":
            # data = YUV420 array from ISP
            img = cv2.cvtColor(data, cv2.COLOR_YUV420p2RGB)
            ok, buf = cv2.imencode(".png", img)
            if ok:
                (session_dir / f"{idx:08d}.png").write_bytes(buf.tobytes())
            ok_j, j_buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 85])
            if ok_j:
                jpeg_bytes = j_buf.tobytes()

        elif mode == "raw_fits":
            # data = (raw_array, metadata) — Bayer RAW12, no ISP processing
            raw, meta = data
            unpacked = _unpack_raw12(raw)
            fits_bytes = _write_fits(unpacked, meta)
            (session_dir / f"{idx:08d}.fits").write_bytes(fits_bytes)
            scaled = np.clip(unpacked >> 4, 0, 255).astype(np.uint8)
            h, w = scaled.shape
            preview = cv2.resize(scaled, (800, int(h * 800 / w))) if w > 800 else scaled
            rgb = cv2.cvtColor(preview, cv2.COLOR_BAYER_RG2RGB)
            ok_j, j_buf = cv2.imencode(".jpg", rgb, [cv2.IMWRITE_JPEG_QUALITY, 80])
            if ok_j:
                jpeg_bytes = j_buf.tobytes()

        if jpeg_bytes is not None:
            app.state.tl_last_jpeg = jpeg_bytes
            # Persistent preview for gallery (overwritten each frame)
            (session_dir / "preview.jpg").write_bytes(jpeg_bytes)

    except Exception as e:
        log.error("timelapse save error frame %d: %s", idx, e)


async def _broadcast(app: Any, event: dict) -> None:
    for q in list(app.state.seq_subscribers):
        await q.put(event)


async def run_timelapse(camera: Any, app: Any, params: dict) -> None:
    mode    = params.get("mode", "isp_jpeg")
    end_str = params.get("end_time", "23:59")

    session_id = datetime.now().strftime("%Y%m%d_%H%M%S")
    session_dir = TIMELAPSE_DIR / session_id
    session_dir.mkdir(parents=True, exist_ok=True)
    end_dt = _end_datetime(end_str)

    session_info = {
        "mode": mode,
        "started_at": datetime.now().isoformat(),
        "end_time": end_str,
        "gain": camera.gain,
        "exposure_ms": camera.exposure_us / 1000,
    }
    (session_dir / "session_info.json").write_text(json.dumps(session_info))

    app.state.tl_running = True
    app.state.tl_last_jpeg = None
    app.state.tl_session = {
        "session_id": session_id,
        "mode": mode,
        "dir": str(session_dir),
        "started_at": datetime.now().isoformat(),
        "end_time": end_str,
        "end_dt": end_dt.isoformat(),
        "frame_count": 0,
    }

    loop = asyncio.get_event_loop()
    frame_count = 0
    last_broadcast = 0.0

    try:
        await loop.run_in_executor(None, camera.apply_timelapse_settings)

        await _broadcast(app, {
            "cmd": "tl_started",
            "session": session_id,
            "mode": mode,
            "end_time": end_str,
            "end_dt": end_dt.isoformat(),
        })
        log.info("Timelapse started: session=%s mode=%s end=%s dir=%s",
                 session_id, mode, end_str, session_dir)

        save_fut: asyncio.Future | None = None
        t_last_capture = time.monotonic()

        while app.state.tl_running:
            if datetime.now() >= end_dt:
                break

            # ISP modes use capture_frame() (hardware debayer + NR).
            # raw_fits uses capture_raw() to preserve the unprocessed Bayer data.
            if mode == "raw_fits":
                frame_data = await loop.run_in_executor(None, camera.capture_raw)
            else:
                frame_data = await loop.run_in_executor(None, camera.capture_frame)

            t_now = time.monotonic()
            interval_ms = int((t_now - t_last_capture) * 1000)
            t_last_capture = t_now
            frame_count += 1
            app.state.tl_session["frame_count"] = frame_count

            log.debug("TL frame %d interval=%dms", frame_count, interval_ms)

            # Wait for previous save only AFTER capture — if save is slower than
            # exposure the delay is (save_time - exposure_time), not save_time
            if save_fut is not None:
                await save_fut

            # Pipeline: kick off save in thread while camera captures next frame
            save_fut = loop.run_in_executor(
                None, _save_frame_sync, frame_data, frame_count, mode, session_dir, app
            )

            # Broadcast at most every 5 s
            if t_now - last_broadcast >= 5.0:
                remaining = max(0, int((end_dt - datetime.now()).total_seconds()))
                await _broadcast(app, {
                    "cmd": "tl_frame",
                    "frame": frame_count,
                    "session": session_id,
                    "remaining_s": remaining,
                    "interval_ms": interval_ms,
                })
                last_broadcast = t_now

        if save_fut is not None:
            await save_fut

        await _broadcast(app, {
            "cmd": "tl_done",
            "session": session_id,
            "frames": frame_count,
        })
        log.info("Timelapse done: %d frames saved to %s", frame_count, session_dir)

    except asyncio.CancelledError:
        log.info("Timelapse cancelled after %d frames", frame_count)
        if save_fut is not None:
            try:
                await asyncio.shield(save_fut)
            except Exception:
                pass
        await _broadcast(app, {"cmd": "tl_done", "session": session_id, "frames": frame_count})
    except Exception as e:
        log.error("Timelapse error: %s", e)
        await _broadcast(app, {"cmd": "tl_error", "detail": str(e)})
    finally:
        app.state.tl_running = False
        app.state.tl_task = None
        await loop.run_in_executor(None, camera.restore_preview_settings)
