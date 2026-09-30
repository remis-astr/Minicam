'use strict';
/**
 * SerFileSource — rejoue un fichier SER local à la place du flux /ws/raw.
 *
 * Même interface que WsFrameReceiver (onFrame, setProcessing, flush, stop…),
 * passée à StreamingStacker.start() : tout le pipeline Lucky/Live Stack
 * (analyse, sélection, alignement, empilement) tourne comme en direct, mais
 * sur des images lues dans le navigateur — rien n'est envoyé au Pi.
 *
 * Les images sont servies une par une, dès que le stacker a fini la
 * précédente (pas de perte, pas de cadence imposée) ; la suivante est lue et
 * convertie pendant que le stacker traite la courante. Durées par étape dans
 * `timings`, résumé dans la console en fin de fichier.
 *
 *   ColorID SER 0 (mono)       → RGBA niveaux de gris  (format 'rgba')
 *   ColorID 8–11 (Bayer)       → RAW, motif Bayer      (format 'raw')
 *   ColorID 100/101 (RGB/BGR)  → RGBA couleur          (format 'rgba')
 *
 * Les SER 16 bits mono/RGB sont ramenés à 8 bits (chemin RGBA 8 bits) ;
 * les SER Bayer 16 bits restent en 16 bits (chemin RAW).
 */

const HEADER_SIZE = 178;
const BAYER_BY_COLOR_ID = { 8: 'RGGB', 9: 'GRBG', 10: 'GBRG', 11: 'BGGR' };

export async function readSerHeader(file) {
    const buf = await file.slice(0, HEADER_SIZE).arrayBuffer();
    const dv  = new DataView(buf);
    const fileId = new TextDecoder().decode(new Uint8Array(buf, 0, 14));
    if (!fileId.startsWith('LUCAM-REC')) throw new Error('Pas un fichier SER (en-tête LUCAM-RECORDER absent)');
    const colorId  = dv.getInt32(18, true);
    const width    = dv.getInt32(26, true);
    const height   = dv.getInt32(30, true);
    const depth    = dv.getInt32(34, true);
    const frames   = dv.getInt32(38, true);
    const planes   = colorId >= 100 ? 3 : 1;
    const bytesPx  = depth > 8 ? 2 : 1;
    const frameSize = width * height * planes * bytesPx;
    if (!(width > 0 && height > 0 && frames > 0))
        throw new Error(`En-tête SER invalide (${width}×${height}, ${frames} images)`);
    if (colorId !== 0 && colorId !== 100 && colorId !== 101 && !(colorId in BAYER_BY_COLOR_ID))
        throw new Error(`Type de couleur SER ${colorId} non pris en charge`);
    const available = Math.floor((file.size - HEADER_SIZE) / frameSize);
    return { colorId, width, height, depth, frames: Math.min(frames, available),
             planes, bytesPx, frameSize, bayer: BAYER_BY_COLOR_ID[colorId] ?? null };
}

export class SerFileSource {
    /**
     * @param {File} file
     * @param {object} [opts]
     * @param {(i:number, n:number) => void} [opts.onProgress]
     * @param {() => void} [opts.onEnd]
     */
    constructor(file, { onProgress, onEnd } = {}) {
        this._file        = file;
        this._onFrame     = null;
        this._onProgress  = onProgress ?? null;
        this._onEnd       = onEnd ?? null;
        this._processing  = false;
        this._idleWaiter  = null;
        this._stopped     = false;
        this._framesSent  = 0;
        this._header      = null;
        this.timings      = { read: [], convert: [], process: [] };
    }

    // --- interface WsFrameReceiver ----------------------------------------
    set onFrame(cb) { this._onFrame = cb; }
    get framesReceived() { return this._framesSent; }
    get droppedFrames()  { return 0; }
    get header()         { return this._header; }

