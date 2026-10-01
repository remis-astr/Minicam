'use strict';
/**
 * DsoStacker — empilement ciel profond aligné sur les étoiles (Live Stack).
 *
 * Pour chaque image RGBA float32 (sortie du débayérisage) :
 *   0. soustraction du niveau de noir du capteur (sinon les rapports de
 *      couleur et toute balance des blancs multiplicative sont faussés) ;
 *   1. détection des étoiles (star_align.js — GPU, ou CPU sans WebGPU) ;
 *   2. appariement avec les étoiles de l'image de référence (la première
 *      acceptée) : rotation + translation (ou affine) ; image rejetée si
 *      l'appariement échoue ou, en option, si ses étoiles sont trop larges
 *      ou trop allongées par rapport à la référence ;
 *   3. normalisation additive du fond : on retire, canal par canal, l'écart
 *      de niveau de ciel (médiane) avec la référence — un ciel qui s'éclaircit
 *      ne doit pas être « remis à l'échelle » comme une planète ;
 *   4. recalage bilinéaire dans le repère de la référence et accumulation
 *      (somme pondérée + carte de couverture : un bord couvert par moins
 *      d'images n'est pas assombri).
 *
 * Module autonome (device demandé lui-même), utilisable dans les workers
 * d'empilement comme dans Node (tests).
 */

import {
    StarDetectorGPU, detectStarsCPU, matchStars, invertTransform, describeTransform,
} from './star_align.js';

export const DSO_DEFAULTS = {
    model:        'similarity',  // 'similarity' (rotation + translation) | 'affine'
    maxFwhmRatio: 0,             // rejet si FWHM médiane > ratio × celle de la réf. (0 = jamais)
    maxElong:     0,             // rejet si allongement médian > valeur (0 = jamais)
    minStars:     8,             // étoiles appariées minimum
};

const WARP_WGSL = /* wgsl */`
struct Params {
    w: u32, h: u32, _p0: u32, _p1: u32,
    m0: f32, m1: f32, m2: f32, m3: f32,
    m4: f32, m5: f32, offR: f32, offG: f32,
    offB: f32, weight: f32, _p2: f32, _p3: f32,
};
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> src: array<f32>;
@group(0) @binding(2) var<storage, read_write> acc: array<f32>;
fn px(x: u32, y: u32) -> vec3<f32> {
    let i = (y * P.w + x) * 4u;
    return vec3<f32>(src[i], src[i + 1u], src[i + 2u]);
}
@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) g: vec3<u32>) {
    if (g.x >= P.w || g.y >= P.h) { return; }
    let x = f32(g.x); let y = f32(g.y);
    let sx = P.m0 * x + P.m1 * y + P.m2;
    let sy = P.m3 * x + P.m4 * y + P.m5;
    if (sx < 0.0 || sy < 0.0 || sx > f32(P.w - 1u) || sy > f32(P.h - 1u)) { return; }
    let x0 = min(u32(floor(sx)), P.w - 2u);
    let y0 = min(u32(floor(sy)), P.h - 2u);
    let fx = sx - f32(x0); let fy = sy - f32(y0);
    let c = mix(mix(px(x0, y0), px(x0 + 1u, y0), fx),
                mix(px(x0, y0 + 1u), px(x0 + 1u, y0 + 1u), fx), fy);
    let o = (g.y * P.w + g.x) * 4u;
    acc[o]      += P.weight * (c.x - P.offR);
    acc[o + 1u] += P.weight * (c.y - P.offG);
    acc[o + 2u] += P.weight * (c.z - P.offB);
    acc[o + 3u] += P.weight;
}
`;

/** Médianes R, G, B sur un échantillon régulier (~60 000 pixels). */
function channelMedians(rgba, n) {
    const step = Math.max(1, Math.floor(n / 60000));
    const m = Math.ceil(n / step);
    const ch = [new Float32Array(m), new Float32Array(m), new Float32Array(m)];
    for (let i = 0, k = 0; i < n; i += step, k++) {
        ch[0][k] = rgba[4 * i]; ch[1][k] = rgba[4 * i + 1]; ch[2][k] = rgba[4 * i + 2];
    }
    return ch.map((a) => a.sort()[a.length >> 1]);
}

/** Luminance binnée 2×2 depuis RGBA float (même formule que le shader). */
function lumBin2FromRgba(rgba, w, h) {
    const bw = w >> 1, bh = h >> 1;
    const L = new Float32Array(bw * bh), sat = new Uint8Array(bw * bh);
    const lum = (i) => rgba[4 * i] + 2 * rgba[4 * i + 1] + rgba[4 * i + 2];
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
        const i0 = 2 * y * w + 2 * x;
        L[y * bw + x] = (lum(i0) + lum(i0 + 1) + lum(i0 + w) + lum(i0 + w + 1)) * 0.25;
    }
    return { L, sat, bw, bh };
}

const median = (a) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[s.length >> 1] : 0; };

