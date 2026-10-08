// cpu_analyze_worker.js — fallback CPU pour webgpu_analyze_worker.js
// Même protocole de messages, implémentation pure JavaScript.
// Supporte : init, crop-analyze-batch, cleanup.
'use strict';

console.log('[cpu_analyze] worker loaded');

let initialized = false;

// ── Debayer bilinéaire RGGB (pattern 0) ────────────────────────────────────
// Retourne Float32Array RGBA (w×h×4, valeurs 0–1).
// data : Uint16Array (16-bit, inv=1/65535) ou Uint8Array (8-bit, inv=1/255)
function debayer(data, srcW, srcH, cropX, cropY, cropW, cropH, pattern, bitDepth = 16) {
    const out = new Float32Array(cropW * cropH * 4);
    const inv = bitDepth === 8 ? 1.0 / 255.0 : 1.0 / 65535.0;
    const W1 = srcW - 1, H1 = srcH - 1;

    // Offset de couleur selon le pattern (quel canal est en (0,0))
    // pattern: 0=RGGB, 1=BGGR, 2=GRBG, 3=GBRG
    const CHAN = [
        [0, 1, 1, 2],  // RGGB: (ee)=R,(oe)=G,(eo)=G,(oo)=B
        [2, 1, 1, 0],  // BGGR: (ee)=B,(oe)=G,(eo)=G,(oo)=R
        [1, 0, 2, 1],  // GRBG: (ee)=G,(oe)=R,(eo)=B,(oo)=G
        [1, 2, 0, 1],  // GBRG: (ee)=G,(oe)=B,(eo)=R,(oo)=G
    ];
    const chan = CHAN[pattern] ?? CHAN[0];

    for (let cy = 0; cy < cropH; cy++) {
        const sy = cropY + cy;
        for (let cx = 0; cx < cropW; cx++) {
            const sx = cropX + cx;
            const xm = sx > 0 ? sx - 1 : sx;
            const xp = sx < W1 ? sx + 1 : sx;
            const ym = sy > 0 ? sy - 1 : sy;
            const yp = sy < H1 ? sy + 1 : sy;

            const c = data[sy * srcW + sx];   // centre
            const h = (data[sy * srcW + xm] + data[sy * srcW + xp]) * 0.5;
            const v = (data[ym * srcW + sx]  + data[yp * srcW + sx]) * 0.5;
            const d = (data[ym * srcW + xm]  + data[ym * srcW + xp] +
                       data[yp * srcW + xm]  + data[yp * srcW + xp]) * 0.25;

            const quad = ((sx & 1) | ((sy & 1) << 1));  // 0..3
            // Pour chaque quad, déterminer R, G, B en fonction du canal courant
            let r, g, b;
            switch (chan[quad]) {
                case 0: r = c;  g = (h + v) * 0.5;  b = d;  break; // pixel = R
                case 2: r = d;  g = (h + v) * 0.5;  b = c;  break; // pixel = B
                default:  // pixel = G sur ligne R ou B
                    if (chan[quad ^ 1] === 0) {
                        r = h; g = c; b = v;   // G sur ligne R → R voisins H, B voisins V
                    } else {
                        r = v; g = c; b = h;   // G sur ligne B → R voisins V, B voisins H
                    }
                    break;
            }

            const i = (cy * cropW + cx) * 4;
            out[i]     = r * inv;
            out[i + 1] = g * inv;
            out[i + 2] = b * inv;
            out[i + 3] = 1.0;
        }
    }
    return out;
}

