'use strict';
/**
 * deconv.js — déconvolution Richardson-Lucy du stack ciel profond (Live Stack).
 *
 * Module autonome (worker ou Node). Deux temps :
 *   prepareDeconv() — calcul lourd, sur demande (bouton) : fond et bruit,
 *     HFR des étoiles du stack → PSF gaussienne (σ = HFR / 1,2533, gaussienne
 *     pure), puis Richardson-Lucy sur la luminance seule (la couleur suit, sans
 *     bruit chromatique amplifié). Convolution gaussienne séparable, sur GPU
 *     (WebGPU) ou CPU en repli.
 *   applyDeconv() — rapide, à chaque rendu : mélange réglable du résultat
 *     brut avec l'image d'origine :
 *       - anti-anneaux : RL creuse un anneau sombre autour des étoiles
 *         brillantes ; on limite l'assombrissement à (1 − a) du niveau
 *         d'origine (a = 1 : la déconvolution ne fait plus que rehausser) ;
 *       - protection du fond : la déconvolution n'agit que là où le signal
 *         lissé dépasse k·σ (transition jusqu'à 2k·σ) — le fond garde son
 *         bruit d'origine au lieu de grainer.
 * Données : RGBA float32 du snapshot (alpha = couverture), unités capteur.
 */

/** Noyau gaussien 1D normalisé, rayon 3σ. */
function gaussKernel(sigma) {
    const r = Math.max(1, Math.ceil(3 * sigma));
    const k = new Float32Array(2 * r + 1);
    let s = 0;
    for (let i = -r; i <= r; i++) { k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma)); s += k[i + r]; }
    for (let i = 0; i < k.length; i++) k[i] /= s;
    return k;
}

/**
 * Convolution séparable src → dst (bords : pixel de bord répété ; dst peut
 * être src). tmp de même taille. Passe horizontale sans test de bord hors des
 * r premières et dernières colonnes ; passe verticale ligne par ligne
 * (accès mémoire contigus).
 */
function convolve(src, dst, tmp, w, h, k) {
    const r = (k.length - 1) >> 1, K = k.length;
    for (let y = 0; y < h; y++) {
        const o = y * w;
        for (let x = 0; x < w; x++) {
            let s = 0;
            if (x >= r && x < w - r) {
                const b = o + x - r;
                for (let j = 0; j < K; j++) s += k[j] * src[b + j];
            } else {
                for (let j = -r; j <= r; j++) {
                    const xx = x + j < 0 ? 0 : x + j >= w ? w - 1 : x + j;
                    s += k[j + r] * src[o + xx];
                }
            }
            tmp[o + x] = s;
        }
    }
    const acc = new Float32Array(w);
    for (let y = 0; y < h; y++) {
        acc.fill(0);
        for (let j = -r; j <= r; j++) {
            const yy = y + j < 0 ? 0 : y + j >= h ? h - 1 : y + j;
            const kj = k[j + r], ro = yy * w;
            for (let x = 0; x < w; x++) acc[x] += kj * tmp[ro + x];
        }
        dst.set(acc, y * w);
    }
}

/**
 * Masque des étoiles brillantes (0–1) : pixels au-dessus de frac × pic,
 * dilatés de `rad` px (max carré séparable) puis adoucis. Leur cœur souvent
 * écrêté ne se déconvolue pas (anneaux clairs et sombres).
 */
function starMask(L, w, h, frac, rad, tmp) {
    const n = w * h, m = new Float32Array(n);
    let peak = 0;
    for (let i = 0; i < n; i++) if (L[i] > peak) peak = L[i];
    const thr = frac * peak;
    for (let i = 0; i < n; i++) m[i] = L[i] > thr ? 1 : 0;
    // dilatation : lignes puis colonnes
    for (let y = 0; y < h; y++) {
        const o = y * w;
        let last = -1e9;
        for (let x = 0; x < w; x++) { if (m[o + x]) last = x; tmp[o + x] = x - last <= rad ? 1 : 0; }
        last = 1e9;
        for (let x = w - 1; x >= 0; x--) { if (m[o + x]) last = x; if (last - x <= rad) tmp[o + x] = 1; }
    }
    for (let x = 0; x < w; x++) {
        let last = -1e9;
        for (let y = 0; y < h; y++) { if (tmp[y * w + x]) last = y; m[y * w + x] = y - last <= rad ? 1 : 0; }
        last = 1e9;
        for (let y = h - 1; y >= 0; y--) { if (tmp[y * w + x]) last = y; if (last - y <= rad) m[y * w + x] = 1; }
    }
    convolve(m, m, tmp, w, h, gaussKernel(Math.max(1, rad / 2)));
    return m;
}

function median(a) {
    const s = Float32Array.from(a).sort();
    return s.length ? s[s.length >> 1] : 0;
}

