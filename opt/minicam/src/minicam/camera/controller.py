from __future__ import annotations

import logging
import threading
import time
from typing import Any

from picamera2 import Picamera2

from minicam.config import load_config, read_state, write_state
from minicam.camera.sensors import bits_from_format, get_sensor_profile

log = logging.getLogger(__name__)


class CameraController:
    def __init__(self) -> None:
        cfg = load_config()
        state = read_state()
        self.sensor: str = cfg["camera"].get("sensor", "imx327")
        try:
            self.profile = get_sensor_profile(self.sensor)
        except ValueError:
            log.error("Capteur inconnu %r en config — repli sur imx327", self.sensor)
            self.sensor = "imx327"
            self.profile = get_sensor_profile(self.sensor)
        self.gain: float = min(state.get("gain", cfg["camera"]["default_gain"]), self.profile.gain_max)
        self.exposure_us: int = int(state.get("exposure_us", cfg["camera"]["default_exposure_ms"] * 1000))
        self.raw_mode: str = state.get("raw_mode", self.profile.raw_modes[0].name)
        if self.raw_mode not in {m.name for m in self.profile.raw_modes}:
            self.raw_mode = self.profile.raw_modes[0].name
        self.wb_red: float = state.get("wb_red", 1.0)
        self.wb_blue: float = state.get("wb_blue", 1.0)
        self.contrast: float = float(state.get("contrast", 1.0))
        self.sharpness: float = float(state.get("sharpness", 1.0))
        self.saturation: float = float(state.get("saturation", 1.0))
        self.brightness: float = float(state.get("brightness", 0.0))
        self.noise_reduction: int = int(state.get("noise_reduction", 1))
        self._lock = threading.Lock()
        self._picam2: Picamera2 | None = None

    def _raw_stream(self) -> tuple[tuple[int, int], str]:
        """True sensor/RAW capture size+format, per the selected raw_mode —
        must match what libcamera actually negotiates (see the check in
        open()). Use `raw_size` instead for anything describing data as
        delivered to callers (FITS header, WS metadata, UI) — modes with a
        `crop_width` deliver a narrower width than they capture."""
        mode = self.profile.get_raw_mode(self.raw_mode)
        return mode.size, mode.format

    @property
    def raw_bits(self) -> int:
        _, raw_format = self._raw_stream()
        return bits_from_format(raw_format)

    @property
    def raw_size(self) -> tuple[int, int]:
        """Delivered RAW size — what capture_raw()/capture_raw_with_settings()
        actually hand back after CameraController._apply_width_crop, and what
        FITS/WS metadata should describe. See _raw_stream() for the true
        (possibly wider) sensor capture size."""
        return self.profile.get_raw_mode(self.raw_mode).delivered_size

    @property
    def bayer_pattern(self) -> str:
        """True Bayer phase of the active raw_mode's output (see RawMode.bayer)."""
        return self.profile.get_raw_mode(self.raw_mode).bayer

    def _make_config(
        self,
        main_size: tuple[int, int] | None = None,
        buffer_count: int = 4,
    ) -> Any:
        raw_size, raw_format = self._raw_stream()
        if main_size is None:
            # The ISP scaler crops/scales "main" independently of RAW, so a
            # crop_width mode can get its narrower width here for free (a
            # real ISP crop) — unlike RAW, which has no such lever and needs
            # _apply_width_crop after capture instead.
            main_size = self.raw_size
        return self._picam2.create_video_configuration(  # type: ignore[union-attr]
            main={"format": "RGB888", "size": main_size},
            raw={"format": raw_format, "size": raw_size},
            display=None,
            buffer_count=buffer_count,
        )

    def _apply_width_crop(self, raw_arr: Any) -> Any:
        """Center-crop a captured RAW array's width to the active mode's
        crop_width, if set — see RawMode.crop_width for why this exists
        (no hardware width-crop lever on this sensor).

        `raw_arr` is picamera2's packed-format array, shape
        (height, width_bytes) — width_bytes bytes-per-row, not pixels, so
        the crop is a plain byte-range slice, not a pixel slice. This is only
        exact (no repacking needed) because both the pixel offset and the
        crop width are chosen to land on whole packing-group boundaries
        (2 pixels/3 bytes at 12-bit, 4 pixels/5 bytes at 10-bit) — asserted
        below rather than silently misaligning the Bayer phase or corrupting
        the packed data if a future mode picks a width that doesn't divide
        evenly.
        """
        mode = self.profile.get_raw_mode(self.raw_mode)
        if mode.crop_width is None:
            return raw_arr
        bits = bits_from_format(mode.format)
        pixel_group, byte_group = (4, 5) if bits == 10 else (2, 3)
        pixel_offset = (mode.size[0] - mode.crop_width) // 2
        if pixel_offset % pixel_group or mode.crop_width % pixel_group:
            raise ValueError(
                f"crop_width {mode.crop_width} ne s'aligne pas sur les groupes de "
                f"packing {bits} bits ({pixel_group} px/{byte_group} octets) pour le mode {mode.name!r}"
            )
        byte_offset = pixel_offset * byte_group // pixel_group
        byte_width = mode.crop_width * byte_group // pixel_group
        return raw_arr[:, byte_offset:byte_offset + byte_width]

    def _full_res_config(self, buffer_count: int = 2) -> Any:
        """Config at the sensor's true native resolution (profile.raw_size),
        independent of the currently selected `raw_mode` crop — used only by
        the full-res still/timelapse paths, never by the fast preview loop.
        """
        return self._picam2.create_video_configuration(  # type: ignore[union-attr]
            main={"format": "RGB888", "size": self.profile.raw_size},
            raw={"format": self.profile.raw_format, "size": self.profile.raw_size},
            display=None,
            buffer_count=buffer_count,
        )

    def _frame_duration_us(self, exposure_us: int) -> int:
        """Minimum frame duration to accommodate the requested exposure.

        Used to be a hard `max(33333, ...)` (30 fps) floor regardless of the
        active sensor mode — that silently capped the fast "planetary" crop
        modes (some good for 100+ fps) at 30 fps even with a short exposure.
        The real floor is exposure alone; nothing here should impose a
        slower-than-necessary frame rate; the sensor mode's own timing
        (frm_length_default / HBLANK, enforced by the kernel driver) is the
        actual lower bound picamera2/libcamera will clamp to.
        """
        return max(1, exposure_us)

    def open(self) -> None:
        with self._lock:
            try:
                self._picam2 = Picamera2()
                self._picam2.configure(self._make_config())
                # libcamera silently renegotiates an unsatisfiable RAW request
                # down to whatever the physically connected sensor actually
                # supports, instead of raising — so a wrong/mismatched sensor
                # profile would otherwise "succeed" while reporting incorrect
                # metadata (gain range, bit depth, FITS INSTRUME...) for data
                # that's really coming from a different sensor. Catch that
                # here explicitly.
                expected_raw_size, _ = self._raw_stream()
                negotiated_raw_size = tuple(self._picam2.camera_config["raw"]["size"])
                if negotiated_raw_size != expected_raw_size:
                    raise RuntimeError(
                        f"capteur détecté incompatible avec le profil {self.sensor!r} : "
                        f"RAW attendu {expected_raw_size}, négocié {negotiated_raw_size} "
                        "— vérifie le capteur branché et l'overlay dtoverlay actif"
                    )
                fd = self._frame_duration_us(self.exposure_us)
                self._picam2.set_controls({
                    "AnalogueGain": self.gain,
                    "ExposureTime": self.exposure_us,
                    "FrameDurationLimits": (fd, fd),
                    "AeEnable": False,
                    "AwbEnable": False,
                    "ColourGains": (self.wb_red, self.wb_blue),
                    "Contrast":   self.contrast,
                    "Sharpness":  self.sharpness,
                    "Saturation": self.saturation,
                    "Brightness": self.brightness,
                    "NoiseReductionMode": self.noise_reduction,
                })
                self._picam2.start()
                log.info("Camera opened mode=%s gain=%.1f exposure_us=%d", self.raw_mode, self.gain, self.exposure_us)
            except Exception:
                # Never leave a half-configured Picamera2 behind — status()
                # reports "open" from `self._picam2 is not None`, and a stale
                # reference here would claim the camera is open when it isn't.
                if self._picam2 is not None:
                    try:
                        self._picam2.close()
                    except Exception:
                        pass
                    self._picam2 = None
                raise

    def close(self) -> None:
        with self._lock:
            if self._picam2:
                self._picam2.stop()
                self._picam2.close()
                self._picam2 = None
                log.info("Camera closed")

    def set_gain(self, gain: float) -> None:
        with self._lock:
            self.gain = max(1.0, min(self.profile.gain_max, gain))
            if self._picam2:
                self._picam2.set_controls({"AnalogueGain": self.gain})
        self._persist()
        log.info("Gain set to %.2f", self.gain)

    def set_gain_transient(self, gain: float) -> float:
        """Apply gain to the sensor without updating self.gain or persisting.
        Used by timelapse auto-gain so restore_preview_settings recovers the original value."""
        clamped = max(1.0, min(self.profile.gain_max, gain))
        with self._lock:
            if self._picam2:
                self._picam2.set_controls({"AnalogueGain": clamped})
        return clamped

    def set_mode(self, name: str) -> None:
        """Switch the active raw/main sensor mode (crop size + binning)."""
        self.profile.get_raw_mode(name)  # raises ValueError if unknown
        with self._lock:
            self.raw_mode = name
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
        log.info("Raw mode set to %s", self.raw_mode)

    def set_isp_controls(
        self,
        contrast: float,
        sharpness: float,
        saturation: float,
        brightness: float,
        noise_reduction: int,
    ) -> None:
        with self._lock:
            self.contrast = max(0.0, min(32.0, contrast))
            self.sharpness = max(0.0, min(16.0, sharpness))
            self.saturation = max(0.0, min(32.0, saturation))
            self.brightness = max(-1.0, min(1.0, brightness))
            self.noise_reduction = max(0, min(3, noise_reduction))
            if self._picam2:
                self._picam2.set_controls({
                    "Contrast":   self.contrast,
                    "Sharpness":  self.sharpness,
                    "Saturation": self.saturation,
                    "Brightness": self.brightness,
                    "NoiseReductionMode": self.noise_reduction,
                })
        self._persist()
        log.info("ISP controls: contrast=%.1f sharpness=%.1f saturation=%.1f brightness=%.2f NR=%d",
                 self.contrast, self.sharpness, self.saturation, self.brightness, self.noise_reduction)

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
            self.exposure_us = int(max(0.1, min(120000.0, ms)) * 1000)
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
            exp_us = int(max(0.1, min(120000.0, exposure_ms)) * 1000)
            fd = self._frame_duration_us(exp_us)
            p.set_controls({
                "AnalogueGain": max(1.0, min(self.profile.gain_max, gain)),
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
        return self._apply_width_crop(arrays[0])

    def capture_frame_with_settings(self, gain: float, exposure_ms: float) -> Any:
        """Capture one frame with temporary settings, then restore preview settings."""
        with self._lock:
            if not self._picam2:
                raise RuntimeError("Camera not open")
            p = self._picam2
            exp_us = int(max(0.1, min(120000.0, exposure_ms)) * 1000)
            fd = self._frame_duration_us(exp_us)
            p.set_controls({
                "AnalogueGain": max(1.0, min(self.profile.gain_max, gain)),
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

    def capture_frame_full_res(self) -> Any:
        """Capture one ISP-processed frame at the sensor's native resolution.

        The live "main" stream is kept small (preview resolution) so it stays
        cheap to JPEG-encode continuously — see the preview capture loop.
        A single still capture can afford the cost of a real reconfigure:
        stop, switch "main" to the full native size, capture, then switch
        back. This briefly interrupts the live preview (~1-2s).
        """
        with self._lock:
            if not self._picam2:
                raise RuntimeError("Camera not open")
            p = self._picam2
            preview_config = self._make_config()
            full_config = self._full_res_config(buffer_count=2)
            fd = self._frame_duration_us(self.exposure_us)
            controls = {
                "AnalogueGain": self.gain,
                "ExposureTime": self.exposure_us,
                "FrameDurationLimits": (fd, fd),
                "AeEnable": False,
                "AwbEnable": False,
                "ColourGains": (self.wb_red, self.wb_blue),
                "Contrast":   self.contrast,
                "Sharpness":  self.sharpness,
                "Saturation": self.saturation,
                "Brightness": self.brightness,
                "NoiseReductionMode": self.noise_reduction,
            }
            p.stop()
            try:
                p.configure(full_config)
                p.set_controls(controls)
                p.start()
                p.capture_array("main")  # discard — let the new mode settle
                frame = p.capture_array("main")
            finally:
                # Must always leave the camera back in its preview config,
                # started — a bare `stop()`/`configure()` sequence without
                # this guarantee left the camera frozen (no exception, just
                # a stuck preview) the one time the full-res reconfigure hit
                # the CMA allocation issue mid-capture.
                try:
                    p.stop()
                    p.configure(preview_config)
                    p.set_controls(controls)
                    p.start()
                except Exception:
                    # The restore attempt hit the same CMA exhaustion right
                    # after the first failure — a further in-process retry
                    # just cascades (confirmed: buffers from a failed
                    # configure() aren't released until the process exits).
                    # Mark the camera as closed so status()/preview honestly
                    # report it as unavailable instead of silently freezing
                    # with a half-broken but "open" camera — only a full
                    # service restart can recover from here.
                    log.error("Camera restore-after-failure also failed — marking camera closed")
                    try:
                        p.close()
                    except Exception:
                        pass
                    self._picam2 = None
        return frame

    def apply_timelapse_settings(self) -> None:
        """Confirm stored settings are active on the sensor (drain pipeline).

        Captures at whatever raw_mode is currently selected — same as the
        live preview and raw_fits, no separate reconfigure. Previously this
        forced a jump to the sensor's true native resolution for isp_jpeg/
        isp_png sessions (independent of the selected mode), from back when
        "main" was always a small fixed size; now that "main" already mirrors
        the selected raw_mode (which can itself be "native" if that's what's
        wanted), forcing that extra reconfigure was both redundant and the
        single heaviest CMA allocation the app could make, causing spurious
        "Cannot allocate memory" failures on isp_jpeg timelapses while
        raw_fits (which never reconfigured) kept working fine.
        """
        with self._lock:
            if not self._picam2:
                raise RuntimeError("Camera not open")
            p = self._picam2
            exp_us = self.exposure_us
            fd = self._frame_duration_us(exp_us)
            p.set_controls({
                "AnalogueGain": self.gain,
                "ExposureTime": exp_us,
                "FrameDurationLimits": (fd, fd),
                "Contrast":   self.contrast,
                "Sharpness":  self.sharpness,
                "Saturation": self.saturation,
                "Brightness": self.brightness,
                "ColourGains": (self.wb_red, self.wb_blue),
                "NoiseReductionMode": self.noise_reduction,
            })
        tolerance = max(500, exp_us // 20)
        actual = 0
        for attempt in range(8):
            _, meta = p.capture_arrays(["raw"])
            actual = meta.get("ExposureTime", 0)
            if abs(actual - exp_us) <= tolerance:
                log.info(
                    "Timelapse settings confirmed after %d discard(s): "
                    "requested=%d µs actual=%d µs",
                    attempt + 1, exp_us, actual,
                )
                break
        else:
            log.warning(
                "Timelapse settings not confirmed after 8 frames "
                "(requested=%d µs, last actual=%d µs) — proceeding anyway",
                exp_us, actual,
            )

    def restore_preview_settings(self) -> None:
        """Restore persistent preview settings after a sequence or timelapse."""
        with self._lock:
            if not self._picam2:
                return
            p = self._picam2
            fd = self._frame_duration_us(self.exposure_us)
            p.set_controls({
                "AnalogueGain": self.gain,
                "ExposureTime": self.exposure_us,
                "FrameDurationLimits": (fd, fd),
                "Contrast":   self.contrast,
                "Sharpness":  self.sharpness,
                "Saturation": self.saturation,
                "Brightness": self.brightness,
                "ColourGains": (self.wb_red, self.wb_blue),
                "NoiseReductionMode": self.noise_reduction,
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
        return self._apply_width_crop(arrays[0]), metadata

    def capture_frame(self) -> Any:
        with self._lock:
            if not self._picam2:
                raise RuntimeError("Camera not open")
            p = self._picam2
        return p.capture_array("main")

    def status(self) -> dict[str, Any]:
        return {
            "sensor": self.sensor,
            "gain": self.gain,
            "gain_max": self.profile.gain_max,
            "exposure_us": self.exposure_us,
            "exposure_ms": self.exposure_us / 1000,
            "raw_mode": self.raw_mode,
            "raw_modes": [m.name for m in self.profile.raw_modes],
            # Dimensions livrées de chaque mode (Live Stack : choix du mode et du ROI)
            "raw_modes_info": [
                {"name": m.name, "width": m.delivered_size[0], "height": m.delivered_size[1],
                 "binned": m.binned, "bits": bits_from_format(m.format)}
                for m in self.profile.raw_modes
            ],
            "raw_size": list(self.raw_size),
            "wb_red": self.wb_red,
            "wb_blue": self.wb_blue,
            "contrast": self.contrast,
            "sharpness": self.sharpness,
            "saturation": self.saturation,
            "brightness": self.brightness,
            "noise_reduction": self.noise_reduction,
            "open": self._picam2 is not None,
        }

    def _persist(self) -> None:
        state = read_state()
        state.update({
            "gain": self.gain,
            "exposure_us": self.exposure_us,
            "raw_mode": self.raw_mode,
            "wb_red": self.wb_red,
            "wb_blue": self.wb_blue,
            "contrast": self.contrast,
            "sharpness": self.sharpness,
            "saturation": self.saturation,
            "brightness": self.brightness,
            "noise_reduction": self.noise_reduction,
        })
        write_state(state)
