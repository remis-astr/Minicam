'use strict';
/**
 * star_align.js — détection d'étoiles (WebGPU, avec version CPU identique)
 * et alignement par appariement de triangles (rotation + translation, ou
 * affine), pour le Live Stack ciel profond.
 *
 * Module autonome : le device GPU est passé en paramètre, aucune dépendance
 * au reste du pipeline — utilisable dans un worker comme dans Node (tests).
 *
 * Détection, sur une luminance binnée 2×2 (un bloc Bayer 2×2 contient
 * R+G+G+B quel que soit le motif) :
 *   1. fond de ciel : moyenne à rejet σ (5 itérations, κ = 3) par bloc de
 *      32×32 px binnés, puis médiane 3×3 de la grille de blocs (une étoile
 *      brillante ou la nébuleuse ne fausse pas un bloc) ; bruit σ = médiane
 *      des écarts-types de blocs ;
 *   2. image filtrée S = gauss(L) − fond (filtre adapté à des étoiles de
 *      quelques pixels) ;
 *   3. pics : maxima locaux 7×7 de S au-dessus de k·σ_S ; pour chacun, sur
 *      L − fond dans la fenêtre 7×7 : centroïde sub-pixel, flux, moments du
 *      2e ordre (FWHM, allongement), saturation (bloc au niveau blanc).
 * Coordonnées rendues en pixels pleine résolution de l'image d'entrée.
 *
 * Alignement : triangles formés par les étoiles les plus brillantes et leurs
 * voisines (invariants de forme, indépendants de la translation, de la
 * rotation et de l'échelle), hypothèses testées sur toutes les étoiles
 * (RANSAC), puis moindres carrés sur les étoiles appariées. Une transformée
 * précédente sert de point de départ (chemin rapide) si elle s'applique
 * encore ; sinon recherche complète — supporte les grands sauts de dérive.
 */

// ---------------------------------------------------------------------------
// Paramètres communs
// ---------------------------------------------------------------------------

export const STAR_DEFAULTS = {
    blockSize:  32,      // bloc de fond, en pixels binnés
    kSigma:     5,       // seuil de détection, en σ de l'image filtrée
    smoothSigma: 1.0,    // gaussienne du filtre adapté (pixels binnés)
    maxStars:   300,     // étoiles rendues (les plus brillantes)
    maxCandidates: 8192, // capacité du tampon GPU de candidats
};

const R_PEAK = 3;        // demi-fenêtre 7×7 des pics / mesures
const R_SMOOTH = 2;      // demi-noyau 5×5 du filtre

function gaussKernel(sigma) {
    const k = [];
    for (let i = -R_SMOOTH; i <= R_SMOOTH; i++) k.push(Math.exp(-(i * i) / (2 * sigma * sigma)));
    const s = k.reduce((a, b) => a + b, 0);
    return k.map((v) => v / s);
}

/** Facteur de bruit du filtre 2D séparable : σ_S = σ · sqrt(Σw²). */
function smoothNoiseFactor(k1d) {
    const s2 = k1d.reduce((a, b) => a + b * b, 0);
    return s2;   // (Σ w_i²)·(Σ w_j²) = s2², racine = s2
}

function median(arr) {
    const a = Float64Array.from(arr).sort();
    const n = a.length;
    return n ? (n % 2 ? a[n >> 1] : 0.5 * (a[n / 2 - 1] + a[n / 2])) : 0;
}

/** Grille de fond : médiane 3×3 des moyennes de blocs ; σ = médiane des écarts-types. */
function backgroundGrid(stats, nbx, nby) {
    const grid = new Float32Array(nbx * nby);
    const tmp = [];
    for (let by = 0; by < nby; by++) {
        for (let bx = 0; bx < nbx; bx++) {
            tmp.length = 0;
            for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
                const x = bx + dx, y = by + dy;
                if (x >= 0 && x < nbx && y >= 0 && y < nby) tmp.push(stats[2 * (y * nbx + x)]);
            }
            grid[by * nbx + bx] = median(tmp);
        }
    }
    const stds = [];
    for (let i = 0; i < nbx * nby; i++) stds.push(stats[2 * i + 1]);
    return { grid, sigma: median(stds) };
}

/** Candidats bruts (8 floats chacun) → étoiles triées, en coordonnées pleine résolution. */
function finalizeStars(raw, count, maxStars) {
    const stars = [];
    for (let i = 0; i < count; i++) {
        const o = i * 8;
        const flux = raw[o + 2];
        if (!(flux > 0)) continue;
        const mxx = raw[o + 4], myy = raw[o + 5], mxy = raw[o + 6];
        // valeurs propres de la matrice des moments → largeur et allongement
        const tr = mxx + myy, det = mxx * myy - mxy * mxy;
        const disc = Math.sqrt(Math.max(0, tr * tr / 4 - det));
        const l1 = tr / 2 + disc, l2 = Math.max(1e-6, tr / 2 - disc);
        stars.push({
            x: 2 * raw[o] + 0.5, y: 2 * raw[o + 1] + 0.5,   // binné → pleine résolution
            flux, peak: raw[o + 3],
            fwhm: 2 * 2.3548 * Math.sqrt(Math.max(0, tr / 2)),
            elong: Math.sqrt(l1 / l2),
            sat: raw[o + 7] > 0,
        });
    }
    stars.sort((a, b) => b.flux - a.flux);
    return stars.slice(0, maxStars);
}

