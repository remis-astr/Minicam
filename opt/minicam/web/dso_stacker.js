'use strict';
/**
 * DsoStacker — empilement ciel profond aligné sur les étoiles (Live Stack),
 * directement sur les pixels bruts Bayer : la qualité prime sur la vitesse
 * (moins de 2 % d'une pose de quelques secondes suffisent).
 *
 * Pour chaque image Bayer 16 bits :
 *   0. bruit de ligne retiré (décalage propre à chaque ligne brute et couleur,
 *      mesuré contre les lignes voisines de même couleur, hors étoiles) :
 *      motif fixe du capteur, qui ne se moyenne pas sans dithering (IMX477
 *      binné : période 8 lignes, ~7 ADU) ;
 *   1. pixels chauds / morts corrigés (8 voisins de même couleur ; critère
 *      qui épargne le cœur des étoiles, dont les voisines à 2 px restent
 *      lumineuses), puis égalisation locale des deux verts Bayer (Gr/Gb) :
 *      sinon, sans dithering, une grille de 2 px apparaît (IMX477 : écart de
 *      1 à 2 %, variable avec la couleur de la scène) ;
 *   2. détection des étoiles (star_align.js) et appariement avec l'image de
 *      référence ; image rejetée si l'appariement échoue ;
 *   3. normalisation photométrique : facteur k = médiane des rapports de flux
 *      des étoiles appariées (poses différentes, voile, transparence), puis
 *      fond de ciel ramené à celui de la référence, couleur par couleur et
 *      point par point (carte de fond de la détection, recalée) : un gradient
 *      de ciel qui change n'est pas pris pour une anomalie au rejet σ ;
 *   4. poids de l'image ∝ (σ_réf / (k·σ))² × min(1, (FWHM_réf / FWHM)²) ;
 *   5. drizzle Bayer : chaque pixel brut est déposé, dans son canal, à sa
 *      position recalée (goutte carrée de côté pixfrac, poids = surface
 *      recouverte) — ni débayérisage ni interpolation de l'image recalée ;
 *   6. rejet σ au fil de l'eau : moyenne et écart-type (non biaisé) par
 *      pixel et par canal (Welford, valeurs bornées) ; au-delà de
 *      `clipMinFrames` images, une valeur à plus de κ·σ au-dessus
 *      (satellite, avion, rayon cosmique) ou κ_bas·σ en dessous n'est pas
 *      empilée ; l'écart toléré inclut une part du signal (β·signal), pour
 *      ne pas rejeter les ailes d'étoiles d'une image plus floue ;
 *   7. référence : parmi les `refCandidates` premières images, la plus fine
 *      (FWHM) devient la référence et ces images sont réempilées.
 * Au rendu : un canal peu ou pas couvert en un pixel (premières images, ou
 * pas de dithering) est estimé par débayérisage Malvar-He-Cutler de la
 * mosaïque empilée, mélangé au drizzle selon la couverture ; alpha =
 * couverture.
 *
 * Calcul sur GPU (WebGPU) ou, sans WebGPU, sur CPU avec des algorithmes
 * identiques. Module autonome, utilisable dans les workers comme dans Node.
 */

import {
    StarDetectorGPU, detectStarsCPU, lumBin2FromBayer, matchStars, invertTransform, describeTransform,
    STAR_DEFAULTS,
} from './star_align.js';

const STAR_BLOCK = STAR_DEFAULTS.blockSize;   // bloc de fond de la détection (px binnés)

export const DSO_DEFAULTS = {
    model:         'similarity',  // 'similarity' (rotation + translation) | 'affine'
    align:         true,          // false : pas de recalage (monture guidée), le reste inchangé
    minStars:      8,             // étoiles appariées minimum
    minInlierFrac: 0.15,          // et au moins cette part des étoiles détectées (faux appariements)
    rowBanding:    true,          // retire le décalage propre à chaque ligne (bruit de ligne du capteur)
    greenBalance:  true,          // égalise localement les deux verts Bayer (déséquilibre Gr/Gb)
    greenRel:      0.08,          // écart toléré pour l'égalisation : 8 % du niveau + 4 σ
    hotPixels:     true,
    hotK:          6,             // seuil pixels chauds, en σ du bruit brut
    pixfrac:       1.0,           // côté de la goutte du drizzle (pixels)
    sigmaClip:     true,
    kappa:         3,             // rejet au-dessus (satellite, avion, rayon cosmique)
    kappaLow:      5,             // rejet en dessous (plus tolérant : turbulence, cœur d'étoile)
    clipMinFrames: 10,            // images avant d'activer le rejet σ
    clipSignalTol: 0.15,          // tolérance ∝ signal (turbulence sur les étoiles) : σ² + (β·signal)²
    photometric:   true,          // normalisation par le flux des étoiles
    weighting:     true,          // poids bruit + FWHM
    refCandidates: 5,             // la meilleure des N premières devient la référence
    maxFwhmRatio:  0,             // rejet si FWHM > ratio × réf. (0 = jamais)
    maxElong:      0,             // rejet si allongement médian > valeur (0 = jamais)
};

const INV16 = 1 / 65535;
const SAT_LEVEL = 0.97 * 65535;
const CH = { R: 0, G: 1, B: 2 };

/** Code des couleurs Bayer (2 bits par position (y&1)*2+(x&1)). */
function bayerCode(pattern) {
    const p = (pattern || 'RGGB').toUpperCase();
    let code = 0;
    for (let i = 0; i < 4; i++) code |= (CH[p[i]] ?? 1) << (2 * i);
    return code;
}
const colorAt = (code, x, y) => (code >> (2 * (((y & 1) << 1) | (x & 1)))) & 3;

/** Carte de fond de la détection, divisée par sa médiane (1 = fond moyen). */
function normGrid(grid) {
    const m = median(grid) || 1;
    return Float32Array.from(grid, (v) => v / m);
}

const median = (a) => {
    const s = Float64Array.from(a).sort();
    return s.length ? (s.length % 2 ? s[s.length >> 1] : 0.5 * (s[s.length / 2 - 1] + s[s.length / 2])) : 0;
};

// ---------------------------------------------------------------------------
// Shaders
// ---------------------------------------------------------------------------

const RAW_WGSL = /* wgsl */`
fn rawAt(i: u32) -> f32 { return f32((raw[i >> 1u] >> ((i & 1u) * 16u)) & 0xffffu); }
`;

