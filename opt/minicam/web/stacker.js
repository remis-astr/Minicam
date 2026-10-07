'use strict';

import { WsFrameReceiver } from './ws_frame_receiver.js';
import { autoStretchParams, autoStretchRender, removeGreen8, localContrast8 } from './auto_stretch.js';

// Bayer pattern string → integer (OpenCV inverted naming : BG=RGGB, RG=BGGR, ...)
const BAYER_INT = { RGGB: 0, BGGR: 1, GRBG: 2, GBRG: 3 };

// ---------------------------------------------------------------------------
// Helpers JS (portés depuis useStacker.js d'Eise, sans dépendances Vue)
// ---------------------------------------------------------------------------

function createAPGrid(width, height, searchRadius) {
    const patchSize = 20;
    const minDim    = Math.min(width, height);
    const spacing   = minDim < 500 ? 20 : Math.floor(patchSize / 2);
    const marginX   = Math.floor((width  % spacing) / 2) + patchSize / 2;
    const marginY   = Math.floor((height % spacing) / 2) + patchSize / 2;
    const points    = [];
    for (let y = marginY; y < height - patchSize / 2; y += spacing)
        for (let x = marginX; x < width  - patchSize / 2; x += spacing)
            points.push({ x, y });
    if (!points.length)
        points.push({ x: Math.floor(width / 2), y: Math.floor(height / 2) });
    return { alignmentPoints: points, patchSize, searchRadius };
}

function filterAPsByQuality(points, refGray, width, height, patchSize) {
    const half = Math.floor(patchSize / 2);
    const ok   = [];
    for (const ap of points) {
        const x0 = ap.x - half, y0 = ap.y - half;
        if (x0 < 0 || y0 < 0 || x0 + patchSize > width || y0 + patchSize > height) continue;
        let sum = 0, sumSq = 0;
        for (let py = 0; py < patchSize; py++)
            for (let px = 0; px < patchSize; px++) {
                const v = refGray[(y0 + py) * width + (x0 + px)];
                sum += v; sumSq += v * v;
            }
        const n    = patchSize * patchSize;
        const mean = sum / n;
        const std  = Math.sqrt(Math.max(0, sumSq / n - mean * mean));
        if (mean >= 5 && std / 255 >= 0.02) ok.push(ap);
    }
    return ok.length ? ok : points;
}

// float32 RGBA (0-1) → uint8 grayscale
function float32ToGray(float32Buf, w, h) {
    const rgba = new Float32Array(float32Buf);
    const gray = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++)
        gray[i] = Math.round((0.299 * rgba[i*4] + 0.587 * rgba[i*4+1] + 0.114 * rgba[i*4+2]) * 255);
    return gray;
}

// float32 RGBA → moyenne de luminance (0-255), sur 1 pixel / 8
function meanBrightness(float32Buf, w, h) {
    const rgba = new Float32Array(float32Buf);
    let sum = 0, n = 0;
    for (let i = 0; i < w * h; i += 8) {
        const lum = (rgba[i*4] + rgba[i*4+1] + rgba[i*4+2]) / 3 * 255;
        if (lum > 10) { sum += lum; n++; }
    }
    return n > 0 ? sum / n : 128;
}

// ---------------------------------------------------------------------------
// Balance des blancs auto (gray-world) — calculée sur l'image STACKÉE
// uniquement (jamais par frame brute), sur le même échantillon 1/16 que les
// percentiles ci-dessous : coût négligeable, appelée une fois par preview.
// ---------------------------------------------------------------------------

function computeAWBGains(float32Buf, w, h) {
    const rgba = new Float32Array(float32Buf);
    const n    = w * h;
    let sumR = 0, sumG = 0, sumB = 0, count = 0;
    for (let i = 0; i < n; i += 16) {
        const r = rgba[i*4], g = rgba[i*4+1], b = rgba[i*4+2];
        // Ignore le fond quasi noir (bruit de lecture) pour ne pas biaiser
        // la moyenne — même seuil que meanBrightness().
        if ((r + g + b) / 3 > 10 / 255) { sumR += r; sumG += g; sumB += b; count++; }
    }
    if (count < 10 || sumR <= 0 || sumG <= 0 || sumB <= 0) return [1, 1, 1];
    const meanR = sumR / count, meanG = sumG / count, meanB = sumB / count;
    // G comme référence (2× plus de photosites verts sur un capteur Bayer,
    // donc canal le moins bruité) — gains bornés pour éviter tout emballement
    // sur un stack encore quasi vide ou très bruité.
    const clamp = (v) => Math.max(0.5, Math.min(3.0, v));
    return [clamp(meanG / meanR), 1, clamp(meanG / meanB)];
}

// ---------------------------------------------------------------------------
// Post-traitement de l'aperçu (ondelettes, contraste, CLAHE) — appliqué au
// rendu canvas (donc à l'export PNG), jamais aux données du stack (FITS brut).
// ---------------------------------------------------------------------------

// Flou B3-spline « à trous » séparable (noyau 1-4-6-4-1, pas 2^j), bords clampés.
function _atrousBlur(src, w, h, step, tmp, dst) {
    const k0 = 6 / 16, k1 = 4 / 16, k2 = 1 / 16;
    for (let y = 0; y < h; y++) {
        const row = y * w;
        for (let x = 0; x < w; x++) {
            const xm1 = Math.max(0, x - step),     xp1 = Math.min(w - 1, x + step);
            const xm2 = Math.max(0, x - 2 * step), xp2 = Math.min(w - 1, x + 2 * step);
            tmp[row + x] = k0 * src[row + x] + k1 * (src[row + xm1] + src[row + xp1])
                         + k2 * (src[row + xm2] + src[row + xp2]);
        }
    }
    for (let y = 0; y < h; y++) {
        const ym1 = Math.max(0, y - step) * w,     yp1 = Math.min(h - 1, y + step) * w;
        const ym2 = Math.max(0, y - 2 * step) * w, yp2 = Math.min(h - 1, y + 2 * step) * w;
        const row = y * w;
        for (let x = 0; x < w; x++) {
            dst[row + x] = k0 * tmp[row + x] + k1 * (tmp[ym1 + x] + tmp[yp1 + x])
                         + k2 * (tmp[ym2 + x] + tmp[yp2 + x]);
        }
    }
}

/**
 * Accentuation par ondelettes à trous sur la luminance (comme les ondelettes
 * de Registax) : L' = L + Σ amounts[j]·détail_j. Le même ΔL est ajouté aux
 * trois canaux (couleur préservée, pas de bruit chromatique amplifié).
 * denoise : seuil doux de la couche 1 en multiples du bruit estimé (MAD).
 * Seul le cadre autour de l'objet est calculé. Retourne un nouveau buffer RGBA
 * float32, ou le buffer d'origine si rien à faire.
 */
