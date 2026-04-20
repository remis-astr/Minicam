from __future__ import annotations

import logging
import threading
import time
from typing import Any

from picamera2 import Picamera2

from minicam.config import load_config, read_state, write_state

log = logging.getLogger(__name__)


RESOLUTIONS = {
    "720p":  (1280, 720),
    "1080p": (1920, 1080),
}


class CameraController:
    def __init__(self) -> None:
        cfg = load_config()
        state = read_state()
        self.gain: float = state.get("gain", cfg["camera"]["default_gain"])
        self.exposure_us: int = int(state.get("exposure_us", cfg["camera"]["default_exposure_ms"] * 1000))
        self.resolution: str = state.get("resolution", "720p")
        self.wb_red: float = state.get("wb_red", 1.0)
        self.wb_blue: float = state.get("wb_blue", 1.0)
        self._lock = threading.Lock()
        self._picam2: Picamera2 | None = None

    def _make_config(self) -> Any:
        size = RESOLUTIONS[self.resolution]
        return self._picam2.create_video_configuration(  # type: ignore[union-attr]
            main={"format": "YUV420", "size": size},
            raw={"format": "SRGGB12_CSI2P", "size": size},
            display=None,
        )

    def open(self) -> None:
        with self._lock:
            self._picam2 = Picamera2()
            self._picam2.configure(self._make_config())
            self._picam2.set_controls({
                "AnalogueGain": self.gain,
                "ExposureTime": self.exposure_us,
                "AeEnable": False,
                "AwbEnable": False,
                "ColourGains": (self.wb_red, self.wb_blue),
            })
            self._picam2.start()
            log.info("Camera opened res=%s gain=%.1f exposure_us=%d", self.resolution, self.gain, self.exposure_us)

    def close(self) -> None:
        with self._lock:
            if self._picam2:
                self._picam2.stop()
                self._picam2.close()
                self._picam2 = None
                log.info("Camera closed")

    def set_gain(self, gain: float) -> None:
        with self._lock:
            self.gain = max(1.0, min(64.0, gain))
            if self._picam2:
                self._picam2.set_controls({"AnalogueGain": self.gain})
        self._persist()
        log.info("Gain set to %.2f", self.gain)

    def set_resolution(self, res: str) -> None:
        if res not in RESOLUTIONS:
            raise ValueError(f"résolution inconnue: {res}")
        with self._lock:
            self.resolution = res
            if self._picam2:
                self._picam2.stop()
                self._picam2.configure(self._make_config())
                self._picam2.set_controls({
                    "AnalogueGain": self.gain,
                    "ExposureTime": self.exposure_us,
                    "AeEnable": False,
                    "AwbEnable": False,
                    "ColourGains": (self.wb_red, self.wb_blue),
                })
                self._picam2.start()
        self._persist()
        log.info("Resolution set to %s", self.resolution)

    def set_wb(self, red: float, blue: float) -> None:
        with self._lock:
            self.wb_red = max(0.1, min(8.0, red))
            self.wb_blue = max(0.1, min(8.0, blue))
            if self._picam2:
                self._picam2.set_controls({"ColourGains": (self.wb_red, self.wb_blue)})
        self._persist()
        log.info("WB set R=%.2f B=%.2f", self.wb_red, self.wb_blue)

    def set_exposure_ms(self, ms: float) -> None:
        with self._lock:
            self.exposure_us = int(max(0.1, min(30000.0, ms)) * 1000)
            if self._picam2:
                self._picam2.set_controls({"ExposureTime": self.exposure_us})
        self._persist()
        log.info("Exposure set to %d µs", self.exposure_us)

    def capture_raw(self) -> tuple[Any, dict[str, Any]]:
        with self._lock:
            if not self._picam2:
                raise RuntimeError("Camera not open")
            arrays, metadata = self._picam2.capture_arrays(["raw"])
            return arrays[0], metadata

    def capture_frame(self) -> Any:
        with self._lock:
            if not self._picam2:
                raise RuntimeError("Camera not open")
            return self._picam2.capture_array("main")

    def status(self) -> dict[str, Any]:
        return {
            "gain": self.gain,
            "exposure_us": self.exposure_us,
            "exposure_ms": self.exposure_us / 1000,
            "resolution": self.resolution,
            "resolutions": list(RESOLUTIONS.keys()),
            "wb_red": self.wb_red,
            "wb_blue": self.wb_blue,
            "open": self._picam2 is not None,
        }

    def _persist(self) -> None:
        state = read_state()
        state.update({"gain": self.gain, "exposure_us": self.exposure_us,
                      "resolution": self.resolution, "wb_red": self.wb_red, "wb_blue": self.wb_blue})
        write_state(state)
