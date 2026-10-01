'use strict';
/**
 * FitsFileSource — rejoue une série de fichiers FITS locaux à la place du
 * flux /ws/raw (même interface que DngFileSource / WsFrameReceiver).
 *
 * Pris en charge (HDU principal) :
 *   - BITPIX 8, 16, 32 (entiers, BZERO/BSCALE) et -32, -64 (flottants) ;
 *   - brut Bayer (NAXIS = 2 + BAYERPAT, décalé par XBAYROFF/YBAYROFF),
 *     mono (NAXIS = 2 sans BAYERPAT) ou RGB débayérisé (NAXIS3 = 3, plans R, G, B).
 * Les lignes sont prises dans l'ordre du fichier, BAYERPAT décrivant le
 * premier pixel écrit (convention des logiciels de capture et de l'export
 * FITS de la Multicam).
 *
 * Échelle : le moteur travaille en 16 bits. Profondeur des données : mot-clé
 * BITDEPTH (export de la Multicam), sinon la plus grande profondeur plausible
 * d'après le maximum du premier fichier — 12 bits jusqu'à 4095 (fichiers
 * natifs de la Multicam, conversions Siril), 14 bits jusqu'à 16383, sinon 16
 * (logiciels qui décalent sur 16 bits) : surestimer n'écrête jamais, une
 * image sombre ne fait pas croire à 9 bits. Gardée pour toute la série.
 * Flottants normalisés (max ≤ 1) : × 65535.
 *
 * Niveau de noir, dans l'ordre : mot-clé BLKLEVEL (ou PEDESTAL), en unités
 * du fichier ; sinon valeur connue du capteur INSTRUME : la plus grande des
 * formes possibles (16 bits décalés, 12 ou 10 bits natifs) qui reste sous
 * le fond mesuré (≤ 1,3 × 0,5e centile du premier fichier : marge du bruit
 * de lecture) ; sinon 0.
 */

import { naturalSort } from './dng_file_source.js';

// rpi.black_level des fichiers de réglage libcamera (16 bits) / 16 → 12 bits natifs
const SENSOR_BLACK_12 = {
    IMX290: 240, IMX327: 240, IMX462: 240, IMX477: 256, IMX585: 200, IMX662: 200, IMX678: 200,
};

const BLOCK = 2880;

function parseValue(raw) {
    const v = raw.split('/')[0].trim();
    if (raw.trimStart().startsWith("'")) {
        const m = raw.match(/'((?:[^']|'')*)'/);
        return m ? m[1].replace(/''/g, "'").trimEnd() : '';
    }
    if (v === 'T') return true;
    if (v === 'F') return false;
    const num = Number(v.replace(/D/i, 'E'));
    return Number.isFinite(num) ? num : v;
}

/** En-tête du HDU principal : { cards: {MOT: valeur}, dataOffset }. */
export async function readFitsHeader(file) {
    const cards = {};
    for (let off = 0; off < file.size; off += BLOCK) {
        const txt = new TextDecoder('latin1').decode(await file.slice(off, off + BLOCK).arrayBuffer());
        if (off === 0 && !txt.startsWith('SIMPLE  =')) throw new Error(`${file.name} : pas un fichier FITS`);
        for (let i = 0; i < BLOCK; i += 80) {
            const card = txt.slice(i, i + 80);
            const key = card.slice(0, 8).trim();
            if (key === 'END') return { cards, dataOffset: off + BLOCK };
            if (card[8] === '=' && key && !(key in cards)) cards[key] = parseValue(card.slice(10));
        }
    }
    throw new Error(`${file.name} : en-tête FITS sans END`);
}

/** Décale un motif Bayer de (dx, dy) pixels. */
function shiftBayer(pattern, dx, dy) {
    const p = pattern.toUpperCase(), out = [];
    for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++)
        out.push(p[((y + dy) & 1) * 2 + ((x + dx) & 1)]);
    return out.join('');
}