function applyWavelets(rgba, w, h, amounts, denoise = 0) {
    if (!amounts.some((a) => a !== 0) && !(denoise > 0)) return rgba;
    const n = w * h;
    const lum = new Float32Array(n);
    let maxL = 0;
    for (let i = 0; i < n; i++) {
        const l = 0.299 * rgba[i*4] + 0.587 * rgba[i*4+1] + 0.114 * rgba[i*4+2];
        lum[i] = l;
        if (l > maxL) maxL = l;
    }
    // Cadre englobant l'objet (> 3 % du max) + marge couvrant le support des
    // 4 niveaux à trous : sur une planète, le ciel noir n'est pas calculé.
    const thr = 0.03 * maxL;
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0; y < h; y++) {
        const row = y * w;
        for (let x = 0; x < w; x++) {
            if (lum[row + x] > thr) {
                if (x < x0) x0 = x; if (x > x1) x1 = x;
                if (y < y0) y0 = y; if (y > y1) y1 = y;
            }
        }
    }
    if (x1 < 0) return rgba;
    const m = 4 << amounts.length;
    x0 = Math.max(0, x0 - m); y0 = Math.max(0, y0 - m);
    x1 = Math.min(w - 1, x1 + m); y1 = Math.min(h - 1, y1 + m);
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1, bn = bw * bh;

    let cur = new Float32Array(bn);
    for (let y = 0; y < bh; y++) cur.set(lum.subarray((y0 + y) * w + x0, (y0 + y) * w + x0 + bw), y * bw);
    const delta = new Float32Array(bn);
    const tmp = new Float32Array(bn);
    let next = new Float32Array(bn);
    for (let j = 0; j < amounts.length; j++) {
        _atrousBlur(cur, bw, bh, 1 << j, tmp, next);
        const a = amounts[j];
        let t = 0;
        if (j === 0 && denoise > 0) {
            // σ du bruit ≈ MAD(détail fin)/0.6745, échantillon 1/16
            const smp = [];
            for (let i = 0; i < bn; i += 16) smp.push(Math.abs(cur[i] - next[i]));
            smp.sort((p, q) => p - q);
            t = denoise * smp[smp.length >> 1] / 0.6745;
        }
        if (a !== 0 || t > 0) {
            for (let i = 0; i < bn; i++) {
                const d0 = cur[i] - next[i];
                const d  = t > 0 ? (d0 > t ? d0 - t : d0 < -t ? d0 + t : 0) : d0;
                delta[i] += (1 + a) * d - d0;   // gain (1 + a) sur la couche (débruitée)
            }
        }
        [cur, next] = [next, cur];
    }
    const out = new Float32Array(rgba);
    for (let y = 0; y < bh; y++) {
        for (let x = 0; x < bw; x++) {
            const dl = delta[y * bw + x], i = ((y0 + y) * w + x0 + x) * 4;
            out[i]   = Math.max(0, rgba[i]   + dl);
            out[i+1] = Math.max(0, rgba[i+1] + dl);
            out[i+2] = Math.max(0, rgba[i+2] + dl);
        }
    }
    return out;
}

/**
 * CLAHE sur la luminance d'une image RGBA 8 bits (en place) : histogrammes
 * écrêtés par tuile (grille tiles×tiles), interpolation bilinéaire entre
 * tuiles, puis mélange avec l'original selon strength (0–1). Les canaux sont
 * mis à l'échelle par Y'/Y (teinte conservée), facteur borné pour que le
 * canal le plus fort ne dépasse pas 255 : écrêté seul, il laissait monter
 * les deux autres et la couleur virait au blanc (couleurs délavées). Le fond
 * quasi noir (Y < 4) n'est pas touché, pour ne pas faire ressortir le bruit
 * du ciel.
 */
function applyClahe(d, w, h, strength, clipLimit = 3, tiles = 8) {
    if (strength <= 0) return;
    const n = w * h;
    const Y = new Uint8Array(n);
    for (let i = 0; i < n; i++)
        Y[i] = Math.min(255, Math.round(0.299 * d[i*4] + 0.587 * d[i*4+1] + 0.114 * d[i*4+2]));
    const tw = Math.ceil(w / tiles), th = Math.ceil(h / tiles);
    const maps = new Array(tiles * tiles);
    const hist = new Uint32Array(256);
    for (let ty = 0; ty < tiles; ty++) for (let tx = 0; tx < tiles; tx++) {
        hist.fill(0);
        const x0 = tx * tw, y0 = ty * th, x1 = Math.min(w, x0 + tw), y1 = Math.min(h, y0 + th);
        const cnt = Math.max(1, (x1 - x0) * (y1 - y0));
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) hist[Y[y * w + x]]++;
        const limit = Math.max(1, Math.floor(clipLimit * cnt / 256));
        let excess = 0;
        for (let v = 0; v < 256; v++) if (hist[v] > limit) { excess += hist[v] - limit; hist[v] = limit; }
        const add = excess / 256;
        const map = new Uint8Array(256);
        let cdf = 0;
        for (let v = 0; v < 256; v++) { cdf += hist[v] + add; map[v] = Math.min(255, Math.round(cdf * 255 / cnt)); }
        maps[ty * tiles + tx] = map;
    }
    for (let y = 0; y < h; y++) {
        const gy = Math.min(tiles - 1, Math.max(0, (y + 0.5) / th - 0.5));
        const ty0 = Math.floor(gy), ty1 = Math.min(tiles - 1, ty0 + 1), fy = gy - ty0;
        for (let x = 0; x < w; x++) {
            const i = y * w + x, v = Y[i];
            if (v < 4) continue;
            const gx = Math.min(tiles - 1, Math.max(0, (x + 0.5) / tw - 0.5));
            const tx0 = Math.floor(gx), tx1 = Math.min(tiles - 1, tx0 + 1), fx = gx - tx0;
            const top = maps[ty0 * tiles + tx0][v] * (1 - fx) + maps[ty0 * tiles + tx1][v] * fx;
            const bot = maps[ty1 * tiles + tx0][v] * (1 - fx) + maps[ty1 * tiles + tx1][v] * fx;
            const eq  = top * (1 - fy) + bot * fy;
            const mx  = Math.max(d[i*4], d[i*4+1], d[i*4+2]);
            const r   = Math.min((v + strength * (eq - v)) / v, 255 / mx);
            d[i*4]   = d[i*4]   * r;
            d[i*4+1] = d[i*4+1] * r;
            d[i*4+2] = d[i*4+2] * r;
        }
    }
}

/**
 * Saturation des couleurs d'une image RGBA 8 bits (en place) : chaque canal
 * est écarté de la luminance Y d'un facteur sat (1 = inchangé, 0 = gris).
 * Luminance et teinte conservées ; le facteur est réduit pixel par pixel
 * pour qu'aucun canal ne sorte de [0, 255] (pas d'écrêtage qui fausserait
 * la teinte).
 */
function applySaturation(d, n, sat) {
    if (sat === 1) return;
    for (let i = 0; i < n * 4; i += 4) {
        const r = d[i], g = d[i+1], b = d[i+2];
        const y = 0.299 * r + 0.587 * g + 0.114 * b;
        let k = sat;
        for (const c of [r, g, b]) {
            const dc = c - y;
            if (dc * k > 255 - y) k = (255 - y) / dc;
            else if (dc * k < -y) k = -y / dc;
        }
        d[i]   = y + k * (r - y);
        d[i+1] = y + k * (g - y);
        d[i+2] = y + k * (b - y);
    }
}

// ---------------------------------------------------------------------------
// Preview stretch : percentiles sur échantillon 1/16, LUT arcsinh, rendu canvas
// ---------------------------------------------------------------------------