// Pixels chauds/morts : un thread par mot (2 pixels).
const HOT_WGSL = /* wgsl */`
struct HP { w: u32, h: u32, thr: f32, _p: f32 };
@group(0) @binding(0) var<uniform> P: HP;
@group(0) @binding(1) var<storage, read> raw: array<u32>;
@group(0) @binding(2) var<storage, read_write> fixedRaw: array<u32>;
@group(0) @binding(3) var<storage, read_write> counter: array<atomic<u32>>;
` + RAW_WGSL + /* wgsl */`
fn nb(x: i32, y: i32, dx: i32, dy: i32) -> f32 {
    var xx = x + dx; var yy = y + dy;
    if (xx < 0 || xx >= i32(P.w)) { xx = x - dx; }
    if (yy < 0 || yy >= i32(P.h)) { yy = y - dy; }
    return rawAt(u32(yy) * P.w + u32(xx));
}
fn fixPx(x: i32, y: i32) -> u32 {
    let v = rawAt(u32(y) * P.w + u32(x));
    var s = array<f32, 8>(nb(x, y, -2, -2), nb(x, y, 0, -2), nb(x, y, 2, -2), nb(x, y, -2, 0),
                          nb(x, y, 2, 0), nb(x, y, -2, 2), nb(x, y, 0, 2), nb(x, y, 2, 2));
    for (var i = 1; i < 8; i++) {
        let k = s[i]; var j = i - 1;
        loop { if (j < 0 || s[j] <= k) { break; } s[j + 1] = s[j]; j--; }
        s[j + 1] = k;
    }
    let med = 0.5 * (s[3] + s[4]);
    if (v > med + 2.0 * (s[7] - med) + P.thr || v < med - 2.0 * (med - s[0]) - P.thr) {
        atomicAdd(&counter[0], 1u);
        return u32(round(med));
    }
    return u32(v);
}
@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) g: vec3<u32>) {
    let hw = P.w / 2u;
    if (g.x >= hw || g.y >= P.h) { return; }
    let x = i32(2u * g.x); let y = i32(g.y);
    fixedRaw[g.y * hw + g.x] = fixPx(x, y) | (fixPx(x + 1, y) << 16u);
}
`;

// Échantillonnage bilinéaire d'une grille de fond (blocs de P.bs px bruts)
const gridFn = (name, buf) => /* wgsl */`
fn ${name}(x: f32, y: f32) -> f32 {
    let gx = clamp((x + 0.5) / P.bs - 0.5, 0.0, f32(P.nbx - 1u));
    let gy = clamp((y + 0.5) / P.bs - 0.5, 0.0, f32(P.nby - 1u));
    let x0 = u32(floor(gx)); let y0 = u32(floor(gy));
    let x1 = min(P.nbx - 1u, x0 + 1u); let y1 = min(P.nby - 1u, y0 + 1u);
    let fx = gx - f32(x0); let fy = gy - f32(y0);
    let top = ${buf}[y0 * P.nbx + x0] * (1.0 - fx) + ${buf}[y0 * P.nbx + x1] * fx;
    let bot = ${buf}[y1 * P.nbx + x0] * (1.0 - fx) + ${buf}[y1 * P.nbx + x1] * fx;
    return top * (1.0 - fy) + bot * fy;
}
`;

// Égalisation locale des verts : un vert est comparé à la moyenne de son
// type (lui + 4 voisins à 2 px) et à celle de ses 4 voisins diagonaux (l'autre
// type de vert) ; si l'écart est faible (déséquilibre, pas un détail), il est
// ramené à mi-chemin. Un thread par mot (2 pixels).
const GEQ_WGSL = /* wgsl */`
struct GP { w: u32, h: u32, cmap: u32, _p: u32, thr: f32, rel: f32, black: f32, _q: f32 };
@group(0) @binding(0) var<uniform> P: GP;
@group(0) @binding(1) var<storage, read> raw: array<u32>;
@group(0) @binding(2) var<storage, read_write> outRaw: array<u32>;
@group(0) @binding(3) var<storage, read_write> counter: array<atomic<u32>>;
` + RAW_WGSL + /* wgsl */`
fn at(x: i32, y: i32) -> f32 {
    var xx = x; var yy = y;
    if (xx < 0) { xx = -xx; } else if (xx >= i32(P.w)) { xx = 2 * (i32(P.w) - 1) - xx; }
    if (yy < 0) { yy = -yy; } else if (yy >= i32(P.h)) { yy = 2 * (i32(P.h) - 1) - yy; }
    return rawAt(u32(yy) * P.w + u32(xx));
}
fn eqPx(x: i32, y: i32) -> u32 {
    let v = at(x, y);
    let c = (P.cmap >> (2u * (((u32(y) & 1u) << 1u) | (u32(x) & 1u)))) & 3u;
    if (c != 1u) { return u32(v); }
    let same = (v + at(x - 2, y) + at(x + 2, y) + at(x, y - 2) + at(x, y + 2)) * 0.2;
    let other = (at(x - 1, y - 1) + at(x + 1, y - 1) + at(x - 1, y + 1) + at(x + 1, y + 1)) * 0.25;
    let d = other - same;
    let lvl = max(0.0, 0.5 * (same + other) - P.black);
    if (abs(d) < P.rel * lvl + P.thr) {
        if (abs(d) >= 1.0) { atomicAdd(&counter[2], 1u); }
        return u32(clamp(round(v + 0.5 * d), 0.0, 65535.0));
    }
    return u32(v);
}
@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) g: vec3<u32>) {
    let hw = P.w / 2u;
    if (g.x >= hw || g.y >= P.h) { return; }
    let x = i32(2u * g.x); let y = i32(g.y);
    outRaw[g.y * hw + g.x] = eqPx(x, y) | (eqPx(x + 1, y) << 16u);
}
`;