// ---------------------------------------------------------------------------
// Luminance binnée 2×2 (CPU)
// ---------------------------------------------------------------------------

/**
 * Bayer 16 bits (Uint16Array, w×h) → luminance binnée 2×2 (Float32Array) et
 * indicateur de saturation par bloc. `black` soustrait (×4 par bloc).
 */
export function lumBin2FromBayer(px, w, h, black = 0, satLevel = 65535) {
    const bw = w >> 1, bh = h >> 1;
    const L = new Float32Array(bw * bh), sat = new Uint8Array(bw * bh);
    for (let y = 0; y < bh; y++) {
        const r0 = 2 * y * w, r1 = r0 + w;
        for (let x = 0; x < bw; x++) {
            const a = px[r0 + 2 * x], b = px[r0 + 2 * x + 1], c = px[r1 + 2 * x], d = px[r1 + 2 * x + 1];
            L[y * bw + x] = a + b + c + d - 4 * black;
            sat[y * bw + x] = Math.max(a, b, c, d) >= satLevel ? 1 : 0;
        }
    }
    return { L, sat, bw, bh };
}

// ---------------------------------------------------------------------------
// Détection CPU (référence et repli sans WebGPU)
// ---------------------------------------------------------------------------

export function detectStarsCPU(L, sat, bw, bh, opts = {}) {
    const o = { ...STAR_DEFAULTS, ...opts };
    const bs = o.blockSize;
    const nbx = Math.ceil(bw / bs), nby = Math.ceil(bh / bs);

    // 1. statistiques de blocs (même algorithme que le shader bgStats)
    const stats = new Float32Array(2 * nbx * nby);
    for (let by = 0; by < nby; by++) for (let bx = 0; bx < nbx; bx++) {
        const x0 = bx * bs, y0 = by * bs, x1 = Math.min(bw, x0 + bs), y1 = Math.min(bh, y0 + bs);
        const pivot = L[Math.min(bh - 1, y0 + (bs >> 1)) * bw + Math.min(bw - 1, x0 + (bs >> 1))];
        let lo = -Infinity, hi = Infinity, mean = pivot, std = 0, ref = pivot;
        for (let it = 0; it < 5; it++) {
            let s = 0, s2 = 0, n = 0;
            for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
                const v = L[y * bw + x];
                if (v >= lo && v <= hi) { const d = v - ref; s += d; s2 += d * d; n++; }
            }
            if (n < 2) break;
            const m = s / n;
            mean = ref + m; std = Math.sqrt(Math.max(0, s2 / n - m * m));
            lo = mean - 3 * std; hi = mean + 3 * std; ref = mean;
        }
        stats[2 * (by * nbx + bx)] = mean;
        stats[2 * (by * nbx + bx) + 1] = std;
    }
    const { grid, sigma } = backgroundGrid(stats, nbx, nby);
    const bgAt = makeBgSampler(grid, nbx, nby, bs);

    // 2. S = gauss(L) − fond
    const k = gaussKernel(o.smoothSigma);
    const tmp = new Float32Array(bw * bh), S = new Float32Array(bw * bh);
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
        let a = 0;
        for (let i = -R_SMOOTH; i <= R_SMOOTH; i++) a += k[i + R_SMOOTH] * L[y * bw + clamp(x + i, 0, bw - 1)];
        tmp[y * bw + x] = a;
    }
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
        let a = 0;
        for (let i = -R_SMOOTH; i <= R_SMOOTH; i++) a += k[i + R_SMOOTH] * tmp[clamp(y + i, 0, bh - 1) * bw + x];
        S[y * bw + x] = a - bgAt(x, y);
    }

    // 3. pics + mesures
    const thr = o.kSigma * sigma * smoothNoiseFactor(k);
    const raw = [];
    for (let y = R_PEAK; y < bh - R_PEAK; y++) for (let x = R_PEAK; x < bw - R_PEAK; x++) {
        const p = y * bw + x, v = S[p];
        if (!(v > thr) || !isLocalMax(S, bw, x, y, v)) continue;
        raw.push(...measure(L, sat, bw, x, y, bgAt));
    }
    const stars = finalizeStars(raw, raw.length / 8, o.maxStars);
    return { stars, sigma, threshold: thr, candidates: raw.length / 8, background: grid, nbx, nby };
}

function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

function makeBgSampler(grid, nbx, nby, bs) {
    return (x, y) => {
        const gx = clamp((x + 0.5) / bs - 0.5, 0, nbx - 1), gy = clamp((y + 0.5) / bs - 0.5, 0, nby - 1);
        const x0 = Math.floor(gx), y0 = Math.floor(gy);
        const x1 = Math.min(nbx - 1, x0 + 1), y1 = Math.min(nby - 1, y0 + 1);
        const fx = gx - x0, fy = gy - y0;
        const top = grid[y0 * nbx + x0] * (1 - fx) + grid[y0 * nbx + x1] * fx;
        const bot = grid[y1 * nbx + x0] * (1 - fx) + grid[y1 * nbx + x1] * fx;
        return top * (1 - fy) + bot * fy;
    };
}