/** Luminance (moyenne R, G, B), fond par canal et bruit (MAD) sur 1 pixel sur 16. */
function lumStats(rgba, w, h) {
    const n = w * h, L = new Float32Array(n);
    const cs = [[], [], []], ls = [];
    for (let i = 0; i < n; i++) {
        L[i] = (rgba[4 * i] + rgba[4 * i + 1] + rgba[4 * i + 2]) / 3;
        if ((i & 15) === 0 && rgba[4 * i + 3] > 0) {
            for (let c = 0; c < 3; c++) cs[c].push(rgba[4 * i + c]);
            ls.push(L[i]);
        }
    }
    const bgc = cs.map(median), bg = (bgc[0] + bgc[1] + bgc[2]) / 3;
    const sigma = 1.4826 * median(ls.map((v) => Math.abs(v - bg))) || 1e-6;
    for (let i = 0; i < n; i++) L[i] -= bg;
    return { L, bgc, sigma };
}

/**
 * HFR médian (px) des étoiles isolées non saturées : maxima locaux 15×15
 * au-dessus de 30 σ, disque de rayon 15 px, fond local = anneau 15–18 px.
 */
export function measureHfr(L, w, h, sigma) {
    const R = 15, Ro = 18, cand = [];
    let peak = 0;
    for (let i = 0; i < L.length; i++) if (L[i] > peak) peak = L[i];
    for (let y = Ro; y < h - Ro; y++) {
        for (let x = Ro; x < w - Ro; x++) {
            const v = L[y * w + x];
            if (v < 30 * sigma || v > 0.9 * peak) continue;
            let isMax = true;
            for (let dy = -7; dy <= 7 && isMax; dy++)
                for (let dx = -7; dx <= 7; dx++)
                    if (L[(y + dy) * w + x + dx] > v) { isMax = false; break; }
            if (isMax) cand.push([v, x, y]);
        }
    }
    cand.sort((a, b) => b[0] - a[0]);
    const hfr = [], ring = [];
    for (const [, x, y] of cand.slice(0, 100)) {
        ring.length = 0;
        for (let dy = -Ro; dy <= Ro; dy++) for (let dx = -Ro; dx <= Ro; dx++) {
            const r2 = dx * dx + dy * dy;
            if (r2 > R * R && r2 <= Ro * Ro) ring.push(L[(y + dy) * w + x + dx]);
        }
        const bg = median(ring);
        let S = 0, sx = 0, sy = 0;
        for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
            if (dx * dx + dy * dy > R * R) continue;
            const v = Math.max(0, L[(y + dy) * w + x + dx] - bg);
            S += v; sx += v * dx; sy += v * dy;
        }
        if (!(S > 0)) continue;
        const mx = sx / S, my = sy / S;
        let hr = 0;
        for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
            if (dx * dx + dy * dy > R * R) continue;
            hr += Math.max(0, L[(y + dy) * w + x + dx] - bg) * Math.hypot(dx - mx, dy - my);
        }
        hfr.push(hr / S);
    }
    return { hfr: hfr.length >= 5 ? median(hfr) : NaN, stars: hfr.length };
}

/**
 * Calcul lourd : PSF mesurée puis Richardson-Lucy sur la luminance — sur GPU
 * (WebGPU, `device` fourni ou demandé) si possible, sinon CPU (même calcul).
 * @param {object} o { iterations, psfScale (× σ mesuré), psfSigma (forcé, px), forceCpu, device }
 * @param {function} [onProgress] (fait, total)
 * @returns { D, L, Ls, bgc, sigma, hfr, psfSigma, iterations, backend, ms } ou { error }
 */
export async function prepareDeconv(rgba, w, h,
                                    { iterations = 30, psfScale = 0.85, psfSigma = 0, forceCpu = false, device = null } = {},
                                    onProgress) {
    const t0 = performance.now();
    const { L, bgc, sigma } = lumStats(rgba, w, h);
    const { hfr, stars } = measureHfr(L, w, h, sigma);
    // HFR d'une gaussienne = σ·√(π/2)
    const sig = psfSigma > 0 ? psfSigma : (hfr / 1.2533) * psfScale;
    if (!(sig > 0.3)) return { error: `PSF non mesurable (${stars} étoiles isolées)` };
    const n = w * h, k = gaussKernel(sig);
    // plancher > 0 : RL exige des valeurs positives ; quelques σ au-dessus
    // de zéro limitent aussi l'amplification du bruit du fond
    const floor = 3 * sigma;
    const f = new Float32Array(n);
    for (let i = 0; i < n; i++) f[i] = Math.max(0, L[i]) + floor;
    let u = null, backend = 'cpu';
    if (!forceCpu) {
        try {
            const dev = device ?? await gpuDevice();
            if (dev) { u = await richardsonLucyGPU(dev, f, w, h, k, iterations, onProgress); backend = 'gpu'; }
        } catch (e) {
            console.warn('[Déconvolution] GPU indisponible, repli CPU :', e.message);
        }
    }
    if (!u) u = richardsonLucyCPU(f, w, h, k, iterations, onProgress);
    for (let i = 0; i < n; i++) u[i] -= floor;
    // signal lissé (σ 2 px) pour la protection du fond
    const Ls = new Float32Array(n);
    convolve(L, Ls, new Float32Array(n), w, h, gaussKernel(2));
    return { D: u, L, Ls, bgc, sigma, hfr, psfSigma: sig, iterations, backend, w, h, masks: new Map(),
             ms: performance.now() - t0 };
}

