from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class RawMode:
    """One selectable sensor readout mode (drives both the RAW capture and
    the ISP "main" preview/UI stream — they always mirror the same crop).

    `bayer` is the *true* Bayer phase of this mode's output ("RGGB"/"BGGR"/
    "GRBG"/"GBRG", top-left-pixel convention) — kept separate from `format`
    (which only encodes bit depth/packing for picamera2's config request).
    Confirmed on the IMX477 by comparing manually-debayered RAW frames
    against the ISP's own (always correct) debayered output: **every**
    mode on this sensor — binned and non-binned alike — is actually BGGR.
    (An earlier pass at this concluded non-binned was RGGB, from a Python
    test using `cv2.cvtColor(..., cv2.COLOR_BAYER_RG2RGB)` — that was a
    false positive: OpenCV's Bayer code names refer to the *second* row,
    not the first, so `RG` really means standard-convention BGGR and vice
    versa. The JS debayer in cpu_analyze_worker.js does NOT have this
    quirk — its `pattern` ints are plain top-left-pixel convention,
    verified by hand-tracing the neighbor-averaging math — so getting a
    consistent answer required testing patterns 0-3 directly against real
    `/ws/raw` frames rather than trusting the cv2 side. `cv2_bayer_code()`
    in routes_capture.py carries the correction for the Python/FITS path.)
    Getting this wrong doesn't affect the ISP-processed preview/JPEG paths
    (the hardware debayer knows the real pattern regardless of what we
    label it) — only the app's own manual debayering (RAW FITS BAYERPAT
    header, and Lucky Stack's client-side JS debayer) reads this field.
    """
    name: str
    size: tuple[int, int]
    format: str
    binned: bool
    bayer: str = "RGGB"
    # Centered software width-crop applied after capture, on top of `size`
    # (the true sensor/RAW capture size) — for sensors with no hardware
    # width-crop mechanism (see IMX327 below). None means no crop: the
    # delivered size equals `size`. Kept separate from `size` because `size`
    # must exactly match what the sensor negotiates (CameraController.open()
    # asserts this) — a width libcamera can't actually deliver would trip
    # that check.
    crop_width: int | None = None

    @property
    def delivered_size(self) -> tuple[int, int]:
        """RAW/main size as seen by everything downstream of capture (UI,
        FITS header, WS metadata) — `size` narrowed to `crop_width` if set."""
        return (self.crop_width or self.size[0], self.size[1])


@dataclass(frozen=True)
class SensorProfile:
    """Capabilities that differ between camera sensors.

    `raw_modes` lists the selectable fast/cropped RAW readout modes (used by
    the live preview, timelapse, and Lucky Stack) — each entry sizes both
    the RAW capture and the ISP "main" stream identically, since these modes
    are already small enough to stay cheap to JPEG-encode live. `raw_size`
    is the sensor's native full-resolution RAW mode, used only by
    `capture_frame_full_res()` for single still-photo captures — a separate,
    slower path independent of `raw_modes`.
    """
    name: str
    raw_modes: list[RawMode]
    raw_size: tuple[int, int]
    raw_format: str
    gain_max: float
    # /boot/firmware/config.txt overlay line (without the "dtoverlay=" prefix)
    # that loads the kernel driver for this sensor — only takes effect after
    # a full reboot, unlike everything else in this profile.
    dtoverlay: str
    default_noise_reduction: int = 1

    def get_raw_mode(self, name: str) -> RawMode:
        for m in self.raw_modes:
            if m.name == name:
                return m
        raise ValueError(f"mode raw inconnu: {name!r} (attendu: {[m.name for m in self.raw_modes]})")