function stretchToCanvas(float32Buf, w, h, canvas, low, high, beta = 0, awbGains = null,
                         contrast = 0, clahe = 0, saturation = 1, bgNeutral = false,
                         removeGreen = false, localContrast = 0) {
    const rgba = new Float32Array(float32Buf);
    const n    = w * h;
    // Fond neutre : médianes R, G, B ramenées à leur moyenne (retire la
    // dominante du ciel ; additif, n'affecte pas les rapports des étoiles)
    if (bgNeutral) {
        // tableaux typés : tri numérique natif, ~10× plus rapide qu'Array.sort
        const cap = Math.ceil(n / 16);
        const ch = [new Float32Array(cap), new Float32Array(cap), new Float32Array(cap)];
        let cnt = 0;
        for (let i = 0; i < n; i += 16) {
            if (rgba[i*4+3] <= 0) continue;   // pixel jamais couvert (stack ciel profond)
            ch[0][cnt] = rgba[i*4]; ch[1][cnt] = rgba[i*4+1]; ch[2][cnt] = rgba[i*4+2]; cnt++;
        }
        if (cnt) {
            const med = ch.map((a) => a.subarray(0, cnt).sort()[cnt >> 1]);
            const m = (med[0] + med[1] + med[2]) / 3;
            for (let i = 0; i < n; i++) {
                rgba[i*4] -= med[0] - m; rgba[i*4+1] -= med[1] - m; rgba[i*4+2] -= med[2] - m;
            }
        }
    }
    const [gR, gG, gB] = awbGains ?? [1, 1, 1];

    // Percentiles de luminance (échantillon 1/16 pour rapidité) — calculés
    // sur la luminance AVANT balance des blancs : les gains R/B restent
    // proches de 1 en pratique, donc la plage de stretch n'a pas besoin
    // d'être recalculée après application des gains.
    const all = new Float32Array(Math.ceil(n / 16));
    let ns = 0;
    for (let i = 0; i < n; i += 16) {
        const lum = 0.299 * rgba[i*4] + 0.587 * rgba[i*4+1] + 0.114 * rgba[i*4+2];
        if (lum > 0) all[ns++] = lum;
    }
    if (!ns) return;
    const samples = all.subarray(0, ns).sort();
    const lo  = samples[Math.max(0, Math.floor(low  * samples.length))];
    const hi  = samples[Math.min(samples.length - 1, Math.floor(high * samples.length))];
    const rng = Math.max(hi - lo, 1e-7);

    // LUT 4096 entrées : [lo, hi] → [0, 255] via arcsinh(β·x)/arcsinh(β)
    // β=0 → stretch linéaire (compatible ascendant)
    const LUT    = 4096;
    const lut    = new Uint8Array(LUT);
    const abeta  = beta > 0 ? Math.asinh(beta) : 1;
    // Contraste : sigmoïde centrée sur 0.5, normalisée pour garder 0→0 et 1→1
    // (contrast 0 → identité, 1 → pente ×~3 au milieu).
    const kS   = contrast * 8;
    const sig  = (x) => 1 / (1 + Math.exp(-kS * (x - 0.5)));
    const s0   = sig(0), s1 = sig(1);
    for (let i = 0; i < LUT; i++) {
        const norm = i / (LUT - 1);                                    // [0, 1]
        let s      = beta > 0 ? Math.asinh(beta * norm) / abeta : norm;
        if (kS > 0) s = (sig(s) - s0) / (s1 - s0);
        lut[i]     = Math.min(255, Math.round(s * 255));
    }

    // Rendu via LUT (lookup seul par pixel — ~5 ms pour 1920×1080)
    const scale = (LUT - 1) / rng;
    const gains = [gR, gG, gB];
    canvas.width  = w;
    canvas.height = h;
    const idata = new ImageData(w, h);
    const d     = idata.data;
    for (let i = 0; i < n; i++) {
        for (let ch = 0; ch < 3; ch++) {
            const v      = rgba[i*4+ch] * gains[ch];
            const idx    = Math.max(0, Math.min(LUT - 1, Math.round((v - lo) * scale)));
            d[i*4 + ch]  = lut[idx];
        }
        d[i*4 + 3] = 255;
    }
    if (removeGreen) removeGreen8(d, w, h);
    localContrast8(d, w, h, localContrast);
    applyClahe(d, w, h, clahe);
    applySaturation(d, n, saturation);
    canvas.getContext('2d').putImageData(idata, 0, 0);
}

// Étirement automatique (auto_stretch.js) : arcsinh à couleurs préservées,
// noir, balance des blancs et force déduits de l'image ; state = lissage
// entre aperçus, key = identité du snapshot. Renvoie les paramètres utilisés.
function autoStretchToCanvas(float32Data, w, h, canvas, state, key,
                             { target = null, localContrast = 0, removeGreen = false,
                               count = 1, clahe = 0, saturation = 1 } = {}) {
    const rgba = float32Data instanceof Float32Array ? float32Data : new Float32Array(float32Data);
    const p = autoStretchParams(rgba, w, h, state, key, target, { count });
    if (!p) return null;
    canvas.width  = w;
    canvas.height = h;
    const idata = new ImageData(w, h);
    autoStretchRender(rgba, w, h, p, idata.data, { localContrast });
    if (removeGreen) removeGreen8(idata.data, w, h);
    applyClahe(idata.data, w, h, clahe);
    applySaturation(idata.data, w * h, saturation);
    canvas.getContext('2d').putImageData(idata, 0, 0);
    return p;
}

// ---------------------------------------------------------------------------
// StreamingStacker
// ---------------------------------------------------------------------------

/**
 * Stacker live depuis /ws/raw.
 *
 * Events (addEventListener) :
 *   'frame'   → CustomEvent { detail: { frameIndex, score, accepted, stackedCount, droppedFrames } }
 *   'preview' → CustomEvent (après mise à jour canvas)
 *   'error'   → CustomEvent { detail: { message } }
 *
 * Usage :
 *   const s = new StreamingStacker({ mode: 'lucky', canvas, options: { qualityThreshold: 0.02 } });
 *   await s.start('ws://192.168.7.2/ws/raw');
 */
export class StreamingStacker extends EventTarget {