/** Description d'un fichier FITS utile au pipeline. */
export async function describeFits(file) {
    const { cards, dataOffset } = await readFitsHeader(file);
    const bitpix = cards.BITPIX, naxis = cards.NAXIS;
    const width = cards.NAXIS1, height = cards.NAXIS2, depth = naxis >= 3 ? cards.NAXIS3 : 1;
    if (![8, 16, 32, -32, -64].includes(bitpix)) throw new Error(`${file.name} : BITPIX ${bitpix} non pris en charge`);
    if (!(naxis === 2 || (naxis === 3 && (depth === 3 || depth === 1))))
        throw new Error(`${file.name} : ${naxis} axes (${width}×${height}×${depth}) non pris en charge`);
    let layout, bayer = null;
    if (depth === 3) layout = 'rgb';
    else if (typeof cards.BAYERPAT === 'string' && /^[RGB]{4}$/i.test(cards.BAYERPAT.trim())) {
        layout = 'bayer';
        bayer = shiftBayer(cards.BAYERPAT.trim(), cards.XBAYROFF | 0, cards.YBAYROFF | 0);
    } else layout = 'mono';
    if (layout === 'bayer' && (width % 2 || height % 2)) throw new Error(`${file.name} : Bayer de dimensions impaires`);
    return {
        width, height, layout, bayer, bitpix, dataOffset,
        bzero: cards.BZERO ?? 0, bscale: cards.BSCALE ?? 1, planes: depth,
        exposureMs: 1000 * (cards.EXPTIME ?? cards.EXPOSURE ?? 0),
        gain: cards.GAIN ?? 0,
        instrument: typeof cards.INSTRUME === 'string' ? cards.INSTRUME.trim().toUpperCase() : '',
        blackKey: cards.BLKLEVEL ?? cards.PEDESTAL ?? null,
        bitDepth: Number.isInteger(cards.BITDEPTH) && cards.BITDEPTH >= 1 && cards.BITDEPTH <= 16 ? cards.BITDEPTH : null,
    };
}

/** Valeurs physiques (BSCALE·v + BZERO) en Float32Array, plans consécutifs. */
export async function readFitsData(file, d) {
    const n = d.width * d.height * d.planes;
    const bpp = Math.abs(d.bitpix) / 8;
    const buf = await file.slice(d.dataOffset, d.dataOffset + n * bpp).arrayBuffer();
    if (buf.byteLength < n * bpp) throw new Error(`${file.name} : données incomplètes`);
    const dv = new DataView(buf), out = new Float32Array(n);
    const { bzero, bscale } = d;
    switch (d.bitpix) {
    case 8:   for (let i = 0; i < n; i++) out[i] = dv.getUint8(i) * bscale + bzero; break;
    case 16:  for (let i = 0; i < n; i++) out[i] = dv.getInt16(2 * i) * bscale + bzero; break;
    case 32:  for (let i = 0; i < n; i++) out[i] = dv.getInt32(4 * i) * bscale + bzero; break;
    case -32: for (let i = 0; i < n; i++) out[i] = dv.getFloat32(4 * i) * bscale + bzero; break;
    case -64: for (let i = 0; i < n; i++) out[i] = dv.getFloat64(8 * i) * bscale + bzero; break;
    }
    return out;
}

/**
 * Échelle vers 16 bits et niveau de noir (unités du fichier), déduits du
 * premier fichier de la série.
 */
export function fitsScale(d, data) {
    let max = 0;
    const sample = [];
    for (let i = 0; i < data.length; i += 7) {
        if (data[i] > max) max = data[i];
        if (sample.length < 200000) sample.push(data[i]);
    }
    sample.sort((a, b) => a - b);
    const p05 = sample[Math.floor(0.005 * sample.length)] ?? 0;
    const isFloat = d.bitpix < 0;
    let scale, bits;
    if (isFloat && max <= 1.0001) { scale = 65535; bits = 0; }
    else {
        bits = d.bitDepth ?? (max <= 4095 ? 12 : max <= 16383 ? 14 : 16);
        scale = 2 ** (16 - bits);
    }
    let black = 0, blackSrc = 'aucun';
    if (d.blackKey != null) { black = d.blackKey; blackSrc = 'en-tête'; }
    else if (SENSOR_BLACK_12[d.instrument] != null && !isFloat) {
        // capteur connu : le noir ne peut pas dépasser le fond mesuré, à la
        // marge du bruit de lecture près (le 0,5e centile tombe sous le noir)
        const b12 = SENSOR_BLACK_12[d.instrument];
        const cand = [b12 * 16, b12, b12 / 4].filter((b) => b <= 1.3 * p05);
        if (cand.length) { black = cand[0]; blackSrc = `capteur ${d.instrument}`; }
    }
    return { scale, bits, black, blackSrc };
}