// ── Netteté + barycentre du disque ─────────────────────────────────────────
// Score : écart-type du Laplacien sur l'image réduite 2×2 (somme des 4 pixels)
// lissée deux fois par [1 2 1], limité au disque (> 30 % du max) et divisé par
// sa luminosité moyenne. À cette échelle le Laplacien voit les détails de la
// planète, pas le bruit des pixels ni celui du débayérisage, et la
// normalisation rend le score insensible à la transparence. Comparé sur 5 SER
// de Jupiter (RGB et RAW Bayer) au Laplacien pleine résolution, qui ne faisait
// pas mieux qu'une sélection au hasard. ~0,8 ms en 288×288.
// center : barycentre du disque en pixels pleine résolution, null quand le
// disque touche le bord (planète qui sort du cadre, surface lunaire ou
// solaire) — il ne suivrait plus la dérive et fausserait le recentrage.
// peak / clipped : niveau maximal (canal le plus haut, 0–1) et part des
// pixels du disque à ≥ 98 % de la pleine échelle — indicateur de saturation
// pour régler la pose (en RAW, ce qui est écrêté est perdu).
function sharpnessAndGray(rgba, w, h) {
    const n = w * h;
    const gray8 = new Uint8Array(n);
    const bw = w >> 1, bh = h >> 1;
    if (bw < 8 || bh < 8) {
        for (let i = 0; i < n; i++)
            gray8[i] = (0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2]) * 255 + 0.5;
        return { sharpness: 0, center: null, peak: 0, clipped: 0, gray8 };
    }

    // Luminance + réduction 2×2 en une passe, niveau max et pixels saturés
    let a = new Float32Array(bw * bh), t = new Float32Array(bw * bh);
    let peak = 0, nSat = 0;
    for (let y = 0; y < h; y++) {
        const by = y >> 1, row = by < bh ? by * bw : -1;
        for (let x = 0; x < w; x++) {
            const i = y * w + x;
            const r = rgba[i * 4], gg = rgba[i * 4 + 1], b = rgba[i * 4 + 2];
            const m = r > gg ? (r > b ? r : b) : (gg > b ? gg : b);
            if (m > peak) peak = m;
            if (m >= 0.98) nSat++;
            const g = 0.299 * r + 0.587 * gg + 0.114 * b;
            gray8[i] = g * 255 + 0.5;
            const bx = x >> 1;
            if (row >= 0 && bx < bw) a[row + bx] += g;
        }
    }
    // Deux lissages [1 2 1] séparables (bords recopiés)
    for (let p = 0; p < 2; p++) {
        for (let y = 0; y < bh; y++) {
            const o = y * bw;
            t[o] = a[o]; t[o + bw - 1] = a[o + bw - 1];
            for (let x = 1; x < bw - 1; x++) t[o + x] = 0.25 * a[o + x - 1] + 0.5 * a[o + x] + 0.25 * a[o + x + 1];
        }
        for (let x = 0; x < bw; x++) { a[x] = t[x]; a[(bh - 1) * bw + x] = t[(bh - 1) * bw + x]; }
        for (let y = 1; y < bh - 1; y++) {
            const o = y * bw;
            for (let x = 0; x < bw; x++) a[o + x] = 0.25 * t[o + x - bw] + 0.5 * t[o + x] + 0.25 * t[o + x + bw];
        }
    }

    let max = 0;
    for (let i = 0; i < a.length; i++) if (a[i] > max) max = a[i];
    const thr = 0.3 * max;
    let sum = 0, sq = 0, sv = 0, cnt = 0, cx = 0, cy = 0, touches = false;
    for (let y = 1; y < bh - 1; y++) {
        for (let x = 1; x < bw - 1; x++) {
            const i = y * bw + x, v = a[i];
            if (v <= thr) continue;
            const lap = 4 * v - a[i - 1] - a[i + 1] - a[i - bw] - a[i + bw];
            sum += lap; sq += lap * lap; sv += v; cnt++;
            cx += v * x; cy += v * y;
            if (x <= 2 || y <= 2 || x >= bw - 3 || y >= bh - 3) touches = true;
        }
    }
    if (!cnt || sv <= 0) return { sharpness: 0, center: null, peak, clipped: 0, gray8 };
    const mean = sum / cnt;
    const sharpness = Math.sqrt(Math.max(0, sq / cnt - mean * mean)) / (sv / cnt);
    // pixel réduit x couvre les pixels 2x et 2x+1 → centre en 2x + 0,5
    const center = touches ? null : { x: 2 * cx / sv + 0.5, y: 2 * cy / sv + 0.5 };
    // cnt pixels réduits = 4 × cnt pixels du disque
    return { sharpness, center, peak, clipped: Math.min(1, nSat / (4 * cnt)), gray8 };
}