    constructor({ mode, canvas, options = {} }) {
        super();
        this._mode   = mode;
        this._canvas = canvas;

        this._qualityThreshold = options.qualityThreshold ?? 0.10;
        // Sélection (Lucky) : 'window' = X % meilleures d'une fenêtre glissante
        // de 50 images (historique) ; 'elite' = pool des N meilleures images de
        // toute la session, la pire remplacée (retirée exactement du stack).
        this._selection        = options.selection ?? 'window';
        this._poolSize         = Math.max(1, options.poolSize ?? 200);
        this._pool             = [];
        this._poolReplaced     = 0;
        this._alignMode        = options.alignMode ?? (mode === 'lucky' ? 'on' : 'on');
        this._searchRadius     = options.searchRadius ?? 32;
        this._targetFps        = options.fps ?? null;
        this._initialRoi       = options.roi ?? null;
        this._initialBitDepth  = options.bitDepth ?? null;
        this._initialFormat    = options.format ?? 'raw';
        this._initialCompression = options.compression ?? null;
        // Présélection par netteté sur le Pi (fraction envoyée, 0 = aucune)
        this._preselect        = options.preselect ?? 0;
        this.lastMeta          = null;
        this._stretchLow       = options.stretchLow  ?? 0.001;
        this._stretchHigh      = options.stretchHigh ?? 0.999;
        this._stretchBeta      = options.stretchBeta ?? 0;
        this._previewEveryN    = options.previewEveryN ?? 1;
        // Buffer d'images avec contrôle de flux (voir WsFrameReceiver) ; 0 =
        // cadence fixe du serveur (comportement historique).
        this._flowCredits      = options.flowCredits ?? 0;
        // Aperçu au plus toutes les previewIntervalMs pendant l'empilement : la
        // relecture GPU + l'étirement bloquent le pipeline, un aperçu par image
        // acceptée donnait un traitement par à-coups. finish() force le dernier.
        this._previewIntervalMs = options.previewIntervalMs ?? 500;
        this._lastPreviewAt    = 0;
        // Prochain aperçu au plus tôt : intervalle compté depuis la FIN du
        // rendu et au moins 2× sa durée (l'aperçu bloque le pipeline ; en
        // 4K il prend plusieurs secondes et passait sinon après chaque image)
        this._nextPreviewAt    = 0;
        // Durées par étape (ms), résumées par timingSummary()
        this.timings = { analyze: [], align: [], stack: [], preview: [] };
        this._awbEnabled       = options.awb ?? false;
        // Post-traitement de l'aperçu (voir applyWavelets / applyClahe)
        this._wavelets         = options.wavelets ?? [0, 0, 0, 0];
        this._waveletDenoise   = options.waveletDenoise ?? 0;
        this._contrast         = options.contrast ?? 0;
        this._clahe            = options.clahe ?? 0;
        this._saturation       = options.saturation ?? 1;
        this._bgNeutral        = options.bgNeutral ?? false;
        // Étirement : 'manual' (percentiles + β, historique) | 'auto' (auto_stretch.js)
        this._stretchMode      = options.stretchMode ?? 'manual';
        this._stretchTarget    = options.stretchTarget ?? null;   // fond visé 0–1, null = automatique
        this._localContrast    = options.localContrast ?? 0;      // amplitude, 0 = désactivé (les deux modes)
        this._removeGreen      = options.removeGreen ?? false;    // les deux modes
        this._autoState        = {};
        this.lastAutoStretch   = null;   // derniers paramètres auto (affichage)
        // Mode alignMode 'stars' (ciel profond) : options de dso_stacker.js
        this._starAlign        = options.starAlign ?? {};
        // Ondelettes + CLAHE (CPU, ~0,1–0,3 s par aperçu) : par défaut
        // appliqués seulement une fois le stack terminé (setPostProcessing) —
        // pendant l'empilement, l'aperçu n'a que l'étirement et le contraste
        // (LUT, quasi gratuits). postLive : aussi pendant l'empilement.
        this._postLive         = options.postLive ?? false;
        this._postActive       = this._postLive;
        this._finished         = false;
        this._lastSnap         = null;   // dernier snapshot du stack, re-rendu sans le GPU
        this._renderPending    = false;

        // Workers (créés dans start())
        this._analyzeWorker = null;
        this._stackWorker   = null;
        this._receiver      = null;
        this._gpuOk         = false;

        // État stacking
        this._stackedCount = 0;
        this._totalExpMs   = 0;
        this._gainSum      = 0;
        this._frameIndex   = 0;
        this._initialized  = false;

        // Données de référence (première frame acceptée)
        this._refGrayData     = null;
        this._alignmentPoints = null;
        this._patchSize       = 0;
        // (_searchRadius : déjà fixé plus haut depuis options.searchRadius — le
        // remettre à 0 ici désactivait l'alignement tant que le curseur n'avait
        // pas été touché.)
        this._cropW           = 0;
        this._cropH           = 0;
        this._refBrightness   = 0;

        // Qualité adaptative (fenêtre glissante)
        this._sharpnessBuffer     = [];
        this._sharpnessBufferSize = 50;
        this._lastSharpness       = 0;

        this._paused  = false;
        this._stopped = false;
        this._reqId   = 0;
    }

    // -------------------------------------------------------------------------
    // API publique
    // -------------------------------------------------------------------------

    async start(wsUrl) {
        this._stopped = false;
        this._paused  = false;

        // Détection WebGPU : seulement un vrai GPU. L'adaptateur de secours
        // (SwiftShader, émulé sur le CPU) est bien plus lent que les workers
        // CPU : ~2,4 s d'alignement par image contre ~0,2 s (mesuré sur un
        // SER 640×480) — il donnait un traitement par à-coups.
        let gpuOk = false;
        let gpuName = 'aucun';
        if (typeof navigator !== 'undefined' && navigator.gpu) {
            try {
                const a = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
                const info = a?.info ?? {};
                gpuName = a ? (info.description || `${info.vendor} ${info.architecture}`.trim() || 'inconnu') : 'aucun';
                gpuOk = !!a && !info.isFallbackAdapter && info.architecture !== 'swiftshader';
            } catch { gpuOk = false; }
        }
        this._gpuOk   = gpuOk;
        this._gpuName = gpuName;

        // Analyse toujours en CPU (plein champ 1920×1080 — GPU analyze worker est square-only).
        // Accumulation en GPU si disponible (worker Eise supporte dimensions rectangulaires).
        const base = new URL('.', import.meta.url).href;
        const analyzeFile = 'cpu_analyze_worker.js';
        const stackFile   = gpuOk ? 'webgpu_stacking_worker.js' : 'cpu_stacking_worker.js';
        console.log(`[Stacker] GPU=${gpuOk} (${gpuName}) → ${analyzeFile} + ${stackFile}`);
        this._analyzeWorker = new Worker(`${base}${analyzeFile}`, { type: 'module' });
        this._stackWorker   = new Worker(`${base}${stackFile}`,   { type: 'module' });

        await Promise.all([
            this._workerInit(this._analyzeWorker, 'analyze'),
            this._workerInit(this._stackWorker,   'stack'),
        ]);

        // wsUrl peut aussi être une source déjà construite ayant l'interface de
        // WsFrameReceiver (ex. SerFileSource pour rejouer un fichier SER).
        this._receiver = typeof wsUrl === 'string' ? new WsFrameReceiver(wsUrl) : wsUrl;
        if (typeof wsUrl === 'string') this._receiver.setFlowControl(this._flowCredits);
        this._receiver.onFrame = (pixels, meta) => this._onFrame(pixels, meta);
        this._receiver.setPreselect?.(this._preselect);   // sources fichier : sans objet
        await this._receiver.start(this._targetFps, this._initialRoi, this._initialBitDepth, this._initialFormat,
                                   this._initialCompression);
    }

    pause()  { this._paused = true; }
    resume() { this._paused = false; }

    stop() {
        this._stopped = true;
        this._receiver?.stop();
        this._analyzeWorker?.terminate();
        this._stackWorker?.terminate();
        this._receiver = this._analyzeWorker = this._stackWorker = null;
    }

    reset() {
        this._stackedCount    = 0;
        this._totalExpMs      = 0;
        this._gainSum         = 0;
        this._frameIndex      = 0;
        this._initialized     = false;
        this._refGrayData     = null;
        this._alignmentPoints = null;
        this._cropW           = 0;
        this._cropH           = 0;
        this._sharpnessBuffer = [];
        this._lastSharpness   = 0;
        this._lastSnap        = null;
        this._autoState       = {};
        this.lastAutoStretch  = null;
        this._finished        = false;
        this._pool            = [];
        this._poolReplaced    = 0;
        this._postActive      = this._postLive;
        if (this._stackWorker) this._stackWorker.postMessage({ type: 'cleanup' });
        if (this._canvas) {
            const ctx = this._canvas.getContext('2d');
            ctx.clearRect(0, 0, this._canvas.width, this._canvas.height);
        }
    }