    setProcessing(busy) {
        this._processing = busy;
        if (!busy && this._idleWaiter) { this._idleWaiter(); this._idleWaiter = null; }
    }
    // Réglages caméra : sans objet pour un fichier.
    flush() {}
    setRate() {}
    setRoi() {}
    setBitDepth() {}
    setFormat() {}

    async start() {
        this._stopped = false;
        this._header  = await readSerHeader(this._file);
        this._run();   // en tâche de fond, comme le flux WebSocket
    }

    stop() {
        this._stopped = true;
        this.setProcessing(false);
    }

    // --- lecture ------------------------------------------------------------
    async _run() {
        const h = this._header;
        const t = this.timings;
        const t0 = performance.now();
        let next = h.frames > 0 ? this._prepare(0) : null;
        for (let i = 0; i < h.frames && !this._stopped; i++) {
            const [pixels, meta] = await next;
            if (this._stopped) break;
            // lecture + conversion de l'image suivante pendant le traitement
            next = i + 1 < h.frames ? this._prepare(i + 1) : null;
            const tp = performance.now();
            this._framesSent++;
            this._onFrame?.(pixels, meta);
            this._onProgress?.(i + 1, h.frames);
            if (this._processing) await new Promise((r) => { this._idleWaiter = r; });
            t.process.push(performance.now() - tp);
        }
        if (this._stopped) return;
        const stat = (a) => a.length
            ? `moy ${(a.reduce((x, y) => x + y, 0) / a.length).toFixed(0)} / max ${Math.max(...a).toFixed(0)} ms`
            : '—';
        console.log(`[SER] ${t.process.length} images en ${((performance.now() - t0) / 1000).toFixed(1)} s — `
            + `lecture ${stat(t.read)}, conversion ${stat(t.convert)}, traitement ${stat(t.process)}`);
        this._onEnd?.();
    }

    async _prepare(i) {
        const h = this._header;
        const off = HEADER_SIZE + i * h.frameSize;
        let t = performance.now();
        const raw = await this._file.slice(off, off + h.frameSize).arrayBuffer();
        this.timings.read.push(performance.now() - t);
        t = performance.now();
        const frame = h.bayer ? this._bayerFrame(raw) : this._rgbaFrame(raw);
        this.timings.convert.push(performance.now() - t);
        return frame;
    }

    _baseMeta(format, extra = {}) {
        const h = this._header;
        return { width: h.width, height: h.height, gain: 0, exposure_ms: 0,
                 exposure_us: 0, format, ts: Date.now() / 1000, ...extra };
    }

    _bayerFrame(raw) {
        const h = this._header;
        const pixels = h.bytesPx === 2 ? new Uint16Array(raw) : new Uint8Array(raw);
        return [pixels, this._baseMeta('raw', { bayer: h.bayer, bit_depth: h.bytesPx === 2 ? 16 : 8 })];
    }

    _rgbaFrame(raw) {
        const h = this._header;
        const n = h.width * h.height;
        // 16 bits → 8 bits : octet de poids fort (SER : little-endian par défaut)
        const src = h.bytesPx === 2
            ? Uint8Array.from(new Uint16Array(raw), (v) => v >> 8)
            : new Uint8Array(raw);
        const rgba = new Uint8Array(n * 4);
        if (h.planes === 1) {
            for (let i = 0, j = 0; i < n; i++, j += 4) {
                rgba[j] = rgba[j + 1] = rgba[j + 2] = src[i]; rgba[j + 3] = 255;
            }
        } else {
            const [r, b] = h.colorId === 101 ? [2, 0] : [0, 2];   // 101 = BGR
            for (let i = 0, k = 0, j = 0; i < n; i++, k += 3, j += 4) {
                rgba[j] = src[k + r]; rgba[j + 1] = src[k + 1]; rgba[j + 2] = src[k + b]; rgba[j + 3] = 255;
            }
        }
        return [rgba, this._baseMeta('rgba')];
    }
}
