# Minicam

Caméra astro / allsky autonome sur **Raspberry Pi Zero 2 W**, pilotée depuis
une page web (téléphone ou PC) servie par le Pi lui-même.

**Minicam = [Multicam](https://github.com/remis-astr/Multicam) + IMU BNO085
et navigation AstroHopper** (voir « IMU et AstroHopper » plus bas). Le reste
du dépôt suit Multicam ; pour reprendre ses mises à jour :

```bash
git remote add multicam https://github.com/remis-astr/Multicam.git  # une fois
git fetch multicam && git merge multicam/master
```

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

- **Navigation AstroHopper** (carte du ciel) orientée par l'IMU BNO085 du
  Pi, sans le gyroscope du téléphone
- Réseau : point d'accès WiFi `MULTICAM` (192.168.4.1, mot de passe
  `multicam`, actif dès le premier démarrage) et liaison USB
  « gadget » Ethernet (192.168.7.3 par défaut, configurable)
- Trames RAW brutes pour un autoguideur externe (`/guide/frame`,
  page `guidage.html`) et relais réseau vers ce contrôleur

- Interface commune à toutes les pages (`web/ui.css`, `web/ui_shell.js`) :
  sur ordinateur, image au centre, acquisition à gauche, réglages à droite
  en onglets, sans défilement de la page ; sur téléphone, image collée en
  haut pendant qu'on règle, onglets dessous et actions en bas (dont le STOP
  de la monture). Mode nuit rouge (interface et images), choix commun aux
  pages. Polices du système : rien n'est chargé depuis internet.

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

## IMU et AstroHopper

