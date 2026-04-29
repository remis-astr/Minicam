from __future__ import annotations

import asyncio
import io
import zipfile
from datetime import datetime
from pathlib import Path

import cv2
import numpy as np
from fastapi import APIRouter, Request
from fastapi.responses import Response

router = APIRouter()
SEQ_DIR = Path("/tmp/minicam_seq")


def _ts() -> str:
    return datetime.now().strftime("%Y%m%d_%H%M%S_%f")[:21]


def _unpack_raw12(raw: np.ndarray) -> np.ndarray:
    """Unpack SRGGB12_CSI2P (3 bytes → 2 pixels of 12 bits) to uint16."""
    flat = raw.reshape(-1)
    n = len(flat) // 3
    b0 = flat[0::3].astype(np.uint16)[:n]
    b1 = flat[1::3].astype(np.uint16)[:n]
    b2 = flat[2::3].astype(np.uint16)[:n]
    out = np.empty(n * 2, dtype=np.uint16)
    out[0::2] = (b0 << 4) | (b2 & 0x0F)
    out[1::2] = (b1 << 4) | (b2 >> 4)
    h = raw.shape[0]
    return out.reshape(h, -1)


def _write_fits(data: np.ndarray, meta: dict | None = None) -> bytes:
    """Write a minimal FITS file for a 2D uint16 Bayer array (BITPIX=16, BZERO=32768)."""
    H, W = data.shape
    exp_s = (meta.get("ExposureTime", 0) / 1e6) if meta else 0.0
    gain = meta.get("AnalogueGain", 0.0) if meta else 0.0
    cards = [
        "SIMPLE  =                    T",
        "BITPIX  =                   16",
        f"NAXIS   =                    2",
        f"NAXIS1  = {W:>20d}",
        f"NAXIS2  = {H:>20d}",
        "BSCALE  =                  1.0",
        "BZERO   =              32768.0",
        # Bayer pattern — mandatory for debayering in Siril / PixInsight / etc.
        "BAYERPAT= 'RGGB    '",
        "XBAYROFF=                    0",
        "YBAYROFF=                    0",
        f"EXPTIME = {exp_s:>20.6f}",
        f"GAIN    = {gain:>20.4f}",
        "INSTRUME= 'IMX462  '",
        "END     ",
    ]
    hdr = b"".join(c.ljust(80).encode("ascii") for c in cards)
    hdr += b" " * ((2880 - len(hdr) % 2880) % 2880)
    # FITS int16 with BZERO=32768 encodes uint16
    raw_i16 = (data.astype(np.int32) - 32768).astype(np.int16).astype(">i2").tobytes()
    raw_i16 += b"\x00" * ((2880 - len(raw_i16) % 2880) % 2880)
    return hdr + raw_i16


@router.get("/capture.png")
async def capture_png(request: Request) -> Response:
    camera = request.app.state.camera
    frame = await asyncio.get_event_loop().run_in_executor(None, camera.capture_frame)
    bgr = cv2.cvtColor(frame, cv2.COLOR_YUV420p2BGR)
    ok, buf = cv2.imencode(".png", bgr)
    if not ok:
        return Response(status_code=500)
    return Response(
        content=buf.tobytes(),
        media_type="image/png",
        headers={"Content-Disposition": f'attachment; filename="minicam_{_ts()}.png"'},
    )


@router.get("/capture.fits")
async def capture_fits(request: Request) -> Response:
    camera = request.app.state.camera
    raw, meta = await asyncio.get_event_loop().run_in_executor(None, camera.capture_raw)
    data = _unpack_raw12(raw)
    fits_bytes = _write_fits(data, meta)
    return Response(
        content=fits_bytes,
        media_type="application/fits",
        headers={"Content-Disposition": f'attachment; filename="minicam_{_ts()}.fits"'},
    )


@router.get("/seq/{session_id}/zip")
async def seq_zip(session_id: str) -> Response:
    session_dir = SEQ_DIR / session_id
    if not session_dir.is_dir():
        return Response(status_code=404)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for f in sorted(session_dir.glob("*.fits")):
            zf.write(f, f"minicam_{session_id}_{f.stem}.fits")
    return Response(
        content=buf.getvalue(),
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="minicam_seq_{session_id}.zip"'},
    )


@router.get("/seq/{session_id}/{index}")
async def seq_frame(session_id: str, index: str) -> Response:
    try:
        idx = int(index)
    except ValueError:
        return Response(status_code=400)
    filepath = SEQ_DIR / session_id / f"{idx:04d}.fits"
    if not filepath.exists():
        return Response(status_code=404)
    return Response(
        content=filepath.read_bytes(),
        media_type="application/fits",
        headers={"Content-Disposition": f'attachment; filename="minicam_{session_id}_{idx:04d}.fits"'},
    )
