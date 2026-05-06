# Mini-caméra astrophoto RPi0 — Plan de projet

> Ce document est destiné à être lu par Claude Code à chaque session. Il décrit l'architecture cible, les conventions, et les phases d'implémentation. Garde-le à jour au fur et à mesure que le projet évolue.

---

## 1. Contexte

On développe une **mini-caméra astrophoto autonome** sur Raspberry Pi Zero 2 W équipé d'un capteur IMX462. Elle doit pouvoir :

- Être pilotée à distance par l'application **RPiCamera2** (https://github.com/remis-astr/Rpicamera2---Halide) qui tourne sur un RPi5
- Être pilotée par **Open Live Stacker** depuis un smartphone via le protocole INDI
- Être pilotée directement depuis une **page HTML** servie en WiFi
- Communiquer soit en **USB gadget** (préféré, faible latence, alimentation incluse) soit en **WiFi**
- Fonctionner sur batteries 18650 + LDO 3245 ou sur l'alimentation USB du RPi5

Les modes de fonctionnement sont **mutuellement exclusifs** et basculés via boutons GPIO pour économiser la RAM (le Zero 2 W n'a que 512 Mo).

---

## 2. Hardware

| Composant | Détail |
|---|---|
| Carte | Raspberry Pi Zero 2 W |
| Capteur | Sony IMX462 (StarVis 2, monochrome ou couleur selon variante) |
| OS | BWL64_STARVIS2 (Bookworm Lite 64-bit avec drivers StarVis) — image fournie : https://soho-enterprise.com/wp/wp-content/uploads/2026/01/BWL64_STARVIS2_shrink.img.gz |
| Alimentation | 18650 + LDO TPS3245 5V **OU** USB depuis RPi5 |
| Boutons GPIO | 1 interrupteur power batterie (hors GPIO) + **B1, B2 : interrupteurs lockables à 2 positions** (SPDT ou à bascule) + **B3 : bouton poussoir momentané** (multifonction veille/shutdown) |
| Écran | OLED I2C SSD1306 128×64 monochrome (adresse 0x3C, **alim 5 V** pour préserver le rail 3,3 V du capteur) |

---

## 3. Architecture logicielle

### Vue d'ensemble

```
                       ┌─────────────────────┐
                       │   RPi5 (RPiCamera2) │
                       │   ou Smartphone     │
                       │   ou Browser        │
                       └──────────┬──────────┘
                                  │  USB gadget (usb0) ou WiFi
                                  │
              ┌───────────────────▼────────────────────┐
              │            RPi Zero 2 W                │
              │                                        │
              │  Mode A  : minicam-api.service         │
              │            (FastAPI + picamera2)       │
              │            ↳ WS commandes              │
              │            ↳ MJPEG preview             │
              │            ↳ HTML statique (optionnel) │
              │                                        │
              │  Mode B  : minicam-indi.service        │
              │            (indi_pylibcamera + indi)   │
              │                                        │
              │  Réseau  : minicam-net-usb.service     │
              │       OU : minicam-net-wifi.service    │
              │                                        │
              │  GPIO    : minicam-ui.service           │
              │            (boutons + OLED, toujours    │
              │             actif, léger)               │
              └────────────────────────────────────────┘
                                  │
                                  ▼
                            IMX462 via CSI-2
```

### Décisions clés

- **Backend Python 3.11+** avec `picamera2` (binding officiel libcamera). Pas d'appel libcamera distant : tout est local au RPi0, exposé via API réseau.
- **API HTTP/WebSocket via FastAPI + uvicorn** (uniprocess, asyncio, faible empreinte).
- **Preview en MJPEG** sur HTTP (`/preview.mjpg`). Compromis simplicité/latence pour le pointage. Pour les frames de capture haute qualité, on passe par endpoint dédié.
- **Commandes en WebSocket** (`/ws/control`) : gain, exposition, ROI, binning, déclenchement capture, etc.
- **Page HTML statique** servie par le même FastAPI, partage le même backend que le mode RPiCamera2. Toujours disponible quand `minicam-api.service` est actif (pas de bouton dédié — le coût RAM est négligeable, les fichiers sont mmap'd par le noyau).
- **Mode INDI** : `indi_pylibcamera` (pure Python, maintenu, supporte la famille IMX290/462). Tourne dans son propre service, exclusif du service API.
- **Bascule réseau** : USB gadget configuré via `libcomposite` (interface `usb0` côté Pi0), WiFi en mode client ou AP. Du point de vue de l'application, c'est juste une interface différente.
- **Affichage OLED SSD1306** piloté par `luma.oled` via I2C : statut mode/réseau (haut), gain/exposition (centre), état capture (bas). Mise en veille hardware (~10 µA, commande `0xAE`) sur appui court du bouton multifonction, et auto-sleep après timeout d'inactivité configurable. Luminosité réduite par défaut (~20/255) pour préserver la vision nocturne.
- **État applicatif partagé** : les services `api` et `indi` écrivent gain/expo/état dans `/var/lib/minicam/state.json` ; le service `ui` le lit (inotify) pour rafraîchir l'OLED. Permet de garder l'UI découplée des backends.
- **État du mode** persisté dans `/var/lib/minicam/state.json` pour survivre aux reboots.
- **Pas de stockage d'images sur le RPi0** : tout est streamé vers le client. Buffer en `tmpfs` borné si nécessaire.

### Services systemd

Les services sont déclarés avec `Conflicts=` pour garantir l'exclusion mutuelle :

- `minicam-ui.service` — toujours actif, gère boutons + OLED + bascule des autres services
- `minicam-api.service` — mode RPiCamera2 + page HTML
- `minicam-indi.service` — mode INDI (conflict avec api)
- `minicam-net-usb.service` — bring up de `usb0` via libcomposite
- `minicam-net-wifi.service` — bring up de wlan0 (conflict avec net-usb)

### Mapping boutons (2 lockables + 1 momentané)

| Bouton | Type | Position / Action | Effet |
|---|---|---|---|
| **B1** Transport | Lockable SPDT | Position OFF (GPIO LOW) | Mode USB gadget |
| | | Position ON (GPIO HIGH) | Mode WiFi |
| **B2** Applicatif | Lockable SPDT | Position OFF (GPIO LOW) | Mode API (RPiCamera2 + HTML) |
| | | Position ON (GPIO HIGH) | Mode INDI |
| **B3** Multifonction | Poussoir momentané | Appui court (< 1 s) | Toggle veille OLED |
| | | Appui long (≥ 3 s) | Shutdown propre (`systemctl poweroff`) |

**Conséquences des B1/B2 lockables** :
- Le niveau GPIO *est* la source de vérité du mode — pas besoin de restauration d'état depuis `state.json` pour ces deux dimensions.
- Au boot, le service `minicam-ui` lit l'état physique et démarre directement le bon couple de services.
- Lecture via `gpiozero.DigitalInputDevice` avec callbacks `when_activated` / `when_deactivated`, sans logique de debounce agressif (l'interrupteur mécanique ne rebondit quasi pas comparé à un poussoir).
- Si l'utilisateur bascule pendant un run, transition propre : stop des services en cours → start des services cibles.

### Interface OLED (SSD1306 128×64)

Trois zones horizontales. Layout pensé pour une lecture rapide en conditions nocturnes, luminosité réduite par défaut.

```
┌────────────────────────────┐
│ API · WiFi  192.168.4.1 ▓▓ │  ← 10 px : mode applicatif · transport · IP · jauge batterie
├────────────────────────────┤
│                            │
│  Gain    24                │
│  Exp   3000 ms             │  ← 36 px : paramètres capture (police moyenne)
│                            │
├────────────────────────────┤
│ ● REC   frame 12 / 30      │  ← 18 px : état + compteur (ou "IDLE", "STACK", etc.)
└────────────────────────────┘
```

**Zone haute (barre statut, 10 px)** :
- Mode applicatif : `API` ou `INDI`
- Séparateur ` · `
- Transport : `USB` ou `WiFi`
- IP active de l'interface courante
- Icône/jauge batterie à droite (si ADC présent, sinon icône USB si alim externe détectée)

**Zone centrale (paramètres, 36 px)** :
- `Gain`   (ex. `24 `)
- `Exp` en ms ou s selon magnitude (ex. `3000 ms` → `3.0 s` → `30 s`)
- Police moyenne (hauteur ~14-16 px) pour bonne lisibilité

**Zone basse (état, 18 px)** :
- `IDLE` au repos
- `● REC  frame N / M` pendant une capture multi-frame (point rouge clignotant)
- `STACK` si live stacking en cours
- `BUSY` pendant une opération non interruptible

**États spéciaux** :
- **Démarrage** : logo/nom pendant 2 s, puis affichage normal
- **Transition de mode** : spinner + message `Switching to INDI…` pendant le stop/start des services
- **Veille** : écran vidé via commande `0xAE` (luma : `device.hide()`), consommation ~10 µA
- **Batterie faible** : icône batterie clignote dans la barre haute
- **Erreur service** : message en zone basse, ex. `ERR: indi failed`

**Paramètres configurables** (`/etc/minicam/config.toml`) :
- `oled.contrast` : 0–255, défaut 20 (astro)
- `oled.auto_sleep_seconds` : défaut 60, 0 = désactivé
- `oled.rotate` : 0 ou 180 (orientation physique)
- `oled.i2c_address` : défaut 0x3C

L'interrupteur power batterie reste un interrupteur d'alimentation indépendant (hors GPIO).

---

## 4. Environnement de développement

**Claude Code tourne sur le RPi5**, jamais sur le Pi0 (RAM insuffisante). Le code est édité et versionné sur le RPi5, et déployé sur le Pi0 par `rsync` over SSH.

### Setup SSH (à faire une fois)

```bash
# Sur le RPi5
ssh-keygen -t ed25519 -C "rpi5-dev"
ssh-copy-id pi@<ip-du-pi0>

# ~/.ssh/config sur le RPi5
Host pi0
    HostName 192.168.7.2     # IP USB gadget par défaut
    User pi
    IdentityFile ~/.ssh/id_ed25519
    StrictHostKeyChecking accept-new
```

Après ça : `ssh pi0` doit fonctionner sans mot de passe.

### Workflow type

```bash
# Édition locale sur RPi5 (Claude Code travaille ici)
cd ~/projects/minicam
# ... modifications ...

# Déploiement
make deploy        # rsync src/ pi0:/opt/minicam/

# Test à distance
ssh pi0 "sudo systemctl restart minicam-api && journalctl -u minicam-api -f"
```

---

## 5. Structure du repo

```
minicam/
├── CLAUDE.md                  # ce fichier
├── README.md
├── pyproject.toml             # deps : picamera2, fastapi, uvicorn, gpiozero, websockets, luma.oled, pyinotify
├── Makefile                   # cibles : deploy, deploy-systemd, logs, restart, status
├── deploy/
│   ├── ssh_config.example
│   ├── bootstrap-pi0.sh       # setup initial du Pi0
│   └── systemd/
│       ├── minicam-api.service
│       ├── minicam-indi.service
│       ├── minicam-ui.service
│       ├── minicam-net-usb.service
│       └── minicam-net-wifi.service
├── src/minicam/
│   ├── __init__.py
│   ├── config.py              # chargement config + état persistant
│   ├── camera/
│   │   ├── controller.py      # wrapper picamera2 pour IMX462
│   │   └── presets.py         # presets exposition/gain pour cibles astro
│   ├── api/
│   │   ├── app.py             # FastAPI app factory
│   │   ├── routes_control.py  # WebSocket commandes
│   │   ├── routes_preview.py  # MJPEG streaming
│   │   ├── routes_capture.py  # capture haute qualité
│   │   └── routes_static.py   # page HTML
│   ├── ui/
│   │   ├── buttons.py         # gpiozero, debounce, gestion appui court/long
│   │   ├── display.py         # luma.oled, layouts, gestion veille + auto-sleep
│   │   ├── state_machine.py   # bascule des services systemd
│   │   └── state_watcher.py   # inotify sur state.json pour rafraîchir l'OLED
│   └── net/
│       ├── usb_gadget.py      # configuration libcomposite
│       └── wifi.py            # client/AP
├── web/
│   ├── index.html
│   ├── app.js                 # vanilla JS, pas de framework
│   └── style.css
├── tests/
│   ├── test_camera_mock.py
│   └── test_state_machine.py
└── scripts/
    └── flash-os-helper.sh
```

---

## 6. Conventions

- **Python 3.11+**, type hints partout, `ruff` + `mypy` en CI locale
- **Logging** via `logging` standard, format JSON pour journalctl friendliness
- **Pas de print()** dans le code de prod
- **Configuration** via `/etc/minicam/config.toml` + variables d'env, jamais en dur
- **Tests** : tout ce qui ne dépend pas du capteur doit être testable sur le RPi5 sans hardware (mocks pour picamera2 et gpiozero)
- **Commits** : style Conventional Commits (`feat:`, `fix:`, `chore:`...)

---

## 7. Phases d'implémentation

À traiter **séquentiellement**. Chaque phase doit être validée avant de passer à la suivante.

### Phase 0 — Bootstrap (pas de code applicatif)

- [x] Flasher BWL64_STARVIS2 sur SD
- [x] Premier boot : SSH activé (hostname laissé à rpi0)
- [x] Setup clé SSH RPi5 → Pi0 + alias `~/.ssh/config` (user=admin, rpi0.local + pi0-usb 192.168.7.2)
- [x] Vérifier capteur : `rpicam-hello --list-cameras` → IMX462 1920×1080 RAW12 60fps OK
- [x] Init du repo Git, premier commit avec ce CLAUDE.md + structure complète
- [x] Écrire `deploy/bootstrap-pi0.sh`

### Phase 1 — Validation capteur

- [x] Script Python minimal : capture RAW12 (SRGGB12_CSI2P packed, shape 1080×2880 uint8), sauvegarde en .npy
- [x] Valider plage gain : ×1.0 → ×31.62 (~30 dB) OK
- [x] Valider plage exposition : 992 µs → 9.998 s OK
- [x] Framerate 720p YUV420 : 28.8 fps (Python loop) — max hardware 60 fps
- [x] **Critère de succès** : validé (IMX462 installé, driver `imx462` + tuning `imx462.json`, 74.25 MHz, 60fps)

### Phase 2 — Squelette API

- [x] FastAPI app, endpoints : `GET /status`, `GET /healthz`
- [x] WebSocket `/ws/control` : commandes `ping`, `set_gain`, `set_exposure`, `status`
- [x] systemd unit `minicam-api.service` installé et activé
- [x] **Critère de succès** : ping/pong + set_gain + set_exposure validés depuis RPi5

### Phase 3 — Preview MJPEG

- [x] Endpoint `/preview.mjpg` (multipart/x-mixed-replace, YUV420→BGR→JPEG via cv2)
- [x] Throttling à 15 fps cible côté serveur
- [x] **Critère de succès** : 13.4 fps mesurés depuis RPi5 en WiFi (> 10 fps requis)

### Phase 4 — Page HTML

- [x] Page de contrôle avec preview MJPEG embarqué + sliders gain/expo
- [x] Bouton "Capture PNG" → `GET /capture.png` (téléchargement direct)
- [x] Vanilla JS, pas de bundler, WebSocket connecté à `/ws/control`
- [x] **Critère de succès** : pilotage complet depuis browser validé

### Phase 5 — Bascule réseau USB ↔ WiFi

- [x] `dtoverlay=dwc2` + `modules-load=dwc2,libcomposite` dans boot config
- [x] `usb_gadget.py` : configuration ECM via libcomposite/ConfigFS
- [x] `minicam-net-usb.service` : usb0 @ 192.168.7.2/24 (NO-CARRIER tant que câble débranché)
- [x] `minicam-net-wifi.service` : WiFi via NetworkManager
- **Par défaut (sans boutons)** : WiFi — NetworkManager gère wlan0 automatiquement. minicam-net-usb est désactivé. minicam-api écoute sur 0.0.0.0 donc actif sur toute interface disponible.
- [x] **Critère de succès** : USB validé — ping 0.35 ms, API et SSH opérationnels sur 192.168.7.2
- RPi5 : connexion NM `minicam-usb` persistante (192.168.7.1/24, autoconnect)

### Phase 6 — UI : OLED + boutons GPIO + state machine

**6a. OLED SSD1306**
- [ ] Activer I2C (`raspi-config` → Interface Options → I2C)
- [ ] **Vérifier niveau logique I2C avant câblage** : alimenter l'OLED en 5 V, mesurer SDA au repos au multimètre → doit être ~3,3 V (pas 5 V). Si 5 V : ajouter level shifter BSS138 sur SDA/SCL.
- [ ] Câblage : VCC→pin 2 (**5V**), GND→pin 6, SDA→pin 3, SCL→pin 5
- [ ] Vérifier détection : `i2cdetect -y 1` doit montrer `0x3C`
- [ ] Install `luma.oled`, premier "hello world" plein écran
- [ ] Layout final : barre statut (mode + IP) / valeurs gain & expo / état capture (idle/REC/stack)
- [ ] Luminosité réglable, défaut bas (~20/255), exposée dans `config.toml`
- [ ] Lecture asynchrone de `/var/lib/minicam/state.json` via inotify pour rafraîchir
- [ ] **Critère de succès** : changement de gain via API → reflété sur OLED en < 500 ms

**6b. Boutons GPIO**
- [ ] **B1** (interrupteur lockable SPDT, transport) : lecture niveau via `DigitalInputDevice`, callbacks `when_activated` / `when_deactivated` → USB (LOW) / WiFi (HIGH)
- [ ] **B2** (interrupteur lockable SPDT, applicatif) : idem → API (LOW) / INDI (HIGH)
- [ ] **B3** (poussoir momentané, multifonction) : via `Button`, détection appui court (< 1 s) = toggle veille OLED, appui long (≥ 3 s) = `systemctl poweroff`
- [ ] Au démarrage du service, lire les positions physiques de B1/B2 et démarrer les services cibles en conséquence (pas de restauration depuis `state.json` pour ces deux dimensions)
- [ ] State machine : gérer proprement les transitions (stop services courants avant start des cibles) + persistance du contexte non-bouton (gain/expo courants, etc.) dans `/var/lib/minicam/state.json`
- [ ] Auto-sleep OLED après timeout d'inactivité (défaut : 60 s, configurable)
- [ ] Réveil OLED automatique sur changement de B1/B2, appui B3, ou commande WebSocket

**6c. Service**
- [ ] Service `minicam-ui.service` (le seul toujours actif), gère boutons + OLED ensemble
- [ ] **Critère de succès global** : 3 boutons opérationnels, OLED affiche correctement, veille manuelle ET auto fonctionnent, modes basculent

### Phase 7 — Mode INDI

- [x] Install `indi_pylibcamera` + `indiserver` (+ deps : lxml, astropy)
- [x] Toggle INDI on/off depuis la page HTML (start_indi/stop_indi WS, subprocess indiserver)
- [ ] Service `minicam-indi.service` dédié avec `Conflicts=minicam-api.service`
- [ ] Test depuis Open Live Stacker (smartphone) en WiFi — OLS+indi_pylibcamera non documenté, combinaison non validée
- [x] **Critère de succès partiel** : KStars voit l'IMX290 via INDI (port 7624) — infrastructure INDI validée

### Phase 8 — Client côté RPiCamera2

- [ ] Module `remote_camera_backend.py` dans RPiCamera2
- [ ] Interface identique à l'actuel backend libcamera local (drop-in)
- [ ] Gestion reconnexion auto, timeout, fallback gracieux
- [ ] **Critère de succès** : RPiCamera2 capture une image via la mini-cam comme s'il s'agissait du capteur local

### Phase 9 — Power management

- [ ] Détection source d'alim (GPIO de présence USB côté Pi5 vs alim batterie)
- [ ] Lecture tension batterie via ADC I2C (ex. ADS1115) pour jauge sur OLED
- [ ] Le shutdown propre est déjà géré par B3 (long press, voir Phase 6b)
- [ ] Avertissement batterie faible : icône OLED + clignotement
- [ ] **Critère de succès** : aucune corruption SD après 10 cycles batterie

---

## 8. Points d'attention / pièges connus

- **Driver capteur** : utiliser `dtoverlay=imx462,clock-frequency=74250000`. La clock XCLK Innomaker est 74.25 MHz au lieu des 37.125 MHz par défaut — sans ce paramètre, le frontend CSI-2 (Unicam) timeout immédiatement. Libcamera charge automatiquement le fichier de tuning `/usr/share/libcamera/ipa/rpi/vc4/imx462.json`.
- **USB gadget + alimentation** : le port USB du Pi0 doit être en mode OTG ; vérifier `dr_mode = peripheral` dans le DT.
- **RAM** : surveiller `free -h` régulièrement. Objectif < 200 Mo utilisés en mode API actif. Si on dépasse, désactiver agressivement les services non utilisés.
- **Banding horizontal IMX585** : problème connu lié à la qualité d'alim. À surveiller aussi sur IMX462 si on alimente sur batterie — soigner les découplages côté LDO.
- **Conflits libcamera ↔ INDI** : un seul process peut ouvrir le capteur à la fois. La directive `Conflicts=` dans systemd est obligatoire, pas optionnelle.
- **OLED en astrophoto** : luminosité maxi conseillée 30/255. Envisager un filtre rouge physique adhésif sur l'écran pour préserver totalement l'adaptation nocturne. La consommation en veille (~10 µA via commande `0xAE`) permet de laisser l'écran "off" sans le débrancher.
- **Bus I2C partagé** : si on ajoute plus tard un ADC (lecture batterie) ou autre périphérique I2C, tous partagent le même bus. Vérifier les conflits d'adresse (OLED = 0x3C, ADS1115 = 0x48 par défaut, pas de conflit).
- **Alimentation OLED en 5 V (choix délibéré)** : l'OLED est alimenté en 5 V (pin 2 ou 4) et non en 3,3 V (pin 1) pour **préserver la marge du rail 3,3 V interne**, qui alimente aussi le capteur IMX462 Innomaker via la nappe CSI. Le 3,3 V est généré par le régulateur interne du Pi (~500 mA max sur Zero 2 W) et est partagé avec WiFi/BT, SoC, et CSI. Le 5 V vient directement de l'alim externe (LDO ou USB RPi5), plus de marge et découplé du rail sensible du capteur.
- **Niveau logique I2C avec OLED en 5 V** : à vérifier **impérativement avant premier câblage** que les pull-ups I2C du module vont vers 3,3 V et non vers 5 V, sinon risque de destruction du GPIO du Pi (strictement 3,3 V tolérance). Méthode : multimètre sur SDA au repos (OLED alimenté mais aucun trafic I2C). Résultat attendu : ~3,3 V. Si ~5 V : utiliser un level shifter bidirectionnel (type BSS138) sur SDA et SCL. La plupart des modules "3.3V-5V compatible" (dont celui sélectionné) gèrent ça correctement nativement.
- **Câblage OLED final** : VCC→pin 2 (5V) · GND→pin 6 · SDA→pin 3 (GPIO 2) · SCL→pin 5 (GPIO 3).

---

## 9. Documentation et liens utiles

- picamera2 manual : https://datasheets.raspberrypi.com/camera/picamera2-manual.pdf
- indi_pylibcamera : https://github.com/scriptorron/indi_pylibcamera
- USB gadget libcomposite : https://www.kernel.org/doc/Documentation/usb/gadget_configfs.txt
- luma.oled (driver SSD1306) : https://luma-oled.readthedocs.io
- RPiCamera2 (projet parent) : https://github.com/remis-astr/Rpicamera2---Halide

---

## 10. Instructions pour Claude Code

- Lis ce fichier en début de session.
- **Demande confirmation avant** : modification d'un fichier systemd, changement de configuration réseau, opération destructive sur le Pi0.
- Pour toute commande à exécuter sur le Pi0, utilise `ssh pi0 "..."` depuis le RPi5.
- Préfère **rechercher des solutions et les proposer** avant de prendre des initiatives qui modifient l'architecture.
- Mets à jour la checklist des phases au fur et à mesure.
- Si une phase révèle un problème d'architecture, **stoppe et discute** avant de bricoler un contournement.
