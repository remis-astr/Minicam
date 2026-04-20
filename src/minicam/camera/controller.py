from __future__ import annotations

import logging
import threading
import time
from typing import Any

from picamera2 import Picamera2

from minicam.config import load_config, read_state, write_state

log = logging.getLogger(__name__)


class CameraController:
    def __init__(self) -> None:
        cfg = load_config()
        state = read_state()
        self.gain: float = state.get("gain", cfg["camera"]["default_gain"])
        self.exposure_us: int = int(state.get("exposure_us", cfg["camera"]["default_exposure_ms"] * 1000))
        self._lock = threading.Lock()
        self._picam2: Picamera2 | None = None

    def open(self) -> None:
        with self._lock:
            self._picam2 = Picamera2()
            config = self._picam2.create_video_configuration(
                main={"format": "YUV420", "size": (1280, 720)},
                raw={"format": "SRGGB12_CSI2P", "size": (1920, 1080)},
                display=None,
            )
            self._picam2.configure(config)
            self._picam2.set_controls({
                "AnalogueGain": self.gain,
                "ExposureTime": self.exposure_us,
                "AeEnable": False,
                "AwbEnable": False,
            })
            self._picam2.start()
            log.info("Camera opened gain=%.1f exposure_us=%d", self.gain, self.exposure_us)

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
            "open": self._picam2 is not None,
        }

    def _persist(self) -> None:
        state = read_state()
        state.update({"gain": self.gain, "exposure_us": self.exposure_us})
        write_state(state)
