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

    def _frame_duration_us(self, exposure_us: int) -> int:
        """Minimum frame duration to accommodate the requested exposure."""
        return max(33333, exposure_us)

    def open(self) -> None:
        with self._lock:
            self._picam2 = Picamera2()
            self._picam2.configure(self._make_config())
            fd = self._frame_duration_us(self.exposure_us)
            self._picam2.set_controls({
                "AnalogueGain": self.gain,
                "ExposureTime": self.exposure_us,
                "FrameDurationLimits": (fd, fd),
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
                fd = self._frame_duration_us(self.exposure_us)
                self._picam2.set_controls({
                    "AnalogueGain": self.gain,
                    "ExposureTime": self.exposure_us,
                    "FrameDurationLimits": (fd, fd),
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
                fd = self._frame_duration_us(self.exposure_us)
                self._picam2.set_controls({
                    "ExposureTime": self.exposure_us,
                    "FrameDurationLimits": (fd, fd),
                })
        self._persist()
        log.info("Exposure set to %d µs", self.exposure_us)

    def capture_raw_with_settings(self, gain: float, exposure_ms: float) -> Any:
        """Capture one RAW frame with temporary settings, then restore."""
        with self._lock:
            if not self._picam2:
                raise RuntimeError("Camera not open")
            p = self._picam2
            exp_us = int(max(0.1, min(30000.0, exposure_ms)) * 1000)
            fd = self._frame_duration_us(exp_us)
            p.set_controls({
                "AnalogueGain": max(1.0, min(64.0, gain)),
                "ExposureTime": exp_us,
                "FrameDurationLimits": (fd, fd),
            })
            restore_gain = self.gain
            restore_exp_us = self.exposure_us
            restore_fd = self._frame_duration_us(self.exposure_us)
        # Blocking calls outside the lock so set_gain / set_exposure can proceed
        p.capture_arrays(["raw"])  # discard — wait for settings
        arrays, _meta = p.capture_arrays(["raw"])
        with self._lock:
            if self._picam2 is p:
                p.set_controls({
                    "AnalogueGain": restore_gain,
                    "ExposureTime": restore_exp_us,
                    "FrameDurationLimits": (restore_fd, restore_fd),
                })
        return arrays[0]

    def capture_frame_with_settings(self, gain: float, exposure_ms: float) -> Any:
        """Capture one frame with temporary settings, then restore preview settings."""
        with self._lock:
            if not self._picam2:
                raise RuntimeError("Camera not open")
            p = self._picam2
            exp_us = int(max(0.1, min(30000.0, exposure_ms)) * 1000)
            fd = self._frame_duration_us(exp_us)
            p.set_controls({
                "AnalogueGain": max(1.0, min(64.0, gain)),
                "ExposureTime": exp_us,
                "FrameDurationLimits": (fd, fd),
            })
            restore_gain = self.gain
            restore_exp_us = self.exposure_us
            restore_fd = self._frame_duration_us(self.exposure_us)
        # Blocking calls outside the lock
        p.capture_array("main")  # discard — wait for settings to apply
        frame = p.capture_array("main")
        with self._lock:
            if self._picam2 is p:
                p.set_controls({
                    "AnalogueGain": restore_gain,
                    "ExposureTime": restore_exp_us,
                    "FrameDurationLimits": (restore_fd, restore_fd),
                })
        return frame

    def apply_sequence_settings(self, gain: float, exposure_ms: float) -> None:
        """Apply capture settings and drain frames until the sensor confirms them."""
        with self._lock:
            if not self._picam2:
                raise RuntimeError("Camera not open")
            p = self._picam2
            exp_us = int(max(0.1, min(30000.0, exposure_ms)) * 1000)
            fd = self._frame_duration_us(exp_us)
            p.set_controls({
                "AnalogueGain": max(1.0, min(64.0, gain)),
                "ExposureTime": exp_us,
                "FrameDurationLimits": (fd, fd),
            })
        # Drain frames outside the lock — IMX290/462 pipeline latency 3-4 frames, cap 8
        tolerance = max(500, exp_us // 20)  # 5 % tolerance
        actual = 0
        for attempt in range(8):
            _, meta = p.capture_arrays(["raw"])
            actual = meta.get("ExposureTime", 0)
            if abs(actual - exp_us) <= tolerance:
                log.info(
                    "Sequence settings confirmed after %d discard(s): "
                    "requested=%d µs actual=%d µs",
                    attempt + 1, exp_us, actual,
                )
                break
        else:
            log.warning(
                "Sequence settings not confirmed after 8 frames "
                "(requested=%d µs, last actual=%d µs) — proceeding anyway",
                exp_us, actual,
            )

    def restore_preview_settings(self) -> None:
        """Restore persistent preview settings after a sequence."""
        with self._lock:
            if not self._picam2:
                return
            fd = self._frame_duration_us(self.exposure_us)
            self._picam2.set_controls({
                "AnalogueGain": self.gain,
                "ExposureTime": self.exposure_us,
                "FrameDurationLimits": (fd, fd),
            })
        log.info("Preview settings restored: gain=%.2f exposure_us=%d", self.gain, self.exposure_us)

    def capture_raw(self) -> tuple[Any, dict[str, Any]]:
        with self._lock:
            if not self._picam2:
                raise RuntimeError("Camera not open")
            p = self._picam2
        # Release lock before the blocking picamera2 call so set_gain / set_exposure
        # and the preview loop are never serialised behind a long-exposure wait.
        arrays, metadata = p.capture_arrays(["raw"])
        return arrays[0], metadata

    def capture_frame(self) -> Any:
        with self._lock:
            if not self._picam2:
                raise RuntimeError("Camera not open")
            p = self._picam2
        return p.capture_array("main")

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
