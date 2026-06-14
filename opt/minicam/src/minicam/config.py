from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

try:
    import tomllib
except ImportError:
    import tomli as tomllib  # type: ignore[no-redef]

log = logging.getLogger(__name__)

CONFIG_PATH = Path("/etc/minicam/config.toml")
STATE_PATH = Path("/var/lib/minicam/state.json")

_DEFAULTS: dict[str, Any] = {
    "camera": {"default_gain": 10.0, "default_exposure_ms": 100.0},
    "oled": {"contrast": 20, "auto_sleep_seconds": 60, "rotate": 0, "i2c_address": "0x3C"},
    "network": {"usb_ip": "192.168.7.2", "usb_prefix": 24},
    "api": {"host": "0.0.0.0", "port": 8000},
}


def load_config() -> dict[str, Any]:
    cfg = dict(_DEFAULTS)
    if CONFIG_PATH.exists():
        with open(CONFIG_PATH, "rb") as f:
            overrides = tomllib.load(f)
        for section, values in overrides.items():
            cfg.setdefault(section, {})
            cfg[section].update(values)
    return cfg


def read_state() -> dict[str, Any]:
    if STATE_PATH.exists():
        try:
            return json.loads(STATE_PATH.read_text())
        except Exception:
            pass
    return {}


def write_state(data: dict[str, Any]) -> None:
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = STATE_PATH.with_suffix(".tmp")
    tmp.write_text(json.dumps(data))
    tmp.replace(STATE_PATH)