// Drizzle Bayer + rejet σ : un thread par pixel de sortie (repère de la
// référence). Les pixels bruts dont la goutte recouvre ce pixel sont dans le
// voisinage 3×3 de son antécédent (rotation faible, échelle ≈ 1).
const DRIZZLE_WGSL = /* wgsl */`
struct DP {
    w: u32, h: u32, cmap: u32, nmin: u32,
    m0: f32, m1: f32, m2: f32, m3: f32, m4: f32, m5: f32,
    i0: f32, i1: f32, i2: f32, i3: f32, i4: f32, i5: f32,
    black: f32, k: f32, pf: f32, kappa: f32,
    fw: f32, bg0: f32, bg1: f32, bg2: f32,       // fond par couleur de l'image (×k)
    clip: f32, kappaLow: f32, nbx: u32, nby: u32,
    rb0: f32, rb1: f32, rb2: f32, bs: f32,       // fond par couleur de la réf. ; bloc (px bruts)
    tol: f32, y0: u32, rows: u32, _q2: f32,       // bande de sortie : lignes [y0, y0 + rows)
};
@group(0) @binding(0) var<uniform> P: DP;
@group(0) @binding(1) var<storage, read> raw: array<u32>;
@group(0) @binding(2) var<storage, read_write> acc: array<f32>;    // aR aG aB wR wG wB
@group(0) @binding(3) var<storage, read_write> st: array<f32>;     // moy×3, M2×3, n×3
@group(0) @binding(4) var<storage, read_write> counter: array<atomic<u32>>;
@group(0) @binding(5) var<storage, read> gCur: array<f32>;   // carte de fond normalisée (image)
@group(0) @binding(6) var<storage, read> gRef: array<f32>;   // idem (référence)
` + RAW_WGSL + /* wgsl */`
${gridFn('gridCur', 'gCur')}${gridFn('gridRef', 'gRef')}
@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) g: vec3<u32>) {
    if (g.x >= P.w || g.y >= P.rows) { return; }
    let px = f32(g.x); let py = f32(P.y0 + g.y);
    let sx = P.i0 * px + P.i1 * py + P.i2;
    let sy = P.i3 * px + P.i4 * py + P.i5;
    let hp = 0.5 * P.pf;
    // fond local : image (en son antécédent) − référence (en ce pixel)
    let gc = gridCur(sx, sy); let gr = gridRef(px, py);
    var off = array<f32, 3>(P.bg0 * gc - P.rb0 * gr, P.bg1 * gc - P.rb1 * gr, P.bg2 * gc - P.rb2 * gr);
    var sky = array<f32, 3>(P.rb0 * gr, P.rb1 * gr, P.rb2 * gr);   // fond de la réf. ici
    var sum = array<f32, 3>(0.0, 0.0, 0.0);
    var ws = array<f32, 3>(0.0, 0.0, 0.0);
    let bx = i32(floor(sx + 0.5)); let by = i32(floor(sy + 0.5));
    for (var dy = -1; dy <= 1; dy++) {
        for (var dx = -1; dx <= 1; dx++) {
            let x = bx + dx; let y = by + dy;
            if (x < 0 || y < 0 || x >= i32(P.w) || y >= i32(P.h)) { continue; }
            let qx = P.m0 * f32(x) + P.m1 * f32(y) + P.m2;
            let qy = P.m3 * f32(x) + P.m4 * f32(y) + P.m5;
            let ox = max(0.0, min(px + 0.5, qx + hp) - max(px - 0.5, qx - hp));
            let oy = max(0.0, min(py + 0.5, qy + hp) - max(py - 0.5, qy - hp));
            let wgt = ox * oy;
            if (wgt <= 0.0) { continue; }
            let c = (P.cmap >> (2u * (((u32(y) & 1u) << 1u) | (u32(x) & 1u)))) & 3u;
            let v = (rawAt(u32(y) * P.w + u32(x)) - P.black) * P.k * ${INV16.toPrecision(12)} - off[c];
            sum[c] += wgt * v; ws[c] += wgt;
        }
    }
    let p = g.y * P.w + g.x;   // indice dans la bande
    for (var c = 0u; c < 3u; c++) {
        if (ws[c] <= 1e-6) { continue; }
        let v = sum[c] / ws[c];
        let n = st[9u * p + 6u + c];
        let mean = st[9u * p + c];
        let m2 = st[9u * p + 3u + c];
        var vw = v;
        var keep = true;
        if (P.clip > 0.5 && n >= f32(P.nmin)) {
            let sig = P.tol * max(0.0, mean - sky[c]);
            let sd = sqrt(m2 / (n - 1.0) + sig * sig);
            if (sd > 0.0 && (v - mean > P.kappa * sd || mean - v > P.kappaLow * sd)) {
                keep = false;
                vw = clamp(v, mean - P.kappaLow * sd, mean + P.kappa * sd);
                atomicAdd(&counter[1], 1u);
            }
        }
        // Welford sur la valeur (bornée si rejetée)
        let n1 = n + 1.0;
        let d = vw - mean;
        let mean1 = mean + d / n1;
        st[9u * p + c] = mean1;
        st[9u * p + 3u + c] = m2 + d * (vw - mean1);
        st[9u * p + 6u + c] = n1;
        if (keep) {
            acc[6u * p + c] += P.fw * ws[c] * v;
            acc[6u * p + 3u + c] += P.fw * ws[c];
        }
    }
}
`;

async function makePipeline(device, code, label) {
    const module = device.createShaderModule({ code, label });
    const info = await module.getCompilationInfo?.();
    for (const m of info?.messages ?? [])
        if (m.type === 'error') throw new Error(`Shader ${label} : ${m.message} (ligne ${m.lineNum})`);
    return device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' }, label });
}

// ---------------------------------------------------------------------------
// Versions CPU (mêmes algorithmes)
// ---------------------------------------------------------------------------

function hotPixelsCPU(raw, w, h, thr) {
    const out = new Uint16Array(raw.length);
    const s = new Float64Array(8);
    const DX = [-2, 0, 2, -2, 2, -2, 0, 2], DY = [-2, -2, -2, 0, 0, 2, 2, 2];
    let count = 0;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const v = raw[y * w + x];
            for (let k = 0; k < 8; k++) {
                let xx = x + DX[k], yy = y + DY[k];
                if (xx < 0 || xx >= w) xx = x - DX[k];
                if (yy < 0 || yy >= h) yy = y - DY[k];
                // tri par insertion (8 valeurs, comme le shader)
                const val = raw[yy * w + xx];
                let j = k - 1;
                while (j >= 0 && s[j] > val) { s[j + 1] = s[j]; j--; }
                s[j + 1] = val;
            }
            const med = 0.5 * (s[3] + s[4]);
            if (v > med + 2 * (s[7] - med) + thr || v < med - 2 * (med - s[0]) - thr) {
                out[y * w + x] = Math.round(med); count++;
            } else {
                out[y * w + x] = v;
            }
        }
    }
    return { fixed: out, count };
}

/** k-ième plus petit élément de a[0..n) (sélection rapide, modifie a). */
function select(a, n, k) {
    let lo = 0, hi = n - 1;
    while (lo < hi) {
        const pivot = a[(lo + hi) >> 1];
        let i = lo, j = hi;
        while (i <= j) {
            while (a[i] < pivot) i++;
            while (a[j] > pivot) j--;
            if (i <= j) { const t = a[i]; a[i] = a[j]; a[j] = t; i++; j--; }
        }
        if (k <= j) hi = j; else if (k >= i) lo = i; else break;
    }
    return a[k];
}

/**
 * Bruit de ligne : pour chaque ligne brute et chacune de ses deux couleurs,
 * écart de ses pixels à la moyenne des 8 lignes voisines de même couleur
 * (±2, ±4, ±6, ±8 : neutralise la structure de la scène) ; décalage = médiane
 * de ces écarts hors étoiles (|écart| < 4 × écart absolu médian), estimée sur
 * un pixel sur deux de la couleur ; soustrait de toute la ligne.
 */
function rowBandingCPU(raw, w, h) {
    const out = new Uint16Array(raw);
    const cap = (w >> 2) + 2;
    const d = new Float64Array(cap), e = new Float64Array(cap), kept = new Float64Array(cap);
    const R = [2, 4, 6, 8];
    let maxOff = 0;
    for (let y = 0; y < h; y++) {
        for (let par = 0; par < 2; par++) {
            let m = 0;
            for (let x = par; x < w; x += 4) {
                let s = 0, c = 0;
                for (let k = 0; k < 4; k++) {
                    const r = R[k];
                    if (y - r >= 0) { s += raw[(y - r) * w + x]; c++; }
                    if (y + r < h) { s += raw[(y + r) * w + x]; c++; }
                }
                d[m++] = raw[y * w + x] - s / c;
            }
            for (let i = 0; i < m; i++) e[i] = d[i];
            const med = select(e, m, m >> 1);
            for (let i = 0; i < m; i++) e[i] = Math.abs(d[i] - med);
            const lim = 4 * (select(e, m, m >> 1) || 1);
            let nk = 0;
            for (let i = 0; i < m; i++) if (Math.abs(d[i] - med) < lim) kept[nk++] = d[i];
            const off = nk ? select(kept, nk, nk >> 1) : 0;
            if (Math.abs(off) > maxOff) maxOff = Math.abs(off);
            if (Math.abs(off) < 0.5) continue;
            for (let x = par; x < w; x += 2) {
                const v = raw[y * w + x] - off;
                out[y * w + x] = v < 0 ? 0 : v > 65535 ? 65535 : Math.round(v);
            }
        }
    }
    return { fixed: out, maxOff };
}

