'use strict';

import { WsFrameReceiver } from './ws_frame_receiver.js';

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
// Preview stretch : percentiles sur échantillon 1/16, LUT arcsinh, rendu canvas
// ---------------------------------------------------------------------------

function stretchToCanvas(float32Buf, w, h, canvas, low, high, beta = 0, awbGains = null) {
    const rgba = new Float32Array(float32Buf);
    const n    = w * h;
    const [gR, gG, gB] = awbGains ?? [1, 1, 1];

    // Percentiles de luminance (échantillon 1/16 pour rapidité) — calculés
    // sur la luminance AVANT balance des blancs : les gains R/B restent
    // proches de 1 en pratique, donc la plage de stretch n'a pas besoin
    // d'être recalculée après application des gains.
    const samples = [];
    for (let i = 0; i < n; i += 16) {
        const lum = 0.299 * rgba[i*4] + 0.587 * rgba[i*4+1] + 0.114 * rgba[i*4+2];
        if (lum > 0) samples.push(lum);
    }
    if (!samples.length) return;
    samples.sort((a, b) => a - b);
    const lo  = samples[Math.max(0, Math.floor(low  * samples.length))];
    const hi  = samples[Math.min(samples.length - 1, Math.floor(high * samples.length))];
    const rng = Math.max(hi - lo, 1e-7);

    // LUT 4096 entrées : [lo, hi] → [0, 255] via arcsinh(β·x)/arcsinh(β)
    // β=0 → stretch linéaire (compatible ascendant)
    const LUT    = 4096;
    const lut    = new Uint8Array(LUT);
    const abeta  = beta > 0 ? Math.asinh(beta) : 1;
    for (let i = 0; i < LUT; i++) {
        const norm = i / (LUT - 1);                                    // [0, 1]
        const s    = beta > 0 ? Math.asinh(beta * norm) / abeta : norm;
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
    canvas.getContext('2d').putImageData(idata, 0, 0);
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
        this._alignMode        = options.alignMode ?? (mode === 'lucky' ? 'on' : 'on');
        this._searchRadius     = options.searchRadius ?? 32;
        this._targetFps        = options.fps ?? null;
        this._initialRoi       = options.roi ?? null;
        this._initialBitDepth  = options.bitDepth ?? null;
        this._initialFormat    = options.format ?? 'raw';
        this._stretchLow       = options.stretchLow  ?? 0.001;
        this._stretchHigh      = options.stretchHigh ?? 0.999;
        this._stretchBeta      = options.stretchBeta ?? 0;
        this._previewEveryN    = options.previewEveryN ?? 1;
        this._awbEnabled       = options.awb ?? false;

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
        this._searchRadius    = 0;
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

        // Détection WebGPU : essayer adapter natif puis fallback SwiftShader
        let gpuOk = false;
        if (typeof navigator !== 'undefined' && navigator.gpu) {
            try {
                const a = await navigator.gpu.requestAdapter()
                       ?? await navigator.gpu.requestAdapter({ forceFallbackAdapter: true });
                gpuOk = !!a;
            } catch { gpuOk = false; }
        }
        this._gpuOk = gpuOk;

        // Analyse toujours en CPU (plein champ 1920×1080 — GPU analyze worker est square-only).
        // Accumulation en GPU si disponible (worker Eise supporte dimensions rectangulaires).
        const base = new URL('.', import.meta.url).href;
        const analyzeFile = 'cpu_analyze_worker.js';
        const stackFile   = gpuOk ? 'webgpu_stacking_worker.js' : 'cpu_stacking_worker.js';
        console.log(`[Stacker] GPU=${gpuOk} → ${analyzeFile} + ${stackFile}`);
        this._analyzeWorker = new Worker(`${base}${analyzeFile}`, { type: 'module' });
        this._stackWorker   = new Worker(`${base}${stackFile}`,   { type: 'module' });

        await Promise.all([
            this._workerInit(this._analyzeWorker, 'analyze'),
            this._workerInit(this._stackWorker,   'stack'),
        ]);

        this._receiver = new WsFrameReceiver(wsUrl);
        this._receiver.onFrame = (pixels, meta) => this._onFrame(pixels, meta);
        await this._receiver.start(this._targetFps, this._initialRoi, this._initialBitDepth, this._initialFormat);
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
    }

    setStretchBeta(beta) { this._stretchBeta = beta; }

    setAWB(enabled) { this._awbEnabled = enabled; }

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
        this._processFrame(pixels, meta)
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
        const cropSize     = srcW;
        const bayerPattern = BAYER_INT[bayer] ?? 0;
        const frameIdx     = this._frameIndex++;

        // 1. Analyze — Bayer (debayer + score Laplacian) ou image déjà
        // débayerisée par l'ISP (JPEG/PNG, décodage navigateur + score).
        let analyzed;
        if (format === 'jpeg' || format === 'png') {
            const imgCopy = pixels.buffer.slice(pixels.byteOffset, pixels.byteOffset + pixels.byteLength);
            analyzed = await this._analyzeImage(new Uint8Array(imgCopy), format, cropSize, frameIdx);
        } else {
            const pixelCopy = pixels.buffer.slice(pixels.byteOffset, pixels.byteOffset + pixels.byteLength);
            const rawPixels = bitDepth === 8 ? new Uint8Array(pixelCopy) : new Uint16Array(pixelCopy);
            analyzed = await this._analyze(
                rawPixels, srcW, srcH, cropSize, bayerPattern, frameIdx, bitDepth
            );
        }
        if (!analyzed) return;

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
        if (!accepted) {
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
        } else {
            // 4. Alignement (optionnel) puis accumulation
            let shifts;
            if (this._alignMode !== 'none') {
                shifts = await this._matchTemplates(packedGrayBuffer, this._cropW, this._cropH);
            } else {
                shifts = this._alignmentPoints.map(() => ({ dx: 0, dy: 0, quality: 1 }));
            }
            await this._stackFrame(float32Buffer, shifts, sharpness);
        }

        // 5. Compteurs
        this._stackedCount++;
        this._totalExpMs += exposure_ms ?? 0;
        this._gainSum    += gain ?? 0;

        // 6. Preview
        if (this._canvas && this._stackedCount % this._previewEveryN === 0)
            await this._updatePreview();
    }

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
    _analyzeImage(bytes, format, cropSize, requestId) {
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
                mimeType: format === 'png' ? 'image/png' : 'image/jpeg',
                cropSize,
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
    _stackFrame(float32Buffer, shifts, sharpness) {
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
                frameWeights: [1.0],
            }, [rgba.buffer]);   // transfert zéro copie
        });
    }

    // Lit le stack courant depuis le GPU, étire et dessine sur le canvas
    async _updatePreview() {
        const snap = await new Promise((resolve) => {
            const handler = ({ data }) => {
                if (!data) return;
                if (data.type === 'stack-snapshot-complete' || data.type === 'snapshot-error') {
                    this._stackWorker.removeEventListener('message', handler);
                    resolve(data.type === 'stack-snapshot-complete' ? data : null);
                }
            };
            this._stackWorker.addEventListener('message', handler);
            this._stackWorker.postMessage({ type: 'get-stack-snapshot' });
        });
        if (!snap?.float32Buffer) return;

        const awbGains = this._awbEnabled
            ? computeAWBGains(snap.float32Buffer, snap.width, snap.height)
            : null;
        stretchToCanvas(snap.float32Buffer, snap.width, snap.height,
                        this._canvas, this._stretchLow, this._stretchHigh, this._stretchBeta, awbGains);
        this.dispatchEvent(new CustomEvent('preview'));
    }
}
