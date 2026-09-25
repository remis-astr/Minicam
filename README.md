# Multicam

Caméra astro / allsky autonome sur **Raspberry Pi Zero 2 W**, pilotée depuis
une page web (téléphone ou PC) servie par le Pi lui-même.

## Fonctions

- Aperçu en direct, réglages de pose et de gain, photos pleine résolution
  (JPEG/PNG/FITS) et galerie de photos
- Timelapse (ISP ou RAW/FITS)
- **Lucky Stack** (planétaire) et **Live Stack**, empilement dans le
  navigateur (WebGPU ou CPU) à partir du flux RAW `/ws/raw`
- Plusieurs capteurs, choisis depuis l'interface (réécrit l'overlay puis
  redémarre) :

  | Capteur | Modes | Pilote |
  |---|---|---|
  | IMX327 / IMX462 | 1080p, 720p, 540p, 480p | `imx290` patché (`usr/src/imx290-crop`) |
  | IMX477 | recadrages « planétaires » binnés ou non, jusqu'à 4056×3040 | `imx477` patché (`usr/src/imx477-planetary`) |
  | IMX585 / IMX678 | 1928×1090 binné, 3856×2180 | DKMS de Will Whang (StarlightEye) |
  | IMX662 | 1936×1100 | DKMS de Will Whang (StarlightEye) |

- Réseau : point d'accès WiFi `AllskyCam` (192.168.4.1) et liaison USB
  « gadget » Ethernet (192.168.7.3)
- Trames RAW brutes pour un autoguideur externe (`/guide/frame`,
  page `guidage.html`) et relais réseau vers ce contrôleur

## Organisation

Le dépôt suit l'arborescence du Pi :

| Chemin | Rôle |
|---|---|
| `opt/minicam/src/minicam/` | API FastAPI + picamera2 (`python3 -m minicam`) |
| `opt/minicam/web/` | interface web (fichiers statiques) |
| `etc/systemd/system/` | services (`minicam-api`, réseau USB/WiFi, relais) |
| `etc/dnsmasq.d/`, `etc/NetworkManager/` | DHCP et point d'accès (`*.example` : remplacer `psk`) |
| `usr/src/` | sources des pilotes noyau patchés (voir l'en-tête de chaque `.c`) |
| `tools/als_sync/` | synchronisation du timelapse vers Astro Live Stacker |

## Prérequis

- Raspberry Pi OS Bookworm 64 bits, `python3-picamera2`, FastAPI/uvicorn
- IMX585/678/662 : pilotes DKMS et libcamera modifiée
  ([will127534/libcamera](https://github.com/will127534/libcamera)) installée
  dans `/usr/local` ; `minicam-api.service` ajoute ses modules Python au
  `PYTHONPATH`
- Configuration : `/etc/minicam/config.toml` (section `[camera]`, clé `sensor`)