function greenEqCPU(raw, w, h, cmap, thr, rel, black) {
    const out = new Uint16Array(raw.length);
    const at = (x, y) => {
        if (x < 0) x = -x; else if (x >= w) x = 2 * (w - 1) - x;
        if (y < 0) y = -y; else if (y >= h) y = 2 * (h - 1) - y;
        return raw[y * w + x];
    };
    let count = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const v = raw[y * w + x];
        if (colorAt(cmap, x, y) !== 1) { out[y * w + x] = v; continue; }
        const same = (v + at(x - 2, y) + at(x + 2, y) + at(x, y - 2) + at(x, y + 2)) * 0.2;
        const other = (at(x - 1, y - 1) + at(x + 1, y - 1) + at(x - 1, y + 1) + at(x + 1, y + 1)) * 0.25;
        const d = other - same, lvl = Math.max(0, 0.5 * (same + other) - black);
        if (Math.abs(d) < rel * lvl + thr) {
            if (Math.abs(d) >= 1) count++;
            out[y * w + x] = Math.min(65535, Math.max(0, Math.round(v + 0.5 * d)));
        } else {
            out[y * w + x] = v;
        }
    }
    return { fixed: out, count };
}

function gridSampler(grid, nbx, nby, bs) {
    return (x, y) => {
        const gx = Math.min(nbx - 1, Math.max(0, (x + 0.5) / bs - 0.5));
        const gy = Math.min(nby - 1, Math.max(0, (y + 0.5) / bs - 0.5));
        const x0 = Math.floor(gx), y0 = Math.floor(gy);
        const x1 = Math.min(nbx - 1, x0 + 1), y1 = Math.min(nby - 1, y0 + 1);
        const fx = gx - x0, fy = gy - y0;
        const top = grid[y0 * nbx + x0] * (1 - fx) + grid[y0 * nbx + x1] * fx;
        const bot = grid[y1 * nbx + x0] * (1 - fx) + grid[y1 * nbx + x1] * fx;
        return top * (1 - fy) + bot * fy;
    };
}

function drizzleCPU(raw, w, h, P, acc, st) {
    const { M, Mi, black, k, pf, kappa, kappaLow, fw, bg, rbg, clip, nmin, cmap } = P;
    const gCur = gridSampler(P.gCur, P.nbx, P.nby, P.bs), gRef = gridSampler(P.gRef, P.nbx, P.nby, P.bs);
    const hp = 0.5 * pf, scale = k * INV16;
    const sum = new Float64Array(3), ws = new Float64Array(3), off = new Float64Array(3), sky = new Float64Array(3);
    const tol = P.tol;
    let rejected = 0;
    for (let py = 0; py < h; py++) {
        for (let px = 0; px < w; px++) {
            const sx = Mi[0] * px + Mi[1] * py + Mi[2], sy = Mi[3] * px + Mi[4] * py + Mi[5];
            sum.fill(0); ws.fill(0);
            const gc = gCur(sx, sy), gr = gRef(px, py);
            for (let c = 0; c < 3; c++) { off[c] = bg[c] * gc - rbg[c] * gr; sky[c] = rbg[c] * gr; }
            const bx = Math.floor(sx + 0.5), by = Math.floor(sy + 0.5);
            for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
                const x = bx + dx, y = by + dy;
                if (x < 0 || y < 0 || x >= w || y >= h) continue;
                const qx = M[0] * x + M[1] * y + M[2], qy = M[3] * x + M[4] * y + M[5];
                const ox = Math.max(0, Math.min(px + 0.5, qx + hp) - Math.max(px - 0.5, qx - hp));
                const oy = Math.max(0, Math.min(py + 0.5, qy + hp) - Math.max(py - 0.5, qy - hp));
                const wgt = ox * oy;
                if (wgt <= 0) continue;
                const c = colorAt(cmap, x, y);
                sum[c] += wgt * ((raw[y * w + x] - black) * scale - off[c]); ws[c] += wgt;
            }
            const p = py * w + px;
            for (let c = 0; c < 3; c++) {
                if (ws[c] <= 1e-6) continue;
                const v = sum[c] / ws[c];
                const n = st[9 * p + 6 + c], mean = st[9 * p + c], m2 = st[9 * p + 3 + c];
                let vw = v, keep = true;
                if (clip && n >= nmin) {
                    const sig = tol * Math.max(0, mean - sky[c]);
                    const sd = Math.sqrt(m2 / (n - 1) + sig * sig);
                    if (sd > 0 && (v - mean > kappa * sd || mean - v > kappaLow * sd)) {
                        keep = false; rejected++;
                        vw = Math.min(mean + kappa * sd, Math.max(mean - kappaLow * sd, v));
                    }
                }
                const n1 = n + 1, d = vw - mean, mean1 = mean + d / n1;
                st[9 * p + c] = mean1; st[9 * p + 3 + c] = m2 + d * (vw - mean1); st[9 * p + 6 + c] = n1;
                if (keep) { acc[6 * p + c] += fw * ws[c] * v; acc[6 * p + 3 + c] += fw * ws[c]; }
            }
        }
    }
    return rejected;
}

// ---------------------------------------------------------------------------
// Rendu : drizzle + débayérisage Malvar-He-Cutler pour les couleurs manquantes
// ---------------------------------------------------------------------------

// Noyaux MHC (Malvar, He, Cutler 2004), ×1/8 : [dx, dy, poids]
const MHC = {
    g:   [[0, 0, 4], [1, 0, 2], [-1, 0, 2], [0, 1, 2], [0, -1, 2],
          [2, 0, -1], [-2, 0, -1], [0, 2, -1], [0, -2, -1]],
    row: [[0, 0, 5], [1, 0, 4], [-1, 0, 4], [2, 0, -1], [-2, 0, -1],
          [1, 1, -1], [-1, 1, -1], [1, -1, -1], [-1, -1, -1], [0, 2, 0.5], [0, -2, 0.5]],
    col: [[0, 0, 5], [0, 1, 4], [0, -1, 4], [0, 2, -1], [0, -2, -1],
          [1, 1, -1], [-1, 1, -1], [1, -1, -1], [-1, -1, -1], [2, 0, 0.5], [-2, 0, 0.5]],
    diag: [[0, 0, 6], [1, 1, 2], [-1, 1, 2], [1, -1, 2], [-1, -1, 2],
           [2, 0, -1.5], [-2, 0, -1.5], [0, 2, -1.5], [0, -2, -1.5]],
};

/**
 * Image RGBA finale depuis les accumulateurs du drizzle (somme pondérée et
 * poids par canal). Un canal bien couvert en un pixel garde la valeur du
 * drizzle ; un canal peu ou pas couvert (sans dithering, chaque pixel de
 * sortie ne reçoit que sa propre couleur Bayer) est estimé par
 * débayérisage Malvar-He-Cutler de la mosaïque empilée — corrélation entre
 * couleurs, pas de grille comme avec un simple flou des voisins — et les
 * deux sont mélangés selon la couverture réelle : w·drizzle + w0·MHC.
 */
