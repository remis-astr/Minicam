# MiniCam

Mini-caméra astrophoto autonome sur **Raspberry Pi Zero 2 W** + capteur **Sony IMX462** (StarVis 2), pilotable depuis un navigateur web ou via le protocole INDI.

---

## Fonctionnalités

- **Preview live** — flux MJPEG en temps réel avec histogramme RGB
- **Contrôles caméra** — gain (×1–64), exposition (0.1–10 000 ms), balance des blancs
- **Capture** — image PNG ou RAW FITS à la demande
- **Séquences** — capture automatique N images avec barre de progression et téléchargement ZIP
- **Mode INDI** — active `indi_pylibcamera` pour pilotage depuis KStars / Open Live Stacker (port 7624)
- **Navigation AstroHopper** — carte du ciel interactive avec orientation fournie par le MPU6050 embarqué (filtre Madgwick 50 Hz, calibration biais automatique)
- **Connectivité** — USB gadget (`192.168.7.2`) ou WiFi

---

## Hardware

| Composant | Détail |
|-----------|--------|
| Carte | Raspberry Pi Zero 2 W |
| Capteur | Sony IMX462 (Innomaker, StarVis 2) |
| OS | BWL64_STARVIS2 (Bookworm Lite 64-bit) |
| IMU | MPU6050 sur I2C (navigation AstroHopper) |
| Alimentation | Batteries 18650 + LDO TPS3245 ou USB |

---

## Accès

Une fois le service démarré, ouvrir dans un navigateur :

```
http://192.168.7.2       # USB gadget
http://<ip-wifi>         # WiFi
```

---

## Structure

```
src/minicam/
├── api/          # FastAPI — WebSocket commandes, MJPEG, capture, IMU
├── camera/       # Wrapper picamera2 (IMX462)
└── imu.py        # MPU6050 + filtre Madgwick
web/
├── index.html    # Interface principale
└── astrohopper/  # Carte du ciel (SkyHopper, modifié)
deploy/systemd/   # Services systemd
```

---

## Déploiement

```bash
make deploy        # rsync vers pi0:/opt/minicam/
make deploy-systemd
ssh pi0 "sudo systemctl restart minicam-api"
```

---

## Licences

- Code MiniCam : **GPL-3.0**
- AstroHopper (Artyom Beilis) : **Apache 2.0**
- Catalogue étoiles (Eleanor Lutz) : **GPL**
- VSOP87 (Greg Miller) : **Public Domain**

Voir [`web/astrohopper/NOTICE`](web/astrohopper/NOTICE) pour le détail des attributions.