# Native full res (1920x1080) matches the ISP "main" preview size 1:1 — no
# binning needed, so raw and preview have historically shared one resolution
# table. Gain ceiling of 64x is beyond the AGC tuning file's target range
# (8-12x) but has been used in practice for manual long-exposure astro shots.
#
# "720p" is a stock mode already in the upstream imx290 kernel driver — no
# kernel change needed, included at zero cost (mirrors the imx477 "fast_990"
# case). It does NOT increase frame rate (Sony's own datasheet lists both
# 1080p and 720p drive modes at the same 60fps max — confirmed empirically
# here too), it only reduces pixel count/data volume.
#
# "540p"/"480p" are custom minicam-local data-reduction crop modes (see
# usr/src/imx290-crop/imx290.c). Real hardware crop ("Window Cropping Mode",
# CTRL_07=0x40) turned out to be a dead end on this sensor — a third party
# (Vision Components' vc_mipi_core imx327 notes) confirmed it's a no-op that
# never actually shrinks the output below 1920x1080. What *does* work,
# because it's core, already-relied-upon driver behavior rather than a
# guess: this driver ties VMAX (frame length) directly to the mode's height
# (see imx290_set_ctrl's V4L2_CID_VBLANK case and imx290_start_streaming's
# vblank_min = mode->vmax_min - mode->height) — so a mode table entry with a
# smaller `.height`/`.vmax_min` genuinely reads out fewer rows, and as a
# bonus increases frame rate (measured 112-125fps vs 60fps baseline). Width
# stays 1920 in hardware (no equivalent lever exists for it), so 540p/480p
# additionally use `crop_width` to trim width in software after capture —
# see RawMode.crop_width and CameraController._apply_width_crop. Verified
# on-device: correct centered crop, no corruption, at both hardware sizes.
IMX327 = SensorProfile(
    name="imx327",
    raw_modes=[
        RawMode("1080p", (1920, 1080), "SRGGB12_CSI2P", binned=False),
        RawMode("720p",  (1280, 720),  "SRGGB12_CSI2P", binned=False),
        RawMode("540p",  (1920, 540),  "SRGGB12_CSI2P", binned=False, crop_width=960),
        RawMode("480p",  (1920, 480),  "SRGGB12_CSI2P", binned=False, crop_width=640),
    ],
    raw_size=(1920, 1080),
    raw_format="SRGGB12_CSI2P",
    gain_max=64.0,
    dtoverlay="imx290,clock-frequency=74250000",
)

# Same 1920x1080 2.9µm-pixel family as the IMX327, driven by the very same
# imx290 kernel module (compatible "sony,imx462lqr" — only the global init
# register block differs, imx290_global_init_settings_462). The custom
# 540p/480p entries live in the lane-based mode tables shared by every model
# of that driver, so the patched imx290.ko from usr/src/imx290-crop/ already
# provides them for this sensor too: identical raw_modes, no kernel change.
# Bayer label inherited from the IMX327 — equally unverified on this chip.
IMX462 = SensorProfile(
    name="imx462",
    raw_modes=IMX327.raw_modes,
    raw_size=(1920, 1080),
    raw_format="SRGGB12_CSI2P",
    gain_max=64.0,
    dtoverlay="imx462,clock-frequency=74250000",
)

# Native full res is 4056x3040 (12.3 MP) — far too heavy to JPEG-encode live
# at preview framerate on a Pi Zero 2 W, so the fast raw_modes below stay at
# modest sizes while `raw_size` keeps the full sensor resolution for the
# separate full-res still-capture path. Gain ceiling of 16x matches the
# imx477.json tuning file's AGC gain ceiling (rpi.agc exposure_modes).
#
# raw_modes below are custom "planetary" crop modes added to the imx477
# kernel driver (supported_modes[] in imx477.c) on top of the 5 stock modes
# — centered fixed-position crops, no on-sensor repositioning. Binned
# variants read a 2x-larger analog window and 2x2-bin it down (more light,
# 10-bit); non-binned variants read the output size 1:1 off the sensor
# (native resolution, 12-bit, narrower field of view for the same size).
#
# Non-binned sizes are shifted a few px below their "nominal" resolution
# (1916x1080 not 1920x1080, etc), for two independent reasons discovered
# while bringing these modes up:
#  1. The imx477 driver picks a sensor mode by (width, height) alone
#     (v4l2_find_nearest_size in imx477_set_pad_format) — it ignores the
#     requested pixel format/bit-depth entirely for mode selection, only
#     applying ADBIT_MODE afterwards. A binned and non-binned mode sharing
#     the exact same output size would be indistinguishable to that lookup
#     (always resolving to whichever is first in supported_modes[]
#     regardless of which format was requested), silently pairing the
#     wrong analog crop with the wrong bit depth.
#  2. Separately, the unicam capture node (/dev/video0, downstream of the
#     sensor) silently rounds the negotiated width up to whatever satisfies
#     its own packed-format byte-stride alignment (confirmed via
#     `v4l2-ctl -d /dev/video0 --try-fmt-video=...`) — a width that isn't
#     already a multiple of 4 gets bumped (e.g. 854 -> 856, 1918 -> 1920),
#     which then disagrees with the sensor subdev's own negotiated width
#     and makes libcamera reject the whole configuration outright
#     ("Can't configure camera with invalid configuration").
# Every size below was verified via --try-fmt-video to round-trip exactly
# unchanged (already a multiple of 4) before being wired into the kernel
# module — the couple-px difference from the "nominal" resolution is
# imperceptible for planetary imaging.
#
# "fast_990" is the one stock mode already in the upstream driver — no
# kernel change needed for it, included here at zero cost.
IMX477 = SensorProfile(
    name="imx477",
    raw_modes=[
        RawMode("1080p",         (1916, 1080), "SRGGB12_CSI2P", binned=False, bayer="BGGR"),
        RawMode("1080p_bin",     (1920, 1080), "SRGGB10_CSI2P", binned=True,  bayer="BGGR"),
        RawMode("720p",          (1276, 720),  "SRGGB12_CSI2P", binned=False, bayer="BGGR"),
        RawMode("720p_bin",      (1280, 720),  "SRGGB10_CSI2P", binned=True,  bayer="BGGR"),
        RawMode("480p",          (848, 480),   "SRGGB12_CSI2P", binned=False, bayer="BGGR"),
        RawMode("480p_bin",      (852, 480),   "SRGGB10_CSI2P", binned=True,  bayer="BGGR"),
        RawMode("640x480",       (636, 480),   "SRGGB12_CSI2P", binned=False, bayer="BGGR"),
        RawMode("640x480_bin",   (640, 480),   "SRGGB10_CSI2P", binned=True,  bayer="BGGR"),
        RawMode("fast_990",      (1332, 990),  "SRGGB10_CSI2P", binned=True,  bayer="BGGR"),
        # The 4 original stock modes (no kernel change needed) — kept last
        # so the default fallback (raw_modes[0], used on first boot / bad
        # persisted state) stays a light/fast mode rather than the heaviest
        # possible CMA allocation. "native" is the sensor's true full
        # resolution — this is what lets the UI resolution selector return
        # to native quality, not just the fast planetary crops above.
        RawMode("native",        (4056, 3040), "SRGGB12_CSI2P", binned=False, bayer="BGGR"),
        RawMode("native_16_9",   (4056, 2160), "SRGGB12_CSI2P", binned=False, bayer="BGGR"),
        RawMode("2028x1520_bin", (2028, 1520), "SRGGB10_CSI2P", binned=True,  bayer="BGGR"),
        RawMode("2028x1080_bin", (2028, 1080), "SRGGB10_CSI2P", binned=True,  bayer="BGGR"),
    ],
    raw_size=(4056, 3040),
    raw_format="SRGGB12_CSI2P",
    gain_max=16.0,
    dtoverlay="imx477",
)