function demosaicBlend(acc, w, h, cmap, wTyp) {
    const n = w * h;
    // mosaïque : valeur du canal natif (couleur Bayer) de chaque pixel
    const mos = new Float32Array(n);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const p = y * w + x, c = colorAt(cmap, x, y), wc = acc[6 * p + 3 + c];
        if (wc > 0) { mos[p] = acc[6 * p + c] / wc; continue; }
        // canal natif jamais déposé ici : moyenne des voisins de même couleur
        let a = 0, b = 0;
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
            const xx = x + dx, yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
            const q = yy * w + xx;
            a += acc[6 * q + c]; b += acc[6 * q + 3 + c];
        }
        mos[p] = b > 0 ? a / b : 0;
    }
    const at = (x, y) => {
        // miroir de pas pair aux bords : même couleur Bayer
        if (x < 0) x = -x; else if (x >= w) x = 2 * (w - 1) - x;
        if (y < 0) y = -y; else if (y >= h) y = 2 * (h - 1) - y;
        return mos[y * w + x];
    };
    const conv = (k, x, y) => { let s = 0; for (const [dx, dy, v] of k) s += v * at(x + dx, y + dy); return s / 8; };
    // Mêmes noyaux MHC déroulés, en indices directs : à 2 px ou plus du bord
    // aucun miroir n'est nécessaire. conv() générique (une closure et un test
    // de bord par échantillon) prenait ~15 s par aperçu en 4056×2160 et
    // espaçait les aperçus du Live Stack de plus de 30 s.
    const m = mos, w2 = 2 * w;
    const gI = (p) => (4 * m[p] + 2 * (m[p - 1] + m[p + 1] + m[p - w] + m[p + w])
                       - (m[p - 2] + m[p + 2] + m[p - w2] + m[p + w2])) / 8;
    const rowI = (p) => (5 * m[p] + 4 * (m[p - 1] + m[p + 1]) - (m[p - 2] + m[p + 2])
                         - (m[p + w + 1] + m[p + w - 1] + m[p - w + 1] + m[p - w - 1])
                         + 0.5 * (m[p + w2] + m[p - w2])) / 8;
    const colI = (p) => (5 * m[p] + 4 * (m[p + w] + m[p - w]) - (m[p + w2] + m[p - w2])
                         - (m[p + w + 1] + m[p + w - 1] + m[p - w + 1] + m[p - w - 1])
                         + 0.5 * (m[p + 2] + m[p - 2])) / 8;
    const diagI = (p) => (6 * m[p] + 2 * (m[p + w + 1] + m[p + w - 1] + m[p - w + 1] + m[p - w - 1])
                          - 1.5 * (m[p + 2] + m[p - 2] + m[p + w2] + m[p - w2])) / 8;
    const w0 = wTyp.map((v) => 0.05 * v);
    const out = new Float32Array(n * 4);
    for (let y = 0; y < h; y++) {
        const innerY = y >= 2 && y < h - 2;
        for (let x = 0; x < w; x++) {
            const p = y * w + x, nat = colorAt(cmap, x, y);
            const inner = innerY && x >= 2 && x < w - 2;
            for (let c = 0; c < 3; c++) {
                const wc = acc[6 * p + 3 + c];
                let f;
                if (c === nat) f = mos[p];
                else if (c === 1) f = inner ? gI(p) : conv(MHC.g, x, y);  // G en R/B
                else if (nat === 1) {
                    const row = colorAt(cmap, x + 1, y) === c;
                    f = inner ? (row ? rowI(p) : colI(p)) : conv(row ? MHC.row : MHC.col, x, y);
                } else f = inner ? diagI(p) : conv(MHC.diag, x, y);      // R en B, B en R
                out[4 * p + c] = wc > 0 ? (acc[6 * p + c] + w0[c] * f) / (wc + w0[c]) : f;
            }
            out[4 * p + 3] = Math.min(1, acc[6 * p + 4] / wTyp[1]);
        }
    }
    return out;
}

/**
 * Rendu pour des plans déjà débayérisés (RGB) ou mono : chaque canal est
 * échantillonné partout, valeur = somme / poids ; un pixel jamais couvert
 * (bord) prend la moyenne pondérée de ses voisins. Mono : G recopié en R, B.
 */
function planesBlend(acc, w, h, mono) {
    const n = w * h, out = new Float32Array(n * 4);
    const chans = mono ? [1] : [0, 1, 2];
    let wMax = 0;
    for (let p = 0; p < n; p += 97) wMax = Math.max(wMax, acc[6 * p + 4]);
    for (let p = 0; p < n; p++) {
        for (const c of chans) {
            const wc = acc[6 * p + 3 + c];
            let v;
            if (wc > 0) v = acc[6 * p + c] / wc;
            else {
                const x = p % w, y = (p / w) | 0;
                let a = 0, b = 0;
                for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
                    const xx = x + dx, yy = y + dy;
                    if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
                    const q = yy * w + xx;
                    a += acc[6 * q + c]; b += acc[6 * q + 3 + c];
                }
                v = b > 0 ? a / b : 0;
            }
            if (mono) out[4 * p] = out[4 * p + 1] = out[4 * p + 2] = v;
            else out[4 * p + c] = v;
        }
        out[4 * p + 3] = wMax > 0 ? Math.min(1, acc[6 * p + 4] / wMax) : 0;
    }
    return out;
}

// ---------------------------------------------------------------------------

export class DsoStacker {
    /**
     * @param {object} o
     * @param {number} o.width  @param {number} o.height  @param {string} o.bayer  ('RGGB'…)
     * @param {string} [o.layout]  'bayer' (défaut) | 'rgb' (3 plans déjà débayérisés) | 'mono'
     * @param {GPUDevice} [o.device]  sinon demandé à navigator.gpu ; échec → CPU
     * @param {boolean} [o.forceCpu]
     */
    static async create({ width, height, bayer = 'RGGB', layout = 'bayer', device, forceCpu = false, ...opts }) {
        if (layout === 'bayer' && (width % 2 || height % 2))
            throw new Error(`dimensions Bayer impaires (${width}×${height})`);
        const s = new DsoStacker();
        s.w = width; s.h = height; s.bayer = bayer; s.layout = layout;
        s.cmap = bayerCode(bayer);
        // plans d'entrée : un plan Bayer, ou des plans déjà débayérisés dont
        // chaque pixel porte une seule couleur (table de couleurs constante)
        s.planes = layout === 'rgb' ? [0, 1, 2].map((c) => c * 0x55)
                 : layout === 'mono' ? [0x55]
                 : [s.cmap];
        s.opts = { ...DSO_DEFAULTS, ...opts };
        s.gpu = null;
        if (!forceCpu) {
            try {
                let dev = device;
                if (!dev && globalThis.navigator?.gpu) {
                    const ad = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
                    if (ad && !ad.info?.isFallbackAdapter && ad.info?.architecture !== 'swiftshader') {
                        dev = await ad.requestDevice({ requiredLimits: {
                            maxStorageBufferBindingSize: ad.limits.maxStorageBufferBindingSize,
                            maxBufferSize: ad.limits.maxBufferSize,
                        } });
                    }
                }
                if (dev) s.gpu = await s._initGpu(dev);
            } catch (e) {
                console.warn('[DSO] WebGPU indisponible, repli CPU :', e.message);
                s.gpu = null;
            }
        }
        if (!s.gpu) {
            const n = width * height;
            s.acc = new Float32Array(6 * n);
            s.st = new Float32Array(9 * n);
        }
        s._resetState();
        console.log(`[DSO] ${layout === 'bayer' ? `drizzle Bayer ${bayer}` : `${layout} (${s.planes.length} plan(s))`} `
                    + `${width}×${height} sur ${s.gpu ? 'GPU' : 'CPU'}, modèle ${s.opts.model}`);
        return s;
    }

