"""MPU6050 reader + Mahony filter → ZXY Euler angles (W3C DeviceOrientation convention)."""
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
import smbus2

log = logging.getLogger(__name__)

# MPU6050 registers
_ADDR        = 0x68
_PWR_MGMT_1  = 0x6B
_ACCEL_OUT   = 0x3B   # 6 bytes: AX_H AX_L AY_H AY_L AZ_H AZ_L
_GYRO_OUT    = 0x43   # 6 bytes: GX_H GX_L GY_H GY_L GZ_H GZ_L
_ALL_OUT     = 0x3B   # 14 bytes: accel(6) + temp(2) + gyro(6)

_ACCEL_SCALE = 16384.0   # ±2g → LSB/g
_GYRO_SCALE  = 131.0     # ±250°/s → LSB/°/s
_DEG2RAD     = math.pi / 180.0
_G           = 9.80665

_CAL_FILE      = Path("/home/admin/.config/minicam/imu_cal.json")
_CAL_SUBSAMPLE = 10    # 1 sample per 10 ticks → 5 Hz at 50 Hz loop
_CAL_MAX       = 500   # cap sample buffer
_CAL_MIN       = 50    # minimum samples required to fit


def _s16(hi: int, lo: int) -> int:
    v = (hi << 8) | lo
    return v - 65536 if v >= 32768 else v


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


class MPU6050:
    def __init__(self, bus: int = 1, addr: int = _ADDR) -> None:
        self._bus  = smbus2.SMBus(bus)
        self._addr = addr
        self._bus.write_byte_data(addr, _PWR_MGMT_1, 0x00)   # wake up
        time.sleep(0.1)

    def read(self) -> tuple[np.ndarray, np.ndarray]:
        """Return (accel m/s², gyro rad/s) in sensor frame."""
        d = self._bus.read_i2c_block_data(self._addr, _ALL_OUT, 14)
        ax = _s16(d[0],  d[1])  / _ACCEL_SCALE * _G
        ay = _s16(d[2],  d[3])  / _ACCEL_SCALE * _G
        az = _s16(d[4],  d[5])  / _ACCEL_SCALE * _G
        # d[6], d[7] = temperature, skipped
        gx = _s16(d[8],  d[9])  / _GYRO_SCALE * _DEG2RAD
        gy = _s16(d[10], d[11]) / _GYRO_SCALE * _DEG2RAD
        gz = _s16(d[12], d[13]) / _GYRO_SCALE * _DEG2RAD
        return np.array([ax, ay, az]), np.array([gx, gy, gz])


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


