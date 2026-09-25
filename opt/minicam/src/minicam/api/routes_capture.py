from __future__ import annotations

import asyncio
from datetime import datetime
from pathlib import Path

import cv2
import numpy as np
from fastapi import APIRouter, Request
from fastapi.responses import Response

router = APIRouter()

PHOTOS_DIR = Path("/photos")


def _ts() -> str:
    return datetime.now().strftime("%Y%m%d_%H%M%S_%f")[:21]


def _unpack_raw12(raw: np.ndarray, width: int) -> np.ndarray:
    """Unpack SRGGB12_CSI2P (3 bytes → 2 pixels of 12 bits) to uint16.

    `raw`'s row stride (raw.shape[1]) can be padded beyond the tight packed
    width — e.g. to a 32-byte boundary — so `width` (the sensor's real pixel
    width) must be passed explicitly rather than inferred from the array
    shape. IMX327's 1920px width happens to already be 32-byte aligned
    (2880 tight bytes/row) so this went unnoticed there; IMX477's 4056px
    width is not (6084 tight vs 6112 padded bytes/row) and silently corrupts
    row alignment if the padding isn't stripped first.
    """
    tight_bytes = (width // 2) * 3
    tight = raw[:, :tight_bytes]
    b0 = tight[:, 0::3].astype(np.uint16)
    b1 = tight[:, 1::3].astype(np.uint16)
    b2 = tight[:, 2::3].astype(np.uint16)
    out = np.empty((raw.shape[0], width), dtype=np.uint16)
    out[:, 0::2] = (b0 << 4) | (b2 & 0x0F)
    out[:, 1::2] = (b1 << 4) | (b2 >> 4)
    return out


def _unpack_raw10(raw: np.ndarray, width: int) -> np.ndarray:
    """Unpack SRGGB10_CSI2P (5 bytes → 4 pixels of 10 bits) to uint16.

    Used by the IMX477's binned mode (2028x1520), unlike its full-res mode
    which packs 12 bits like the IMX327 — see _unpack_raw12. Same
    stride-padding caveat as _unpack_raw12 applies here.
    """
    tight_bytes = (width // 4) * 5
    tight = raw[:, :tight_bytes]
    b0 = tight[:, 0::5].astype(np.uint16)
    b1 = tight[:, 1::5].astype(np.uint16)
    b2 = tight[:, 2::5].astype(np.uint16)
    b3 = tight[:, 3::5].astype(np.uint16)
    b4 = tight[:, 4::5].astype(np.uint16)
    out = np.empty((raw.shape[0], width), dtype=np.uint16)
    out[:, 0::4] = (b0 << 2) | (b4 & 0x03)
    out[:, 1::4] = (b1 << 2) | ((b4 >> 2) & 0x03)
    out[:, 2::4] = (b2 << 2) | ((b4 >> 4) & 0x03)
    out[:, 3::4] = (b3 << 2) | ((b4 >> 6) & 0x03)
    return out


def unpack_raw(raw: np.ndarray, bits: int, width: int) -> np.ndarray:
    """Dispatch to the unpacker matching the sensor's active RAW bit depth."""
    if bits == 12:
        return _unpack_raw12(raw, width)
    if bits == 10:
        return _unpack_raw10(raw, width)
    raise ValueError(f"profondeur RAW non supportée: {bits} bits")


# OpenCV's Bayer conversion codes are named after the *second* row of the
# pattern, not the first — so they're inverted relative to the usual
# top-left-pixel convention used everywhere else in this codebase (FITS
# BAYERPAT, RawMode.bayer, the JS debayer's pattern ints). Confirmed
# empirically: cv2.COLOR_BAYER_RG2RGB is what actually produces correct
# colors for standard-convention BGGR data (cv2.COLOR_BAYER_BG2RGB gives a
# clear blue cast on the same data) — see RawMode.bayer's docstring.
_CV2_BAYER_CODE = {
    "RGGB": cv2.COLOR_BAYER_BG2RGB,
    "BGGR": cv2.COLOR_BAYER_RG2RGB,
    "GRBG": cv2.COLOR_BAYER_GB2RGB,
    "GBRG": cv2.COLOR_BAYER_GR2RGB,
}


def cv2_bayer_code(pattern: str) -> int:
    """OpenCV Bayer→RGB conversion code matching a "RGGB"/"BGGR"/"GRBG"/"GBRG"
    pattern string (top-left-pixel convention) — never hardcode
    cv2.COLOR_BAYER_RG2RGB directly, both because the true pattern varies by
    mode (see RawMode.bayer in sensors.py) and because OpenCV's own code
    names don't match that convention (see comment above)."""
    try:
        return _CV2_BAYER_CODE[pattern]
    except KeyError:
        raise ValueError(f"pattern bayer non supporté: {pattern!r}") from None


def _write_fits(data: np.ndarray, meta: dict | None = None, instrument: str = "IMX327", bayer_pattern: str = "RGGB") -> bytes:
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
        # Must reflect the true phase of `data`, not just assume RGGB — on
        # the IMX477, 2x2 binning shifts the effective phase to BGGR (see
        # RawMode.bayer in sensors.py for how this was confirmed).
        f"BAYERPAT= '{bayer_pattern:<8}'",
        "XBAYROFF=                    0",
        "YBAYROFF=                    0",
        f"EXPTIME = {exp_s:>20.6f}",
        f"GAIN    = {gain:>20.4f}",
        f"INSTRUME= '{instrument.upper():<8}'",
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
    frame = await asyncio.get_event_loop().run_in_executor(None, camera.capture_frame_full_res)
    ok, buf = cv2.imencode(".png", frame)
    if not ok:
        return Response(status_code=500)
    content = buf.tobytes()
    filename = f"minicam_{_ts()}.png"
    PHOTOS_DIR.mkdir(parents=True, exist_ok=True)
    (PHOTOS_DIR / filename).write_bytes(content)
    return Response(
        content=content,
        media_type="image/png",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/capture.fits")
async def capture_fits(request: Request) -> Response:
    camera = request.app.state.camera
    raw, meta = await asyncio.get_event_loop().run_in_executor(None, camera.capture_raw)
    data = unpack_raw(raw, camera.raw_bits, camera.raw_size[0])
    fits_bytes = _write_fits(data, meta, instrument=camera.sensor, bayer_pattern=camera.bayer_pattern)
    filename = f"minicam_{_ts()}.fits"
    PHOTOS_DIR.mkdir(parents=True, exist_ok=True)
    (PHOTOS_DIR / filename).write_bytes(fits_bytes)
    return Response(
        content=fits_bytes,
        media_type="application/fits",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