function richardsonLucyCPU(f, w, h, k, iterations, onProgress) {
    const n = w * h, u = Float32Array.from(f), c = new Float32Array(n), tmp = new Float32Array(n);
    for (let it = 0; it < iterations; it++) {
        convolve(u, c, tmp, w, h, k);
        for (let i = 0; i < n; i++) c[i] = f[i] / Math.max(c[i], 1e-12);
        convolve(c, c, tmp, w, h, k);   // noyau symétrique : PSF retournée = PSF
        for (let i = 0; i < n; i++) u[i] *= c[i];
        onProgress?.(it + 1, iterations);
    }
    return u;
}

async function gpuDevice() {
    const gpu = globalThis.navigator?.gpu;
    if (!gpu) return null;
    const ad = await gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!ad || ad.info?.isFallbackAdapter) return null;
    return ad.requestDevice({ requiredLimits: {
        maxStorageBufferBindingSize: ad.limits.maxStorageBufferBindingSize,
        maxBufferSize: ad.limits.maxBufferSize,
    } });
}

// Convolution séparable (axe choisi par P.axis) et étapes de Richardson-Lucy
const RL_WGSL = /* wgsl */ `
struct P { w: u32, h: u32, r: u32, axis: u32 }
@group(0) @binding(0) var<uniform> p: P;
@group(0) @binding(1) var<storage, read> k: array<f32>;
@group(0) @binding(2) var<storage, read> src: array<f32>;
@group(0) @binding(3) var<storage, read_write> dst: array<f32>;

@compute @workgroup_size(16, 16)
fn conv(@builtin(global_invocation_id) g: vec3<u32>) {
    if (g.x >= p.w || g.y >= p.h) { return; }
    let r = i32(p.r);
    var s = 0.0;
    if (p.axis == 0u) {
        let row = g.y * p.w;
        for (var j = -r; j <= r; j++) {
            let x = u32(clamp(i32(g.x) + j, 0, i32(p.w) - 1));
            s += k[u32(j + r)] * src[row + x];
        }
    } else {
        for (var j = -r; j <= r; j++) {
            let y = u32(clamp(i32(g.y) + j, 0, i32(p.h) - 1));
            s += k[u32(j + r)] * src[y * p.w + g.x];
        }
    }
    dst[g.y * p.w + g.x] = s;
}

// dst = src / max(dst, ε)  (rapport observé / estimé reflou)
@compute @workgroup_size(16, 16)
fn ratio(@builtin(global_invocation_id) g: vec3<u32>) {
    if (g.x >= p.w || g.y >= p.h) { return; }
    let i = g.y * p.w + g.x;
    dst[i] = src[i] / max(dst[i], 1e-12);
}

// dst *= src  (mise à jour multiplicative)
@compute @workgroup_size(16, 16)
fn update(@builtin(global_invocation_id) g: vec3<u32>) {
    if (g.x >= p.w || g.y >= p.h) { return; }
    let i = g.y * p.w + g.x;
    dst[i] = dst[i] * src[i];
}
`;

/**
 * Richardson-Lucy sur GPU : u ← u · (K ⊗ (f / (K ⊗ u))), K gaussienne
 * séparable. Toutes les passes d'une itération dans un seul envoi ;
 * avancement remonté toutes les quelques itérations.
 */