// ── Décodage JPEG/PNG (déjà débayerisé côté ISP) ───────────────────────────
// Retourne { sharpness, center, peak, clipped, float32Buffer, packedGrayBuffer, width, height },
// même forme que le chemin Bayer ci-dessus — décodage via createImageBitmap
// (dispo dans les module workers) + OffscreenCanvas, pas de debayer() ici.
async function analyzeImageBytes(bytes, mimeType, cropSize, width, height) {
    if (mimeType === 'image/x-rgba') return analyzeRgba8(bytes, width, height);
    const blob   = new Blob([bytes], { type: mimeType });
    const bitmap = await createImageBitmap(blob);
    const srcW = bitmap.width, srcH = bitmap.height;
    const cropW = Math.min(cropSize ?? srcW, srcW);
    const cropH = Math.min(cropSize ?? srcH, srcH);
    const cropX = Math.max(0, Math.round((srcW - cropW) / 2));
    const cropY = Math.max(0, Math.round((srcH - cropH) / 2));

    const canvas = new OffscreenCanvas(cropW, cropH);
    const ctx    = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bitmap, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);
    bitmap.close();
    const { data: rgba8 } = ctx.getImageData(0, 0, cropW, cropH);

    const n   = cropW * cropH;
    const rgba = new Float32Array(n * 4);
    const inv  = 1 / 255;
    for (let i = 0; i < n * 4; i++) rgba[i] = rgba8[i] * inv;

    const { sharpness, center, peak, clipped, gray8 } = sharpnessAndGray(rgba, cropW, cropH);
    return { sharpness, center, peak, clipped, float32Buffer: rgba.buffer, packedGrayBuffer: gray8.buffer, width: cropW, height: cropH };
}

// Pixels RGBA 8 bits déjà en mémoire (ex. SER RGB rejoué) : pas d'aller-retour
// PNG, même sortie que analyzeImageBytes (plein champ, pas de recadrage).
function analyzeRgba8(rgba8, w, h) {
    const n    = w * h;
    const rgba = new Float32Array(n * 4);
    const inv  = 1 / 255;
    for (let i = 0; i < n * 4; i++) rgba[i] = rgba8[i] * inv;
    const { sharpness, center, peak, clipped, gray8 } = sharpnessAndGray(rgba, w, h);
    return { sharpness, center, peak, clipped, float32Buffer: rgba.buffer, packedGrayBuffer: gray8.buffer, width: w, height: h };
}

// ── Décalage global par corrélation de phase (cible « surface ») ───────────
// Sur la Lune ou le Soleil en gros plan, la zone éclairée touche les bords :
// pas de barycentre fiable pour recentrer. Le décalage image − référence est
// alors le pic de la corrélation de phase entre les deux images réduites
// (côté ≤ 128 px, fenêtre de Hann, FFT 2D) : insensible aux variations de
// luminosité, trouve en une passe une dérive jusqu'à ~1/4 du champ.
// Précision ~1–2 px pleine résolution (affinée par les points d'alignement).
// Demandée par le stacker pour les seules images acceptées (~8 ms en 640×480).
let shiftRef = null;   // { w, h, f, bw, bh, nx, ny, re, im } : spectre de la référence
const _fftTables = new Map();

function _fftTable(n) {
    let t = _fftTables.get(n);
    if (t) return t;
    const bits = Math.log2(n), rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
        let r = 0;
        for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
        rev[i] = r;
    }
    const cos = new Float64Array(n / 2), sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos(2 * Math.PI * i / n); sin[i] = Math.sin(2 * Math.PI * i / n); }
    t = { rev, cos, sin };
    _fftTables.set(n, t);
    return t;
}