// Maximum strict dans la fenêtre 7×7 ; à égalité, le premier pixel (ordre de
// balayage) gagne — même règle que le shader.
function isLocalMax(S, bw, x, y, v) {
    const p = y * bw + x;
    for (let dy = -R_PEAK; dy <= R_PEAK; dy++) for (let dx = -R_PEAK; dx <= R_PEAK; dx++) {
        if (!dx && !dy) continue;
        const q = (y + dy) * bw + x + dx, w = S[q];
        if (w > v || (w === v && q < p)) return false;
    }
    return true;
}

function measure(L, sat, bw, x, y, bgAt) {
    let s = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, peak = 0, st = 0;
    const b = bgAt(x, y);
    for (let dy = -R_PEAK; dy <= R_PEAK; dy++) for (let dx = -R_PEAK; dx <= R_PEAK; dx++) {
        const q = (y + dy) * bw + x + dx;
        const v = L[q] - b;
        if (v > peak) peak = v;
        if (Math.abs(dx) <= 1 && Math.abs(dy) <= 1 && sat[q]) st = 1;
        if (v <= 0) continue;
        s += v; sx += v * dx; sy += v * dy; sxx += v * dx * dx; syy += v * dy * dy; sxy += v * dx * dy;
    }
    if (s <= 0) return [x, y, 0, 0, 0, 0, 0, st];
    const cx = sx / s, cy = sy / s;
    return [x + cx, y + cy, s, peak, sxx / s - cx * cx, syy / s - cy * cy, sxy / s - cx * cy, st];
}

// ---------------------------------------------------------------------------
// Détection GPU
// ---------------------------------------------------------------------------

const PARAMS_WGSL = /* wgsl */`
struct Params {
    w: u32, h: u32, bw: u32, bh: u32,
    nbx: u32, nby: u32, bs: u32, maxOut: u32,
    black: f32, sat: f32, thr: f32, _pad: f32,
};
@group(0) @binding(0) var<uniform> P: Params;
`;

const BG_SAMPLER_WGSL = /* wgsl */`
fn bgAt(x: i32, y: i32) -> f32 {
    let gx = clamp((f32(x) + 0.5) / f32(P.bs) - 0.5, 0.0, f32(P.nbx - 1u));
    let gy = clamp((f32(y) + 0.5) / f32(P.bs) - 0.5, 0.0, f32(P.nby - 1u));
    let x0 = u32(floor(gx)); let y0 = u32(floor(gy));
    let x1 = min(P.nbx - 1u, x0 + 1u); let y1 = min(P.nby - 1u, y0 + 1u);
    let fx = gx - f32(x0); let fy = gy - f32(y0);
    let top = bg[y0 * P.nbx + x0] * (1.0 - fx) + bg[y0 * P.nbx + x1] * fx;
    let bot = bg[y1 * P.nbx + x0] * (1.0 - fx) + bg[y1 * P.nbx + x1] * fx;
    return top * (1.0 - fy) + bot * fy;
}
`;

// Bayer 16 bits (2 pixels par u32) → L binnée + saturation
const LUM_BAYER_WGSL = PARAMS_WGSL + /* wgsl */`
@group(0) @binding(1) var<storage, read> src: array<u32>;
@group(0) @binding(2) var<storage, read_write> L: array<f32>;
@group(0) @binding(3) var<storage, read_write> satf: array<u32>;
fn px(i: u32) -> f32 { return f32((src[i >> 1u] >> ((i & 1u) * 16u)) & 0xffffu); }
@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) g: vec3<u32>) {
    if (g.x >= P.bw || g.y >= P.bh) { return; }
    let i0 = 2u * g.y * P.w + 2u * g.x;
    let a = px(i0); let b = px(i0 + 1u); let c = px(i0 + P.w); let d = px(i0 + P.w + 1u);
    let o = g.y * P.bw + g.x;
    L[o] = a + b + c + d - 4.0 * P.black;
    satf[o] = select(0u, 1u, max(max(a, b), max(c, d)) >= P.sat);
}
`;

// RGBA float32 pleine résolution (sortie du débayérisage) → L binnée
const LUM_RGBA_WGSL = PARAMS_WGSL + /* wgsl */`
@group(0) @binding(1) var<storage, read> src: array<f32>;
@group(0) @binding(2) var<storage, read_write> L: array<f32>;
@group(0) @binding(3) var<storage, read_write> satf: array<u32>;
fn lum(i: u32) -> vec2<f32> {
    let r = src[4u * i]; let g = src[4u * i + 1u]; let b = src[4u * i + 2u];
    return vec2<f32>(r + 2.0 * g + b, max(r, max(g, b)));
}
@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) g: vec3<u32>) {
    if (g.x >= P.bw || g.y >= P.bh) { return; }
    let i0 = 2u * g.y * P.w + 2u * g.x;
    let a = lum(i0); let b = lum(i0 + 1u); let c = lum(i0 + P.w); let d = lum(i0 + P.w + 1u);
    let o = g.y * P.bw + g.x;
    L[o] = (a.x + b.x + c.x + d.x) * 0.25 - 4.0 * P.black;
    satf[o] = select(0u, 1u, P.sat > 0.0 && max(max(a.y, b.y), max(c.y, d.y)) >= P.sat);
}
`;