    setStretch(low, high, beta) {
        this._stretchLow  = low;
        this._stretchHigh = high;
        if (beta !== undefined) this._stretchBeta = beta;
        this._scheduleRender();
    }

    setStretchBeta(beta) { this._stretchBeta = beta; this._scheduleRender(); }

    setAWB(enabled) { this._awbEnabled = enabled; this._scheduleRender(); }

    /** amounts : gains par couche [fin, moyen, large, très large] (0 = neutre). */
    setWavelets(amounts, denoise = 0) {
        this._wavelets = amounts;
        this._waveletDenoise = denoise;
        this._scheduleRender();
    }

    setContrast(c) { this._contrast = c; this._scheduleRender(); }

    setClahe(strength) { this._clahe = strength; this._scheduleRender(); }
    /** Saturation des couleurs (1 = inchangée), appliquée à l'aperçu en direct. */
    setSaturation(sat) { this._saturation = sat; this._scheduleRender(); }
    /** Fond de ciel neutre à l'affichage (médianes R, G, B égalisées). */
    setBgNeutral(on) { this._bgNeutral = on; this._scheduleRender(); }
    /** 'manual' | 'auto' */
    setStretchMode(mode) { this._stretchMode = mode; this._scheduleRender(); }
    /** Fond visé en mode auto (0–1), null = automatique selon le bruit du stack. */
    setStretchTarget(t) { this._stretchTarget = t; this._scheduleRender(); }
    /** Contraste local grande échelle : amplitude (0,8 = réglage par défaut de la page), 0 = désactivé. */
    setLocalContrast(amount) { this._localContrast = amount; this._scheduleRender(); }
    setRemoveGreen(on) { this._removeGreen = on; this._scheduleRender(); }

    /** Active/désactive ondelettes + CLAHE (à la fin du stack). */
    setPostProcessing(active) { this._postActive = active; this._scheduleRender(); }

    /** Ondelettes + CLAHE aussi pendant l'empilement (sinon seulement à la fin). */
    setPostLive(on) {
        this._postLive = on;
        this.setPostProcessing(on || this._finished);
    }

    /**
     * Fin du stack (SER terminé, bouton Arrêter) : relit le stack complet
     * (l'aperçu est limité dans le temps pendant l'empilement, les dernières
     * images n'y sont peut-être pas) puis active ondelettes + CLAHE. À appeler
     * avant stop(), tant que le worker d'empilement existe.
     */
    async finish() {
        await this._inflight;   // image en cours (ses erreurs sont déjà signalées)
        if (this._stackWorker && this._initialized) await this._updatePreview();
        this._finished = true;
        this.setPostProcessing(true);
        console.log('[Stacker] ' + this.timingSummary());
    }

    timingSummary() {
        const f = (a) => a.length
            ? `${(a.reduce((x, y) => x + y, 0) / a.length).toFixed(0)}/${Math.max(...a).toFixed(0)} ms ×${a.length}`
            : '—';
        const t = this.timings;
        return `moy/max — analyse ${f(t.analyze)}, alignement ${f(t.align)}, `
             + `empilement ${f(t.stack)}, aperçu ${f(t.preview)} (GPU=${this._gpuOk}, ${this._gpuName})`;
    }
    get postProcessing() { return this._postActive; }

    setAlignMode(mode) {
        if (this._alignMode === mode) return;
        this._alignMode = mode;
        if (this._initialized) this.reset();
    }

    setSearchRadius(r) {
        this._searchRadius = r;
        if (this._initialized) this.reset();
    }

    get currentThreshold() {
        if (this._sharpnessBuffer.length < 5) return 0;
        const sorted = [...this._sharpnessBuffer].sort((a, b) => a - b);
        const idx    = Math.max(0, Math.floor((1 - this._qualityThreshold) * sorted.length) - 1);
        return sorted[idx];
    }

    get lastSharpness() { return this._lastSharpness; }

    /** Change le débit de frames envoyées par le serveur (1–15 fps). */
    setRate(fps) { this._receiver?.setRate(fps); }

    /**
     * Change le ROI centré envoyé par le serveur.
     * @param {number|null} w  Largeur souhaitée (null = plein champ)
     * @param {number|null} h  Hauteur souhaitée
     */
    setRoi(w, h) {
        this._initialRoi = (w && h) ? [w, h] : null;
        this._receiver?.setRoi(w, h);
        this.flush(3);
        if (this._initialized) this.reset();
    }

    flush(n = 3) { this._receiver?.flush(n); }

    /** Présélection sur le Pi : fraction des images envoyées (0 = toutes). */
    setPreselect(keep) {
        this._preselect = keep;
        this._receiver?.setPreselect?.(keep);
    }

    /** Compression du RAW : 'none' ou 'zstd' (sans perte). */
    setCompression(codec) {
        this._initialCompression = codec;
        this._receiver?.setCompression?.(codec);
    }

    /** Change le format de flux : 'raw' (Bayer), 'jpeg' ou 'png' (ISP). */
    setFormat(format) {
        this._initialFormat = format;
        this._receiver?.setFormat(format);
        this.flush(3);
        if (this._initialized) this.reset();
    }

    get stackedCount() { return this._stackedCount; }

    /**
     * Retourne le résultat courant du stack (snapshot GPU).
     * Résout avec { float32Data, width, height, stackedCount, totalExpMs, gainMean }.
     */
    getStackResult() {
        // Stack arrêté (workers terminés) : dernier snapshot gardé pour l'aperçu.
        if (!this._stackWorker && this._lastSnap)
            return Promise.resolve({
                float32Data:  this._lastSnap.data,
                width:        this._lastSnap.width,
                height:       this._lastSnap.height,
                stackedCount: this._stackedCount,
                totalExpMs:   this._totalExpMs,
                gainMean:     this._stackedCount > 0 ? this._gainSum / this._stackedCount : 0,
            });
        if (!this._stackWorker || !this._initialized)
            return Promise.reject(new Error('Stacking not initialized'));

        return new Promise((resolve, reject) => {
            const handler = ({ data }) => {
                if (!data) return;
                if (data.type === 'stack-snapshot-complete') {
                    this._stackWorker.removeEventListener('message', handler);
                    resolve({
                        float32Data:  data.float32Buffer ? new Float32Array(data.float32Buffer) : null,
                        width:        data.width,
                        height:       data.height,
                        stackedCount: this._stackedCount,
                        totalExpMs:   this._totalExpMs,
                        gainMean:     this._stackedCount > 0 ? this._gainSum / this._stackedCount : 0,
                    });
                } else if (data.type === 'snapshot-error') {
                    this._stackWorker.removeEventListener('message', handler);
                    reject(new Error(data.error));
                }
            };
            this._stackWorker.addEventListener('message', handler);
            this._stackWorker.postMessage({ type: 'get-stack-snapshot' });
        });
    }

    // -------------------------------------------------------------------------
    // Pipeline
    // -------------------------------------------------------------------------

