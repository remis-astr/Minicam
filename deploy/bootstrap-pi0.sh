#!/bin/bash
# Bootstrap initial du Raspberry Pi Zero 2 W pour le projet minicam.
# À exécuter une seule fois sur le Pi0 après le premier boot.
# Usage : bash bootstrap-pi0.sh

set -euo pipefail

echo "=== minicam bootstrap ==="

# --- Locale & hostname ---
sudo raspi-config nonint do_hostname minicam0
sudo sed -i 's/^# *fr_FR.UTF-8/fr_FR.UTF-8/' /etc/locale.gen
sudo locale-gen
sudo update-locale LANG=fr_FR.UTF-8

# --- Mise à jour système ---
sudo apt-get update -qq
sudo apt-get upgrade -y -qq

# --- Dépendances système ---
sudo apt-get install -y -qq \
    python3-picamera2 \
    python3-pip \
    python3-venv \
    python3-gpiozero \
    i2c-tools \
    python3-smbus \
    git \
    rsync \
    curl

# --- Activer I2C ---
sudo raspi-config nonint do_i2c 0

# --- Répertoires runtime ---
sudo mkdir -p /etc/minicam /var/lib/minicam /opt/minicam
sudo chown admin:admin /var/lib/minicam /opt/minicam

# --- Config TOML par défaut ---
if [ ! -f /etc/minicam/config.toml ]; then
    sudo tee /etc/minicam/config.toml > /dev/null <<'EOF'
[oled]
contrast = 20
auto_sleep_seconds = 60
rotate = 0
i2c_address = "0x3C"

[camera]
default_gain = 10
default_exposure_ms = 100

[network]
usb_ip = "192.168.7.2"
usb_prefix = 24
EOF
fi

# --- Venv Python pour minicam ---
python3 -m venv /opt/minicam/venv --system-site-packages
/opt/minicam/venv/bin/pip install --quiet --upgrade pip
/opt/minicam/venv/bin/pip install --quiet \
    fastapi \
    uvicorn[standard] \
    websockets \
    "luma.oled" \
    pyinotify \
    tomli

echo ""
echo "=== Bootstrap terminé ==="
echo "Vérifier le capteur : rpicam-hello --list-cameras"
echo "Redémarrer si le hostname a changé : sudo reboot"