// Statistiques de fond par bloc : un workgroup (256 threads) par bloc,
// moyenne à rejet σ, valeurs décalées d'un pivot (précision f32).
const BG_STATS_WGSL = PARAMS_WGSL + /* wgsl */`
@group(0) @binding(1) var<storage, read> L: array<f32>;
@group(0) @binding(2) var<storage, read_write> stats: array<f32>;
var<workgroup> sS: array<f32, 256>;
var<workgroup> sS2: array<f32, 256>;
var<workgroup> sN: array<f32, 256>;
var<workgroup> cur: vec4<f32>;   // lo, hi, ref, std
@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_index) t: u32) {
    let blk = wg.x;
    if (blk >= P.nbx * P.nby) { return; }
    let bx = blk % P.nbx; let by = blk / P.nbx;
    let x0 = bx * P.bs; let y0 = by * P.bs;
    let x1 = min(P.bw, x0 + P.bs); let y1 = min(P.bh, y0 + P.bs);
    let cnt = P.bs * P.bs;
    if (t == 0u) {
        let pv = L[min(P.bh - 1u, y0 + P.bs / 2u) * P.bw + min(P.bw - 1u, x0 + P.bs / 2u)];
        cur = vec4<f32>(-3.4e38, 3.4e38, pv, 0.0);
    }
    workgroupBarrier();
    for (var it = 0u; it < 5u; it++) {
        let c = cur;
        var s = 0.0; var s2 = 0.0; var n = 0.0;
        for (var k = t; k < cnt; k += 256u) {
            let x = x0 + k % P.bs; let y = y0 + k / P.bs;
            if (x < x1 && y < y1) {
                let v = L[y * P.bw + x];
                if (v >= c.x && v <= c.y) { let d = v - c.z; s += d; s2 += d * d; n += 1.0; }
            }
        }
        sS[t] = s; sS2[t] = s2; sN[t] = n;
        workgroupBarrier();
        for (var st = 128u; st > 0u; st >>= 1u) {
            if (t < st) { sS[t] += sS[t + st]; sS2[t] += sS2[t + st]; sN[t] += sN[t + st]; }
            workgroupBarrier();
        }
        if (t == 0u && sN[0] >= 2.0) {
            let m = sS[0] / sN[0];
            let mean = c.z + m;
            let sd = sqrt(max(0.0, sS2[0] / sN[0] - m * m));
            cur = vec4<f32>(mean - 3.0 * sd, mean + 3.0 * sd, mean, sd);
        }
        workgroupBarrier();
    }
    if (t == 0u) { stats[2u * blk] = cur.z; stats[2u * blk + 1u] = cur.w; }
}
`;

function smoothWgsl(k) {
    const K = `array<f32, 5>(${k.map((v) => v.toFixed(9)).join(', ')})`;
    // Passe horizontale puis verticale (dir 0 / 1), fond soustrait à la 2e.
    return PARAMS_WGSL + /* wgsl */`
@group(0) @binding(1) var<storage, read> src: array<f32>;
@group(0) @binding(2) var<storage, read_write> dst: array<f32>;
@group(0) @binding(3) var<storage, read> bg: array<f32>;
@group(0) @binding(4) var<uniform> dir: vec4<u32>;
` + BG_SAMPLER_WGSL + /* wgsl */`
@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) g: vec3<u32>) {
    if (g.x >= P.bw || g.y >= P.bh) { return; }
    let K = ${K};
    var a = 0.0;
    for (var i = -2; i <= 2; i++) {
        var x = i32(g.x); var y = i32(g.y);
        if (dir.x == 0u) { x = clamp(x + i, 0, i32(P.bw) - 1); } else { y = clamp(y + i, 0, i32(P.bh) - 1); }
        a += K[i + 2] * src[u32(y) * P.bw + u32(x)];
    }
    if (dir.x == 1u) { a -= bgAt(i32(g.x), i32(g.y)); }
    dst[g.y * P.bw + g.x] = a;
}
`;
}

const PEAKS_WGSL = PARAMS_WGSL + /* wgsl */`
@group(0) @binding(1) var<storage, read> S: array<f32>;
@group(0) @binding(2) var<storage, read> L: array<f32>;
@group(0) @binding(3) var<storage, read> bg: array<f32>;
@group(0) @binding(4) var<storage, read> satf: array<u32>;
@group(0) @binding(5) var<storage, read_write> outBuf: array<f32>;
@group(0) @binding(6) var<storage, read_write> counter: array<atomic<u32>>;
` + BG_SAMPLER_WGSL + /* wgsl */`
@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) g: vec3<u32>) {
    let x = i32(g.x); let y = i32(g.y);
    if (x < 3 || y < 3 || x >= i32(P.bw) - 3 || y >= i32(P.bh) - 3) { return; }
    let p = u32(y) * P.bw + u32(x);
    let v = S[p];
    if (!(v > P.thr)) { return; }
    for (var dy = -3; dy <= 3; dy++) {
        for (var dx = -3; dx <= 3; dx++) {
            if (dx == 0 && dy == 0) { continue; }
            let q = u32(y + dy) * P.bw + u32(x + dx);
            let w = S[q];
            if (w > v || (w == v && q < p)) { return; }
        }
    }
    let b = bgAt(x, y);
    var s = 0.0; var sx = 0.0; var sy = 0.0; var sxx = 0.0; var syy = 0.0; var sxy = 0.0;
    var peak = 0.0; var st = 0.0;
    for (var dy = -3; dy <= 3; dy++) {
        for (var dx = -3; dx <= 3; dx++) {
            let q = u32(y + dy) * P.bw + u32(x + dx);
            let val = L[q] - b;
            peak = max(peak, val);
            if (abs(dx) <= 1 && abs(dy) <= 1 && satf[q] != 0u) { st = 1.0; }
            if (val <= 0.0) { continue; }
            let fx = f32(dx); let fy = f32(dy);
            s += val; sx += val * fx; sy += val * fy;
            sxx += val * fx * fx; syy += val * fy * fy; sxy += val * fx * fy;
        }
    }
    let idx = atomicAdd(&counter[0], 1u);
    if (idx >= P.maxOut) { return; }
    let o = idx * 8u;
    if (s <= 0.0) {
        outBuf[o] = f32(x); outBuf[o + 1u] = f32(y); outBuf[o + 2u] = 0.0; outBuf[o + 3u] = 0.0;
        outBuf[o + 4u] = 0.0; outBuf[o + 5u] = 0.0; outBuf[o + 6u] = 0.0; outBuf[o + 7u] = st;
        return;
    }
    let cx = sx / s; let cy = sy / s;
    outBuf[o] = f32(x) + cx; outBuf[o + 1u] = f32(y) + cy;
    outBuf[o + 2u] = s; outBuf[o + 3u] = peak;
    outBuf[o + 4u] = sxx / s - cx * cx; outBuf[o + 5u] = syy / s - cy * cy;
    outBuf[o + 6u] = sxy / s - cx * cy; outBuf[o + 7u] = st;
}
`;

