"""Gestion WiFi via NetworkManager (nmcli)."""
from __future__ import annotations

import asyncio
import logging
import re
import subprocess
import time

from fastapi import APIRouter
from fastapi.responses import JSONResponse
from pydantic import BaseModel

log = logging.getLogger(__name__)
router = APIRouter()


def _run(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(list(args), capture_output=True, text=True)


def _wifi_ip() -> str | None:
    r = _run("ip", "-4", "addr", "show", "wlan0")
    m = re.search(r"inet (\d+\.\d+\.\d+\.\d+)", r.stdout)
    return m.group(1) if m else None


def _wifi_gateway() -> str | None:
    r = _run("ip", "route", "show", "dev", "wlan0")
    m = re.search(r"default via (\d+\.\d+\.\d+\.\d+)", r.stdout)
    return m.group(1) if m else None


def _wifi_ip_method(ssid: str) -> str:
    r = _run("nmcli", "-t", "-f", "ipv4.method", "connection", "show", ssid)
    return "static" if "manual" in r.stdout else "dhcp"


def _wifi_status_sync() -> dict:
    r = _run("nmcli", "-t", "-f", "WIFI", "radio")
    enabled = "enabled" in r.stdout.lower()

    r = _run("nmcli", "-t", "-f", "DEVICE,TYPE,STATE,CONNECTION", "device", "status")
    ssid = None
    connected = False
    for line in r.stdout.splitlines():
        if line.startswith("wlan"):
            parts = line.split(":", 3)
            if len(parts) >= 4 and parts[2] == "connected":
                connected = True
                ssid = parts[3] if parts[3] != "--" else None
            break

    ip = _wifi_ip() if connected else None
    ip_method = _wifi_ip_method(ssid) if (connected and ssid) else None
    return {"enabled": enabled, "connected": connected, "ssid": ssid, "ip": ip, "ip_method": ip_method}


@router.get("/system/wifi/profiles")
async def wifi_profiles() -> JSONResponse:
    loop = asyncio.get_event_loop()

    def _profiles() -> list[str]:
        r = _run("nmcli", "-t", "-f", "NAME,TYPE", "connection", "show")
        return [
            line.split(":", 1)[0]
            for line in r.stdout.splitlines()
            if line.endswith(":802-11-wireless")
        ]

    return JSONResponse({"ok": True, "profiles": await loop.run_in_executor(None, _profiles)})


@router.get("/system/wifi")
async def wifi_status() -> JSONResponse:
    loop = asyncio.get_event_loop()
    st = await loop.run_in_executor(None, _wifi_status_sync)
    return JSONResponse({"ok": True, **st})


class _ConnectBody(BaseModel):
    ssid: str
    password: str = ""


@router.post("/system/wifi/connect")
async def wifi_connect(body: _ConnectBody) -> JSONResponse:
    ssid = body.ssid.strip()
    password = body.password
    if not ssid:
        return JSONResponse({"ok": False, "detail": "ssid requis"}, status_code=400)

    loop = asyncio.get_event_loop()

    def _connect() -> dict:
        _run("sudo", "nmcli", "radio", "wifi", "on")

        r = _run("nmcli", "-t", "-f", "NAME", "connection", "show")
        existing = {line.strip() for line in r.stdout.splitlines()}

        if ssid in existing:
            if password:
                r = _run("sudo", "nmcli", "connection", "modify", ssid,
                         "wifi-sec.key-mgmt", "wpa-psk",
                         "wifi-sec.psk", password)
                if r.returncode != 0:
                    return {"ok": False, "detail": r.stderr.strip() or "Modification du profil échouée"}
        else:
            args = ["sudo", "nmcli", "connection", "add", "type", "wifi",
                    "ssid", ssid, "con-name", ssid, "connection.autoconnect", "yes"]
            if password:
                args += ["wifi-sec.key-mgmt", "wpa-psk", "wifi-sec.psk", password]
            else:
                args += ["wifi-sec.key-mgmt", "none"]
            r = _run(*args)
            if r.returncode != 0:
                return {"ok": False, "detail": r.stderr.strip() or "Création du profil échouée"}

        r = _run("sudo", "nmcli", "connection", "up", ssid, "ifname", "wlan0")
        if r.returncode != 0:
            return {"ok": False, "detail": r.stderr.strip() or "Connexion échouée"}

        time.sleep(3)
        ip = _wifi_ip()
        return {"ok": True, "ssid": ssid, "ip": ip}

    result = await loop.run_in_executor(None, _connect)
    return JSONResponse(result)


@router.post("/system/wifi/fixip")
async def wifi_fix_ip() -> JSONResponse:
    """Passe le profil NM actif en IP statique avec l'IP courante."""
    loop = asyncio.get_event_loop()

    def _fixip() -> dict:
        r = _run("nmcli", "-t", "-f", "DEVICE,TYPE,STATE,CONNECTION", "device", "status")
        ssid = None
        for line in r.stdout.splitlines():
            if line.startswith("wlan"):
                parts = line.split(":", 3)
                if len(parts) >= 4 and parts[2] == "connected" and parts[3] != "--":
                    ssid = parts[3]
                break
        if not ssid:
            return {"ok": False, "detail": "Aucune connexion WiFi active"}

        ip = _wifi_ip()
        gw = _wifi_gateway()
        if not ip:
            return {"ok": False, "detail": "IP introuvable sur wlan0"}
        if not gw:
            return {"ok": False, "detail": "Passerelle introuvable"}

        r = _run("sudo", "nmcli", "connection", "modify", ssid,
                 "ipv4.method", "manual",
                 "ipv4.addresses", f"{ip}/24",
                 "ipv4.gateway", gw,
                 "ipv4.dns", gw)
        if r.returncode != 0:
            return {"ok": False, "detail": r.stderr.strip() or "Modification échouée"}

        # Réapplique la connexion pour activer la config statique
        _run("sudo", "nmcli", "connection", "up", ssid, "ifname", "wlan0")
        time.sleep(2)
        return {"ok": True, "ip": ip, "gateway": gw}

    result = await loop.run_in_executor(None, _fixip)
    return JSONResponse(result)


@router.post("/system/wifi/disconnect")
async def wifi_disconnect() -> JSONResponse:
    loop = asyncio.get_event_loop()

    def _disconnect() -> dict:
        r = _run("nmcli", "-t", "-f", "DEVICE,TYPE,STATE,CONNECTION", "device", "status")
        for line in r.stdout.splitlines():
            if line.startswith("wlan"):
                parts = line.split(":", 3)
                if len(parts) >= 4 and parts[2] == "connected" and parts[3] != "--":
                    _run("sudo", "nmcli", "connection", "down", parts[3])
                break
        return {"ok": True}

    result = await loop.run_in_executor(None, _disconnect)
    return JSONResponse(result)