export class DsoStacker {
    /**
     * @param {object} o
     * @param {number} o.width   @param {number} o.height
     * @param {GPUDevice|null} [o.device]  sinon demandé à navigator.gpu ; null/échec → CPU
     * @param {boolean} [o.forceCpu]
     */
    static async create({ width, height, device, forceCpu = false, ...opts }) {
        const s = new DsoStacker();
        s.w = width; s.h = height;
        s.opts = { ...DSO_DEFAULTS, ...opts };
        s.ref = null;            // { stars, bg: [r,g,b], fwhm, elong }
        s.prior = null;
        s.count = 0;
        s.gpu = null;
        if (!forceCpu) {
            try {
                let dev = device;
                if (!dev && globalThis.navigator?.gpu) {
                    const ad = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
                    if (ad && !ad.info?.isFallbackAdapter) {
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
        if (!s.gpu) s.acc = new Float32Array(width * height * 4);
        console.log(`[DSO] empilement ${width}×${height} sur ${s.gpu ? 'GPU' : 'CPU'}, modèle ${s.opts.model}`);
        return s;
    }

    get backend() { return this.gpu ? 'gpu' : 'cpu'; }

    async _initGpu(device) {
        const n = this.w * this.h;
        const module = device.createShaderModule({ code: WARP_WGSL, label: 'dso-warp' });
        const info = await module.getCompilationInfo?.();
        for (const m of info?.messages ?? [])
            if (m.type === 'error') throw new Error(`Shader dso-warp : ${m.message}`);
        const U = GPUBufferUsage;
        const g = {
            device,
            detector: await StarDetectorGPU.create(device),
            warp: device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } }),
            params: device.createBuffer({ size: 64, usage: U.UNIFORM | U.COPY_DST }),
            src: device.createBuffer({ size: n * 16, usage: U.STORAGE | U.COPY_DST }),
            acc: device.createBuffer({ size: n * 16, usage: U.STORAGE | U.COPY_SRC | U.COPY_DST }),
            rb: device.createBuffer({ size: n * 16, usage: U.MAP_READ | U.COPY_DST }),
        };
        const enc = device.createCommandEncoder();
        enc.clearBuffer(g.acc);
        device.queue.submit([enc.finish()]);
        return g;
    }

    /** Remet le stack à zéro (nouvelle référence à la prochaine image). */
    async reset() {
        this.ref = null; this.prior = null; this.count = 0;
        if (this.gpu) {
            const enc = this.gpu.device.createCommandEncoder();
            enc.clearBuffer(this.gpu.acc);
            this.gpu.device.queue.submit([enc.finish()]);
        } else {
            this.acc.fill(0);
        }
    }

    /**
     * Ajoute une image. @param {Float32Array} rgba  w×h×4 (modifiée sur place)
     * @param {number} [o.black]  niveau de noir en unités 0–1
     * @returns compte rendu { accepted, reason?, stars, inliers, rms, dx, dy, rotationDeg, fwhm, elong, timing }
     */
    async addFrame(rgba, { weight = 1, black = 0 } = {}) {
        const { w, h } = this, n = w * h;
        if (rgba.length !== n * 4) throw new Error(`image ${rgba.length / 4} px ≠ ${n} px du stack`);
        const timing = {};
        let t = performance.now();
        // 0. niveau de noir (débayérisage linéaire : soustraire après revient au même)
        if (black > 0) {
            for (let i = 0; i < n * 4; i += 4) { rgba[i] -= black; rgba[i + 1] -= black; rgba[i + 2] -= black; }
        }

        // 1. étoiles
        let det;
        if (this.gpu) {
            this.gpu.device.queue.writeBuffer(this.gpu.src, 0, rgba);
            det = await this.gpu.detector.detect({ rgbaBuffer: this.gpu.src }, w, h, { satLevel: 0 });
        } else {
            const { L, sat, bw, bh } = lumBin2FromRgba(rgba, w, h);
            det = detectStarsCPU(L, sat, bw, bh);
        }
        const stars = det.stars;
        const fwhm = median(stars.map((s) => s.fwhm));
        const elong = median(stars.map((s) => s.elong));
        timing.detect = performance.now() - t; t = performance.now();
        const bg = channelMedians(rgba, n);
        timing.background = performance.now() - t; t = performance.now();

        const report = { stars: stars.length, fwhm, elong, background: bg, timing };
        if (!this.ref) {
            if (stars.length < this.opts.minStars)
                return { ...report, accepted: false, reason: `${stars.length} étoiles (réf.)` };
            this.ref = { stars, bg, fwhm, elong };
            Object.assign(report, { inliers: stars.length, rms: 0, dx: 0, dy: 0, rotationDeg: 0, M: [1, 0, 0, 0, 1, 0] });
        } else {
            // 2. appariement + contrôle qualité
            const m = matchStars(this.ref.stars, stars, { model: this.opts.model, minInliers: this.opts.minStars }, this.prior);
            timing.match = performance.now() - t; t = performance.now();
            if (!m.ok) return { ...report, accepted: false, reason: `alignement impossible (${m.inliers} étoiles)` };
            const d = describeTransform(m.M);
            Object.assign(report, { inliers: m.inliers, rms: m.rms, method: m.method, M: m.M,
                                    dx: d.dx, dy: d.dy, rotationDeg: d.rotationDeg });
            if (this.opts.maxFwhmRatio > 0 && fwhm > this.opts.maxFwhmRatio * this.ref.fwhm)
                return { ...report, accepted: false, reason: `FWHM ${fwhm.toFixed(1)} px` };
            if (this.opts.maxElong > 0 && elong > this.opts.maxElong)
                return { ...report, accepted: false, reason: `étoiles allongées (${elong.toFixed(2)})` };
            this.prior = m.M;
        }

        // 3–4. fond + recalage + accumulation (repère de la référence)
        const Minv = invertTransform(report.M);
        const off = bg.map((v, c) => v - this.ref.bg[c]);
        if (this.gpu) await this._warpGpu(Minv, off, weight);
        else this._warpCpu(rgba, Minv, off, weight);
        timing.warp = performance.now() - t;
        this.count++;
        return { ...report, accepted: true };
    }

    async _warpGpu(Minv, off, weight) {
        const g = this.gpu, q = g.device.queue;
        const p = new ArrayBuffer(64), u = new Uint32Array(p), f = new Float32Array(p);
        u[0] = this.w; u[1] = this.h;
        f.set(Minv, 4); f[10] = off[0]; f[11] = off[1]; f[12] = off[2]; f[13] = weight;
        q.writeBuffer(g.params, 0, p);
        const enc = g.device.createCommandEncoder();
        const pass = enc.beginComputePass();
        pass.setPipeline(g.warp);
        pass.setBindGroup(0, g.device.createBindGroup({
            layout: g.warp.getBindGroupLayout(0),
            entries: [g.params, g.src, g.acc].map((b, i) => ({ binding: i, resource: { buffer: b } })),
        }));
        pass.dispatchWorkgroups(Math.ceil(this.w / 16), Math.ceil(this.h / 16));
        pass.end();
        q.submit([enc.finish()]);
        await q.onSubmittedWorkDone();
    }

    _warpCpu(rgba, M, off, weight) {
        const { w, h, acc } = this;
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const sx = M[0] * x + M[1] * y + M[2], sy = M[3] * x + M[4] * y + M[5];
                if (sx < 0 || sy < 0 || sx > w - 1 || sy > h - 1) continue;
                const x0 = Math.min(Math.floor(sx), w - 2), y0 = Math.min(Math.floor(sy), h - 2);
                const fx = sx - x0, fy = sy - y0;
                const i00 = (y0 * w + x0) * 4, i10 = i00 + 4, i01 = i00 + 4 * w, i11 = i01 + 4;
                const o = (y * w + x) * 4;
                for (let c = 0; c < 3; c++) {
                    const top = rgba[i00 + c] + (rgba[i10 + c] - rgba[i00 + c]) * fx;
                    const bot = rgba[i01 + c] + (rgba[i11 + c] - rgba[i01 + c]) * fx;
                    acc[o + c] += weight * (top + (bot - top) * fy - off[c]);
                }
                acc[o + 3] += weight;
            }
        }
    }

    /**
     * Stack courant normalisé (moyenne par pixel), RGBA float32 ; alpha =
     * fraction d'images ayant couvert le pixel (0 = jamais couvert).
     */
    async snapshot() {
        const n = this.w * this.h;
        let acc;
        if (this.gpu) {
            const g = this.gpu;
            const enc = g.device.createCommandEncoder();
            enc.copyBufferToBuffer(g.acc, 0, g.rb, 0, n * 16);
            g.device.queue.submit([enc.finish()]);
            await g.rb.mapAsync(GPUMapMode.READ);
            acc = new Float32Array(g.rb.getMappedRange().slice(0));
            g.rb.unmap();
        } else {
            acc = this.acc;
        }
        const out = new Float32Array(n * 4);
        const total = Math.max(1, this.count);
        for (let i = 0; i < n; i++) {
            const wgt = acc[4 * i + 3];
            if (wgt > 0) {
                out[4 * i] = acc[4 * i] / wgt;
                out[4 * i + 1] = acc[4 * i + 1] / wgt;
                out[4 * i + 2] = acc[4 * i + 2] / wgt;
            }
            out[4 * i + 3] = wgt / total;
        }
        return { data: out, width: this.w, height: this.h, count: this.count };
    }

    destroy() {
        if (this.gpu) {
            for (const k of ['params', 'src', 'acc', 'rb']) this.gpu[k]?.destroy();
            this.gpu.detector.destroyBuffers();
            this.gpu = null;
        }
        this.acc = null;
    }
}
