"""BNO085 reader → ZXY Euler angles (W3C DeviceOrientation convention).

The BNO085 runs internal sensor fusion (Game Rotation Vector at ~100 Hz).
Quaternions are read directly — no external Mahony filter needed.
"""
from __future__ import annotations

import json
import logging
import math
import threading
import time
import uuid
from pathlib import Path
from typing import Callable

import numpy as np

log = logging.getLogger(__name__)

_ADDR = 0x4A   # ADR pin → GND
_G    = 9.80665

_CAL_FILE      = Path("/home/admin/.config/minicam/imu_cal.json")
_CAL_SUBSAMPLE = 10
_CAL_MAX       = 500
_CAL_MIN       = 50

_INIT_RETRY_DELAYS = (5, 10, 30, 60)  # seconds between successive init attempts

# Mount orientation correction [w,x,y,z] — compensates for PCB orientation on scope.
# Identity = no correction. Adjust empirically after first run by comparing
# β(elev) direction against known sky objects.
_MOUNT_QUAT = np.array([1.0, 0.0, 0.0, 0.0])


def _fit_accel_calibration(samples: np.ndarray) -> tuple[np.ndarray, np.ndarray, float]:
    """Diagonal ellipsoid fit on raw accelerometer samples (N, 3).

    Solves: A·x² + B·y² + C·z² + D·x + E·y + F·z = 1  (least squares)
    Returns (offset (3,), scale (3,), rms_mg) such that
      a_cal = (a_raw - offset) * scale  →  ||a_cal|| ≈ g
    """
    if len(samples) < _CAL_MIN:
        raise ValueError(f"need ≥{_CAL_MIN} samples, got {len(samples)}")
    spans = np.ptp(samples, axis=0)
    if np.any(spans < 0.5 * _G):
        raise ValueError(
            f"insufficient coverage — axis spans (m/s²): {spans.round(2)}. "
            "Move the scope to more diverse altitudes and azimuths."
        )
    x, y, z = samples[:, 0], samples[:, 1], samples[:, 2]
    D_mat = np.column_stack([x**2, y**2, z**2, x, y, z])
    v, *_ = np.linalg.lstsq(D_mat, np.ones(len(samples)), rcond=None)
    pA, pB, pC, pD, pE, pF = v
    offset = np.array([-pD / (2.0 * pA), -pE / (2.0 * pB), -pF / (2.0 * pC)])
    k      = 1.0 + pD**2 / (4.0 * pA) + pE**2 / (4.0 * pB) + pF**2 / (4.0 * pC)
    scale  = _G * np.sqrt(np.abs([pA, pB, pC]) / k)
    a_cal  = (samples - offset) * scale
    rms_mg = float(np.sqrt(np.mean((np.linalg.norm(a_cal, axis=1) - _G) ** 2)) / _G * 1000)
    return offset, scale, rms_mg


def _quat_to_euler_zxy(q: np.ndarray) -> tuple[float, float, float]:
    """Quaternion [w,x,y,z] → ZXY Euler (W3C DeviceOrientation) in degrees.

    alpha = yaw  (Z, 0–360°)
    beta  = pitch (X, −180–180°)
    gamma = roll  (Y, −90–90°)
    """
    w, x, y, z = q
    beta  = math.degrees(math.asin(max(-1.0, min(1.0, 2.0 * (w*x + y*z)))))
    alpha = math.degrees(math.atan2(2.0*(w*z - x*y), 1.0 - 2.0*(x*x + z*z))) % 360.0
    gamma = math.degrees(math.atan2(2.0*(w*y - x*z), 1.0 - 2.0*(x*x + y*y)))
    return alpha, beta, gamma


