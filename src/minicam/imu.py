"""MPU6050 reader + Madgwick filter → ZXY Euler angles (W3C DeviceOrientation convention)."""
from __future__ import annotations

import logging
import math
import threading
import time
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


def _s16(hi: int, lo: int) -> int:
    v = (hi << 8) | lo
    return v - 65536 if v >= 32768 else v


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
    """Reads MPU6050 at FREQ Hz, runs Madgwick, broadcasts Euler angles to callbacks."""

    FREQ = 50  # Hz

    def __init__(self) -> None:
        self._callbacks: list[Callable[[float, float, float], None]] = []
        self._lock      = threading.Lock()
        self._stop      = threading.Event()
        self._thread: threading.Thread | None = None
        self.alpha: float = 0.0
        self.beta:  float = 0.0
        self.gamma: float = 0.0
        self.running: bool = False

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
    def _loop(self) -> None:
        try:
            mpu = MPU6050()
        except Exception as exc:
            log.error("IMU: MPU6050 init failed — %s", exc)
            return

        try:
            import ahrs
            filt = ahrs.filters.Madgwick(frequency=float(self.FREQ), beta=0.033)
        except Exception as exc:
            log.error("IMU: Madgwick init failed — %s", exc)
            return

        q   = np.array([1.0, 0.0, 0.0, 0.0])
        dt  = 1.0 / self.FREQ

        # Calibrate gyro bias: average 100 samples at rest
        CALIB_N = 100
        gyr_bias = np.zeros(3)
        for _ in range(CALIB_N):
            _, gyr = mpu.read()
            gyr_bias += gyr
            time.sleep(dt)
        gyr_bias /= CALIB_N
        log.info("IMU gyro bias calibrated: [%.4f, %.4f, %.4f] rad/s", *gyr_bias)

        # Below this norm the gyro is treated as stationary (prevents accel-noise oscillation)
        GYR_DEADZONE = 0.008  # rad/s ≈ 0.46°/s — well below any intentional movement

        log.info("IMU loop started @ %d Hz", self.FREQ)

        while not self._stop.is_set():
            t0 = time.monotonic()
            try:
                acc, gyr = mpu.read()
                gyr -= gyr_bias
                if np.linalg.norm(gyr) >= GYR_DEADZONE:
                    # MPU mounted Y-up: remap [X,Y,Z] → [X,-Z,Y] so filter's Z
                    # aligns with physical Y (vertical) → alpha = azimuth rotation.
                    acc_f = np.array([ acc[0], -acc[2],  acc[1]])
                    gyr_f = np.array([ gyr[0], -gyr[2],  gyr[1]])
                    q = filt.updateIMU(q, gyr_f, acc_f)
                alpha, beta, gamma = _quat_to_euler_zxy(q)
                self.alpha, self.beta, self.gamma = alpha, beta, gamma
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