# Starvis 2 sensors (IMX585/IMX678/IMX662): out-of-tree drivers by Will Whang
# (StarlightEye), installed via DKMS (/usr/src/imx*-0.0.1), and a patched
# libcamera (will127534 fork, /usr/local) that has their cam helpers and
# tuning files — the Debian libcamera does not know them, hence the extra
# PYTHONPATH entry in minicam-api.service. Only the stock driver modes for
# now (12-bit, no custom crop modes yet); every width is already a multiple
# of 4 (unicam stride rule, see IMX477 above). The overlays default to 4 CSI
# lanes: ",2lane" is mandatory on the Pi Zero 2 W. Bayer labels are the
# driver's unflipped RGGB default — unverified on real hardware.
IMX585 = SensorProfile(
    name="imx585",
    raw_modes=[
        RawMode("1080p_bin", (1928, 1090), "SRGGB12_CSI2P", binned=True),
        RawMode("native",    (3856, 2180), "SRGGB12_CSI2P", binned=False),
    ],
    raw_size=(3856, 2180),
    raw_format="SRGGB12_CSI2P",
    gain_max=64.0,
    dtoverlay="imx585,2lane",
)

IMX678 = SensorProfile(
    name="imx678",
    raw_modes=[
        RawMode("1080p_bin", (1928, 1090), "SRGGB12_CSI2P", binned=True),
        RawMode("native",    (3856, 2180), "SRGGB12_CSI2P", binned=False),
    ],
    raw_size=(3856, 2180),
    raw_format="SRGGB12_CSI2P",
    gain_max=64.0,
    dtoverlay="imx678,2lane",
)

IMX662 = SensorProfile(
    name="imx662",
    raw_modes=[
        RawMode("1080p", (1936, 1100), "SRGGB12_CSI2P", binned=False),
    ],
    raw_size=(1936, 1100),
    raw_format="SRGGB12_CSI2P",
    gain_max=64.0,
    dtoverlay="imx662,2lane",
)

SENSOR_PROFILES: dict[str, SensorProfile] = {
    "imx327": IMX327,
    "imx462": IMX462,
    "imx477": IMX477,
    "imx585": IMX585,
    "imx662": IMX662,
    "imx678": IMX678,
}


def get_sensor_profile(name: str) -> SensorProfile:
    try:
        return SENSOR_PROFILES[name]
    except KeyError:
        raise ValueError(
            f"capteur inconnu: {name!r} (attendu: {list(SENSOR_PROFILES)})"
        ) from None


def bits_from_format(raw_format: str) -> int:
    """Bit depth encoded in a packed CSI-2 Bayer format name (e.g. SRGGB12_CSI2P)."""
    if "12" in raw_format:
        return 12
    if "10" in raw_format:
        return 10
    raise ValueError(f"format raw non supporté: {raw_format!r}")