def _quat_mul(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """Hamilton product of two quaternions [w,x,y,z]."""
    w1, x1, y1, z1 = a
    w2, x2, y2, z2 = b
    return np.array([
        w1*w2 - x1*x2 - y1*y2 - z1*z2,
        w1*x2 + x1*w2 + y1*z2 - z1*y2,
        w1*y2 - x1*z2 + y1*w2 + z1*x2,
        w1*z2 + x1*y2 - y1*x2 + z1*w2,
    ])


class IMUStreamer:
    """Reads BNO085 Game Rotation Vector and broadcasts ZXY Euler angles to callbacks."""

    FREQ = 100  # Hz — matches BNO085 native Game RV output rate

    def __init__(self) -> None:
        self._callbacks: list[Callable[[float, float, float], None]] = []
        self._lock      = threading.Lock()
        self._stop      = threading.Event()
        self._thread: threading.Thread | None = None
        self.alpha: float = 0.0
        self.beta:  float = 0.0
        self.gamma: float = 0.0
        self.q: list[float] = [1.0, 0.0, 0.0, 0.0]
        self.running: bool = False
        self.session_id: str = uuid.uuid4().hex

        self._cal_lock       = threading.Lock()
        self._cal_offset     = np.zeros(3)
        self._cal_scale      = np.ones(3)
        self._cal_collecting = False
        self._cal_samples: list[np.ndarray] = []
        self._cal_tick       = 0
        self.load_calibration()

    # ------------------------------------------------------------------
    def start(self) -> None:
        if self.running:
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, daemon=True, name="imu-loop")
        self._thread.start()
        self.running = True

    def stop(self) -> None:
        self._stop.set()
        self.running = False

    def add_callback(self, cb: Callable[[float, float, float], None]) -> None:
        with self._lock:
            self._callbacks.append(cb)

    def remove_callback(self, cb: Callable[[float, float, float], None]) -> None:
        with self._lock:
            try:
                self._callbacks.remove(cb)
            except ValueError:
                pass

    # ------------------------------------------------------------------
    # Calibration API
    # ------------------------------------------------------------------

    def load_calibration(self) -> bool:
        if not _CAL_FILE.exists():
            return False
        try:
            d = json.loads(_CAL_FILE.read_text())
            with self._cal_lock:
                self._cal_offset = np.array(d["offset"], dtype=float)
                self._cal_scale  = np.array(d["scale"],  dtype=float)
            log.info("IMU cal loaded: offset=%s scale=%s", self._cal_offset, self._cal_scale)
            return True
        except Exception as exc:
            log.warning("IMU cal load failed: %s", exc)
            return False

    def save_calibration(self) -> None:
        _CAL_FILE.parent.mkdir(parents=True, exist_ok=True)
        with self._cal_lock:
            d = {"offset": self._cal_offset.tolist(), "scale": self._cal_scale.tolist()}
        _CAL_FILE.write_text(json.dumps(d, indent=2))
        log.info("IMU cal saved to %s", _CAL_FILE)

    def calibration_start(self) -> None:
        with self._cal_lock:
            self._cal_samples = []
            self._cal_tick    = 0
            self._cal_collecting = True
        log.info("IMU calibration collection started")

    def calibration_finish(self) -> dict:
        with self._cal_lock:
            self._cal_collecting = False
            samples = np.array(self._cal_samples) if self._cal_samples else np.zeros((0, 3))
        offset, scale, rms_mg = _fit_accel_calibration(samples)
        with self._cal_lock:
            self._cal_offset = offset
            self._cal_scale  = scale
        self.save_calibration()
        log.info("IMU cal applied: offset=%s scale=%s rms=%.1f mg", offset, scale, rms_mg)
        return {
            "offset":    offset.tolist(),
            "scale":     scale.tolist(),
            "rms_mg":    round(rms_mg, 1),
            "n_samples": len(samples),
        }

    def restart_filter(self) -> None:
        """Restart the IMU loop and issue a new session ID.

        Forces WS clients to re-sync (session_id change).
        Much faster than MPU6050 version — no gyro bias calibration delay.
        """
        log.info("IMU: restarting…")
        self._stop.set()
        self.running = False
        if self._thread:
            self._thread.join(timeout=5.0)
        self._stop.clear()
        self.q          = [1.0, 0.0, 0.0, 0.0]
        self.session_id = uuid.uuid4().hex
        self._thread = threading.Thread(target=self._loop, daemon=True, name="imu-loop")
        self._thread.start()
        self.running = True
        log.info("IMU: restarted, new session %s", self.session_id[:8])

    def calibration_reset(self) -> None:
        with self._cal_lock:
            self._cal_offset     = np.zeros(3)
            self._cal_scale      = np.ones(3)
            self._cal_collecting = False
            self._cal_samples    = []
        _CAL_FILE.unlink(missing_ok=True)
        log.info("IMU calibration reset to identity")

    def calibration_status(self) -> dict:
        with self._cal_lock:
            has_cal = bool(
                np.any(self._cal_scale != 1.0) or np.any(self._cal_offset != 0.0)
            )
            return {
                "collecting":       self._cal_collecting,
                "n_samples":        len(self._cal_samples),
                "has_calibration":  has_cal,
                "offset":           self._cal_offset.tolist(),
                "scale":            self._cal_scale.tolist(),
            }

    # ------------------------------------------------------------------
    def _loop(self) -> None:
        from adafruit_bno08x import BNO_REPORT_ACCELEROMETER, BNO_REPORT_GAME_ROTATION_VECTOR
        from adafruit_bno08x.i2c import BNO08X_I2C
        from adafruit_extended_bus import ExtendedI2C

        # Retry init with backoff — BNO085 may not be ready immediately after boot
        # or may be temporarily unreachable (power glitch, I2C reset).
        bno = None
        for attempt, delay in enumerate((*_INIT_RETRY_DELAYS, None), start=1):
            if self._stop.is_set():
                return
            try:
                # Bus 8 = software I2C (i2c-gpio overlay, GPIO2/GPIO3).
                # Handles BNO085 clock stretching that BCM2835 hardware I2C cannot tolerate.
                i2c = ExtendedI2C(8)
                bno = BNO08X_I2C(i2c, address=_ADDR)
                bno.enable_feature(BNO_REPORT_GAME_ROTATION_VECTOR)
                bno.enable_feature(BNO_REPORT_ACCELEROMETER)
                break
            except Exception as exc:
                if delay is None:
                    log.error("IMU: BNO085 init failed after %d attempts — giving up: %s", attempt, exc)
                    return
                log.warning("IMU: BNO085 init attempt %d failed (%s) — retry in %ds", attempt, exc, delay)
                self._stop.wait(delay)

        dt = 1.0 / self.FREQ
        log.info("IMU loop started @ %d Hz (BNO085 Game Rotation Vector)", self.FREQ)

        _static_ticks = 0

        while not self._stop.is_set():
            t0 = time.monotonic()
            try:
                # --- Quaternion (Game Rotation Vector) ---
                raw = bno.game_quaternion   # (i, j, k, real) or None if no new packet yet
                if raw is not None:
                    qi, qj, qk, qr = raw
                    # Adafruit returns (i,j,k,real) — convert to [w,x,y,z]
                    q_sensor = np.array([qr, qi, qj, qk])
                    # Apply mount rotation: q_world = _MOUNT_QUAT ⊗ q_sensor
                    q = _quat_mul(_MOUNT_QUAT, q_sensor)
                    norm = np.linalg.norm(q)
                    if norm > 1e-9:
                        q /= norm

                    alpha, beta, gamma = _quat_to_euler_zxy(q)
                    self.alpha, self.beta, self.gamma = alpha, beta, gamma
                    self.q = q.tolist()

                    with self._lock:
                        cbs = list(self._callbacks)
                    for cb in cbs:
                        try:
                            cb(alpha, beta, gamma)
                        except Exception:
                            pass

                    _static_ticks += 1
                    if _static_ticks % (self.FREQ * 2) == 0:
                        log.debug(
                            "IMU α=%.1f° β=%.1f° γ=%.1f°  q=[%.3f,%.3f,%.3f,%.3f]",
                            alpha, beta, gamma, *q,
                        )

                # --- Accelerometer (for ellipsoid calibration) ---
                acc_raw = bno.acceleration   # (x, y, z) m/s² or None
                if acc_raw is not None and self._cal_collecting:
                    acc = np.array(acc_raw)
                    self._cal_tick += 1
                    if self._cal_tick % _CAL_SUBSAMPLE == 0:
                        with self._cal_lock:
                            if len(self._cal_samples) < _CAL_MAX:
                                self._cal_samples.append(acc.copy())

            except Exception as exc:
                log.warning("IMU read error: %s", exc)

            elapsed = time.monotonic() - t0
            rem = dt - elapsed
            if rem > 0:
                time.sleep(rem)

        log.info("IMU loop stopped")