async function makePipeline(device, code, label) {
    const module = device.createShaderModule({ code, label });
    const info = await module.getCompilationInfo?.();
    for (const m of info?.messages ?? [])
        if (m.type === 'error') throw new Error(`Shader ${label} : ${m.message} (ligne ${m.lineNum})`);
    return device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' }, label });
}

export class StarDetectorGPU {
    /** @param {GPUDevice} device */
    static async create(device, opts = {}) {
        const d = new StarDetectorGPU();
        d.device = device;
        d.opts = { ...STAR_DEFAULTS, ...opts };
        d.kernel = gaussKernel(d.opts.smoothSigma);
        const [lumBayer, lumRgba, bgStats, smooth, peaks] = await Promise.all([
            makePipeline(device, LUM_BAYER_WGSL, 'star-lum-bayer'),
            makePipeline(device, LUM_RGBA_WGSL, 'star-lum-rgba'),
            makePipeline(device, BG_STATS_WGSL, 'star-bg-stats'),
            makePipeline(device, smoothWgsl(d.kernel), 'star-smooth'),
            makePipeline(device, PEAKS_WGSL, 'star-peaks'),
        ]);
        Object.assign(d, { lumBayer, lumRgba, bgStats, smooth, peaks });
        d._buf = null;
        return d;
    }

    _buffers(w, h) {
        if (this._buf && this._buf.w === w && this._buf.h === h) return this._buf;
        this.destroyBuffers();
        const dev = this.device, U = GPUBufferUsage;
        const bw = w >> 1, bh = h >> 1, bs = this.opts.blockSize;
        const nbx = Math.ceil(bw / bs), nby = Math.ceil(bh / bs);
        const n = bw * bh, cap = this.opts.maxCandidates;
        const mk = (size, usage) => dev.createBuffer({ size: Math.max(16, Math.ceil(size / 4) * 4), usage });
        const S = U.STORAGE, C = U.COPY_SRC, D = U.COPY_DST;
        this._buf = {
            w, h, bw, bh, nbx, nby,
            params: mk(48, U.UNIFORM | D),
            dir0: mk(16, U.UNIFORM | D), dir1: mk(16, U.UNIFORM | D),
            src: null, srcSize: 0,
            L: mk(n * 4, S), sat: mk(n * 4, S), tmp: mk(n * 4, S), Sb: mk(n * 4, S),
            stats: mk(nbx * nby * 8, S | C), bg: mk(nbx * nby * 4, S | D),
            out: mk(cap * 32, S | C), counter: mk(4, S | C | D),
            rbStats: mk(nbx * nby * 8, U.MAP_READ | D),
            rbOut: mk(cap * 32 + 16, U.MAP_READ | D),
        };
        dev.queue.writeBuffer(this._buf.dir0, 0, new Uint32Array([0, 0, 0, 0]));
        dev.queue.writeBuffer(this._buf.dir1, 0, new Uint32Array([1, 0, 0, 0]));
        return this._buf;
    }

    destroyBuffers() {
        if (!this._buf) return;
        for (const v of Object.values(this._buf)) if (v && typeof v.destroy === 'function') v.destroy();
        this._buf = null;
    }

    _writeParams(B, black, sat, thr) {
        const p = new ArrayBuffer(48), u = new Uint32Array(p), f = new Float32Array(p);
        u.set([B.w, B.h, B.bw, B.bh, B.nbx, B.nby, this.opts.blockSize, this.opts.maxCandidates]);
        f[8] = black; f[9] = sat; f[10] = thr;
        this.device.queue.writeBuffer(B.params, 0, p);
    }

    _bind(pipe, buffers) {
        return this.device.createBindGroup({
            layout: pipe.getBindGroupLayout(0),
            entries: buffers.map((b, i) => ({ binding: i, resource: { buffer: b } })),
        });
    }

    _pass(enc, pipe, bg, x, y = 1) {
        const pass = enc.beginComputePass();
        pass.setPipeline(pipe); pass.setBindGroup(0, bg);
        pass.dispatchWorkgroups(x, y);
        pass.end();
    }

