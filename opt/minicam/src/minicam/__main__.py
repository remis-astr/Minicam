import inspect
import logging
import uvicorn
from minicam.api.app import create_app
from minicam.config import load_config

logging.basicConfig(
    level=logging.INFO,
    format='{"ts":"%(asctime)s","level":"%(levelname)s","name":"%(name)s","msg":"%(message)s"}',
)

cfg = load_config()
app = create_app()

if __name__ == "__main__":
    # permessage-deflate (négocié d'office avec les navigateurs) compresse
    # chaque image en zlib, en Python, sur le Pi : c'était le vrai goulot du
    # flux /ws/raw (RAW 8 bits 640×480 : 12 → 33–52 img/s en USB une fois
    # désactivé). La compression utile est zstd, choisie par le client.
    # Option absente des uvicorn anciens (paquet Debian) : ne la passer que
    # si elle existe, sinon le service refuserait de démarrer.
    ws_opts = {}
    if "ws_per_message_deflate" in inspect.signature(uvicorn.Config).parameters:
        ws_opts["ws_per_message_deflate"] = bool(cfg["api"].get("ws_deflate", False))
    uvicorn.run(app, host=cfg["api"]["host"], port=cfg["api"]["port"], log_config=None, **ws_opts)
