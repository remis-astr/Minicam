// cpu_stacking_worker.js — fallback CPU pour webgpu_stacking_worker.js
// Même protocole de messages, accumulateur Float32 pur JavaScript.
// Supporte : init, init-stacking, match-templates-batch, stack-frame-batch-rgba,
//            get-stack-snapshot, cleanup ; + mode étoiles (dso_worker_handler.js).
'use strict';

import { handleDsoMessage } from './dso_worker_handler.js';

console.log('[cpu_stack] worker loaded');

let outW = 0, outH = 0;
let accumR = null, accumG = null, accumB = null, accumW = null;
let initialized = false, stackingReady = false;

// ── Sous-échantillonnage par facteur N (point sampling) ──────────────────────
function downsampleN(gray, w, h, n) {
    const dw = Math.floor(w / n), dh = Math.floor(h / n);
    const out = new Float32Array(dw * dh);
    for (let y = 0; y < dh; y++)
        for (let x = 0; x < dw; x++)
            out[y * dw + x] = gray[y * n * w + x * n];
    return { data: out, w: dw, h: dh };
}

// ── Estimation de la translation globale par SSD ─────────────────────────────
// Gabarit centré sur l'objet (barycentre des pixels > 25 % du max de la
// référence) — et non au centre de l'image : une planète décentrée laissait
// un gabarit de ciel noir, donc des décalages aléatoires.
// 1) recherche grossière sur images sous-échantillonnées (×2 si searchRadius
//    ≤ 48, ×4 au-delà), 2) affinage ±ds px en pleine résolution.
// offset : décalage prédit { dx, dy } (image − référence, convention de
// searchOffset côté GPU), la recherche est centrée dessus — une dérive plus
// grande que searchRadius reste trouvée.
// Retourne { dx, dy } en pixels PLEINE résolution (référence − image).
// Perf indicative (640×480, gabarit 64×64 sous-échantillonné) :
//   ×2, sr=16  →  33×33 × 4096 ≈ 4 M ops  → ~20 ms
//   ×4, sr=32  →  65×65 × 1024 ≈ 4 M ops  → ~20 ms   (searchRadius=128)
//   ×4, sr=64  → 129×129 × 1024 ≈ 17 M ops → ~80 ms   (searchRadius=256)
function objectCenter(gray, w, h) {
    let max = 0;
    for (let i = 0; i < gray.length; i++) if (gray[i] > max) max = gray[i];
    const thr = max * 0.25;
    let sx = 0, sy = 0, sw = 0;
    for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
            const v = gray[y * w + x];
            if (v > thr) { sx += x * v; sy += y * v; sw += v; }
        }
    return sw > 0 ? { cx: sx / sw, cy: sy / sw } : { cx: w / 2, cy: h / 2 };
}

// SSD du gabarit (tx0, ty0, ts×ts) de ref dans frm décalé de (dx, dy), pixels
// hors image pénalisés.
function ssdAt(ref, frm, w, h, tx0, ty0, ts, dx, dy) {
    let ssd = 0;
    for (let ty = 0; ty < ts; ty++) {
        const ry = ty0 + ty, fy = ry + dy;
        if (fy < 0 || fy >= h) { ssd += ts * 65025; continue; }
        for (let tx = 0; tx < ts; tx++) {
            const rx = tx0 + tx, fx = rx + dx;
            if (fx < 0 || fx >= w) { ssd += 65025; continue; }
            const d = ref[ry * w + rx] - frm[fy * w + fx];
            ssd += d * d;
        }
    }
    return ssd;
}

function bestShift(ref, frm, w, h, tx0, ty0, ts, x0, x1, y0, y1) {
    let bestSSD = Infinity, bestDx = 0, bestDy = 0;
    for (let dy = y0; dy <= y1; dy++)
        for (let dx = x0; dx <= x1; dx++) {
            const ssd = ssdAt(ref, frm, w, h, tx0, ty0, ts, dx, dy);
            if (ssd < bestSSD) { bestSSD = ssd; bestDx = dx; bestDy = dy; }
        }
    return { dx: bestDx, dy: bestDy };
}

function estimateShift(refGray, frmGray, w, h, searchRadius, offset = null) {
    const ds  = searchRadius > 48 ? 4 : 2;
    const ref = downsampleN(refGray, w, h, ds);
    const frm = downsampleN(frmGray, w, h, ds);
    const dw = ref.w, dh = ref.h;

    const ts  = Math.min(64, (dw >> 1), (dh >> 1));
    const { cx, cy } = objectCenter(ref.data, dw, dh);
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    const tx0 = clamp(Math.round(cx - ts / 2), 0, dw - ts);
    const ty0 = clamp(Math.round(cy - ts / 2), 0, dh - ts);
    const sr  = Math.max(1, Math.ceil(searchRadius / ds));

    const ox = Math.round((offset?.dx ?? 0) / ds), oy = Math.round((offset?.dy ?? 0) / ds);
    const c = bestShift(ref.data, frm.data, dw, dh, tx0, ty0, ts, ox - sr, ox + sr, oy - sr, oy + sr);

    // Affinage pleine résolution autour de la solution grossière
    const fts = Math.min(ts * ds, 128);
    const ftx = clamp(Math.round(cx * ds - fts / 2), 0, w - fts);
    const fty = clamp(Math.round(cy * ds - fts / 2), 0, h - fts);
    const gx = c.dx * ds, gy = c.dy * ds;
    const f = bestShift(refGray, frmGray, w, h, ftx, fty, fts, gx - ds, gx + ds, gy - ds, gy + ds);
    // Convention de l'empilement ci-dessous (pixel source à x − dx) : dx =
    // position dans la référence − position dans l'image. La recherche donne
    // l'inverse ; sans cette négation le décalage était doublé au lieu d'être
    // annulé (écart RMS 56,8 contre 2,6, mesuré sur un SER de Jupiter).
    return { dx: -f.dx, dy: -f.dy };
}

