from pathlib import Path
from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from minicam.config import load_config

WEB_DIR = Path("/opt/minicam/web")
router = APIRouter()

_NO_CACHE = {"Cache-Control": "no-store"}


@router.get("/")
async def index() -> FileResponse:
    return FileResponse(WEB_DIR / "index.html", headers=_NO_CACHE)


@router.get("/ca.crt")
async def ca_cert() -> FileResponse:
    """Certificat racine de la carte (public) à installer sur un téléphone
    ou une tablette pour que la page HTTPS soit reconnue (minicam-tls-setup)."""
    ca = Path(load_config()["api"].get("tls_dir", "/etc/minicam/tls")) / "ca.crt"
    if not ca.is_file():
        raise HTTPException(404, "HTTPS non configuré (lancer minicam-tls-setup)")
    return FileResponse(ca, media_type="application/x-x509-ca-cert",
                        filename="multicam-ca.crt", headers=_NO_CACHE)


@router.get("/static/app.js")
async def app_js() -> FileResponse:
    return FileResponse(WEB_DIR / "app.js", media_type="application/javascript", headers=_NO_CACHE)


@router.get("/static/style.css")
async def style_css() -> FileResponse:
    return FileResponse(WEB_DIR / "style.css", media_type="text/css", headers=_NO_CACHE)