    /**
     * Détecte les étoiles.
     * @param {object} input
     *   { bayer: Uint16Array }            image Bayer 16 bits (envoyée au GPU)
     *   { rgbaBuffer: GPUBuffer }         RGBA float32 déjà sur le GPU
     *   { rgba: Float32Array }            RGBA float32 (envoyée au GPU)
     * @param {number} w  largeur pleine résolution
     * @param {number} h  hauteur
     * @param {object} [o] { black = 0, satLevel = 65535 (0 = pas de test) }
     */
    async detect(input, w, h, { black = 0, satLevel = 65535 } = {}) {
        const dev = this.device, q = dev.queue, B = this._buffers(w, h);
        const timing = {};
        let t = performance.now();
        let srcBuf, lumPipe;
        if (input.rgbaBuffer) {
            srcBuf = input.rgbaBuffer; lumPipe = this.lumRgba;
        } else {
            const data = input.bayer ?? input.rgba;
            lumPipe = input.bayer ? this.lumBayer : this.lumRgba;
            const size = Math.ceil(data.byteLength / 4) * 4;
            if (!B.src || B.srcSize < size) {
                B.src?.destroy();
                B.src = dev.createBuffer({ size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
                B.srcSize = size;
            }
            if (data.byteLength % 4) {
                const pad = new Uint8Array(size);
                pad.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
                q.writeBuffer(B.src, 0, pad);
            } else {
                q.writeBuffer(B.src, 0, data.buffer, data.byteOffset, data.byteLength);
            }
            srcBuf = B.src;
        }
        this._writeParams(B, black, input.bayer ? satLevel : (input.rgbaSat ?? 0), 0);

        // 1. luminance + statistiques de blocs
        let enc = dev.createCommandEncoder();
        this._pass(enc, lumPipe, this._bind(lumPipe, [B.params, srcBuf, B.L, B.sat]),
                   Math.ceil(B.bw / 16), Math.ceil(B.bh / 16));
        this._pass(enc, this.bgStats, this._bind(this.bgStats, [B.params, B.L, B.stats]), B.nbx * B.nby);
        enc.copyBufferToBuffer(B.stats, 0, B.rbStats, 0, B.nbx * B.nby * 8);
        q.submit([enc.finish()]);
        await B.rbStats.mapAsync(GPUMapMode.READ);
        const stats = new Float32Array(B.rbStats.getMappedRange().slice(0));
        B.rbStats.unmap();
        timing.background = performance.now() - t; t = performance.now();

        // grille de fond (médiane 3×3) et seuil sur CPU : quelques centaines de valeurs
        const { grid, sigma } = backgroundGrid(stats, B.nbx, B.nby);
        const thr = this.opts.kSigma * sigma * smoothNoiseFactor(this.kernel);
        q.writeBuffer(B.bg, 0, grid);
        this._writeParams(B, black, input.bayer ? satLevel : (input.rgbaSat ?? 0), thr);
        q.writeBuffer(B.counter, 0, new Uint32Array([0]));

        // 2. filtre + 3. pics
        enc = dev.createCommandEncoder();
        const wx = Math.ceil(B.bw / 16), wy = Math.ceil(B.bh / 16);
        this._pass(enc, this.smooth, this._bind(this.smooth, [B.params, B.L, B.tmp, B.bg, B.dir0]), wx, wy);
        this._pass(enc, this.smooth, this._bind(this.smooth, [B.params, B.tmp, B.Sb, B.bg, B.dir1]), wx, wy);
        this._pass(enc, this.peaks, this._bind(this.peaks, [B.params, B.Sb, B.L, B.bg, B.sat, B.out, B.counter]), wx, wy);
        enc.copyBufferToBuffer(B.counter, 0, B.rbOut, 0, 4);
        enc.copyBufferToBuffer(B.out, 0, B.rbOut, 16, this.opts.maxCandidates * 32);
        q.submit([enc.finish()]);
        await B.rbOut.mapAsync(GPUMapMode.READ);
        const mapped = B.rbOut.getMappedRange();
        const count = Math.min(new Uint32Array(mapped, 0, 1)[0], this.opts.maxCandidates);
        const raw = new Float32Array(mapped.slice(16, 16 + count * 32));
        B.rbOut.unmap();
        timing.peaks = performance.now() - t;

        const stars = finalizeStars(raw, count, this.opts.maxStars);
        return { stars, sigma, threshold: thr, candidates: count, background: grid,
                 nbx: B.nbx, nby: B.nby, timing };
    }
}

// ---------------------------------------------------------------------------
// Transformations 2D : M = [a, b, c, d, e, f] → x' = a·x + b·y + c, y' = d·x + e·y + f
// ---------------------------------------------------------------------------

export function applyTransform(M, x, y) {
    return [M[0] * x + M[1] * y + M[2], M[3] * x + M[4] * y + M[5]];
}

export function invertTransform(M) {
    const det = M[0] * M[4] - M[1] * M[3];
    const a = M[4] / det, b = -M[1] / det, d = -M[3] / det, e = M[0] / det;
    return [a, b, -(a * M[2] + b * M[5]), d, e, -(d * M[2] + e * M[5])];
}

export function describeTransform(M) {
    const scale = Math.sqrt(Math.abs(M[0] * M[4] - M[1] * M[3]));
    return { dx: M[2], dy: M[5], rotationDeg: Math.atan2(M[3] - M[1], M[0] + M[4]) * 180 / Math.PI, scale };
}

/** Similitude (rotation, échelle, translation) aux moindres carrés : src → dst. */
function fitSimilarity(src, dst) {
    const n = src.length;
    let mx = 0, my = 0, nx = 0, ny = 0;
    for (let i = 0; i < n; i++) { mx += src[i][0]; my += src[i][1]; nx += dst[i][0]; ny += dst[i][1]; }
    mx /= n; my /= n; nx /= n; ny /= n;
    let sxx = 0, sxy = 0, ss = 0;
    for (let i = 0; i < n; i++) {
        const x = src[i][0] - mx, y = src[i][1] - my, u = dst[i][0] - nx, v = dst[i][1] - ny;
        sxx += x * u + y * v; sxy += x * v - y * u; ss += x * x + y * y;
    }
    if (ss <= 0) return null;
    const a = sxx / ss, b = sxy / ss;
    return [a, -b, nx - a * mx + b * my, b, a, ny - b * mx - a * my];
}

/** Affine complète aux moindres carrés : src → dst. */
function fitAffine(src, dst) {
    const n = src.length;
    if (n < 3) return null;
    let sxx = 0, sxy = 0, syy = 0, sx = 0, sy = 0;
    let ux = 0, uy = 0, u1 = 0, vx = 0, vy = 0, v1 = 0;
    for (let i = 0; i < n; i++) {
        const [x, y] = src[i], [u, v] = dst[i];
        sxx += x * x; sxy += x * y; syy += y * y; sx += x; sy += y;
        ux += u * x; uy += u * y; u1 += u; vx += v * x; vy += v * y; v1 += v;
    }
    const A = [[sxx, sxy, sx], [sxy, syy, sy], [sx, sy, n]];
    const solve = (r) => {
        const m = A.map((row, i) => [...row, r[i]]);
        for (let c = 0; c < 3; c++) {
            let p = c;
            for (let i = c + 1; i < 3; i++) if (Math.abs(m[i][c]) > Math.abs(m[p][c])) p = i;
            [m[c], m[p]] = [m[p], m[c]];
            if (Math.abs(m[c][c]) < 1e-12) return null;
            for (let i = 0; i < 3; i++) if (i !== c) {
                const f = m[i][c] / m[c][c];
                for (let j = c; j < 4; j++) m[i][j] -= f * m[c][j];
            }
        }
        return [m[0][3] / m[0][0], m[1][3] / m[1][1], m[2][3] / m[2][2]];
    };
    const p = solve([ux, uy, u1]), q = solve([vx, vy, v1]);
    return p && q ? [...p, ...q] : null;
}

// ---------------------------------------------------------------------------
// Appariement
// ---------------------------------------------------------------------------

export const MATCH_DEFAULTS = {
    model:        'similarity',   // 'similarity' (rotation + translation) ou 'affine'
    nBright:      40,             // étoiles utilisées pour les triangles
    neighbors:    6,              // voisines par étoile pour former les triangles
    invTol:       0.008,          // tolérance sur les invariants de forme
    ransacTol:    3,              // px, test des hypothèses
    finalTol:     1.5,            // px, appariement final
    minInliers:   8,
    maxScaleDev:  0.02,           // échelle tolérée (même optique) : 1 ± 2 %
};

/** Grille spatiale pour le plus proche voisin rapide. */
class StarGrid {
    constructor(stars, cell = 16) {
        this.cell = cell; this.stars = stars; this.map = new Map();
        stars.forEach((s, i) => {
            const k = `${Math.floor(s.x / cell)},${Math.floor(s.y / cell)}`;
            if (!this.map.has(k)) this.map.set(k, []);
            this.map.get(k).push(i);
        });
    }
    nearest(x, y, tol) {
        const c = this.cell, r = Math.ceil(tol / c);
        const cx = Math.floor(x / c), cy = Math.floor(y / c);
        let best = -1, bd = tol * tol;
        for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
            for (const i of this.map.get(`${cx + dx},${cy + dy}`) ?? []) {
                const s = this.stars[i], d = (s.x - x) ** 2 + (s.y - y) ** 2;
                if (d < bd) { bd = d; best = i; }
            }
        }
        return best;
    }
}

/** Paires (cur → ref) sous la transformée M, chaque étoile de réf. au plus une fois. */
function pairsUnder(M, cur, refGrid, tol) {
    const pairs = [];
    const used = new Map();
    cur.forEach((s, i) => {
        const [x, y] = applyTransform(M, s.x, s.y);
        const j = refGrid.nearest(x, y, tol);
        if (j < 0) return;
        const d = (refGrid.stars[j].x - x) ** 2 + (refGrid.stars[j].y - y) ** 2;
        const prev = used.get(j);
        if (prev && prev.d <= d) return;
        used.set(j, { i, d });
    });
    for (const [j, { i, d }] of used) pairs.push({ i, j, d });
    return pairs;
}

function triangles(stars, n, k) {
    const pts = stars.slice(0, n);
    const out = [];
    const seen = new Set();
    for (let i = 0; i < pts.length; i++) {
        const nn = pts.map((p, j) => [j, (p.x - pts[i].x) ** 2 + (p.y - pts[i].y) ** 2])
            .filter(([j]) => j !== i).sort((a, b) => a[1] - b[1]).slice(0, k).map(([j]) => j);
        for (let a = 0; a < nn.length; a++) for (let b = a + 1; b < nn.length; b++) {
            const tri = [i, nn[a], nn[b]].sort((p, q) => p - q);
            const key = tri.join(',');
            if (seen.has(key)) continue;
            seen.add(key);
            const t = triangleInvariant(pts, tri);
            if (t) out.push(t);
        }
    }
    return out;
}

// Côtés triés l0 ≤ l1 ≤ l2 ; sommets ordonnés par le côté opposé (même ordre
// d'un triangle à son image) ; invariants (l0/l2, l1/l2).
function triangleInvariant(pts, tri) {
    const [p, q, r] = tri.map((i) => pts[i]);
    const sides = [
        [Math.hypot(q.x - r.x, q.y - r.y), tri[0]],   // opposé à p
        [Math.hypot(p.x - r.x, p.y - r.y), tri[1]],
        [Math.hypot(p.x - q.x, p.y - q.y), tri[2]],
    ].sort((a, b) => a[0] - b[0]);
    if (sides[2][0] < 8 || sides[0][0] < 0.15 * sides[2][0]) return null;   // trop petit / trop plat
    return { v: [sides[0][1], sides[1][1], sides[2][1]], i0: sides[0][0] / sides[2][0], i1: sides[1][0] / sides[2][0] };
}

/**
 * Transformée qui amène les étoiles `cur` sur `ref` (coordonnées image).
 * @returns {{ok:boolean, M?:number[], inliers:number, rms:number, method:string, scale?:number}}
 */
export function matchStars(ref, cur, opts = {}, prior = null) {
    const o = { ...MATCH_DEFAULTS, ...opts };
    const fit = o.model === 'affine' ? fitAffine : fitSimilarity;
    const refGrid = new StarGrid(ref);
    const nExpected = Math.min(ref.length, cur.length);

    const refine = (M0, method) => {
        let M = M0, pairs = [];
        for (const tol of [o.ransacTol, o.finalTol, o.finalTol]) {
            pairs = pairsUnder(M, cur, refGrid, tol);
            if (pairs.length < Math.max(3, o.minInliers)) return null;
            const src = pairs.map((p) => [cur[p.i].x, cur[p.i].y]);
            const dst = pairs.map((p) => [ref[p.j].x, ref[p.j].y]);
            const M1 = (o.model === 'affine' && pairs.length >= 12 ? fitAffine : fitSimilarity)(src, dst);
            if (!M1) return null;
            M = M1;
        }
        let s2 = 0;
        for (const p of pairs) {
            const [x, y] = applyTransform(M, cur[p.i].x, cur[p.i].y);
            s2 += (x - ref[p.j].x) ** 2 + (y - ref[p.j].y) ** 2;
        }
        const scale = describeTransform(M).scale;
        if (Math.abs(scale - 1) > o.maxScaleDev) return null;
        return { ok: true, M, inliers: pairs.length, rms: Math.sqrt(s2 / pairs.length), method, scale };
    };

    // Chemin rapide : la transformée précédente tient encore
    if (prior) {
        const pairs = pairsUnder(prior, cur, refGrid, o.ransacTol * 2);
        if (pairs.length >= Math.max(o.minInliers, 0.4 * nExpected)) {
            const r = refine(prior, 'précédente');
            if (r && r.inliers >= Math.max(o.minInliers, 0.4 * nExpected)) return r;
        }
    }

    // Recherche complète par triangles
    const tr = triangles(ref, o.nBright, o.neighbors);
    const tc = triangles(cur, o.nBright, o.neighbors);
    const rb = ref.slice(0, o.nBright), cb = cur.slice(0, o.nBright);
    const brightGrid = new StarGrid(rb);
    let best = null;
    tr.sort((a, b) => a.i0 - b.i0);
    for (const t of tc) {
        // fenêtre sur i0 (liste triée) puis test sur i1
        let lo = 0, hi = tr.length;
        while (lo < hi) { const m = (lo + hi) >> 1; if (tr[m].i0 < t.i0 - o.invTol) lo = m + 1; else hi = m; }
        for (let k = lo; k < tr.length && tr[k].i0 <= t.i0 + o.invTol; k++) {
            const u = tr[k];
            if (Math.abs(u.i1 - t.i1) > o.invTol) continue;
            const src = t.v.map((i) => [cb[i].x, cb[i].y]);
            const dst = u.v.map((i) => [rb[i].x, rb[i].y]);
            const M = fitSimilarity(src, dst);
            if (!M) continue;
            const sc = describeTransform(M).scale;
            if (Math.abs(sc - 1) > o.maxScaleDev || M[0] * M[4] - M[1] * M[3] <= 0) continue;
            const n = pairsUnder(M, cb, brightGrid, o.ransacTol).length;
            if (!best || n > best.n) {
                best = { n, M };
                if (n >= 0.8 * Math.min(rb.length, cb.length)) break;
            }
        }
        if (best && best.n >= 0.8 * Math.min(rb.length, cb.length)) break;
    }
    if (!best || best.n < Math.min(o.minInliers, 6))
        return { ok: false, inliers: best?.n ?? 0, rms: NaN, method: 'triangles' };
    const r = refine(best.M, 'triangles');
    return r ?? { ok: false, inliers: best.n, rms: NaN, method: 'triangles' };
}
