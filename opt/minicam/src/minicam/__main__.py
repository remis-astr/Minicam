import asyncio
import inspect
import logging
import ssl
from pathlib import Path

import uvicorn
from minicam.api.app import create_app
from minicam.config import load_config

logging.basicConfig(
    level=logging.INFO,
    format='{"ts":"%(asctime)s","level":"%(levelname)s","name":"%(name)s","msg":"%(message)s"}',
)
log = logging.getLogger("minicam")

cfg = load_config()
app = create_app()


def _ws_opts() -> dict:
    # permessage-deflate (négocié d'office avec les navigateurs) compresse
    # chaque image en zlib, en Python, sur le Pi : c'était le vrai goulot du
    # flux /ws/raw (RAW 8 bits 640×480 : 12 → 33–52 img/s en USB une fois
    # désactivé). La compression utile est zstd, choisie par le client.
    # Option absente des uvicorn anciens (paquet Debian) : ne la passer que
    # si elle existe, sinon le service refuserait de démarrer.
    if "ws_per_message_deflate" in inspect.signature(uvicorn.Config).parameters:
        return {"ws_per_message_deflate": bool(cfg["api"].get("ws_deflate", False))}
    return {}


def _tls_files() -> tuple[Path, Path] | None:
    """Certificat/clé HTTPS si [api] https_port est réglé et que
    minicam-tls-setup les a créés ; None = HTTP seul (comportement historique)."""
    port = int(cfg["api"].get("https_port", 0) or 0)
    if not port:
        return None
    tls_dir = Path(cfg["api"].get("tls_dir", "/etc/minicam/tls"))
    cert, key = tls_dir / "server.crt", tls_dir / "server.key"
    if not (cert.is_file() and key.is_file()):
        log.warning("https_port=%d mais %s / %s absents — lancer minicam-tls-setup ; HTTP seul",
                    port, cert, key)
        return None
    return cert, key


def _prefer_chacha20(ctx: ssl.SSLContext) -> None:
    """Le SoC du Pi Zero 2 W n'a pas d'instructions AES : AES-GCM ~27 Mo/s
    contre ~166 Mo/s pour ChaCha20-Poly1305 (openssl speed). TLS 1.3 négocie
    AES-256-GCM et Python ne permet pas d'y changer l'ordre des suites ; on
    plafonne donc à TLS 1.2 avec ECDHE + ChaCha20-Poly1305 en priorité
    serveur (AES-GCM en secours) — chiffrement robuste, connu de tous les
    navigateurs récents."""
    ctx.maximum_version = ssl.TLSVersion.TLSv1_2
    ctx.set_ciphers("ECDHE+CHACHA20:ECDHE+AESGCM")
    ctx.options |= ssl.OP_CIPHER_SERVER_PREFERENCE


async def _serve_http_and_https(cert: Path, key: Path) -> None:
    """HTTP (port habituel) + HTTPS (page sûre → WebGPU sur les autres
    appareils) dans le même processus, sur la même application : un seul
    accès caméra. Le cycle de vie (ouverture caméra…) ne tourne que sur le
    serveur HTTP."""
    host = cfg["api"]["host"]
    http = uvicorn.Server(uvicorn.Config(
        app, host=host, port=cfg["api"]["port"], log_config=None, **_ws_opts()))
    https_cfg = uvicorn.Config(
        app, host=host, port=int(cfg["api"]["https_port"]), log_config=None,
        lifespan="off", ssl_certfile=str(cert), ssl_keyfile=str(key), **_ws_opts())
    https_cfg.load()   # crée le contexte TLS, ajusté ci-dessous avant serve()
    _prefer_chacha20(https_cfg.ssl)
    https = uvicorn.Server(https_cfg)
    log.info("HTTPS actif sur le port %s (%s)", cfg["api"]["https_port"], cert)
    await asyncio.gather(http.serve(), https.serve())


if __name__ == "__main__":
    tls = _tls_files()
    if tls:
        asyncio.run(_serve_http_and_https(*tls))
    else:
        uvicorn.run(app, host=cfg["api"]["host"], port=cfg["api"]["port"], log_config=None, **_ws_opts())