    _onFrame(pixels, meta) {
        if (this._paused || this._stopped) return;
        this._receiver.setProcessing(true);
        // gardée : finish() attend l'image en cours avant la relecture finale
        this._inflight = this._processFrame(pixels, meta)
            .catch((err) => {
                this.dispatchEvent(new CustomEvent('error', { detail: { message: err.message } }));
            })
            .finally(() => {
                if (this._receiver) this._receiver.setProcessing(false);
            });
    }

    async _processFrame(pixels, meta) {
        const { width: srcW, height: srcH, gain, exposure_ms, bayer, bit_depth: bitDepth = 16,
                format = 'raw' } = meta;
        this.lastMeta = meta;   // compteurs de présélection du Pi, entre autres
        const cropSize     = srcW;
        const bayerPattern = BAYER_INT[bayer] ?? 0;
        const frameIdx     = this._frameIndex++;

        // Ciel profond : pixels bruts Bayer directement au worker d'empilement
        // (pixels chauds, étoiles, drizzle Bayer — dso_stacker.js), sans
        // débayérisage ni score de netteté.
        if (this._alignMode === 'stars') {
            // Bayer brut (caméra, DNG, FITS CFA), ou plans 16 bits déjà débayérisés / mono (FITS)
            const layout = format === 'rgb16' ? 'rgb' : format === 'mono16' ? 'mono' : format === 'raw' ? 'bayer' : null;
            if (!layout) throw new Error(`alignement étoiles : format RAW, mono16 ou rgb16 requis (reçu ${format})`);
            let tStep = performance.now();
            const lap = (key) => { const t = performance.now(); this.timings[key].push(t - tStep); tStep = t; };
            if (this._initialized && (srcW !== this._cropW || srcH !== this._cropH || layout !== this._layout)) this.reset();
            this._layout = layout;
            const raw = (layout === 'bayer' && bitDepth === 8)
                ? Uint16Array.from(pixels, (v) => v << 8)
                : new Uint16Array(pixels.buffer.slice(pixels.byteOffset, pixels.byteOffset + pixels.byteLength));
            await this._processStarsFrame(raw, srcW, srcH, bayer, frameIdx, gain, exposure_ms, lap,
                                          meta.black_level ?? 0, layout);
            return;
        }

        // 1. Analyze — Bayer (debayer + score Laplacian) ou image déjà
        // débayerisée par l'ISP (JPEG/PNG, décodage navigateur + score).
        let analyzed;
        let tStep = performance.now();
        const lap = (key) => { const t = performance.now(); this.timings[key].push(t - tStep); tStep = t; };
        // Pool élite : copie de l'image d'origine, pour pouvoir la réanalyser
        // et la retirer du stack plus tard (même analyse → même contribution)
        const store = this._selection === 'elite' && this._mode !== 'live'
            ? { data: pixels.buffer.slice(pixels.byteOffset, pixels.byteOffset + pixels.byteLength),
                format, srcW, srcH, cropSize, bayerPattern, bitDepth }
            : null;
        if (format === 'jpeg' || format === 'png' || format === 'rgba') {
            const imgCopy = pixels.buffer.slice(pixels.byteOffset, pixels.byteOffset + pixels.byteLength);
            analyzed = await this._analyzeImage(new Uint8Array(imgCopy), format, cropSize, frameIdx,
                                                srcW, srcH);
        } else {
            const pixelCopy = pixels.buffer.slice(pixels.byteOffset, pixels.byteOffset + pixels.byteLength);
            const rawPixels = bitDepth === 8 ? new Uint8Array(pixelCopy) : new Uint16Array(pixelCopy);
            analyzed = await this._analyze(
                rawPixels, srcW, srcH, cropSize, bayerPattern, frameIdx, bitDepth
            );
        }
        if (!analyzed) return;
        lap('analyze');

        const { sharpness, float32Buffer, packedGrayBuffer,
                width: _fw, height: _fh } = analyzed;
        const frameW = _fw ?? cropSize;
        const frameH = _fh ?? cropSize;

        // Détection changement de dimensions (ROI modifié en cours de session)
        if (this._initialized && (frameW !== this._cropW || frameH !== this._cropH)) {
            console.log(`[Stacker] dimensions ${this._cropW}×${this._cropH} → ${frameW}×${frameH} — reset`);
            this.reset();
        }

        // 2. Qualité adaptative — fenêtre glissante 50 frames, seuil = percentile (1 - threshold)
        this._lastSharpness = sharpness ?? 0;
        this._sharpnessBuffer.push(this._lastSharpness);
        if (this._sharpnessBuffer.length > this._sharpnessBufferSize)
            this._sharpnessBuffer.shift();

        let accepted = this._mode === 'live';
        const elite = !!store;
        if (elite) {
            // pool pas plein : tout entre ; plein : seulement mieux que la pire
            const pool = this._pool;
            accepted = pool.length < this._poolSize
                || this._lastSharpness > pool.reduce((m, e) => Math.min(m, e.score), Infinity);
        } else if (!accepted) {
            if (this._sharpnessBuffer.length < 5) {
                accepted = true;   // accepter les premières frames le temps de calibrer
            } else {
                const sorted = [...this._sharpnessBuffer].sort((a, b) => a - b);
                const idx    = Math.max(0, Math.floor((1 - this._qualityThreshold) * sorted.length) - 1);
                accepted     = this._lastSharpness >= sorted[idx];
            }
        }

        this.dispatchEvent(new CustomEvent('frame', { detail: {
            frameIndex:    frameIdx,
            score:         this._lastSharpness,
            accepted,
            stackedCount:  this._stackedCount,
            droppedFrames: this._receiver?.droppedFrames ?? 0,
        }}));

        if (!accepted) return;

        // 3. Première frame acceptée : initialiser le stacking
        if (!this._initialized) {
            this._cropW = frameW;
            this._cropH = frameH;
            await this._initStacking(float32Buffer, frameW, frameH);
            const zeroShifts = this._alignmentPoints.map(() => ({ dx: 0, dy: 0, quality: 1 }));
            await this._stackFrame(float32Buffer, zeroShifts, sharpness);
            if (elite) this._pool.push({ score: this._lastSharpness, store, shifts: zeroShifts,
                                         exposure_ms: exposure_ms ?? 0, gain: gain ?? 0 });
        } else {
            // 4. Alignement (optionnel) puis accumulation
            let shifts;
            if (this._alignMode !== 'none') {
                shifts = await this._matchTemplates(packedGrayBuffer, this._cropW, this._cropH);
            } else {
                shifts = this._alignmentPoints.map(() => ({ dx: 0, dy: 0, quality: 1 }));
            }
            lap('align');
            await this._stackFrame(float32Buffer, shifts, sharpness);
            lap('stack');
            if (elite) this._pool.push({ score: this._lastSharpness, store, shifts,
                                         exposure_ms: exposure_ms ?? 0, gain: gain ?? 0 });
        }

        // 5. Compteurs
        this._stackedCount++;
        this._totalExpMs += exposure_ms ?? 0;
        this._gainSum    += gain ?? 0;
        if (elite && this._pool.length > this._poolSize) await this._removeWorstFromPool();

        // 6. Preview
        const now = performance.now();
        if (this._canvas && this._stackedCount % this._previewEveryN === 0
            && (this._stackedCount === 1 || now >= this._nextPreviewAt)) {
            this._lastPreviewAt = now;
            tStep = performance.now();
            await this._updatePreview();
            this._previewDone(now);
            lap('preview');
        }
    }