// FFT radix 2 en place de n valeurs complexes (pas `stride` à partir de off) ;
// inv : transformée inverse non normalisée
function _fft1(re, im, off, stride, n, inv) {
    const { rev, cos, sin } = _fftTable(n);
    for (let i = 0; i < n; i++) {
        const j = rev[i];
        if (j > i) {
            const a = off + i * stride, b = off + j * stride;
            let t = re[a]; re[a] = re[b]; re[b] = t;
            t = im[a]; im[a] = im[b]; im[b] = t;
        }
    }
    const sg = inv ? 1 : -1;
    for (let size = 2; size <= n; size <<= 1) {
        const half = size >> 1, step = n / size;
        for (let s = 0; s < n; s += size) {
            for (let k = 0; k < half; k++) {
                const c = cos[k * step], sn = sg * sin[k * step];
                const a = off + (s + k) * stride, b = a + half * stride;
                const tr = re[b] * c - im[b] * sn, ti = re[b] * sn + im[b] * c;
                re[b] = re[a] - tr; im[b] = im[a] - ti;
                re[a] += tr; im[a] += ti;
            }
        }
    }
}

function _fft2(re, im, nx, ny, inv) {
    for (let y = 0; y < ny; y++) _fft1(re, im, y * nx, 1, nx, inv);
    for (let x = 0; x < nx; x++) _fft1(re, im, x, nx, ny, inv);
}

// Image 8 bits → réduite par blocs f×f, moyenne retirée, fenêtre de Hann,
// placée dans un tableau nx×ny complété de zéros, puis FFT
function _spectrum(gray, w, h, f, bw, bh, nx, ny) {
    const re = new Float64Array(nx * ny), im = new Float64Array(nx * ny);
    let sum = 0;
    for (let y = 0; y < bh; y++) {
        for (let x = 0; x < bw; x++) {
            let v = 0;
            for (let j = 0; j < f; j++) {
                const row = (y * f + j) * w + x * f;
                for (let i = 0; i < f; i++) v += gray[row + i];
            }
            re[y * nx + x] = v;
            sum += v;
        }
    }
    const mean = sum / (bw * bh);
    for (let y = 0; y < bh; y++) {
        const wy = 0.5 - 0.5 * Math.cos(2 * Math.PI * (y + 0.5) / bh);
        for (let x = 0; x < bw; x++) {
            const wx = 0.5 - 0.5 * Math.cos(2 * Math.PI * (x + 0.5) / bw);
            re[y * nx + x] = (re[y * nx + x] - mean) * wx * wy;
        }
    }
    _fft2(re, im, nx, ny, false);
    return { re, im };
}

function setShiftReference(gray, w, h) {
    if (!gray) { shiftRef = null; return; }
    const f  = Math.max(1, Math.ceil(Math.max(w, h) / 128));
    const bw = Math.floor(w / f), bh = Math.floor(h / f);
    if (bw < 16 || bh < 16) { shiftRef = null; return; }
    const nx = 1 << Math.ceil(Math.log2(bw)), ny = 1 << Math.ceil(Math.log2(bh));
    const { re, im } = _spectrum(gray, w, h, f, bw, bh, nx, ny);
    shiftRef = { w, h, f, bw, bh, nx, ny, re, im };
}

// → { dx, dy, peak } (image − référence, pixels pleine résolution), null sans
// référence de même taille. peak : hauteur du pic (0–1), confiance.
function phaseShift(gray, w, h) {
    const R = shiftRef;
    if (!R || R.w !== w || R.h !== h) return null;
    const { f, bw, bh, nx, ny } = R;
    const { re, im } = _spectrum(gray, w, h, f, bw, bh, nx, ny);
    // spectre croisé normalisé F·G*/|F·G*|
    for (let i = 0; i < re.length; i++) {
        const a = re[i], b = im[i], c = R.re[i], d = R.im[i];
        const xr = a * c + b * d, xi = b * c - a * d;
        const m = Math.sqrt(xr * xr + xi * xi) + 1e-12;
        re[i] = xr / m; im[i] = xi / m;
    }
    _fft2(re, im, nx, ny, true);
    let best = -Infinity, bi = 0;
    for (let i = 0; i < re.length; i++) if (re[i] > best) { best = re[i]; bi = i; }
    const px = bi % nx, py = (bi / nx) | 0;
    const at = (x, y) => re[((y + ny) % ny) * nx + ((x + nx) % nx)];
    const sub = (m, c, p) => { const den = m - 2 * c + p; return den < 0 ? 0.5 * (m - p) / den : 0; };
    const sx = sub(at(px - 1, py), best, at(px + 1, py));
    const sy = sub(at(px, py - 1), best, at(px, py + 1));
    const ux = px > nx / 2 ? px - nx : px, uy = py > ny / 2 ? py - ny : py;
    return { dx: (ux + sx) * f, dy: (uy + sy) * f, peak: best / (nx * ny) };
}