    get backend() { return this.gpu ? 'gpu' : 'cpu'; }

    _resetState() {
        this.ref = null;          // { stars, bg[3], sigma, fwhm }
        this.prior = null;
        this.count = 0;
        this.sigmaRaw = null;     // bruit d'un pixel brut (ADU) pour les pixels chauds
        this.candidates = [];     // premières images, pour choisir la référence
        this.refLocked = this.opts.refCandidates <= 1;
    }

    async _initGpu(device) {
        const n = this.w * this.h, U = GPUBufferUsage;
        const g = {
            device,
            detector: await StarDetectorGPU.create(device),
            hot: await makePipeline(device, HOT_WGSL, 'dso-hot'),
            geq: await makePipeline(device, GEQ_WGSL, 'dso-geq'),
            gp: device.createBuffer({ size: 32, usage: U.UNIFORM | U.COPY_DST }),
            eqs: this.planes.map(() => device.createBuffer({ size: n * 2, usage: U.STORAGE | U.COPY_DST | U.COPY_SRC })),
            drizzle: await makePipeline(device, DRIZZLE_WGSL, 'dso-drizzle'),
            hp: device.createBuffer({ size: 16, usage: U.UNIFORM | U.COPY_DST }),
            dp: device.createBuffer({ size: 144, usage: U.UNIFORM | U.COPY_DST }),
            raw: device.createBuffer({ size: n * 2, usage: U.STORAGE | U.COPY_DST }),
            fixed: device.createBuffer({ size: n * 2, usage: U.STORAGE | U.COPY_DST | U.COPY_SRC }),
            bands: this._makeBands(device),
            counter: device.createBuffer({ size: 16, usage: U.STORAGE | U.COPY_SRC | U.COPY_DST }),
            rbCounter: device.createBuffer({ size: 16, usage: U.MAP_READ | U.COPY_DST }),
            rbAcc: null,   // créé avec les bandes (taille de la plus grande)
        };
        g.rbAcc = device.createBuffer({ size: this._rbBytes, usage: U.MAP_READ | U.COPY_DST });
        this._clearGpu(g);
        return g;
    }

    /**
     * Accumulateurs en bandes de lignes : 24 + 36 octets par pixel dépassent
     * les limites d'un tampon WebGPU (souvent 128–256 Mo) dès ~3,5 Mpx
     * (IMX477 natif 4056×3040 = 12,3 Mpx). Une seule bande en 1080p.
     */
    _makeBands(device) {
        const U = GPUBufferUsage, w = this.w, h = this.h;
        const lim = Math.min(device.limits.maxStorageBufferBindingSize, device.limits.maxBufferSize);
        let rows = Math.max(16, Math.floor(lim / (36 * w)));
        if (this.opts._maxBandRows) rows = Math.min(rows, this.opts._maxBandRows);   // tests
        const bands = [];
        for (let y0 = 0; y0 < h; y0 += rows) {
            const r = Math.min(rows, h - y0), n = r * w;
            bands.push({
                y0, rows: r,
                acc: device.createBuffer({ size: n * 24, usage: U.STORAGE | U.COPY_SRC | U.COPY_DST }),
                st: device.createBuffer({ size: n * 36, usage: U.STORAGE | U.COPY_DST }),
            });
        }
        this._rbBytes = Math.max(...bands.map((b) => b.rows * w * 24));
        if (bands.length > 1) console.log(`[DSO] ${w}×${h} : accumulateurs en ${bands.length} bandes de ${rows} lignes`);
        return bands;
    }

    _clearGpu(g = this.gpu) {
        const enc = g.device.createCommandEncoder();
        for (const b of g.bands) { enc.clearBuffer(b.acc); enc.clearBuffer(b.st); }
        g.device.queue.submit([enc.finish()]);
    }

    _clearAccumulators() {
        if (this.gpu) this._clearGpu();
        else { this.acc.fill(0); this.st.fill(0); }
    }

    async reset() {
        this._clearAccumulators();
        this._resetState();
    }

    _bind(pipe, buffers) {
        return this.gpu.device.createBindGroup({
            layout: pipe.getBindGroupLayout(0),
            entries: buffers.map((b, i) => ({ binding: i, resource: { buffer: b } })),
        });
    }

    _dispatch(pipe, bg, x, y) {
        const enc = this.gpu.device.createCommandEncoder();
        const pass = enc.beginComputePass();
        pass.setPipeline(pipe); pass.setBindGroup(0, bg);
        pass.dispatchWorkgroups(x, y);
        pass.end();
        return enc;
    }

    async _readCounters() {
        const g = this.gpu;
        const enc = g.device.createCommandEncoder();
        enc.copyBufferToBuffer(g.counter, 0, g.rbCounter, 0, 16);
        g.device.queue.submit([enc.finish()]);
        await g.rbCounter.mapAsync(GPUMapMode.READ);
        const c = new Uint32Array(g.rbCounter.getMappedRange().slice(0));
        g.rbCounter.unmap();
        return c;
    }

    async _detect(raw, black, onGpuBuffer) {
        if (this.gpu) {
            const input = onGpuBuffer ? { bayerBuffer: onGpuBuffer } : { bayer: raw };
            return this.gpu.detector.detect(input, this.w, this.h, { black, satLevel: SAT_LEVEL });
        }
        const { L, sat, bw, bh } = lumBin2FromBayer(raw, this.w, this.h, black, SAT_LEVEL);
        return detectStarsCPU(L, sat, bw, bh);
    }

    /** Médianes du fond par couleur (brut − noir, unités 0–1), sur un échantillon. */
    _skyMedians(planes, black) {
        const { w, h } = this, n = w * h;
        const vals = [[], [], []];
        const step = 7;   // impair : parcourt toutes les positions Bayer
        planes.forEach((pl, k) => {
            const cmap = this.planes[k];
            for (let i = 0; i < n; i += step) vals[colorAt(cmap, i % w, (i / w) | 0)].push(pl[i]);
        });
        const m = vals.map((v) => v.length ? (median(v) - black) * INV16 : null);
        const any = m.find((v) => v != null) ?? 0;
        return m.map((v) => v ?? any);   // mono : même fond pour les trois canaux
    }

    /** Image de détection : le plan Bayer, ou la luminance des plans débayérisés. */
    _detectionPlane(planes) {
        if (this.layout !== 'rgb') return planes[0];
        const [r, g, b] = planes, out = new Uint16Array(r.length);
        for (let i = 0; i < r.length; i++) out[i] = (r[i] + 2 * g[i] + b[i] + 2) >> 2;
        return out;
    }