    // Pool élite : retire du stack l'image la moins nette — réanalysée depuis
    // sa copie d'origine puis recalée avec ses décalages et un poids −1, ce qui
    // annule exactement sa contribution (accumulation linéaire).
    async _removeWorstFromPool() {
        const pool = this._pool;
        let k = 0;
        for (let i = 1; i < pool.length; i++) if (pool[i].score < pool[k].score) k = i;
        const [e] = pool.splice(k, 1);
        const st = e.store, id = -(++this._reqId);
        const analyzed = (st.format === 'jpeg' || st.format === 'png' || st.format === 'rgba')
            ? await this._analyzeImage(new Uint8Array(st.data), st.format, st.cropSize, id, st.srcW, st.srcH)
            : await this._analyze(st.bitDepth === 8 ? new Uint8Array(st.data) : new Uint16Array(st.data),
                                  st.srcW, st.srcH, st.cropSize, st.bayerPattern, id, st.bitDepth);
        if (!analyzed?.float32Buffer) return;
        await this._stackFrame(analyzed.float32Buffer, e.shifts, e.score, -1);
        this._stackedCount--;
        this._totalExpMs -= e.exposure_ms;
        this._gainSum    -= e.gain;
        this._poolReplaced++;
    }

    /** Pool élite : { size, capacity, minScore, replaced, bytes } (null en fenêtre glissante). */
    get eliteStats() {
        if (this._selection !== 'elite') return null;
        const pool = this._pool;
        return {
            size: pool.length, capacity: this._poolSize, replaced: this._poolReplaced,
            minScore: pool.length ? pool.reduce((m, e) => Math.min(m, e.score), Infinity) : 0,
            bytes: pool.reduce((a, e) => a + e.store.data.byteLength, 0),
        };
    }

    // Mode 'stars' : une image Bayer → pixels chauds, étoiles, appariement,
    // rejet éventuel, drizzle dans le worker ; compte rendu dans
    // lastStarReport et dans l'événement 'frame' (detail.stars).
    async _processStarsFrame(raw, w, h, bayer, frameIdx, gain, exposure_ms, lap, blackLevel = 0, layout = 'bayer') {
        if (!this._initialized) {
            this._cropW = w;
            this._cropH = h;
            await new Promise((resolve, reject) => {
                const handler = ({ data }) => {
                    if (data?.type === 'init-stacking-done') {
                        this._stackWorker.removeEventListener('message', handler); resolve();
                    } else if (data?.type === 'init-stacking-error') {
                        this._stackWorker.removeEventListener('message', handler); reject(new Error(data.error));
                    }
                };
                this._stackWorker.addEventListener('message', handler);
                this._stackWorker.postMessage({ type: 'init-stacking', width: w, height: h, bayer, layout,
                                                starAlign: this._starAlign });
            });
            this._initialized = true;
            this._rejectedCount = 0;
        }
        const report = await new Promise((resolve, reject) => {
            const requestId = ++this._reqId;
            const handler = ({ data }) => {
                if (!data || data.requestId !== requestId) return;
                if (data.type === 'stack-stars-done') {
                    this._stackWorker.removeEventListener('message', handler); resolve(data.report);
                } else if (data.type === 'stack-frame-error') {
                    this._stackWorker.removeEventListener('message', handler); reject(new Error(data.error));
                }
            };
            this._stackWorker.addEventListener('message', handler);
            // Noir capteur en ADU 16 bits, même échelle que les pixels
            this._stackWorker.postMessage({ type: 'stack-frame-stars', requestId, raw, black: blackLevel },
                                          [raw.buffer]);
        });
        lap('stack');
        this._lastStarReport = report;
        if (report.accepted) {
            this._stackedCount++;
            this._totalExpMs += exposure_ms ?? 0;
            this._gainSum    += gain ?? 0;
        } else {
            this._rejectedCount = (this._rejectedCount ?? 0) + 1;
            console.log(`[Stacker] image ${frameIdx} rejetée : ${report.reason}`);
        }
        this.dispatchEvent(new CustomEvent('frame', { detail: {
            frameIndex: frameIdx, accepted: report.accepted, stackedCount: this._stackedCount,
            droppedFrames: this._receiver?.droppedFrames ?? 0, stars: report,
        }}));
        const now = performance.now();
        if (report.accepted && this._canvas
            && (this._stackedCount === 1 || now >= this._nextPreviewAt)) {
            this._lastPreviewAt = now;
            await this._updatePreview();
            this._previewDone(now);
            lap('preview');
        }
    }

    _previewDone(startedAt) {
        const end = performance.now();
        this._nextPreviewAt = end + Math.max(this._previewIntervalMs, 2 * (end - startedAt));
    }

    get lastStarReport() { return this._lastStarReport ?? null; }
    get rejectedCount()  { return this._rejectedCount ?? 0; }

    // -------------------------------------------------------------------------
    // Appels workers
    // -------------------------------------------------------------------------

