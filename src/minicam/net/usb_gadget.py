"""Configuration du gadget USB ECM/RNDIS via libcomposite (ConfigFS)."""
from __future__ import annotations

import logging
import os
import subprocess
from pathlib import Path

log = logging.getLogger(__name__)

GADGET_DIR = Path("/sys/kernel/config/usb_gadget/minicam")
USB_IP = "192.168.7.2"
HOST_IP = "192.168.7.1"


def _write(path: Path, value: str) -> None:
    path.write_text(value)


def setup_gadget() -> None:
    if GADGET_DIR.exists():
        log.info("Gadget déjà configuré")
        return

    GADGET_DIR.mkdir(parents=True)
    _write(GADGET_DIR / "idVendor",  "0x1d6b")  # Linux Foundation
    _write(GADGET_DIR / "idProduct", "0x0104")  # Multifunction Composite Gadget
    _write(GADGET_DIR / "bcdDevice", "0x0100")
    _write(GADGET_DIR / "bcdUSB",    "0x0200")

    strings = GADGET_DIR / "strings/0x409"
    strings.mkdir(parents=True, exist_ok=True)
    _write(strings / "manufacturer", "MiniCam")
    _write(strings / "product",      "MiniCam USB")
    _write(strings / "serialnumber", "minicam0")

    # Fonction ECM (Linux/Mac) + RNDIS (Windows)
    ecm = GADGET_DIR / "functions/ecm.usb0"
    ecm.mkdir(parents=True, exist_ok=True)

    config = GADGET_DIR / "configs/c.1"
    config.mkdir(parents=True, exist_ok=True)
    (config / "strings/0x409").mkdir(parents=True, exist_ok=True)
    _write(config / "strings/0x409/configuration", "ECM")
    _write(config / "MaxPower", "250")

    os.symlink(ecm, config / "ecm.usb0")

    # Activer le gadget sur le premier UDC disponible
    udcs = list(Path("/sys/class/udc").iterdir())
    if not udcs:
        raise RuntimeError("Aucun UDC disponible — vérifier dtoverlay=dwc2")
    _write(GADGET_DIR / "UDC", udcs[0].name)
    log.info("Gadget USB ECM activé sur %s", udcs[0].name)


def bring_up(ip: str = USB_IP) -> None:
    subprocess.run(["ip", "link", "set", "usb0", "up"], check=True)
    subprocess.run(["ip", "addr", "add", f"{ip}/24", "dev", "usb0"], check=False)
    log.info("usb0 up @ %s", ip)


def tear_down() -> None:
    subprocess.run(["ip", "link", "set", "usb0", "down"], check=False)
    if GADGET_DIR.exists():
        _write(GADGET_DIR / "UDC", "")
        (GADGET_DIR / "configs/c.1/ecm.usb0").unlink(missing_ok=True)
    log.info("usb0 down")