    /**
     * Ajoute une image. @param {Uint16Array} data  16 bits : w×h (Bayer, mono)
     *   ou 3 plans w×h consécutifs R, G, B (layout 'rgb')
     * @param {object} [o] { black (ADU 16 bits) }
     * @returns compte rendu { accepted, reason?, stars, inliers, rms, dx, dy, rotationDeg, fwhm,
     *   elong, scale, weight, hotPixels, clipped, greenFixed, banding, timing }
     */
    async addFrame(data, { black = 0, _replay = false } = {}) {
        const { w, h } = this, o = this.opts, n = w * h, np = this.planes.length;
        if (data.length !== n * np) throw new Error(`image ${data.length} valeurs ≠ ${n * np} attendues (${w}×${h}×${np})`);
        const timing = {};
        let t = performance.now();
        const g = this.gpu;
        const isBayer = this.layout === 'bayer';

        // 0. bruit de ligne, plan par plan (CPU, avant envoi au GPU)
        let banding = 0;
        const planes = [];
        for (let k = 0; k < np; k++) {
            let pl = data.subarray(k * n, (k + 1) * n);
            if (o.rowBanding) {
                const r = rowBandingCPU(pl, w, h);
                pl = r.fixed; banding = Math.max(banding, r.maxOff);
            }
            planes.push(pl);
        }
        timing.banding = performance.now() - t; t = performance.now();
        const detPlane = this._detectionPlane(planes);

        // 1. pixels chauds (bruit brut de l'image précédente, ou d'une
        // détection préalable pour la première), puis verts (Bayer seulement)
        let hotPixels = 0, greenFixed = 0;
        if (g) g.device.queue.writeBuffer(g.counter, 0, new Uint32Array(4));   // [chauds, rejets σ, verts]
        if (o.hotPixels && this.sigmaRaw == null)
            this.sigmaRaw = Math.max((await this._detect(detPlane, black)).sigma, 2) / 2;
        const thr = o.hotK * (this.sigmaRaw ?? 0);
        const geqOn = isBayer && o.greenBalance && this.sigmaRaw != null;
        const geqThr = 4 * (this.sigmaRaw ?? 0);
        const cpuPlanes = [];
        for (let k = 0; k < np; k++) {
            const pl = planes[k];
            if (g) {
                g.device.queue.writeBuffer(g.raw, 0, pl);
                const enc = g.device.createCommandEncoder();
                if (o.hotPixels) {
                    const hp = new ArrayBuffer(16);
                    new Uint32Array(hp, 0, 2).set([w, h]);
                    new Float32Array(hp, 8, 1)[0] = thr;
                    g.device.queue.writeBuffer(g.hp, 0, hp);
                    const pass = enc.beginComputePass();
                    pass.setPipeline(g.hot); pass.setBindGroup(0, this._bind(g.hot, [g.hp, g.raw, g.fixed, g.counter]));
                    pass.dispatchWorkgroups(Math.ceil(w / 32), Math.ceil(h / 16)); pass.end();
                } else {
                    enc.copyBufferToBuffer(g.raw, 0, g.fixed, 0, n * 2);
                }
                if (geqOn) {
                    const gp = new ArrayBuffer(32);
                    new Uint32Array(gp, 0, 3).set([w, h, this.planes[k]]);
                    new Float32Array(gp, 16, 3).set([geqThr, o.greenRel, black]);
                    g.device.queue.writeBuffer(g.gp, 0, gp);
                    const pass = enc.beginComputePass();
                    pass.setPipeline(g.geq); pass.setBindGroup(0, this._bind(g.geq, [g.gp, g.fixed, g.eqs[k], g.counter]));
                    pass.dispatchWorkgroups(Math.ceil(w / 32), Math.ceil(h / 16)); pass.end();
                } else {
                    enc.copyBufferToBuffer(g.fixed, 0, g.eqs[k], 0, n * 2);
                }
                g.device.queue.submit([enc.finish()]);
            } else {
                let cur = pl;
                if (o.hotPixels) { const r = hotPixelsCPU(cur, w, h, thr); cur = r.fixed; hotPixels += r.count; }
                if (geqOn) {
                    const r = greenEqCPU(cur, w, h, this.planes[k], geqThr, o.greenRel, black);
                    cur = r.fixed; greenFixed += r.count;
                }
                cpuPlanes.push(cur);
            }
        }
        timing.hot = performance.now() - t; t = performance.now();

        // 2. étoiles (brut Bayer corrigé, ou luminance des plans)
        const det = isBayer
            ? await this._detect(g ? null : cpuPlanes[0], black, g ? g.eqs[0] : null)
            : await this._detect(g ? detPlane : this._detectionPlane(cpuPlanes), black);
        const stars = det.stars;
        // plancher : une image sans bruit mesurable (zone uniforme, image
        // synthétique) donnerait un σ nul, donc un poids 0/0 et un seuil nul
        const sigma = Math.max(det.sigma, 2);
        this.sigmaRaw = sigma / 2;
        const fwhm = median(stars.filter((s) => !s.sat).map((s) => s.fwhm));
        const elong = median(stars.filter((s) => !s.sat).map((s) => s.elong));
        const bg = this._skyMedians(planes, black);
        timing.detect = performance.now() - t; t = performance.now();

        const report = { stars: stars.length, fwhm, elong, background: bg, timing };
        let M, k = 1;
        if (!this.ref) {
            if (o.align && stars.length < o.minStars)
                return { ...report, accepted: false, reason: `${stars.length} étoiles (réf.)` };
            this.ref = { stars, bg, sigma, fwhm, grid: normGrid(det.background) };
            M = [1, 0, 0, 0, 1, 0];
            Object.assign(report, { inliers: stars.length, rms: 0, dx: 0, dy: 0, rotationDeg: 0, method: 'référence' });
        } else if (!o.align) {
            M = [1, 0, 0, 0, 1, 0];
            Object.assign(report, { inliers: 0, rms: 0, dx: 0, dy: 0, rotationDeg: 0, method: 'sans alignement' });
        } else {
            const minInliers = Math.max(o.minStars,
                Math.ceil(o.minInlierFrac * Math.min(stars.length, this.ref.stars.length)));
            const m = matchStars(this.ref.stars, stars, { model: o.model, minInliers }, this.prior);
            timing.match = performance.now() - t; t = performance.now();
            if (!m.ok || m.inliers < minInliers)
                return { ...report, accepted: false, reason: `alignement impossible (${m.inliers}/${stars.length} étoiles)` };
            const d = describeTransform(m.M);
            Object.assign(report, { inliers: m.inliers, rms: m.rms, method: m.method,
                                    dx: d.dx, dy: d.dy, rotationDeg: d.rotationDeg });
            if (o.maxFwhmRatio > 0 && fwhm > o.maxFwhmRatio * this.ref.fwhm)
                return { ...report, accepted: false, reason: `FWHM ${fwhm.toFixed(1)} px` };
            if (o.maxElong > 0 && elong > o.maxElong)
                return { ...report, accepted: false, reason: `étoiles allongées (${elong.toFixed(2)})` };
            // 3. photométrie : flux des étoiles appariées, non saturées
            if (o.photometric) {
                const r = m.pairs.filter(([i, j]) => !stars[i].sat && !this.ref.stars[j].sat)
                                 .map(([i, j]) => this.ref.stars[j].flux / stars[i].flux);
                if (r.length >= 5) k = median(r);
                if (!(k > 0.2 && k < 5))
                    return { ...report, accepted: false, reason: `transparence (flux ×${(1 / k).toFixed(2)})` };
            }
            M = m.M;
            this.prior = m.M;
        }

        // 4. poids, 5–6. drizzle + rejet σ (fond local : grille de la détection,
        // normalisée, × fond global par couleur)
        const gridCur = normGrid(det.background);
        let weight = o.weighting
            ? (this.ref.sigma / (k * sigma)) ** 2 * Math.min(1, (this.ref.fwhm / fwhm) ** 2)
            : 1;
        if (!Number.isFinite(weight) || weight <= 0) weight = 1;   // FWHM inconnue (aucune étoile non saturée)…
        const P = {
            M, Mi: invertTransform(M), black, k, pf: o.pixfrac, kappa: o.kappa, kappaLow: o.kappaLow,
            fw: weight, bg: bg.map((v) => k * v), rbg: this.ref.bg,
            clip: o.sigmaClip, nmin: o.clipMinFrames, cmap: this.cmap, tol: o.clipSignalTol,
            gCur: gridCur, gRef: this.ref.grid, nbx: det.nbx, nby: det.nby, bs: 2 * STAR_BLOCK,
        };
        let clipped = 0;
        if (g) {
            const buf = new ArrayBuffer(144), u = new Uint32Array(buf), f = new Float32Array(buf);
            u[0] = w; u[1] = h; u[3] = P.nmin;
            f.set(M, 4); f.set(P.Mi, 10);
            f[16] = black; f[17] = k; f[18] = P.pf; f[19] = P.kappa;
            f[20] = weight; f.set(P.bg, 21); f[24] = P.clip ? 1 : 0; f[25] = P.kappaLow;
            u[26] = P.nbx; u[27] = P.nby; f.set(P.rbg, 28); f[31] = P.bs; f[32] = P.tol;
            const gridBytes = P.nbx * P.nby * 4;
            if (!g.gCur || g.gCur.size < gridBytes) {
                g.gCur?.destroy(); g.gRef?.destroy();
                const U = GPUBufferUsage;
                g.gCur = g.device.createBuffer({ size: gridBytes, usage: U.STORAGE | U.COPY_DST });
                g.gRef = g.device.createBuffer({ size: gridBytes, usage: U.STORAGE | U.COPY_DST });
            }
            g.device.queue.writeBuffer(g.gCur, 0, P.gCur);
            g.device.queue.writeBuffer(g.gRef, 0, P.gRef);
            // une passe par plan et par bande (paramètres écrits avant chaque
            // envoi : la file les applique dans l'ordre)
            for (let pk = 0; pk < np; pk++) {
                u[2] = this.planes[pk];
                for (const b of g.bands) {
                    u[33] = b.y0; u[34] = b.rows;
                    g.device.queue.writeBuffer(g.dp, 0, buf);
                    const enc = this._dispatch(g.drizzle, this._bind(g.drizzle,
                                               [g.dp, g.eqs[pk], b.acc, b.st, g.counter, g.gCur, g.gRef]),
                                               Math.ceil(w / 16), Math.ceil(b.rows / 16));
                    g.device.queue.submit([enc.finish()]);
                }
            }
            const c = await this._readCounters();
            hotPixels = c[0]; clipped = c[1]; greenFixed = c[2];
        } else {
            for (let pk = 0; pk < np; pk++)
                clipped += drizzleCPU(cpuPlanes[pk], w, h, { ...P, cmap: this.planes[pk] }, this.acc, this.st);
        }
        timing.drizzle = performance.now() - t;
        this.count++;
        Object.assign(report, { accepted: true, scale: k, weight, hotPixels, clipped, greenFixed, banding });

        // 7. choix de la référence parmi les premières images
        if (!_replay && !this.refLocked) {
            this.candidates.push({ raw: data.slice(), black, fwhm, stars: stars.length });
            if (this.candidates.length >= o.refCandidates) await this._chooseReference(report);
        }
        return report;
    }

