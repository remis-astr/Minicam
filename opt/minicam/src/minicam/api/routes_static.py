from pathlib import Path
from fastapi import APIRouter
from fastapi.responses import FileResponse

WEB_DIR = Path("/opt/minicam/web")
router = APIRouter()

_NO_CACHE = {"Cache-Control": "no-store"}


@router.get("/")
async def index() -> FileResponse:
    return FileResponse(WEB_DIR / "index.html", headers=_NO_CACHE)


@router.get("/static/app.js")
async def app_js() -> FileResponse:
    return FileResponse(WEB_DIR / "app.js", media_type="application/javascript", headers=_NO_CACHE)


@router.get("/static/style.css")
async def style_css() -> FileResponse:
    return FileResponse(WEB_DIR / "style.css", media_type="text/css", headers=_NO_CACHE)
