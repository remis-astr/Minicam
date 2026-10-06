"""Compression zstd via la libzstd système (ctypes) — aucune dépendance Python.

libzstd1 fait partie de l'installation de base de Debian/Raspberry Pi OS ;
si elle manque, `available()` renvoie False et le flux reste non compressé.
Mesuré sur Pi Zero 2 W, RAW 8 bits 640×480 d'une planète sur fond noir :
300 → 94 Ko en ~10 ms au niveau 1 (sans perte).
"""
from __future__ import annotations

import ctypes
import ctypes.util
import logging
import threading

log = logging.getLogger(__name__)

_lib = None
_tls = threading.local()


def _load():
    global _lib
    if _lib is not None:
        return _lib
    name = ctypes.util.find_library("zstd") or "libzstd.so.1"
    try:
        lib = ctypes.CDLL(name)
    except OSError as e:
        log.warning("libzstd introuvable (%s) — compression zstd indisponible", e)
        _lib = False
        return _lib
    lib.ZSTD_createCCtx.restype = ctypes.c_void_p
    lib.ZSTD_compressBound.restype = ctypes.c_size_t
    lib.ZSTD_compressBound.argtypes = [ctypes.c_size_t]
    lib.ZSTD_compressCCtx.restype = ctypes.c_size_t
    lib.ZSTD_compressCCtx.argtypes = [
        ctypes.c_void_p, ctypes.c_void_p, ctypes.c_size_t,
        ctypes.c_char_p, ctypes.c_size_t, ctypes.c_int,
    ]
    lib.ZSTD_isError.restype = ctypes.c_uint
    lib.ZSTD_isError.argtypes = [ctypes.c_size_t]
    _lib = lib
    return _lib


def available() -> bool:
    return bool(_load())


def compress(data: bytes, level: int = 1) -> bytes:
    """Compresse `data` en une trame zstd autonome (taille d'origine incluse)."""
    lib = _load()
    if not lib:
        raise RuntimeError("libzstd indisponible")
    # Un contexte par thread : réutilisé d'une image à l'autre (évite de le
    # recréer), jamais partagé entre threads du pool d'exécution.
    cctx = getattr(_tls, "cctx", None)
    if cctx is None:
        cctx = _tls.cctx = lib.ZSTD_createCCtx()
    bound = lib.ZSTD_compressBound(len(data))
    dst = ctypes.create_string_buffer(bound)
    n = lib.ZSTD_compressCCtx(cctx, dst, bound, data, len(data), level)
    if lib.ZSTD_isError(n):
        raise RuntimeError("échec compression zstd")
    return ctypes.string_at(dst, n)