async function richardsonLucyGPU(device, f, w, h, k, iterations, onProgress) {
    const n = w * h, U = GPUBufferUsage;
    const mod = device.createShaderModule({ code: RL_WGSL, label: 'deconv-rl' });
    const layout = device.createBindGroupLayout({ entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
    ] });
    const pl = device.createPipelineLayout({ bindGroupLayouts: [layout] });
    const [conv, ratio, update] = await Promise.all(['conv', 'ratio', 'update']
        .map((e) => device.createComputePipelineAsync({ layout: pl, compute: { module: mod, entryPoint: e } })));
    const buf = (size, usage) => device.createBuffer({ size, usage });
    const bytes = n * 4;
    const bf = buf(bytes, U.STORAGE | U.COPY_DST), bu = buf(bytes, U.STORAGE | U.COPY_DST | U.COPY_SRC);
    const bc = buf(bytes, U.STORAGE), bt = buf(bytes, U.STORAGE);
    const bk = buf(k.byteLength, U.STORAGE | U.COPY_DST);
    const read = buf(bytes, U.MAP_READ | U.COPY_DST);
    const uni = (axis) => {
        const b = buf(16, U.UNIFORM | U.COPY_DST);
        device.queue.writeBuffer(b, 0, new Uint32Array([w, h, (k.length - 1) >> 1, axis]));
        return b;
    };
    const pH = uni(0), pV = uni(1);
    device.queue.writeBuffer(bf, 0, f);
    device.queue.writeBuffer(bu, 0, f);
    device.queue.writeBuffer(bk, 0, k);
    const bg = (P, src, dst) => device.createBindGroup({ layout, entries: [
        { binding: 0, resource: { buffer: P } }, { binding: 1, resource: { buffer: bk } },
        { binding: 2, resource: { buffer: src } }, { binding: 3, resource: { buffer: dst } },
    ] });
    // u →(H) t →(V) c ; c = f / c ; c →(H) t →(V) c ; u *= c
    const steps = [
        [conv, bg(pH, bu, bt)], [conv, bg(pV, bt, bc)], [ratio, bg(pH, bf, bc)],
        [conv, bg(pH, bc, bt)], [conv, bg(pV, bt, bc)], [update, bg(pH, bc, bu)],
    ];
    const gx = Math.ceil(w / 16), gy = Math.ceil(h / 16);
    try {
        const chunk = 5;
        for (let it = 0; it < iterations; it += chunk) {
            const enc = device.createCommandEncoder();
            for (let j = it; j < Math.min(iterations, it + chunk); j++) {
                for (const [pipeline, group] of steps) {
                    const pass = enc.beginComputePass();
                    pass.setPipeline(pipeline); pass.setBindGroup(0, group);
                    pass.dispatchWorkgroups(gx, gy); pass.end();
                }
            }
            device.queue.submit([enc.finish()]);
            await device.queue.onSubmittedWorkDone();
            onProgress?.(Math.min(iterations, it + chunk), iterations);
        }
        const enc = device.createCommandEncoder();
        enc.copyBufferToBuffer(bu, 0, read, 0, bytes);
        device.queue.submit([enc.finish()]);
        await read.mapAsync(GPUMapMode.READ);
        const out = new Float32Array(read.getMappedRange().slice(0));
        read.unmap();
        return out;
    } finally {
        for (const b of [bf, bu, bc, bt, bk, read, pH, pV]) b.destroy();
    }
}

/**
 * Rendu : RGBA d'origine + déconvolution dosée (voir en-tête). Renvoie un
 * nouveau Float32Array RGBA.
 * @param {object} p { antiRing (0–1), noiseK (σ, 0 = partout),
 *   starFrac (étoiles brillantes protégées au-dessus de cette part du pic, 0 = non) }
 */
export function applyDeconv(rgba, w, h, d, { antiRing = 0.5, noiseK = 5, starFrac = 0.2 } = {}) {
    const n = w * h, out = new Float32Array(rgba);
    const { D, L, Ls, bgc, sigma } = d;
    // masque mis en cache par seuil (le curseur revient souvent aux mêmes valeurs)
    let ms = null;
    if (starFrac > 0) {
        const key = starFrac.toFixed(3);
        ms = d.masks.get(key);
        if (!ms) {
            ms = starMask(L, w, h, starFrac, Math.ceil(4 * d.psfSigma), new Float32Array(n));
            if (d.masks.size > 8) d.masks.clear();
            d.masks.set(key, ms);
        }
    }
    const k0 = noiseK * sigma, k1 = 2 * noiseK * sigma;
    for (let i = 0; i < n; i++) {
        const lo = L[i];
        let v = D[i];
        if (lo > 0 && v < antiRing * lo) v = antiRing * lo;
        if (noiseK > 0) {
            const t = (Ls[i] - k0) / (k1 - k0);
            const m = t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t);
            v = lo + m * (v - lo);
        }
        if (ms) v = lo + (1 - ms[i]) * (v - lo);
        const dl = v - lo;
        if (dl === 0) continue;
        // la couleur suit : écart de luminance réparti selon la teinte du pixel
        // (proportions des canaux au-dessus du fond), neutre dans le fond
        for (let ch = 0; ch < 3; ch++) {
            const q = lo > 3 * sigma ? Math.min(3, Math.max(0, (rgba[4 * i + ch] - bgc[ch]) / lo)) : 1;
            out[4 * i + ch] += dl * q;
        }
    }
    return out;
}
