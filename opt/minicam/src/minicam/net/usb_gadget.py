"""Configuration du gadget USB ECM/RNDIS via libcomposite (ConfigFS)."""
from __future__ import annotations

import logging
import os
import subprocess
from pathlib import Path

from minicam.config import load_config

log = logging.getLogger(__name__)

GADGET_DIR = Path("/sys/kernel/config/usb_gadget/minicam")
# /etc/minicam/config.toml, [network] usb_ip ; l'hôte (PC/M8S) est en .1 du même /24.
# Changer le sous-réseau permet de brancher deux Multicam sur la même machine.
USB_IP: str = load_config()["network"]["usb_ip"]
HOST_IP = USB_IP.rsplit(".", 1)[0] + ".1"


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

    # c.1 : RNDIS (Windows / Android) — premier config, pris en priorité par ces hôtes
    rndis = GADGET_DIR / "functions/rndis.usb0"
    rndis.mkdir(parents=True, exist_ok=True)

    c1 = GADGET_DIR / "configs/c.1"
    c1.mkdir(parents=True, exist_ok=True)
    (c1 / "strings/0x409").mkdir(parents=True, exist_ok=True)
    _write(c1 / "strings/0x409/configuration", "RNDIS")
    _write(c1 / "MaxPower", "250")
    os.symlink(rndis, c1 / "rndis.usb0")

    # c.2 : ECM (Linux / Mac) — préféré par Linux qui énumère toutes les configs
    ecm = GADGET_DIR / "functions/ecm.usb1"
    ecm.mkdir(parents=True, exist_ok=True)

    c2 = GADGET_DIR / "configs/c.2"
    c2.mkdir(parents=True, exist_ok=True)
    (c2 / "strings/0x409").mkdir(parents=True, exist_ok=True)
    _write(c2 / "strings/0x409/configuration", "ECM")
    _write(c2 / "MaxPower", "250")
    os.symlink(ecm, c2 / "ecm.usb1")

    # Activer le gadget sur le premier UDC disponible
    udcs = list(Path("/sys/class/udc").iterdir())
    if not udcs:
        raise RuntimeError("Aucun UDC disponible — vérifier dtoverlay=dwc2")
    _write(GADGET_DIR / "UDC", udcs[0].name)
    log.info("Gadget USB RNDIS+ECM activé sur %s", udcs[0].name)


def bring_up(ip: str = USB_IP) -> None:
    # usb0 = RNDIS (c.1), usb1 = ECM (c.2)
    # On assigne l'IP aux deux interfaces : le host peut se connecter avant ou après le boot.
    # On supprime ensuite la route de l'interface linkdown pour éviter que le kernel route
    # les réponses sur une interface morte (il prend la première route, pas forcément la bonne).
    for iface in ("usb0", "usb1"):
        r = subprocess.run(["ip", "link", "show", iface], capture_output=True)
        if r.returncode != 0:
            continue
        subprocess.run(["ip", "link", "set", iface, "up"], check=False)
        subprocess.run(["ip", "addr", "add", f"{ip}/24", "dev", iface], check=False)
        log.info("%s up @ %s", iface, ip)
    _fix_routes(ip)


def _fix_routes(ip: str = USB_IP) -> None:
    """Supprime la route de l'interface linkdown pour que le kernel choisisse la bonne."""
    network = ip.rsplit(".", 1)[0] + ".0"
    for iface in ("usb0", "usb1"):
        carrier = Path(f"/sys/class/net/{iface}/carrier")
        try:
            has_carrier = carrier.read_text().strip() == "1"
        except OSError:
            has_carrier = False
        if not has_carrier:
            subprocess.run(
                ["ip", "route", "del", f"{network}/24", "dev", iface],
                check=False, capture_output=True,
            )
            log.info("%s linkdown — route supprimée", iface)


def tear_down() -> None:
    for iface in ("usb0", "usb1"):
        subprocess.run(["ip", "link", "set", iface, "down"], check=False)
    if GADGET_DIR.exists():
        _write(GADGET_DIR / "UDC", "")
        (GADGET_DIR / "configs/c.1/rndis.usb0").unlink(missing_ok=True)
        (GADGET_DIR / "configs/c.2/ecm.usb1").unlink(missing_ok=True)
    log.info("USB network down")
