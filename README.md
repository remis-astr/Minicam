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

- Réseau : point d'accès WiFi `MULTICAM` (192.168.4.1, mot de passe
  `multicam`, actif dès le premier démarrage) et liaison USB
  « gadget » Ethernet (192.168.7.3 par défaut, configurable)
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

## Lucky Stack — notes

- **Flux caméra** : buffer de 8 images avec contrôle de flux par crédits
  (`{"cmd": "credit"}` sur `/ws/raw`) — le Pi envoie au maximum de ses
  capacités, sans image perdue. Mesuré en USB (IMX477) : RAW 8 bits ROI
  640×480 ≈ 8,7 img/s ; RAW 16 bits 852×480 ≈ 2 img/s. La limite est
  l'envoi côté Pi (~3,6 Mo/s). Les autres pages gardent la cadence fixe.
  Une seule capture RAW à la fois (verrou serveur) : deux flux simultanés
  ont figé la caméra (« Camera frontend has timed out »).
- **Test SER** : rejoue un fichier SER local (lu dans le navigateur, rien
  n'est envoyé au Pi) à la place de la caméra. Mono, Bayer, RGB/BGR, 8/16 bits.
- **Traitement** : étirement linéaire par défaut (arcsinh réservé au ciel
  profond), contraste (courbe en S) ; ondelettes à trous (4 couches +
  débruitage) et CLAHE appliqués **à la fin** du stack (SER terminé ou
  ■ Arrêter), qui garde l'image et laisse tous les réglages actifs. PNG =
  image traitée, FITS = stack brut.
- **WebGPU** : Chrome ne l'expose que sur une page sûre (HTTPS ou
  `localhost`). La page étant en HTTP : `ssh -N -L 8000:localhost:8000
  admin@<ip>` puis `http://localhost:8000/…`, ou
  `chrome://flags/#unsafely-treat-insecure-origin-as-secure`. Sous Linux,
  activer aussi `#enable-unsafe-webgpu` et `#enable-vulkan`, sinon Chrome
  fournit SwiftShader (GPU émulé, bien plus lent que les workers CPU : le
  stacker le refuse). La console indique `[Stacker] GPU=… (carte)` et, à la
  fin, la durée de chaque étape.

## Installation sur une nouvelle carte SD

Procédure complète, validée sur `multicam2` (Pi Zero 2 W + IMX477). Les
étapes 1 à 6 se font depuis un PC Linux, carte SD montée ; les étapes 7 et 8
sur le Pi démarré. Dans les commandes, `/dev/sdX` = la carte SD (vérifier
avec `lsblk` : tout son contenu est effacé) et `$M` = son point de montage.

### 1. Image de base