class IMUStreamer:
    """Reads MPU6050 at FREQ Hz, runs Mahony, broadcasts Euler angles to callbacks."""

    FREQ = 50  # Hz

    def __init__(self) -> None:
        self._callbacks: list[Callable[[float, float, float], None]] = []
        self._lock      = threading.Lock()
        self._stop      = threading.Event()
        self._thread: threading.Thread | None = None
        self.alpha: float = 0.0
        self.beta:  float = 0.0
        self.gamma: float = 0.0
        self.q: list[float] = [1.0, 0.0, 0.0, 0.0]  # [w,x,y,z] latest quaternion
        self.running: bool = False
        self.session_id: str = uuid.uuid4().hex   # unique per Mahony filter lifetime

        # Accelerometer calibration (ellipsoid)
        self._cal_lock       = threading.Lock()
        self._cal_offset     = np.zeros(3)
        self._cal_scale      = np.ones(3)
        self._cal_collecting = False
        self._cal_samples: list[np.ndarray] = []
        self._cal_tick       = 0
        self.load_calibration()

        # Inclinometer calibration — raw-acc burst capture
        self._raw_lock = threading.Lock()
        self._raw_buf:  list[np.ndarray] = []
        self._raw_need: int = 0
        self._raw_evt   = threading.Event()

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
        # Fit outside lock — may raise ValueError on bad data
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

    # ------------------------------------------------------------------
    # Inclinometer calibration API
    # ------------------------------------------------------------------

    def incl_capture_start(self, n: int = 75) -> None:
        """Start collecting n raw acc samples (≈1.5 s at 50 Hz)."""
        with self._raw_lock:
            self._raw_buf  = []
            self._raw_need = n
            self._raw_evt.clear()

    def incl_capture_wait(self, timeout: float = 6.0) -> np.ndarray:
        """Block until n samples collected; return mean raw acc [3]."""
        if not self._raw_evt.wait(timeout=timeout):
            raise TimeoutError(f"Inclinometer capture timed out after {timeout} s")
        with self._raw_lock:
            arr = np.array(self._raw_buf, dtype=float)
            self._raw_need = 0   # stop collecting — avoids lock churn at 50 Hz
        return arr.mean(axis=0)

    def apply_calibration(self, offset: list, scale: list) -> None:
        """Apply and persist a calibration (offset + scale per axis)."""
        with self._cal_lock:
            self._cal_offset = np.array(offset, dtype=float)
            self._cal_scale  = np.array(scale,  dtype=float)
        self.save_calibration()
        log.info("IMU incl cal applied: offset=%s scale=%s", self._cal_offset, self._cal_scale)

    def restart_filter(self) -> None:
        """Restart the IMU loop: resets Mahony integral + re-calibrates gyro bias.

        Must be called after applying inclinometer calibration — the Mahony
        integral (kI) was trained on the old accelerometer readings and would
        otherwise over-correct the gyroscope for ~200 s causing yaw drift.
        Blocks until the new loop has started (~2 s for gyro bias calibration).
        """
        log.info("IMU: restarting filter (Mahony integral reset)…")
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
        log.info("IMU: filter restarted, new session %s", self.session_id[:8])

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
        try:
            mpu = MPU6050()
        except Exception as exc:
            log.error("IMU: MPU6050 init failed — %s", exc)
            return

        try:
            import ahrs
            # kI=0.01: time constant ~100 s — enough to track slow gyro temperature drift
            # while staying conservative (kP=2.0 >> 2*kI=0.02 → well within stability margin)
            filt = ahrs.filters.Mahony(frequency=float(self.FREQ), kP=2.0, kI=0.01)
        except Exception as exc:
            log.error("IMU: Mahony init failed — %s", exc)
            return

        q   = np.array([1.0, 0.0, 0.0, 0.0])
        dt  = 1.0 / self.FREQ

        # Calibrate gyro bias: average 300 samples at rest (~6 s)
        # More samples → lower standard error on bias estimate, especially for Z
        # (yaw axis: no accelerometer correction, only kI can compensate residual bias)
        CALIB_N = 300
        gyr_bias = np.zeros(3)
        for _ in range(CALIB_N):
            _, gyr = mpu.read()
            gyr_bias += gyr
            time.sleep(dt)
        gyr_bias /= CALIB_N
        log.info("IMU gyro bias calibrated: [%.4f, %.4f, %.4f] rad/s", *gyr_bias)
        log.info("IMU remap v7: acc_f=[Y,-X,Z]  gyr_f=[Y,-X,Z]  (filter-Y=-phys-X → beta=+90 at zenith)")

        _dbg_counter  = 0
        _static_ticks = 0   # for periodic static log

        log.info("IMU loop started @ %d Hz", self.FREQ)

        while not self._stop.is_set():
            t0 = time.monotonic()
            try:
                acc, gyr = mpu.read()
                gyr -= gyr_bias

                # Collect raw sample for ellipsoid calibration if active
                if self._cal_collecting:
                    self._cal_tick += 1
                    if self._cal_tick % _CAL_SUBSAMPLE == 0:
                        with self._cal_lock:
                            if len(self._cal_samples) < _CAL_MAX:
                                self._cal_samples.append(acc.copy())

                # Collect raw sample for inclinometer calibration if active
                with self._raw_lock:
                    if self._raw_need > 0 and len(self._raw_buf) < self._raw_need:
                        self._raw_buf.append(acc.copy())
                        if len(self._raw_buf) >= self._raw_need:
                            self._raw_evt.set()

                # Apply accelerometer calibration (identity until calibrated)
                with self._cal_lock:
                    cal_offset = self._cal_offset.copy()
                    cal_scale  = self._cal_scale.copy()
                acc = (acc - cal_offset) * cal_scale

                # Physical layout (confirmed by gravity measurement):
                #   phys-X = optical axis  → acc[0] = g·sin(elev), zero when horizontal
                #   phys-Y = altitude trunnion (always horizontal) → acc[1] ≈ 0
                #   phys-Z = up when horizontal (vertical/gravity) → acc[2] = g·cos(elev)
                #
                # Remap so Mahony sees gravity on filter-Z and altitude rotation on filter-X:
                #   filter-X = phys-Y (altitude trunnion → beta = elevation)
                #   filter-Y = -phys-X (optical axis negated → Mahony beta goes +90° at zenith)
                #   filter-Z = phys-Z (up-when-horizontal → gravity anchor → alpha = azimuth)
                # acc_f[1] = -acc[0]: gravity moves toward -filter-Y as tube rises,
                #   giving beta = R_x(+90°) = +90° at zenith (not -90°).
                acc_f = np.array([ acc[1], -acc[0],  acc[2]])
                gyr_f = np.array([ gyr[1], -gyr[0],  gyr[2]])

                # ── Debug: dominant gyro axis during movement (≥6°/s) ──────────────
                _AXES = ('X', 'Y', 'Z')
                _DBG_THRESH = 0.10   # rad/s ≈ 6°/s
                moving = np.max(np.abs(gyr)) > _DBG_THRESH
                if moving:
                    _dbg_counter += 1
                    _static_ticks = 0
                    if _dbg_counter % 5 == 0:   # throttle: ~10 Hz at 50 Hz loop
                        dom_raw = int(np.argmax(np.abs(gyr)))
                        dom_f   = int(np.argmax(np.abs(gyr_f)))
                        alpha_d, beta_d, gamma_d = _quat_to_euler_zxy(q)
                        print(
                            f"[IMU-MOV] phys {_AXES[dom_raw]}={gyr[dom_raw]*180/math.pi:+.0f}°/s"
                            f"  →  filter-{_AXES[dom_f]}={gyr_f[dom_f]*180/math.pi:+.0f}°/s"
                            f"  | α={alpha_d:.1f}° β(elev)={beta_d:.1f}° γ={gamma_d:.1f}°"
                            f"  | acc=[{acc[0]/_G:+.2f}g,{acc[1]/_G:+.2f}g,{acc[2]/_G:+.2f}g]",
                            flush=True,
                        )
                else:
                    _dbg_counter = 0
                    _static_ticks += 1
                    # Log static orientation + gravity every 2 s to confirm remap
                    if _static_ticks % (self.FREQ * 2) == 0:
                        alpha_s, beta_s, gamma_s = _quat_to_euler_zxy(q)
                        dom_acc = int(np.argmax(np.abs(acc)))
                        print(
                            f"[IMU-STAT] α={alpha_s:.1f}° β(elev)={beta_s:.1f}° γ={gamma_s:.1f}°"
                            f"  | acc=[{acc[0]/_G:+.2f}g,{acc[1]/_G:+.2f}g,{acc[2]/_G:+.2f}g]"
                            f"  dominant=phys-{_AXES[dom_acc]}",
                            flush=True,
                        )

                q = filt.updateIMU(q, gyr_f, acc_f)
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
            except Exception as exc:
                log.warning("IMU read error: %s", exc)

            elapsed = time.monotonic() - t0
            rem = dt - elapsed
            if rem > 0:
                time.sleep(rem)

        log.info("IMU loop stopped")
