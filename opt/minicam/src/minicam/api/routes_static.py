from pathlib import Path
from fastapi import APIRouter
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

WEB_DIR = Path("/opt/minicam/web")
router = APIRouter()


@router.get("/")
async def index() -> FileResponse:
    return FileResponse(WEB_DIR / "index.html")