    async _chooseReference(report) {
        const cands = this.candidates;
        this.candidates = [];
        this.refLocked = true;
        const maxStars = Math.max(...cands.map((c) => c.stars));
        let best = 0;
        cands.forEach((c, i) => {
            if (c.stars >= 0.7 * maxStars && c.fwhm < cands[best].fwhm) best = i;
        });
        if (best === 0 || cands[best].fwhm > 0.97 * cands[0].fwhm) return;   // gain négligeable
        // Nouvelle référence : stack refait avec ces images, la meilleure d'abord
        console.log(`[DSO] référence : image ${best + 1}/${cands.length} (FWHM ${cands[best].fwhm.toFixed(2)} `
                    + `contre ${cands[0].fwhm.toFixed(2)} px) — réempilement`);
        this._clearAccumulators();
        this.ref = null; this.prior = null; this.count = 0;
        for (const i of [best, ...cands.keys()].filter((v, j, a) => a.indexOf(v) === j))
            await this.addFrame(cands[i].raw, { black: cands[i].black, _replay: true });
        report.reference = best;
    }

    /**
     * Stack courant (RGBA float32, unités 0–1 du capteur noir soustrait,
     * photométrie de la référence) ; canal sans échantillon comblé par ses
     * voisins ; alpha = couverture relative (0 = jamais couvert).
     */
    async snapshot() {
        const n = this.w * this.h, { w, h } = this;
        let acc;
        if (this.gpu) {
            const g = this.gpu;
            acc = new Float32Array(n * 6);
            for (const b of g.bands) {
                const bytes = b.rows * w * 24;
                const enc = g.device.createCommandEncoder();
                enc.copyBufferToBuffer(b.acc, 0, g.rbAcc, 0, bytes);
                g.device.queue.submit([enc.finish()]);
                await g.rbAcc.mapAsync(GPUMapMode.READ, 0, bytes);
                acc.set(new Float32Array(g.rbAcc.getMappedRange(0, bytes)), b.y0 * w * 6);
                g.rbAcc.unmap();
            }
        } else {
            acc = this.acc;
        }
        // poids typique par canal (médiane des pixels couverts)
        const wTyp = [0, 1, 2].map((c) => {
            const v = [];
            for (let i = 0; i < n; i += 97) if (acc[6 * i + 3 + c] > 0) v.push(acc[6 * i + 3 + c]);
            return median(v) || 1;
        });
        const out = this.layout === 'bayer' ? demosaicBlend(acc, w, h, this.cmap, wTyp)
                                            : planesBlend(acc, w, h, this.layout === 'mono');
        return { data: out, width: w, height: h, count: this.count };
    }

    destroy() {
        if (this.gpu) {
            for (const k of ['hp', 'dp', 'gp', 'raw', 'fixed', 'counter', 'rbCounter', 'rbAcc', 'gCur', 'gRef'])
                this.gpu[k]?.destroy();
            for (const b of this.gpu.eqs) b.destroy();
            for (const b of this.gpu.bands) { b.acc.destroy(); b.st.destroy(); }
            this.gpu.detector.destroyBuffers();
            this.gpu = null;
        }
        this.acc = this.st = null;
        this.candidates = [];
    }
}