    _workerInit(worker, name) {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(
                () => reject(new Error(`Worker '${name}' init timeout`)), 30_000
            );
            const handler = ({ data }) => {
                if (!data) {
                    clearTimeout(timeout);
                    worker.removeEventListener('message', handler);
                    reject(new Error(`Worker '${name}' crashed on init`));
                    return;
                }
                if (data.type === 'ready') {
                    clearTimeout(timeout);
                    worker.removeEventListener('message', handler);
                    resolve();
                } else if (data.type === 'init-error') {
                    clearTimeout(timeout);
                    worker.removeEventListener('message', handler);
                    reject(new Error(data.error ?? `Worker '${name}' init-error`));
                }
            };
            worker.addEventListener('message', handler);
            worker.postMessage({ type: 'init' });
        });
    }

    // Envoie la frame au worker pour débayérisation + score — transfère le buffer (zéro copie)
    _analyze(pixels, srcW, srcH, cropSize, bayerPattern, requestId, bitDepth = 16) {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(
                () => reject(new Error('Analyze timeout')), 60_000
            );
            const handler = ({ data }) => {
                if (!data || data.requestId !== requestId) return;
                if (data.type === 'crop-analyze-result') {
                    clearTimeout(timeout);
                    this._analyzeWorker.removeEventListener('message', handler);
                    resolve(data.results?.[0] ?? null);
                } else if (data.type === 'crop-analyze-error') {
                    clearTimeout(timeout);
                    this._analyzeWorker.removeEventListener('message', handler);
                    reject(new Error(data.error));
                }
            };
            this._analyzeWorker.addEventListener('message', handler);

            this._analyzeWorker.postMessage({
                type:         'crop-analyze-batch',
                frames:       [{ data: pixels, index: 0 }],
                srcWidth:     srcW,
                srcHeight:    srcH,
                cropSize,
                centers:      [{ x: srcW / 2, y: srcH / 2 }],
                bayerPattern,
                bitDepth,
                threshold:    this._qualityThreshold,
                requestId,
                metadataOnly: false,
            }, [pixels.buffer]);
        });
    }

    // Envoie des bytes JPEG/PNG (déjà débayerisés par l'ISP) au worker pour
    // décodage + score — pendant analogue de _analyze() pour le chemin non-Bayer.
    _analyzeImage(bytes, format, cropSize, requestId, width, height) {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(
                () => reject(new Error('Image analyze timeout')), 60_000
            );
            const handler = ({ data }) => {
                if (!data || data.requestId !== requestId) return;
                if (data.type === 'image-analyze-result') {
                    clearTimeout(timeout);
                    this._analyzeWorker.removeEventListener('message', handler);
                    resolve(data.result ?? null);
                } else if (data.type === 'image-analyze-error') {
                    clearTimeout(timeout);
                    this._analyzeWorker.removeEventListener('message', handler);
                    reject(new Error(data.error));
                }
            };
            this._analyzeWorker.addEventListener('message', handler);

            this._analyzeWorker.postMessage({
                type:     'image-analyze',
                bytes,
                mimeType: format === 'png' ? 'image/png' : format === 'rgba' ? 'image/x-rgba' : 'image/jpeg',
                cropSize,
                width,
                height,
                requestId,
            }, [bytes.buffer]);
        });
    }

    // Initialise le stacking à partir de la première frame acceptée
    async _initStacking(float32Buffer, w, h) {
        const refGray = float32ToGray(float32Buffer, w, h);
        this._refBrightness = meanBrightness(float32Buffer, w, h);

        const searchRadius = this._searchRadius;
        const { alignmentPoints, patchSize } = createAPGrid(w, h, searchRadius);
        const activeAPs = filterAPsByQuality(alignmentPoints, refGray, w, h, patchSize);

        this._refGrayData     = refGray;
        this._alignmentPoints = activeAPs;
        this._patchSize       = patchSize;
        this._searchRadius    = searchRadius;

        await new Promise((resolve, reject) => {
            const handler = ({ data }) => {
                if (!data) return;
                if (data.type === 'init-stacking-done') {
                    this._stackWorker.removeEventListener('message', handler);
                    resolve();
                } else if (data.type === 'init-stacking-error') {
                    this._stackWorker.removeEventListener('message', handler);
                    reject(new Error(data.error));
                }
            };
            this._stackWorker.addEventListener('message', handler);
            this._stackWorker.postMessage({
                type:            'init-stacking',
                width:           w,
                height:          h,
                srcWidth:        w,
                srcHeight:       h,
                drizzleScale:    1.0,
                alignmentPoints: activeAPs,
                patchSize,
                refBrightness:   this._refBrightness,
                minApQuality:    0.02,
                bayerPattern:    -1,
                bitDepth:        16,
                bayerScale:      1.0,
                pixfrac:         1.0,
            });
        });

        this._initialized = true;
    }

    // Template matching : retourne les shifts pour la frame courante
    // packedGrayBuffer est transféré → ne pas réutiliser après l'appel
    _matchTemplates(packedGrayBuffer, w, h) {
        return new Promise((resolve, reject) => {
            const requestId = ++this._reqId;
            const timeout   = setTimeout(
                () => reject(new Error('Template match timeout')), 30_000
            );
            const handler = ({ data }) => {
                if (!data || data.requestId !== requestId) return;
                if (data.type === 'batch-result') {
                    clearTimeout(timeout);
                    this._stackWorker.removeEventListener('message', handler);
                    resolve(data.allShifts?.[0] ?? this._alignmentPoints.map(() => ({ dx: 0, dy: 0, quality: 1 })));
                } else if (data.type === 'batch-error') {
                    clearTimeout(timeout);
                    this._stackWorker.removeEventListener('message', handler);
                    reject(new Error(data.error));
                }
            };
            this._stackWorker.addEventListener('message', handler);

            const grayU8 = new Uint8Array(packedGrayBuffer);

            this._stackWorker.postMessage({
                type:            'match-templates-batch',
                requestId,
                refGrayData:     this._refGrayData,
                frameGrayDatas:  [grayU8],
                width:           w,
                height:          h,
                alignmentPoints: this._alignmentPoints,
                patchSize:       this._patchSize,
                searchRadius:    this._searchRadius,
            }, [grayU8.buffer]);
        });
    }

    // Accumulation dans le stack GPU — float32Buffer transféré
    _stackFrame(float32Buffer, shifts, sharpness, weight = 1.0) {
        return new Promise((resolve, reject) => {
            const handler = ({ data }) => {
                if (!data) return;
                if (data.type === 'stack-batch-done') {
                    this._stackWorker.removeEventListener('message', handler);
                    resolve();
                } else if (data.type === 'stack-frame-error') {
                    this._stackWorker.removeEventListener('message', handler);
                    reject(new Error(data.error));
                }
            };
            this._stackWorker.addEventListener('message', handler);

            const rgba = new Float32Array(float32Buffer);
            this._stackWorker.postMessage({
                type:         'stack-frame-batch-rgba',
                frames:       [{ rgbaBuffer: rgba, sharpness: Math.max(sharpness ?? 1, 0.001) }],
                shifts:       [shifts],
                frameWeights: [weight],   // −1 : retrait exact d'une image (pool élite)
            }, [rgba.buffer]);   // transfert zéro copie
        });
    }

    // Lit le stack courant depuis le GPU, étire et dessine sur le canvas
    async _updatePreview() {
        // worker gardé localement : stop() peut le retirer pendant l'attente
        const wk = this._stackWorker;
        if (!wk) return;
        const snap = await new Promise((resolve) => {
            const handler = ({ data }) => {
                if (!data) return;
                if (data.type === 'stack-snapshot-complete' || data.type === 'snapshot-error') {
                    wk.removeEventListener('message', handler);
                    resolve(data.type === 'stack-snapshot-complete' ? data : null);
                }
            };
            wk.addEventListener('message', handler);
            wk.postMessage({ type: 'get-stack-snapshot' });
        });
        if (!snap?.float32Buffer) return;
        this._lastSnap = { data: new Float32Array(snap.float32Buffer), width: snap.width, height: snap.height };
        this._render();
    }

    // Re-rendu du dernier snapshot quand un réglage d'affichage change (même
    // stack terminé) ; les mouvements de curseur rapprochés sont regroupés.
    // setTimeout plutôt que requestAnimationFrame, suspendu onglet masqué.
    _scheduleRender() {
        if (!this._lastSnap || this._renderPending) return;
        this._renderPending = true;
        setTimeout(() => { this._renderPending = false; this._render(); }, 0);
    }

    _render() {
        const snap = this._lastSnap;
        if (!snap || !this._canvas) return;
        const { width: w, height: h } = snap;
        const awbGains = this._awbEnabled ? computeAWBGains(snap.data, w, h) : null;
        const post = this._postActive;
        const sharpened = post ? applyWavelets(snap.data, w, h, this._wavelets, this._waveletDenoise)
                               : snap.data;
        if (this._stretchMode === 'auto') {
            this.lastAutoStretch = autoStretchToCanvas(sharpened, w, h, this._canvas, this._autoState, snap, {
                target: this._stretchTarget, localContrast: this._localContrast,
                removeGreen: this._removeGreen, count: Math.max(1, this._stackedCount),
                clahe: post ? this._clahe : 0, saturation: this._saturation,
            });
        } else {
            stretchToCanvas(sharpened, w, h, this._canvas, this._stretchLow, this._stretchHigh,
                            this._stretchBeta, awbGains, this._contrast, post ? this._clahe : 0,
                            this._saturation, this._bgNeutral, this._removeGreen, this._localContrast);
        }
        this.dispatchEvent(new CustomEvent('preview'));
    }
}
