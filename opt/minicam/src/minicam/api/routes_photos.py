from __future__ import annotations

import shutil
from pathlib import Path

import cv2
from fastapi import APIRouter
from fastapi.responses import JSONResponse, Response

from minicam.api.routes_capture import PHOTOS_DIR
from minicam.api.routes_timelapse import _fits_to_jpeg

router = APIRouter()

_EXTENSIONS = (".png", ".fits")


def _safe_path(filename: str) -> Path | None:
    if "/" in filename or "\\" in filename or ".." in filename:
        return None
    path = PHOTOS_DIR / filename
    if path.suffix not in _EXTENSIONS:
        return None
    return path


@router.get("/photos/list")
async def list_photos() -> JSONResponse:
    photos = []
    if PHOTOS_DIR.exists():
        files = [f for f in PHOTOS_DIR.iterdir() if f.suffix in _EXTENSIONS]
        for f in sorted(files, key=lambda p: p.stat().st_mtime, reverse=True):
            photos.append({
                "filename": f.name,
                "type": f.suffix.lstrip("."),
                "size_mb": round(f.stat().st_size / 1_000_000, 1),
                "mtime": f.stat().st_mtime,
            })
    return JSONResponse(photos)


@router.get("/photos/disk")
async def photos_disk() -> JSONResponse:
    usage = shutil.disk_usage(PHOTOS_DIR if PHOTOS_DIR.exists() else "/")
    return JSONResponse({
        "total_gb": round(usage.total / 1e9, 1),
        "free_gb":  round(usage.free  / 1e9, 1),
        "used_pct": round(usage.used  / usage.total * 100),
    })


@router.get("/photos/thumb/{filename}")
async def photo_thumb(filename: str) -> Response:
    path = _safe_path(filename)
    if path is None or not path.is_file():
        return Response(status_code=404)
    try:
        if path.suffix == ".fits":
            jpeg = _fits_to_jpeg(path)
        else:
            img = cv2.imread(str(path))
            h, w = img.shape[:2]
            if w > 640:
                img = cv2.resize(img, (640, int(h * 640 / w)))
            ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 80])
            if not ok:
                return Response(status_code=500)
            jpeg = buf.tobytes()
    except Exception:
        return Response(status_code=500)
    return Response(content=jpeg, media_type="image/jpeg", headers={"Cache-Control": "max-age=3600"})


@router.get("/photos/file/{filename}")
async def photo_file(filename: str) -> Response:
    """Inline-viewable rendering (for the <img> viewer) — FITS is debayered
    to JPEG since browsers can't display it natively; PNG is served as-is."""
    path = _safe_path(filename)
    if path is None or not path.is_file():
        return Response(status_code=404)
    if path.suffix == ".fits":
        jpeg = _fits_to_jpeg(path)
        return Response(content=jpeg, media_type="image/jpeg")
    return Response(content=path.read_bytes(), media_type="image/png")


@router.get("/photos/download/{filename}")
async def photo_download(filename: str) -> Response:
    path = _safe_path(filename)
    if path is None or not path.is_file():
        return Response(status_code=404)
    media_type = "application/fits" if path.suffix == ".fits" else "image/png"
    return Response(
        content=path.read_bytes(),
        media_type=media_type,
        headers={"Content-Disposition": f'attachment; filename="{path.name}"'},
    )


@router.delete("/photos/{filename}")
async def delete_photo(filename: str) -> JSONResponse:
    path = _safe_path(filename)
    if path is None:
        return JSONResponse({"error": "invalid filename"}, status_code=400)
    if not path.is_file():
        return JSONResponse({"error": "not found"}, status_code=404)
    path.unlink()
    return JSONResponse({"deleted": filename})


@router.delete("/photos")
async def delete_all_photos() -> JSONResponse:
    if not PHOTOS_DIR.exists():
        return JSONResponse({"deleted": 0})
    count = 0
    for f in PHOTOS_DIR.iterdir():
        if f.suffix in _EXTENSIONS:
            f.unlink()
            count += 1
    return JSONResponse({"deleted": count})