export class FitsFileSource {
    /**
     * @param {File[]|FileList} files
     * @param {object} [opts] { onProgress, onEnd, onSkip }
     */
    constructor(files, { onProgress, onEnd, onSkip } = {}) {
        this._files      = naturalSort(files);
        this._onFrame    = null;
        this._onProgress = onProgress ?? null;
        this._onEnd      = onEnd ?? null;
        this._onSkip     = onSkip ?? null;
        this._processing = false;
        this._idleWaiter = null;
        this._stopped    = false;
        this._framesSent = 0;
        this._header     = null;
        this._scale      = null;
        this.timings     = { read: [], process: [] };
    }

    // --- interface WsFrameReceiver ----------------------------------------
    set onFrame(cb) { this._onFrame = cb; }
    get framesReceived() { return this._framesSent; }
    get droppedFrames()  { return 0; }
    get header()         { return this._header; }
    get fileCount()      { return this._files.length; }

    setProcessing(busy) {
        this._processing = busy;
        if (!busy && this._idleWaiter) { this._idleWaiter(); this._idleWaiter = null; }
    }
    flush() {}
    setRate() {}
    setRoi() {}
    setBitDepth() {}
    setFormat() {}
    setCompression() {}
    setFlowControl() {}

    async start() {
        this._stopped = false;
        if (!this._files.length) throw new Error('Aucun fichier FITS');
        const d = await describeFits(this._files[0]);
        this._scale = fitsScale(d, await readFitsData(this._files[0], d));
        this._header = { ...d, ...this._scale };
        if (this._scale.blackSrc === 'aucun')
            console.warn('[FITS] niveau de noir inconnu (ni BLKLEVEL ni capteur reconnu) : 0 utilisé');
        this._run();
    }

    stop() {
        this._stopped = true;
        this.setProcessing(false);
    }

    async _run() {
        const t = this.timings, t0 = performance.now(), n = this._files.length;
        let next = this._prepare(0);
        for (let i = 0; i < n && !this._stopped; i++) {
            const frame = await next;
            if (this._stopped) break;
            next = i + 1 < n ? this._prepare(i + 1) : null;
            this._onProgress?.(i + 1, n);
            if (!frame) continue;
            const tp = performance.now();
            this._framesSent++;
            this._onFrame?.(frame[0], frame[1]);
            if (this._processing) await new Promise((r) => { this._idleWaiter = r; });
            t.process.push(performance.now() - tp);
        }
        if (this._stopped) return;
        const stat = (a) => a.length
            ? `moy ${(a.reduce((x, y) => x + y, 0) / a.length).toFixed(0)} / max ${Math.max(...a).toFixed(0)} ms` : '—';
        console.log(`[FITS] ${t.process.length}/${n} images en ${((performance.now() - t0) / 1000).toFixed(1)} s — `
            + `lecture ${stat(t.read)}, traitement ${stat(t.process)}`);
        this._onEnd?.();
    }

    async _prepare(i) {
        const file = this._files[i], t = performance.now();
        try {
            const d = await describeFits(file), ref = this._header;
            if (d.width !== ref.width || d.height !== ref.height || d.layout !== ref.layout || d.bayer !== ref.bayer)
                throw new Error(`${d.width}×${d.height} ${d.layout} ${d.bayer ?? ''} ≠ ${ref.width}×${ref.height} ${ref.layout} ${ref.bayer ?? ''} du 1er fichier`);
            const data = await readFitsData(file, d);
            const { scale, black } = this._scale;
            const px = new Uint16Array(data.length);
            for (let k = 0; k < data.length; k++) {
                const v = data[k] * scale;
                px[k] = v <= 0 ? 0 : v >= 65535 ? 65535 : Math.round(v);
            }
            this.timings.read.push(performance.now() - t);
            const format = d.layout === 'rgb' ? 'rgb16' : d.layout === 'mono' ? 'mono16' : 'raw';
            return [px, {
                width: d.width, height: d.height, format, bit_depth: 16,
                ...(d.bayer ? { bayer: d.bayer } : {}),
                gain: d.gain, exposure_ms: d.exposureMs, exposure_us: Math.round(d.exposureMs * 1000),
                black_level: (d.blackKey ?? black) * scale,
                ts: (file.lastModified ?? Date.now()) / 1000, file: file.name,
            }];
        } catch (err) {
            console.warn(`[FITS] ${file.name} ignoré : ${err.message}`);
            this._onSkip?.(file, err);
            return null;
        }
    }
}
