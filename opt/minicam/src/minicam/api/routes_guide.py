"""Trames brutes pour l'autoguideur du M8S (projet « Mecoll M8S pro L »).

Le M8S fait tout le calcul (dépaquetage, détection d'étoiles, guidage,
plate solving) : ici on ne fait que livrer les octets RAW *packés* tels que
picamera2 les fournit — ni dépaquetage, ni compression, ni écriture sur la
SD — pour garder le RPi0 au repos.

Pourquoi HTTP et pas /ws/raw : mesuré le 24/09/2026 sur le lien gadget USB,
une trame de 4,3 Mo met ~1,3 s à partir par le WebSocket (≈3,4 Mo/s, limité
par la pile WebSocket Python) contre ~0,45 s en réponse HTTP, pour un lien
qui tient 20 Mo/s en HTTP brut.
"""
from __future__ import annotations

import asyncio
import time

from fastapi import APIRouter, Request
from fastapi.responses import Response

router = APIRouter()

# Tant qu'une trame de guidage a été demandée dans cette fenêtre, la boucle
# d'aperçu JPEG (routes_preview._capture_loop) se met en pause : elle
# consommerait sinon le CPU du Pi à encoder des JPEG que personne ne regarde
# pendant une session de guidage.
GUIDE_HOLD_S = 10.0


def guide_active(state) -> bool:
    return time.monotonic() - getattr(state, "guide_last_request", -1e9) < GUIDE_HOLD_S


@router.get("/guide/frame")
async def guide_frame(request: Request) -> Response:
    """Une trame RAW packée, avec la pose et le gain courants. Le M8S règle
    la pose d'une session (guidage et solve) via les commandes habituelles
    de /ws/control (set_exposure, set_gain) : changer la pose le temps d'une
    seule trame s'est révélé lent et peu fiable, les trames longues déjà en
    file devant d'abord s'écouler (essais du 24/09/2026)."""
    app = request.app
    if app.state.indi_mode:
        return Response(status_code=409, content=b"INDI mode active")
    app.state.guide_last_request = time.monotonic()
    camera = app.state.camera
    raw, meta = await asyncio.get_event_loop().run_in_executor(None, camera.capture_raw)
    app.state.guide_last_request = time.monotonic()
    width, height = camera.raw_size
    headers = {
        # Géométrie du buffer packé : `stride` octets par ligne, dont seuls
        # les premiers (width*bits/8) portent des pixels (padding éventuel).
        "X-Width": str(width),
        "X-Height": str(height),
        "X-Stride": str(raw.shape[1]),
        "X-Bits": str(camera.raw_bits),
        "X-Bayer": camera.bayer_pattern,
        "X-Raw-Mode": camera.raw_mode,
        # binning 2×2 matériel du mode (RawMode.binned) : le nom ne suffit pas
        # à le déduire (ex. « fast_990 » est binné sans suffixe « _bin »)
        "X-Binned": "1" if camera.profile.get_raw_mode(camera.raw_mode).binned else "0",
        "X-Sensor": camera.sensor,
        "X-Exposure-Us": str(meta.get("ExposureTime", camera.exposure_us)),
        "X-Gain": f"{meta.get('AnalogueGain', camera.gain):.4f}",
        "X-Sensor-Timestamp-Ns": str(meta.get("SensorTimestamp", 0)),
        "X-Wall-Time": f"{time.time():.3f}",
    }
    return Response(content=raw.tobytes(), media_type="application/octet-stream", headers=headers)