Image du vendeur de la caméra (SOHO Enterprise, hostname d'origine `SEL00`) :
`BWL64_STARVIS2_shrink.img` — Bookworm Lite 64 bits, utilisateur `pi`, avec
les pilotes DKMS IMX585/662/678, la libcamera de will127534 (0.6) dans
`/usr/local` et les en-têtes du noyau. C'est la même base que la première
Multicam.

```bash
sudo dd if=BWL64_STARVIS2_shrink.img of=/dev/sdX bs=4M conv=fsync status=progress
# l'image est réduite : agrandir la partition système tout de suite
sudo parted -s /dev/sdX resizepart 2 100%
sudo e2fsck -fy /dev/sdX2 && sudo resize2fs /dev/sdX2

M=/mnt/multicam
sudo mkdir -p $M && sudo mount /dev/sdX2 $M && sudo mount /dev/sdX1 $M/boot/firmware
```

L'image contient un `/etc/rc.local` qui agrandit la partition au premier
démarrage puis restaure un `rc.local.bak` absent. L'agrandissement étant
fait, le remplacer :

```bash
sudo mv $M/etc/rc.local $M/etc/rc.local.soho-expand
printf '#!/bin/sh -e\nexit 0\n' | sudo tee $M/etc/rc.local && sudo chmod 755 $M/etc/rc.local
```

### 2. Boot (`$M/boot/firmware`)

- `config.txt` : ajouter `dtoverlay=dwc2` dans `[all]` (gadget USB) ;
  corriger la ligne capteur livrée `dtoverlay=imx678,2lane,ink-frequency=…`
  en `dtoverlay=imx678,2lane`. Inutile de mettre le bon capteur ici : la
  page web le change (étape 8).
- `cmdline.txt` (une seule ligne) : remplacer
  `cfg80211.ieee80211_regdom=JP` par
  `cfg80211.ieee80211_regdom=FR modules-load=dwc2,libcomposite`

### 3. Paquets (chroot ARM64)

Sur le PC : `qemu-user-static` (ou `qemu-user` + `binfmt-support`) pour
exécuter les binaires arm64.

```bash
for d in dev dev/pts proc sys; do sudo mount --bind /$d $M/$d; done
sudo mv $M/etc/resolv.conf $M/etc/resolv.conf.orig
sudo cp -L /etc/resolv.conf $M/etc/resolv.conf     # DNS pour apt
sudo chroot $M apt-get update
sudo chroot $M apt-get install -y --no-install-recommends \
    python3-picamera2 python3-fastapi python3-uvicorn python3-opencv \
    python3-numpy python3-pydantic dnsmasq
```

**FastAPI ≥ 0.93 obligatoire** : le paquet Debian Bookworm (0.92) ignore
silencieusement `FastAPI(lifespan=…)`, la caméra n'est alors jamais ouverte
(`'State' object has no attribute 'camera'`). Installer une version récente
par pip, dans le chroot (ou plus tard sur le Pi, en copiant des wheels
téléchargées sur le PC s'il n'a pas Internet) :

```bash
# PC, si besoin de wheels hors ligne
pip download -d wheels --only-binary=:all: --platform manylinux2014_aarch64 \
    --platform any --python-version 3.11 --implementation cp fastapi uvicorn
# chroot ou Pi
sudo pip3 install --break-system-packages --upgrade fastapi uvicorn
#   (hors ligne : ajouter --no-index --find-links wheels)
```

(testé : fastapi 0.142.2, starlette 1.7.0, uvicorn 0.54.0, pydantic 2.13.5)

### 4. Fichiers du dépôt

| Dépôt | Destination |
|---|---|
| `opt/minicam/` | `/opt/minicam/` (propriétaire `admin`, uid 1001 dans cette image) |
| `etc/systemd/system/*` | `/etc/systemd/system/` (dont `dnsmasq.service.d/`) |
| `etc/dnsmasq.d/allsky-ap.conf` | `/etc/dnsmasq.d/` (`minicam-usb.conf` est généré) |
| `etc/minicam/m8s-forward.nft` | `/etc/minicam/` |
| `usr/local/bin/minicam-usb-route-watch` | `/usr/local/bin/` (mode 755) |
| `usr/local/bin/minicam-net-init` | `/usr/local/bin/` (mode 755) |
| `usr/src/` | `/usr/src/minicam-drivers/` (compilés à l'étape 7) |

Puis `/etc/minicam/config.toml` :

```toml
[camera]
sensor = "imx678"   # doit correspondre à la ligne dtoverlay de config.txt

[wifi]                # facultatif, valeurs par défaut ci-dessous
ap_ssid = "MULTICAM"
ap_psk = "multicam"   # 8 à 63 caractères

[network]             # facultatif
usb_ip = "192.168.7.3"  # IP du Pi sur le lien USB ; hôte (PC/M8S) = .1 du /24
```

`minicam-net-init.service` (à chaque démarrage, avant NetworkManager et
dnsmasq) génère à partir de ces sections :

- le hotspot `/etc/NetworkManager/system-connections/MulticamAP.nmconnection`
  (sauf si un autre profil en mode AP existe déjà, ex. `AllskyAP` fait à la
  main : il est conservé) ;
- le DHCP USB `/etc/dnsmasq.d/minicam-usb.conf` (plage .10–.20,
  `bind-dynamic` : avec `bind-interfaces`, dnsmasq refusait de démarrer tant
  que `wlan0` n'avait pas d'IP, et l'USB n'avait plus de DHCP non plus) ;
- `/run/minicam/net.env` (lu par `minicam-usb-route-watch`) et
  `/run/minicam/m8s-forward.nft` (relais M8S vers l'hôte .1).

`usb_gadget.py` lit aussi `usb_ip`. Modifier `config.toml` puis redémarrer.
Sans section `[network]`, tout est identique à l'ancienne configuration
fixe (Pi 192.168.7.3, M8S 192.168.7.1). **Mise à jour d'une installation
existante** : installer et activer `minicam-net-init` ; `dnsmasq` et
`minicam-m8s-forward` le tirent automatiquement (`Wants=`), et le relais M8S
retombe sur `/etc/minicam/m8s-forward.nft` si le fichier généré manque.

**Plusieurs Multicam sur la même machine** (PC ou M8S) : donner à chacune un
sous-réseau USB différent, pas seulement une autre IP dans 192.168.7.x
(deux interfaces dans le même /24 et deux DHCP sur la même plage = routage
aléatoire). Exemple : première en `192.168.7.3`, `multicam2` en
`192.168.8.3`. Le relais M8S suppose alors que le M8S a aussi l'IP .1 du
second sous-réseau.

### 5. Système (dans le chroot)

```bash
echo <nom> > /etc/hostname              # + remplacer SEL00 dans /etc/hosts
useradd -m -s /bin/bash admin           # le service tourne en User=admin
usermod -aG sudo,video,render,gpio,i2c,spi,netdev,plugdev,dialout,input,audio admin
echo "admin ALL=(ALL) NOPASSWD: ALL" > /etc/sudoers.d/010_admin-nopasswd
chmod 440 /etc/sudoers.d/010_admin-nopasswd
# l'API appelle sudo (nmcli, tee config.txt, systemctl reboot)
mkdir -p /timelapse /var/lib/minicam && chown admin:admin /timelapse /var/lib/minicam
chown -R admin:admin /opt/minicam
# clé SSH publique du PC -> /home/admin/.ssh/authorized_keys
# (700 / 600, propriétaire admin). admin n'a pas de mot de passe : `passwd admin` si besoin.
systemctl enable minicam-api minicam-net-usb minicam-usb-route-watch \
    minicam-net-wifi minicam-net-init dnsmasq
ln -sf /usr/share/zoneinfo/Europe/Paris /etc/localtime   # l'image SOHO est en Asia/Tokyo
```

L'image contient aussi un profil WiFi client du vendeur
(`/etc/NetworkManager/system-connections/preconfigured.nmconnection`,
réseau `tplink-deco…`) : sans utilité, peut être supprimé.

### 6. Nettoyage et démontage

```bash
sudo chroot $M apt-get clean
sudo rm $M/etc/resolv.conf && sudo mv $M/etc/resolv.conf.orig $M/etc/resolv.conf
for d in dev/pts dev proc sys; do sudo umount $M/$d; done
sync && sudo umount $M/boot/firmware $M
```

### 7. Premier démarrage et pilotes patchés

Brancher le câble sur le port **USB** du Zero 2 W (celui du milieu, pas
« PWR ») : il alimente le Pi et crée le lien réseau. Le PC reçoit une
adresse par DHCP (laisser la connexion en automatique : l'adresse MAC du
gadget change à chaque démarrage). Le hotspot `MULTICAM` est actif aussi.

- SSH : `ssh admin@192.168.7.3` (ou l'`usb_ip` choisie) ; en WiFi `192.168.4.1`
- Interface web : `http://<ip>:8000/`
- Contrôle : `systemctl status minicam-api minicam-net-init dnsmasq`,
  `journalctl -u minicam-api -b`

Les **pilotes patchés sont obligatoires** : les profils de `sensors.py`
attendent leurs modes (ex. IMX477 : RAW 1916×1080 ; avec le pilote
d'origine, 2028×1080 est négocié et l'API refuse d'ouvrir la caméra).
Compilation sur le Pi (~40 s, en-têtes déjà dans l'image) :

```bash
cp -r /usr/src/minicam-drivers/imx477-planetary /tmp/imx477 && cd /tmp/imx477
make -C /lib/modules/$(uname -r)/build M=$PWD modules
K=/lib/modules/$(uname -r)/kernel/drivers/media/i2c
sudo mv $K/imx477.ko.xz ~/imx477.ko.xz.orig      # sauvegarde
xz -c imx477.ko | sudo tee $K/imx477.ko.xz >/dev/null
sudo depmod -a && sudo reboot                    # pas de rmmod/insmod
```

Même procédure pour `imx290-crop` (IMX327/IMX462, module `imx290`). Les
IMX585/662/678 utilisent les pilotes DKMS déjà présents. **À refaire après
chaque mise à jour du noyau.**

### 8. Choix du capteur

Depuis la page web : choisir le capteur branché. L'API réécrit
`/etc/minicam/config.toml` (`sensor`) et la ligne `dtoverlay=` de
`config.txt`, puis redémarre le Pi. Après le redémarrage, le journal de
`minicam-api` doit afficher `Camera ready`.

### Points d'attention

- Mémoire CMA (Zero 2 W) : l'ouverture de la caméra échoue parfois au
  démarrage (`OSError: [Errno 12] Cannot allocate memory`, `cma_alloc …
  ret: -16` dans dmesg). L'API s'arrête alors et systemd la relance avec une
  CMA propre (3 fois au plus en 5 min, compteur
  `/var/lib/minicam/cma_retries`) ; en général la 2e tentative passe.
- Message « capteur détecté incompatible avec le profil … RAW attendu … » :
  pilote patché absent ou écrasé par une mise à jour du noyau (étape 7).
