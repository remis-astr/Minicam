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

// ── Variance du Laplacien (sharpness) ──────────────────────────────────────
function sharpnessAndGray(rgba, w, h) {
    const n = w * h;
    const gray = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        gray[i] = 0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2];
    }

    let sum = 0, sq = 0, cnt = 0;
    for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
            const lap = -gray[(y - 1) * w + x] - gray[y * w + x - 1]
                      + 4 * gray[y * w + x]
                      - gray[y * w + x + 1] - gray[(y + 1) * w + x];
            sum += lap;
            sq  += lap * lap;
            cnt++;
        }
    }
    const mean = sum / cnt;
    const sharpness = Math.sqrt(Math.max(0, sq / cnt - mean * mean));

    const gray8 = new Uint8Array(n);
    for (let i = 0; i < n; i++) gray8[i] = gray[i] * 255 + 0.5;
    return { sharpness, gray8 };
}

// ── Décodage JPEG/PNG (déjà débayerisé côté ISP) ───────────────────────────
// Retourne { sharpness, float32Buffer, packedGrayBuffer, width, height },
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

    const { sharpness, gray8 } = sharpnessAndGray(rgba, cropW, cropH);
    return { sharpness, float32Buffer: rgba.buffer, packedGrayBuffer: gray8.buffer, width: cropW, height: cropH };
}

// Pixels RGBA 8 bits déjà en mémoire (ex. SER RGB rejoué) : pas d'aller-retour
// PNG, même sortie que analyzeImageBytes (plein champ, pas de recadrage).
function analyzeRgba8(rgba8, w, h) {
    const n    = w * h;
    const rgba = new Float32Array(n * 4);
    const inv  = 1 / 255;
    for (let i = 0; i < n * 4; i++) rgba[i] = rgba8[i] * inv;
    const { sharpness, gray8 } = sharpnessAndGray(rgba, w, h);
    return { sharpness, float32Buffer: rgba.buffer, packedGrayBuffer: gray8.buffer, width: w, height: h };
}

// ── Message handler ─────────────────────────────────────────────────────────
self.onmessage = ({ data }) => {
    if (!data) return;

    if (data.type === 'init') {
        initialized = true;
        self.postMessage({ type: 'ready' });
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
            const { sharpness, gray8 } = sharpnessAndGray(rgba, cropW, cropH);

            const float32Buffer    = rgba.buffer;
            const packedGrayBuffer = gray8.buffer;
            results.push({ sharpness, float32Buffer, packedGrayBuffer, width: cropW, height: cropH });
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