Spécifique à Minicam. Fichiers : `opt/minicam/src/minicam/imu.py`
(lecture du BNO085, fusion interne « Game Rotation Vector » ~100 Hz),
`api/routes_imu.py` (`/ws/imu`, calibration de l'accéléromètre) et
`opt/minicam/web/astrohopper/` (page `/astrohopper/astrohopper.html`,
`imu_shim.js` remplace l'orientation du téléphone par celle du Pi).

- **Câblage** : BNO085 en I2C sur GPIO 2 (SDA) et GPIO 3 (SCL), broche ADR à
  la masse (adresse `0x4A`).
- **Bus I2C logiciel n° 8** (le BNO085 étire l'horloge, ce que l'I2C matériel
  du BCM2835 ne supporte pas), dans `config.txt`, section `[all]` :

  ```
  dtoverlay=i2c-gpio,i2c_gpio_sda=2,i2c_gpio_scl=3,i2c_gpio_delay_us=0,bus=8
  ```
- **Bibliothèques** (utilisateur `admin`) :
  `pip install --user --break-system-packages adafruit-circuitpython-bno08x adafruit-extended-bus`
  (installe aussi Blinka).
- **Calibration** : `/home/admin/.config/minicam/imu_cal.json`.
- **Sans IMU** : `[imu] enabled = false` dans `/etc/minicam/config.toml`
  (ni lecture du capteur, ni routes `/ws/imu`, ni `/astrohopper`). Activée par
  défaut ; si le capteur ne répond pas, l'API démarre quand même et abandonne
  l'IMU après quelques essais.

## Lucky Stack — notes

- **Flux caméra** : buffer de 8 images avec contrôle de flux par crédits
  (`{"cmd": "credit"}` sur `/ws/raw`) — le Pi envoie au maximum de ses
  capacités, sans image perdue. Mesuré en USB (IMX477, mode 480p_bin
  852×480, pose 2 ms) : RAW 8 bits ROI 640×480 ≈ 50 img/s (limite du lien
  USB, ~15,5 Mo/s) ; ROI 320×240 ≈ 80 img/s (cadence max du capteur) ;
  RAW 16 bits ≈ 18 img/s ; JPEG ISP ≈ 40 img/s ; RAW 8 bits + zstd sur
  scène texturée ≈ 32 img/s. En mode crédits, l'image suivante est
  capturée/encodée pendant l'envoi de la précédente (capteur, CPU et lien
  travaillent en même temps) ; une capture d'avance n'est jamais annulée
  (elle garde le verrou caméra jusqu'au bout). Les autres pages gardent la
  cadence fixe, une image à la fois.
- **permessage-deflate désactivé** (`[api] ws_deflate = false` par défaut) :
  uvicorn acceptait cette extension proposée par les navigateurs, et
  compressait chaque image en zlib, en Python, sur le Pi — c'était le vrai
  goulot (RAW 8 bits : 12 img/s, et 4 img/s sur une scène texturée).
  `ws_deflate = true` rétablit l'ancien comportement. Option ignorée avec un
  uvicorn trop ancien pour la proposer.
- **RAW 8 bits** : les 8 bits de poids fort sont pris directement dans la
  trame CSI-2 empaquetée (RAW10/RAW12, ROI comprise) sans dépaquetage —
  mêmes octets qu'avant, 4 ms au lieu de 25 ms par image sur Pi Zero 2 W.
- **RAW 16 bits avec ROI** : seuls les groupes de packing qui couvrent le
  ROI sont dépaquetés (`unpack_raw_box`), au lieu de toute l'image puis
  recadrage — résultat identique. ROI 640×480 : 103 → 20 ms en 2028×1080
  10 bits, 929 → 54 ms en 4056×3040 ; flux RAW 16 bits en USB 7 → 20 img/s.
- **Présélection sur le Pi** (menu « Présélection Pi » : désactivée par
  défaut, 50 / 25 / 10 % envoyées) : le Pi mesure la netteté de chaque
  image et n'envoie que les meilleures, la liaison (Wi-Fi surtout) ne
  transporte plus les images que le navigateur aurait rejetées. Score =
  écart-type du Laplacien après `pyrDown` (lissage + réduction 2×) sur le
  disque (> 30 % du max, tout le plan à défaut), divisé par sa luminosité
  moyenne, calculé sur un des deux plans verts du ROI lu en 8 bits de
  poids fort directement dans le RAW empaqueté (~1 ms pour la lecture,
  ~1,8 ms pour le score en 640×480). Le Laplacien du plan brut mesurait
  surtout le bruit : en RAW Bayer, il ne gardait pas plus les meilleures
  images que le hasard ; même
  règle que la sélection du navigateur (percentile des 50 derniers scores,
  5 premières images toujours acceptées). En RAW, chaque image produite
  par la caméra passe par le `post_callback` de picamera2, et 3 threads
  calculent le score dans le buffer caméra sans copie (`MappedArray`) :
  seules les images retenues sont extraites, puis envoyées au rythme des
  crédits (file de 4) ; si les 3 threads sont occupés, l'image n'est pas
  analysée (compteur « non analysées »). JPEG/PNG : capture image par image.
  `/ws/raw` : `{"cmd": "set_preselect", "keep": 0.25}` ; métadonnées
  `presel_keep`, `presel_score`, `presel_analyzed`, `presel_sent`,
  `presel_skipped`, résumées dans les statistiques de la page.
  Mesuré en USB, IMX477, ROI 640×480, 25 % (images analysées/s) : pose
  22,5 ms (capteur 44 img/s) → 44, aucune ratée ; pose 2 ms, `720p_bin`
  (capteur 169 img/s) → 92 (62 en 16 bits), `2028x1080_bin` (75 img/s) →
  64, plein champ 2028×1080 → 31 (17 en capturant image par image). Limite
  restante : le traitement de chaque requête par libcamera/picamera2 —
  même sans aucun calcul, Python ne reçoit que ~130 img/s en `720p_bin` et
  ~230 en `640x480_bin` (capteur 456) ; réduire le flux ISP n'y change
  rien. Une image écartée par le Pi est perdue ; garder une sélection plus
  large côté navigateur (ex. 50 % avec 25 % côté Pi).
- **Compression zstd** (menu Compression, RAW seulement, sans perte) :
  `{"cmd": "set_compression", "codec": "zstd"}` sur `/ws/raw`, chaque image
  porte `"compression"` dans ses métadonnées. Compression par la libzstd du
  système (ctypes, paquet `libzstd1` déjà présent sur Raspberry Pi OS),
  décompression dans le navigateur par `web/fzstd.js` (fzstd 0.1.1, MIT,
  copie locale pour le hotspot sans Internet). Planète sur fond noir :
  300 → 94 Ko (13 ms sur le Pi) ; scène texturée : gain faible. Utile en
  Wi-Fi ; en USB le lien n'est plus le frein et zstd ralentit un peu.
  Une seule capture RAW à la fois (verrou serveur) : deux flux simultanés
  ont figé la caméra (« Camera frontend has timed out »).
- **Sélection des images** (menu « Sélection », choix gardé par le
  navigateur) : *Fenêtre glissante* (défaut, comportement historique) —
  chaque image est comparée aux 50 dernières et empilée si elle est parmi
  les X % meilleures, sans jamais être retirée ; *Pool élite* — le stack
  contient toujours les N images les plus nettes de toute la session : une
  meilleure image remplace la pire, retirée exactement du stack (image
  d'origine gardée en mémoire, réanalysée et recalée avec un poids −1).
  Les curseurs « Meilleures frames (%) » / « Taille du pool (images) »
  s'affichent selon le choix ; mémoire estimée (ROI, profondeur ou SER) et
  plafonnée à ~¼ de la mémoire de l'appareil (1,5 Go max). Mesuré, SER
  Jupiter 832 images : pool de 83 = exactement les 83 meilleures de la
  session, netteté +10 % par rapport à la fenêtre glissante à 10 % (104
  images), 23 s contre 15 s ; retrait vérifié exact (même stack qu'un
  empilement direct des images restées, écart ≤ 0,0001 %).
- **Score de netteté du navigateur** (`cpu_analyze_worker.js`) : écart-type
  du Laplacien sur l'image réduite 2×2 et lissée deux fois par [1 2 1],
  limité au disque (> 30 % du max) et divisé par sa luminosité moyenne —
  il mesure les détails de la planète, pas le bruit des pixels ni du
  débayérisage, et ne dépend pas de la transparence. Comparé hors ligne à
  12 scores (Sobel, Tenengrad, FFT, différence de gaussiennes…) sur 5 SER
  de Jupiter (RGB et RAW Bayer) : le meilleur sur toutes ; l'ancien
  Laplacien pleine résolution ne faisait pas mieux qu'une sélection au
  hasard parmi les images gardées par le Pi. ~0,8 ms en 288×288.
- **Recentrage avant alignement** : le barycentre du disque, calculé avec le
  score, donne le décalage de chaque image par rapport à la référence ; les
  points d'alignement sont cherchés autour de cette position (`searchOffset`)
  et le décalage est appliqué à toute l'image (`globalOffsetX/Y` du shader
  d'empilement, aussi loin des points). Une dérive du suivi plus grande que
  le rayon de recherche est donc rattrapée ; le rayon (16 px par défaut) ne
  couvre que la turbulence. Si le disque touche le bord (planète qui sort
  du cadre, surface lunaire), son barycentre est ignoré et le dernier
  décalage connu est gardé. Vérifié sur un SER avec 100 px de dérive
  ajoutée : stack identique à celui du SER d'origine (GPU et CPU), alors
  que l'ancien code l'étalait.
- **Cible Surface** (menu « Cible », choix gardé par le navigateur) : Lune
  ou Soleil en gros plan, disque partiel — la zone éclairée touche les
  bords, pas de barycentre. Le décalage vient de la corrélation de phase
  entre l'image réduite (côté ≤ 128 px, fenêtre de Hann, FFT 2D) et la
  référence, calculée dans le worker d'analyse pour les seules images
  acceptées (~8 ms en 640×480) ; pic trop bas → dernier décalage connu.
  Précision < 1 px jusqu'à 150 × 100 px de décalage. Vérifié sur une
  vidéo de la Lune (fenêtres 640×480 d'un MP4 4032×3024) : corrélation
  des détails du stack avec l'image source 0,82 avec ou sans 75 px de
  dérive ajoutée, contre 0,58 / 0,47 pour l'ancien code (rayon 32) et
  0,40 en cible Planète ; au limbe 0,96 contre 0,85 en cible Planète.
- **Exposition et rendu des planètes** : sous les statistiques, niveau max
  et part des pixels du disque écrêtés (≥ 98 %) sur les 50 dernières images
  — en RAW c'est le capteur (alerte au-delà de 90 %, viser 60–75 % : ce
  qui est écrêté est perdu), en JPEG/PNG la sortie de l'ISP. Point blanc
  pris sur les pixels du disque et sur le canal le plus haut **après** la
  balance des blancs : en RAW (vert dominant, gains R/B nettement > 1),
  le point blanc calculé sur la luminance avant les gains laissait R et B
  déborder et la zone équatoriale partait au blanc (SER SharpCap : 7 043
  pixels écrêtés à l'affichage → 40). Curseur Gamma (> 1 assombrit les
  tons moyens, 1,4–1,8 pour Jupiter en RAW ; l'ISP applique l'inverse).
  Niveau de noir du capteur (`black_level` du Pi) retiré au rendu en RAW,
  avant la balance des blancs ; le stack et le FITS restent bruts. Le Live
  Stack garde l'ancien point blanc.
- **Fichier SER / MP4** : rejoue un fichier local (lu dans le navigateur, rien
  n'est envoyé au Pi) à la place de la caméra. SER : mono, Bayer, RGB/BGR,
  8/16 bits. MP4/MOV (H.264) : démultiplexage maison (tables
  d'échantillons du `moov`) et décodage WebCodecs, matériel si possible ;
  toutes les images dans l'ordre, aucune sautée ; vidéo tronquée →
  empilement des images lisibles. Une vidéo 4K est réduite (÷1 à ÷4, par
  défaut la première ≤ ~2 Mpx) puis recadrée au centre, choix faits au
  chargement. Mesuré sur une Lune 4032×3024 de 614 images (RX 570) :
  ÷3 en 2 min 50, ÷2 en 4 min 26, pleine résolution en 11 min 47 (analyse
  CPU 0,7 s et aperçu 3,6 s par image dominent). Sur cette vidéo, le
  spectre d'une image garde du signal jusqu'à ~0,3 cycle/px : ÷2 ne perd
  presque rien, ÷3 coupe une bande que l'empilement aurait pu révéler.
  WebCodecs exige le HTTPS (port 8443), comme WebGPU.
- **Déformation locale** : le décalage de chaque pixel est la moyenne des
  points d'alignement voisins pondérée par une gaussienne qui tombe à zéro
  au rayon d'influence (4 × patch = 80 px), plus un petit poids « pas de
  décalage local » : un point isolé (voisins rejetés sur une zone sombre
  ou peu contrastée) s'estompe vers le recentrage global au lieu de
  découper un disque de 160 px, d'où les ronds sur la Lune. Index spatial
  des points (grille de 80 px) : chaque pixel ne parcourt que les 3×3
  cellules voisines au lieu de tous les points, sinon le coût croît comme
  le carré de la résolution. Sur deux SER de Jupiter 640×480 (RGB et
  Bayer), stack à 0,08 et 0,17 % de l'ancien, netteté inchangée.
- **Traitement** : étirement linéaire par défaut (arcsinh réservé au ciel
  profond), contraste (courbe en S) ; ondelettes à trous (4 couches +
  débruitage) et CLAHE appliqués **à la fin** du stack (SER terminé ou
  ■ Arrêter), qui garde l'image et laisse tous les réglages actifs — ou
  pendant l'empilement avec la case « Accentuation en direct » (choix gardé
  par le navigateur ; calcul sur le processeur, pas sur WebGPU : ~0,1–0,3 s
  par aperçu en 640×480, jusqu'à ~2,5 s en 2028×1080 plein champ). PNG =
  image traitée, FITS = stack brut. CLAHE : facteur borné pour qu'aucun
  canal ne dépasse 255 (sinon la couleur vire au blanc). **Saturation**
  (0–300 %, 100 % = inchangée, en direct) : écarte les canaux de la
  luminance sans changer luminance ni teinte, sans écrêtage — compense
  l'aspect délavé que donne CLAHE en éclaircissant. Le curseur de point
  blanc s'appelait auparavant « Saturation (percentile blanc) ».
- **GPU émulé** : si Chrome n'obtient que SwiftShader (Linux sans Vulkan
  activé), le stacker l'écarte et calcule sur CPU ; l'avertissement orange
  des pages Lucky/Live Stack le signale (avant, il n'apparaissait que sans
  WebGPU du tout). Activer `chrome://flags/#enable-vulkan` et
  `#enable-unsafe-webgpu`, puis relancer Chrome.
- **WebGPU** : Chrome ne l'expose que sur une page sûre (HTTPS ou
  `localhost`). La page étant en HTTP : `ssh -N -L 8000:localhost:8000
  admin@<ip>` puis `http://localhost:8000/…`, ou
  `chrome://flags/#unsafely-treat-insecure-origin-as-secure`. Sous Linux,
  activer aussi `#enable-unsafe-webgpu` et `#enable-vulkan`, sinon Chrome
  fournit SwiftShader (GPU émulé, bien plus lent que les workers CPU : le
  stacker le refuse). La console indique `[Stacker] GPU=… (carte)` et, à la
  fin, la durée de chaque étape.

## Live Stack (ciel profond) — notes

- **Test DNG** : rejoue une série de DNG locaux (rpicam-still / picamera2,
  CFA non compressé 8/16 bits) à la place de la caméra, dans l'ordre
  naturel des noms (`…_2` avant `…_10`) ; lus dans le navigateur, rien n'est
  envoyé au Pi (`web/dng_file_source.js`). Niveau de noir, niveau blanc et
  pose lus dans le fichier (l'IFD Exif de rpicam est en fin de fichier). Un
  fichier à l'en-tête abîmé est ignoré.
- **Test FITS** (`web/fits_file_source.js`, même champ « Fichiers » que les
  DNG ; une série d'un seul type) : HDU principal, BITPIX 8/16/32/−32/−64,
  BZERO/BSCALE ; brut Bayer (`BAYERPAT`, décalé par `XBAYROFF`/`YBAYROFF`),
  mono, ou RGB débayérisé (3 plans, ex. conversion Siril) — le moteur traite
  alors chaque plan (bruit de ligne, pixels chauds, drizzle, rejet σ ; pas
  d'égalisation des verts) et détecte les étoiles sur la luminance. Lignes
  prises dans l'ordre du fichier. Profondeur : `BITDEPTH`, sinon la plus
  grande plausible d'après le maximum du 1er fichier (12 bits ≤ 4095, 14 bits
  ≤ 16383, sinon 16 ; surestimer n'écrête pas). Noir : `BLKLEVEL` ou
  `PEDESTAL`, sinon valeur du capteur `INSTRUME` (16 bits décalés, 12 ou
  10 bits natifs : la plus grande ≤ 1,3 × 0,5e centile du fond). L'export
  FITS de la Multicam écrit désormais `BLKLEVEL` et `BITDEPTH` (fichiers
  autonomes). Mesuré sur M31 (IMX477 4056×2160, 25 s) : 30 FITS Bayer de
  la Multicam et 20 FITS RGB Siril empilés, résidu 0,2 px, ~1 s/image
  (Bayer), ~2,8 s/image (RGB, 3 plans) sur RX 570. Un obstacle présent dans
  les images (câble électrique…) reste dans le stack : le rejet σ, tolérant
  vers le bas (κ = 5) et actif après 10 images, ne retire que ce qui ne
  revient pas d'une image à l'autre.
- **Détection d'étoiles et alignement** (`web/star_align.js`) : luminance binnée 2×2, fond par blocs (moyenne
  à rejet σ + médiane 3×3), filtre gaussien, maxima locaux à 5σ, centroïde
  sub-pixel, FWHM, allongement, saturation — sur GPU (WebGPU), avec une
  version CPU identique (repli et référence). Appariement par triangles
  d'étoiles + RANSAC (rotation + translation, ou affine), insensible aux
  grands sauts de dérive et aux recadrages. Mesuré sur 312 DNG de M27
  (IMX462 1920×1080, RX 570) : détection GPU ≈ 7 ms (CPU ≈ 150–200 ms,
  mêmes étoiles à 0,0001 px), appariement ≈ 5 ms, 312/312 images alignées
  (dérive jusqu'à ~380 px, recadrage de −5,9°), résidu médian 0,57 px.
- **Empilement** (`web/dso_stacker.js`, case « Alignement étoiles » = mode
  `alignMode: 'stars'`), directement sur les **pixels bruts Bayer** (le
  stacker les envoie au worker d'empilement, sans débayérisage), sur GPU ou
  à l'identique sur CPU. Pour chaque image :
  1. bruit de ligne retiré (décalage propre à chaque ligne et couleur,
     mesuré contre les lignes voisines de même couleur, hors étoiles),
     pixels chauds / morts corrigés (8 voisins de même couleur ; le
     critère épargne le cœur des étoiles), égalisation locale des deux
     verts Bayer (Gr/Gb). Sans dithering (caméra fixe, monture guidée),
     ces motifs fixes du capteur ne se moyennent pas : IMX477 binné,
     écart Gr/Gb de 1 à 2 % → grille de 2 px (×132 dans le spectre, ×6
     une fois corrigée), bruit de ligne de période 8 lignes (5,7 → 1,2 ADU) ;
  2. niveau de noir soustrait (DNG : `BlackLevel` ; caméra : `black_level`
     des métadonnées `/ws/raw`, tiré de `SensorBlackLevels`), détection
     des étoiles, appariement avec la référence ; image rejetée si
     l'alignement échoue ou si moins de 15 % des étoiles sont appariées
     (scène sans étoiles : faux appariements) ;
  3. normalisation photométrique (facteur = médiane des rapports de flux
     des étoiles appariées : poses différentes, voile) puis fond de ciel
     ramené à celui de la référence, par couleur et localement (carte de
     fond de la détection, recalée) ;
  4. poids ∝ (σ_réf / (k·σ))² × min(1, (FWHM_réf / FWHM)²) ;
  5. **drizzle Bayer** : chaque pixel brut déposé dans son canal à sa
     position recalée (goutte `pixfrac` = 1) — pas de franges colorées, pas
     de flou d'interpolation ;
  6. **rejet σ au fil de l'eau** (Welford par pixel et par canal, après
     10 images) : κ = 3 au-dessus (satellites, avions, rayons cosmiques),
     5 en dessous, tolérance de 15 % du signal (turbulence sur les étoiles) ;
  7. la meilleure (FWHM) des 5 premières images devient la référence.

  Affichage : menu **Étirement** (`web/auto_stretch.js`), **Auto** par
  défaut, **Manuel** = réglages historiques (percentile noir, arcsinh β,
  point blanc, « Fond neutre » : médianes R, G, B égalisées).
  Auto : arcsinh à couleurs préservées (courbe calculée sur la luminance,
  R, G, B multipliés par le même facteur : le cœur des galaxies ne délave
  plus en blanc), noir de chaque canal à médiane − 2,8 σ (MAD) donc fond
  neutre, balance des blancs sur le signal (étoiles + objet > 10 σ, non
  saturés), β choisi pour que le fond tombe au niveau « Fond ». Fond
  automatique : 10 % au premier aperçu, monte à 18 % quand le bruit du
  stack a baissé d'un facteur 5 (≈ 25 images), sinon fixé au curseur
  (5–30 %). Statistiques lissées d'un aperçu à l'autre. « Contraste local »
  (curseur 0–150 %, 80 % par défaut, 0 = désactivé, les deux modes) :
  renforce les structures larges (flou large calculé sur l'image réduite
  ÷4, hautes lumières protégées ; en Manuel, appliqué à l'image étirée,
  ≈ 0,6 s en 4K). « Retirer le vert »
  (les deux modes, coché par défaut) : SCNR neutre moyen calculé sur les
  moyennes locales (≈ 12 px) et appliqué comme facteur doux, luminosité
  conservée ; un SCNR pixel par pixel remplaçait le vert, canal le moins
  bruité, par le bruit du rouge et du bleu (grain du cœur de M31 +35 %,
  noyau aplati). Choix mémorisés
  dans le navigateur (`live.*`). Coût mesuré sur 4056×2160 : ≈ 2,4 s par
  aperçu avec contraste local et retrait du vert (2,9 s pour l'ancien étirement), quatre fois
  moins en 1080p. Lucky Stack n'est pas concerné. Le FITS reste brut.
  Saturation des couleurs dans les deux modes. Aperçu pendant
  l'empilement : au plus toutes les 500 ms ET au moins 2× la durée du
  dernier rendu, comptés depuis sa fin (l'aperçu bloque le pipeline : il
  passait sinon après chaque image). Le débayérisage MHC de l'instantané
  (`demosaicBlend`) prenait ~15 s en 4056×2160 et repoussait l'aperçu
  suivant de plus de 30 s : l'écran restait sur la première image jusqu'à
  ■ Arrêter. Noyaux déroulés à l'intérieur de l'image (bords inchangés),
  résultat identique au bit près : instantané 22 → 2,1 s, aperçu complet
  ≈ 5,5 s dans Chrome, soit un aperçu toutes les ~11 s en 4K. Tris des
  percentiles en tableaux typés (étirement Manuel 4K : 2,9 → 1,4 s). ■ Arrêter (ou fin des DNG) relit le stack complet et le garde :
  étirement, point blanc, saturation, fond neutre et exports PNG/FITS
  restent actifs ; ▶ Démarrer ou ↺ Reset l'oublient. Case « Alignement étoiles » décochée :
  même empilement sans recalage (monture guidée) ; grisée pendant
  l'empilement. Au bureau (scène sans étoiles), laisser l'alignement coché
  rejette les images : c'est voulu.
- **Tous capteurs** : menu « Mode capteur » rempli depuis le profil du
  capteur branché (dimensions réelles livrées, statut `/ws/control` :
  `raw_modes_info`), ROI limité aux recadrages qui tiennent dans le mode ;
  les deux sont grisés pendant l'empilement. Mêmes libellés (« nom — L×H
  (binning) ») et mêmes règles sur la page principale, Lucky Stack
  (recadrages planétaires jusqu'à 256×256) et Live Stack (jusqu'à
  512×512) — fonctions communes de `web/ui_common.js`. Niveau de noir : celui que
  libcamera renvoie (`SensorBlackLevels`, = `rpi.black_level` des fichiers
  de réglage : 3840 IMX290/327/462, 4096 IMX477, 3200 IMX585/662/678),
  sinon `black_level` du profil (`sensors.py`). Flux 8 ou 16 bits, RAW10 ou
  RAW12. Grands modes (IMX477 natif 4056×3040, IMX585/678 3856×2180) :
  accumulateurs en bandes de lignes selon les limites WebGPU de l'appareil
  (4 bandes avec les limites par défaut de 128/256 Mo, résultat identique
  à une bande) ; ~4 s par image en 4056×3040 sur RX 570. Mesuré, 312 DNG M27 sur RX 570 : 312/312 empilées, 60 ms par
  image (Chrome sans GPU : ~3 s), FWHM du stack 7,07 px (7,23 px avec
  l'ancien débayérisage + recalage bilinéaire), traînée de satellite et
  points de pixels chauds/rayons cosmiques supprimés ; ~130 pixels chauds
  corrigés par image ; GPU = CPU aux décisions de seuil près (42 pixels sur
  6,2 millions sur 15 images).

## HTTPS (WebGPU sur téléphone et tablette)

Les navigateurs n'exposent WebGPU que sur une page sûre (HTTPS ou
`localhost`) : sans HTTPS, un téléphone sur le hotspot calcule tout sur son
processeur. Le HTTP (port 8000) reste disponible et inchangé ; le HTTPS
s'ajoute sur un second port, dans le même service (une seule caméra). Les
pages choisissent `wss://` ou `ws://` selon leur protocole.

1. Sur le Pi : `sudo minicam-tls-setup` — crée l'autorité de
   certification « Multicam CA » (`/etc/minicam/tls/ca.crt` + `ca.key`,
   10 ans, faite une seule fois) et le certificat du serveur (825 jours, maximum
   accepté par iOS) pour `localhost`, le nom d'hôte, `<hôte>.local`, l'IP
   USB de `config.toml` et le hotspot 192.168.4.1. Noms ou IP en plus
   (adresse sur la box…) : `sudo minicam-tls-setup 192.168.1.42`. Relancer
   le script réémet le certificat serveur avec la même autorité, sans rien
   refaire sur les appareils.
   **Plusieurs Multicam** : utiliser la même autorité sur toutes, pour
   qu'un appareil n'installe qu'un seul certificat, valable pour toutes.
   Sauvegarder `ca.crt` et `ca.key` de la première carte (sur le PC :
   `ssh admin@<ip> 'sudo cat /etc/minicam/tls/ca.key' > ca.key`, idem
   `ca.crt`), les copier sur chaque autre carte puis
   `sudo minicam-tls-setup --ca <dossier>` (clé vérifiée contre le
   certificat). `ca.key` est secrète — qui la possède peut fabriquer des
   certificats que vos appareils accepteront : ne jamais la publier ni la
   mettre dans le dépôt (`*.key` est dans `.gitignore`) ; chaque utilisateur
   du projet crée la sienne.
2. `/etc/minicam/config.toml` : `[api]` `https_port = 8443`, puis
   `sudo systemctl restart minicam-api`.
3. Sur chaque appareil, une fois : ouvrir `http://<ip>:8000/ca.crt`.
   - Android : Paramètres → Sécurité → Chiffrement et identifiants →
     Installer un certificat → Certificat CA → choisir `multicam-ca.crt`.
   - iPhone/iPad : autoriser le profil téléchargé (Réglages → Profil
     téléchargé → Installer), puis Réglages → Général → Informations →
     Réglages des certificats → activer la confiance totale pour
     « Multicam … CA ».
   - PC : importer `multicam-ca.crt` comme autorité dans le navigateur.
4. Ouvrir `https://192.168.4.1:8443/` (hotspot) ou `https://<ip USB>:8443/`.

Chiffrement : le Pi Zero 2 W n'a pas d'instructions AES (AES-GCM ~27 Mo/s
contre ~166 Mo/s pour ChaCha20-Poly1305), le serveur impose donc TLS 1.2 +
ECDHE-ChaCha20-Poly1305 (AES-GCM en secours). Mesuré en USB, RAW 8 bits
640×480 : 44 img/s (13,5 Mo/s) en HTTPS contre 51 img/s en HTTP (28 img/s
en TLS 1.3 AES-256-GCM) — au-dessus du débit du Wi-Fi. WebGPU demande aussi
un navigateur qui le prend en charge (Chrome Android 12+, Safari iOS
récent…) ; sous Linux, Chrome reste à débloquer (voir « GPU émulé »).

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
| `usr/local/bin/minicam-tls-setup` | `/usr/local/bin/` (mode 755, facultatif : HTTPS) |
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

[api]                 # facultatif
ws_deflate = false    # true = compression zlib WebSocket (ancien comportement, lent)
https_port = 0        # 8443 = HTTPS en plus du HTTP (voir « HTTPS » ci-dessous)
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
mkdir -p /timelapse /photos /var/lib/minicam && chown admin:admin /timelapse /photos /var/lib/minicam
# /photos : photos et FITS de capture (sans lui, /capture.fits répond 500)
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
  À la dernière relance, l'API revient au mode capteur par défaut : un mode
  mémorisé trop gros pour la CMA ne bloque plus la caméra à chaque
  démarrage.
- Modes de plus de 5 Mpx (IMX477 natif 4056×3040…) : le flux ISP « main »
  est en YUV420 avec 2 buffers (converti en BGR à la capture). En RGB888,
  un seul buffer natif fait 37 Mo et même 2 buffers ne s'allouaient pas
  (~135 Mo de CMA libres après le démarrage).
- Aperçu de la page principale : réduit à 2028 px de large avant
  l'encodage JPEG (le canevas est à la taille de l'écran ; stacks, photos et
  timelapse gardent la pleine résolution), capture et encodage hors de la
  boucle asyncio — en natif, l'encodage d'un JPEG de 12 Mpx (0,4 à 4 s)
  gelait tout le serveur. Côté navigateur, une seule boucle d'aperçu (pause
  de 1 s sur une réponse 503) : une reconnexion `/ws/control` en chaîne en
  relançait une de plus toutes les 5 s, jusqu'à ~150 requêtes/s.
- Message « capteur détecté incompatible avec le profil … RAW attendu … » :
  pilote patché absent ou écrasé par une mise à jour du noyau (étape 7).

## Licences

- Code Minicam / Multicam : **GPL-3.0** (`LICENSE`)
- AstroHopper (Artyom Beilis) : **Apache 2.0**
- Catalogue d'étoiles (Eleanor Lutz) : **GPL**
- VSOP87 (Greg Miller) : **domaine public**

Détail des attributions : `opt/minicam/web/astrohopper/NOTICE`.