self.onmessage = async ({ data }) => {
    if (!data) return;
    const { type } = data;

    // Live Stack ciel profond : alignement sur les étoiles (repli CPU)
    if (await handleDsoMessage(data, { forceCpu: true })) return;

    // ── init ──────────────────────────────────────────────────────────────
    if (type === 'init') {
        initialized = true;
        self.postMessage({ type: 'ready' });
        return;
    }

    // ── init-stacking ─────────────────────────────────────────────────────
    if (type === 'init-stacking') {
        const { width, height } = data;
        outW = width;
        outH = height;
        accumR = new Float32Array(outW * outH);
        accumG = new Float32Array(outW * outH);
        accumB = new Float32Array(outW * outH);
        accumW = new Float32Array(outW * outH);
        stackingReady = true;
        self.postMessage({ type: 'init-stacking-done', outWidth: outW, outHeight: outH });
        return;
    }

    // ── match-templates-batch — translation globale via SSD sous-échantillonné ──
    if (type === 'match-templates-batch') {
        const { requestId, refGrayData, frameGrayDatas = [],
                width, height, alignmentPoints = [], searchRadius = 8, searchOffset = null } = data;

        const refGray = refGrayData instanceof Uint8Array ? refGrayData
                      : new Uint8Array(refGrayData instanceof ArrayBuffer ? refGrayData : refGrayData.buffer);

        const allShifts = frameGrayDatas.map(fgd => {
            const frmGray = fgd instanceof Uint8Array ? fgd
                          : new Uint8Array(fgd instanceof ArrayBuffer ? fgd : fgd.buffer);
            const { dx, dy } = estimateShift(refGray, frmGray, width, height, searchRadius, searchOffset);
            return alignmentPoints.map(() => ({ dx, dy, quality: 1 }));
        });

        self.postMessage({ type: 'batch-result', requestId, allShifts });
        return;
    }

    // ── stack-frame-batch-rgba ────────────────────────────────────────────
    if (type === 'stack-frame-batch-rgba') {
        if (!stackingReady) {
            self.postMessage({ type: 'stack-frame-error', error: 'Stacking not initialized' });
            return;
        }
        const { frames = [], shifts = [], frameWeights = [] } = data;
        let count = 0;
        for (let fi = 0; fi < frames.length; fi++) {
            const { rgbaBuffer } = frames[fi];
            const weight = frameWeights[fi] ?? 1.0;
            const rgba = rgbaBuffer instanceof Float32Array ? rgbaBuffer
                       : new Float32Array(rgbaBuffer instanceof ArrayBuffer ? rgbaBuffer : rgbaBuffer.buffer);

            // Calcul du shift global (médiane des AP shifts)
            const frameShifts = shifts[fi] ?? [];
            let dx = 0, dy = 0;
            if (frameShifts.length > 0) {
                const dxs = frameShifts.map(s => s.dx ?? 0).sort((a, b) => a - b);
                const dys = frameShifts.map(s => s.dy ?? 0).sort((a, b) => a - b);
                const mid = frameShifts.length >> 1;
                dx = dxs[mid] | 0;
                dy = dys[mid] | 0;
            }

            if (dx === 0 && dy === 0) {
                // Chemin rapide sans translation
                const pixels = outW * outH;
                for (let i = 0; i < pixels; i++) {
                    accumR[i] += rgba[i * 4]     * weight;
                    accumG[i] += rgba[i * 4 + 1] * weight;
                    accumB[i] += rgba[i * 4 + 2] * weight;
                    accumW[i] += weight;
                }
            } else {
                // Translation entière : pixel source à (x-dx, y-dy)
                for (let y = 0; y < outH; y++) {
                    const sy = y - dy;
                    if (sy < 0 || sy >= outH) continue;
                    for (let x = 0; x < outW; x++) {
                        const sx = x - dx;
                        if (sx < 0 || sx >= outW) continue;
                        const si = (sy * outW + sx) * 4;
                        const di = y * outW + x;
                        accumR[di] += rgba[si]     * weight;
                        accumG[di] += rgba[si + 1] * weight;
                        accumB[di] += rgba[si + 2] * weight;
                        accumW[di] += weight;
                    }
                }
            }
            count++;
        }
        self.postMessage({ type: 'stack-batch-done', count });
        return;
    }

    // ── get-stack-snapshot ────────────────────────────────────────────────
    if (type === 'get-stack-snapshot') {
        if (!stackingReady) {
            self.postMessage({ type: 'finalize-error', error: 'Stacking not initialized' });
            return;
        }
        const pixels = outW * outH;
        const float32Data = new Float32Array(pixels * 4);
        for (let i = 0; i < pixels; i++) {
            const w = accumW[i];
            if (w > 0) {
                float32Data[i * 4]     = accumR[i] / w;
                float32Data[i * 4 + 1] = accumG[i] / w;
                float32Data[i * 4 + 2] = accumB[i] / w;
            }
            float32Data[i * 4 + 3] = 1.0;
        }
        self.postMessage({
            type: 'stack-snapshot-complete',
            float32Buffer: float32Data.buffer,
            width:  outW,
            height: outH,
        }, [float32Data.buffer]);
        return;
    }

    // ── cleanup ───────────────────────────────────────────────────────────
    if (type === 'cleanup') {
        accumR = accumG = accumB = accumW = null;
        stackingReady = false;
        self.postMessage({ type: 'cleanup-done' });
    }
};
