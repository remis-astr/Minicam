#!/usr/bin/env python3
"""Phase 1 — validation capteur IMX462.

Teste : capture RAW12, plage gain, plage exposition, framerate preview 720p.
Usage : python3 validate_sensor.py [--output /tmp/frames]
"""

import argparse
import logging
import time
from pathlib import Path

import numpy as np
from picamera2 import Picamera2

logging.basicConfig(
    level=logging.INFO,
    format='{"ts":"%(asctime)s","level":"%(levelname)s","msg":"%(message)s"}',
)
log = logging.getLogger("validate_sensor")


def capture_raw(picam2: Picamera2, output_dir: Path, gain: float, exposure_us: int) -> np.ndarray:
    config = picam2.create_still_configuration(
        raw={"format": "SRGGB12_CSI2P", "size": (1920, 1080)},
        display=None,
    )
    picam2.configure(config)
    picam2.set_controls({"AnalogueGain": gain, "ExposureTime": exposure_us})
    picam2.start()
    time.sleep(0.5)
    buffers, metadata = picam2.capture_arrays(["raw"])
    picam2.stop()

    raw = buffers[0]
    path = output_dir / f"raw_g{gain:.0f}_e{exposure_us}.npy"
    np.save(path, raw)
    log.info(f"RAW sauvegardé : {path}  shape={raw.shape}  dtype={raw.dtype}  "
             f"min={raw.min()}  max={raw.max()}  "
             f"exp_réel={metadata.get('ExposureTime')}µs  gain_réel={metadata.get('AnalogueGain'):.2f}")
    return raw


def measure_fps(picam2: Picamera2, duration: float = 5.0) -> float:
    config = picam2.create_video_configuration(
        main={"format": "YUV420", "size": (1280, 720)},
        display=None,
    )
    picam2.configure(config)
    picam2.set_controls({"AnalogueGain": 1.0, "ExposureTime": 10000})

    count = 0
    t0 = time.monotonic()
    picam2.start()
    while time.monotonic() - t0 < duration:
        picam2.capture_array("main")
        count += 1
    picam2.stop()

    fps = count / duration
    log.info(f"Framerate 720p YUV420 : {fps:.1f} fps sur {duration:.0f} s ({count} frames)")
    return fps


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", default="/tmp/minicam_validate", type=Path)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)

    picam2 = Picamera2()
    log.info(f"Capteur détecté : {picam2.camera_properties.get('Model', '?')}")

    log.info("=== Test 1 : capture RAW12 gain min, expo courte ===")
    capture_raw(picam2, args.output, gain=1.0, exposure_us=1000)

    log.info("=== Test 2 : capture RAW12 gain max (~30 dB ≈ x32) ===")
    capture_raw(picam2, args.output, gain=32.0, exposure_us=1000)

    log.info("=== Test 3 : exposition longue 10 s ===")
    capture_raw(picam2, args.output, gain=4.0, exposure_us=10_000_000)

    log.info("=== Test 4 : framerate preview 720p ===")
    measure_fps(picam2, duration=5.0)

    log.info(f"Frames sauvegardées dans {args.output}")
    log.info("Validation Phase 1 terminée.")


if __name__ == "__main__":
    main()