// ── Message handler ─────────────────────────────────────────────────────────
self.onmessage = ({ data }) => {
    if (!data) return;

    if (data.type === 'init') {
        initialized = true;
        self.postMessage({ type: 'ready' });
        return;
    }

    // Référence de la corrélation de phase (cible surface) : image de
    // référence du stack en niveaux de gris 8 bits ; gray null = oubliée
    if (data.type === 'set-shift-reference') {
        setShiftReference(data.gray ?? null, data.width, data.height);
        return;
    }
    if (data.type === 'phase-shift') {
        const { gray, width, height, requestId } = data;
        self.postMessage({ type: 'phase-shift-result', requestId, shift: phaseShift(gray, width, height) });
        return;
    }

    if (data.type === 'image-analyze') {
        if (!initialized) {
            self.postMessage({ type: 'image-analyze-error', error: 'Not initialized', requestId: data.requestId });
            return;
        }
        const { bytes, mimeType, cropSize, width, height, requestId } = data;
        analyzeImageBytes(bytes, mimeType, cropSize, width, height)
            .then((result) => {
                self.postMessage(
                    { type: 'image-analyze-result', requestId, result },
                    [result.float32Buffer, result.packedGrayBuffer]
                );
            })
            .catch((error) => {
                self.postMessage({ type: 'image-analyze-error', error: String(error), requestId });
            });
        return;
    }

    if (data.type === 'crop-analyze-batch') {
        if (!initialized) {
            self.postMessage({ type: 'crop-analyze-error', error: 'Not initialized', requestId: data.requestId });
            return;
        }
        const { frames, srcWidth: srcW, srcHeight: srcH, cropSize, centers,
                bayerPattern = 0, bitDepth = 16, requestId } = data;
        const results = [];
        const transferables = [];

        for (const frame of frames) {
            const idx = frame.index ?? 0;
            const center = centers?.[idx] ?? { x: srcW / 2, y: srcH / 2 };
            const cropX = Math.max(0, Math.round(center.x - cropSize / 2));
            const cropY = Math.max(0, Math.round(center.y - cropSize / 2));
            const cropW = Math.min(cropSize, srcW - cropX);
            const cropH = Math.min(cropSize, srcH - cropY);

            // Accepte Uint8Array (8-bit) ou Uint16Array (16-bit)
            let bayerData;
            if (bitDepth === 8) {
                bayerData = (frame.data instanceof Uint8Array) ? frame.data
                          : new Uint8Array(frame.data instanceof ArrayBuffer ? frame.data : frame.data.buffer);
            } else {
                bayerData = (frame.data instanceof Uint16Array) ? frame.data
                          : new Uint16Array(frame.data instanceof ArrayBuffer ? frame.data : frame.data.buffer);
            }

            const rgba = debayer(bayerData, srcW, srcH, cropX, cropY, cropW, cropH, bayerPattern, bitDepth);
            const { sharpness, center: discCenter, peak, clipped, gray8 } = sharpnessAndGray(rgba, cropW, cropH);

            const float32Buffer    = rgba.buffer;
            const packedGrayBuffer = gray8.buffer;
            results.push({ sharpness, center: discCenter, peak, clipped, float32Buffer, packedGrayBuffer, width: cropW, height: cropH });
            transferables.push(float32Buffer, packedGrayBuffer);
        }

        self.postMessage({ type: 'crop-analyze-result', requestId, results }, transferables);
        return;
    }

    if (data.type === 'cleanup') {
        initialized = false;
        self.postMessage({ type: 'cleanup-done' });
    }
};
