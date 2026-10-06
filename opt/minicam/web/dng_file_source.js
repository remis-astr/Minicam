'use strict';
/**
 * DngFileSource — rejoue une série de fichiers DNG locaux à la place du flux
 * /ws/raw (pendant de SerFileSource pour le ciel profond).
 *
 * Même interface que WsFrameReceiver (onFrame, setProcessing, flush, stop…),
 * passée à StreamingStacker.start() : tout le pipeline Live Stack tourne comme
 * en direct, sur des images lues dans le navigateur — rien n'est envoyé au Pi.
 * Les fichiers sont servis dans l'ordre naturel des noms (…_2 avant …_10),
 * un par un, dès que le stacker a fini le précédent ; le suivant est lu
 * pendant le traitement du courant.
 *
 * DNG pris en charge : image CFA (Bayer 2×2) non compressée, 8 ou 16 bits —
 * ce qu'écrivent rpicam-still / picamera2. Les pixels sont livrés en 16 bits
 * (format 'raw', bit_depth 16) tels quels, comme le flux caméra ; le niveau
 * de noir et le temps de pose du fichier sont ajoutés aux métadonnées
 * (black_level, exposure_ms).
 */

const TAG = {
    NewSubfileType: 254, ImageWidth: 256, ImageLength: 257, BitsPerSample: 258,
    Compression: 259, Photometric: 262, StripOffsets: 273, SamplesPerPixel: 277,
    StripByteCounts: 279, SubIFDs: 330, ExifIFD: 34665, CFARepeatPatternDim: 33421,
    CFAPattern: 33422, ExposureTime: 33434, ISO: 34855, BlackLevel: 50714,
    WhiteLevel: 50717,
};
const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4 };
const CFA_COLORS = 'RGB';
const PHOTOMETRIC_CFA = 32803;

/**
 * Lit toutes les IFD (chaîne principale + SubIFDs + Exif) d'un TIFF/DNG.
 * `segments` : morceaux du fichier déjà lus, [{ start, buf }] — rpicam range
 * l'IFD Exif après les pixels, en fin de fichier. Retourne aussi les
 * décalages d'IFD tombés hors des morceaux (`missing`) pour une 2e passe.
 */
function readIfds(segments) {
    const seg = (o, len) => segments.find((g) => o >= g.start && o + len <= g.start + g.buf.byteLength);
    const head = segments[0];
    const dv0 = new DataView(head.buf);
    const le = dv0.getUint16(0) === 0x4949;          // 'II' = little-endian
    if (dv0.getUint16(0) !== 0x4949 && dv0.getUint16(0) !== 0x4d4d) throw new Error('Pas un fichier TIFF/DNG');
    if (dv0.getUint16(2, le) !== 42) throw new Error('Pas un fichier TIFF/DNG');
    const views = new Map(segments.map((g) => [g, new DataView(g.buf)]));
    const at = (o, len) => {
        const g = seg(o, len);
        if (!g) throw new RangeError('hors segment');
        return [views.get(g), o - g.start];
    };
    const u16 = (o) => { const [d, r] = at(o, 2); return d.getUint16(r, le); };
    const u32 = (o) => { const [d, r] = at(o, 4); return d.getUint32(r, le); };
    const i32 = (o) => { const [d, r] = at(o, 4); return d.getInt32(r, le); };
    const f32 = (o) => { const [d, r] = at(o, 4); return d.getFloat32(r, le); };
    const f64 = (o) => { const [d, r] = at(o, 8); return d.getFloat64(r, le); };
    const u8  = (o) => { const [d, r] = at(o, 1); return d.getUint8(r); };

    const value = (type, count, off) => {
        const out = [];
        for (let i = 0; i < count; i++) {
            switch (type) {
            case 3: case 8: out.push(u16(off + 2 * i)); break;
            case 4: case 9: case 13: out.push(u32(off + 4 * i)); break;
            case 5: out.push(u32(off + 8 * i) / (u32(off + 8 * i + 4) || 1)); break;
            case 10: out.push(i32(off + 8 * i) / (i32(off + 8 * i + 4) || 1)); break;
            case 11: out.push(f32(off + 4 * i)); break;
            case 12: out.push(f64(off + 8 * i)); break;
            default: out.push(u8(off + i));
            }
        }
        return out;
    };

    const ifds = [];
    const missing = [];
    const seen = new Set();
    const walk = (off) => {
        while (off && !seen.has(off)) {
            seen.add(off);
            if (!seg(off, 2)) { missing.push(off); return; }
            const n = u16(off);
            if (n > 1000 || !seg(off, 2 + 12 * n + 4)) { missing.push(off); return; }
            const tags = {};
            for (let i = 0; i < n; i++) {
                const e = off + 2 + 12 * i;
                const tag = u16(e), type = u16(e + 2), count = u32(e + 4);
                const size = (TYPE_SIZE[type] ?? 1) * count;
                const voff = size <= 4 ? e + 8 : u32(e + 8);
                if (!seg(voff, size)) continue;   // valeur hors des morceaux lus
                tags[tag] = value(type, count, voff);
            }
            ifds.push(tags);
            for (const sub of [...(tags[TAG.SubIFDs] ?? []), ...(tags[TAG.ExifIFD] ?? [])]) walk(sub);
            off = u32(off + 2 + 12 * n);
        }
    };
    walk(u32(4));
    return { ifds, le, missing };
}

/**
 * En-tête d'un DNG : dimensions, motif Bayer, position des pixels, noir,
 * pose. `headerBytes` doit couvrir toutes les IFD (64 Ko suffisent pour
 * rpicam ; relu en entier sinon).
 */
export async function readDngHeader(file, headerBytes = 65536) {
    const segments = [{ start: 0, buf: await file.slice(0, Math.min(file.size, headerBytes)).arrayBuffer() }];
    let parsed = readIfds(segments);
    // IFD rangées plus loin (Exif en fin de fichier chez rpicam) : 2e lecture
    const extra = parsed.missing.filter((o) => o < file.size);
    if (extra.length) {
        const start = Math.min(...extra);
        segments.push({ start, buf: await file.slice(start, Math.min(file.size, Math.max(...extra) + headerBytes)).arrayBuffer() });
        parsed = readIfds(segments);
    }
    const { ifds, le } = parsed;
    const raw = ifds.find((t) => (t[TAG.NewSubfileType]?.[0] ?? 0) === 0
                                 && t[TAG.Photometric]?.[0] === PHOTOMETRIC_CFA);
    if (!raw) throw new Error(`${file.name} : pas d'image CFA (Bayer) pleine résolution dans ce DNG`);
    const width = raw[TAG.ImageWidth][0], height = raw[TAG.ImageLength][0];
    const bits = raw[TAG.BitsPerSample]?.[0] ?? 16;
    if ((raw[TAG.Compression]?.[0] ?? 1) !== 1)
        throw new Error(`${file.name} : DNG compressé non pris en charge`);
    if ((raw[TAG.SamplesPerPixel]?.[0] ?? 1) !== 1 || (bits !== 16 && bits !== 8))
        throw new Error(`${file.name} : format CFA ${bits} bits / ${raw[TAG.SamplesPerPixel]} plan(s) non pris en charge`);
    const dim = raw[TAG.CFARepeatPatternDim] ?? [2, 2];
    const cfa = raw[TAG.CFAPattern];
    if (dim[0] !== 2 || dim[1] !== 2 || !cfa || cfa.length !== 4)
        throw new Error(`${file.name} : motif CFA non 2×2`);
    const bayer = cfa.map((c) => CFA_COLORS[c]).join('');
    const offsets = raw[TAG.StripOffsets], counts = raw[TAG.StripByteCounts];
    const exif = ifds.find((t) => t[TAG.ExposureTime]) ?? {};
    const black = raw[TAG.BlackLevel] ?? [0];
    return {
        width, height, bits, bayer, littleEndian: le,
        strips: offsets.map((o, i) => [o, counts[i]]),
        blackLevel: black.reduce((a, b) => a + b, 0) / black.length,
        whiteLevel: raw[TAG.WhiteLevel]?.[0] ?? (2 ** bits - 1),
        exposureMs: (exif[TAG.ExposureTime]?.[0] ?? 0) * 1000,
        iso: exif[TAG.ISO]?.[0] ?? 0,
    };
}

/** Pixels CFA en Uint16Array (width × height), quel que soit le stockage. */
export async function readDngPixels(file, h) {
    const n = h.width * h.height;
    const bytesPx = h.bits / 8;
    const contiguous = h.strips.every(([o, c], i) => i === 0 || o === h.strips[i - 1][0] + h.strips[i - 1][1]);
    const total = h.strips.reduce((a, [, c]) => a + c, 0);
    if (total < n * bytesPx) throw new Error(`${file.name} : données image incomplètes`);
    let bytes;
    if (contiguous) {
        bytes = new Uint8Array(await file.slice(h.strips[0][0], h.strips[0][0] + n * bytesPx).arrayBuffer());
    } else {
        bytes = new Uint8Array(n * bytesPx);
        let k = 0;
        for (const [o, c] of h.strips) {
            const part = new Uint8Array(await file.slice(o, o + Math.min(c, bytes.length - k)).arrayBuffer());
            bytes.set(part, k);
            k += part.length;
            if (k >= bytes.length) break;
        }
    }
    if (bytesPx === 1) return Uint16Array.from(bytes, (v) => v << 8);
    // Uint16Array suit l'ordre de la machine (little-endian partout en pratique)
    if (h.littleEndian) return new Uint16Array(bytes.buffer, bytes.byteOffset, n);
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return Uint16Array.from({ length: n }, (_, i) => dv.getUint16(2 * i, false));
}

/** Tri naturel : « img_2 » avant « img_10 ». */
export function naturalSort(files) {
    const coll = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
    return [...files].sort((a, b) => coll.compare(a.name, b.name));
}

export class DngFileSource {
    /**
     * @param {File[]|FileList} files
     * @param {object} [opts]
     * @param {(i:number, n:number) => void} [opts.onProgress]
     * @param {() => void} [opts.onEnd]
     * @param {(file: File, err: Error) => void} [opts.onSkip]  fichier illisible (ignoré)
     */
    constructor(files, { onProgress, onEnd, onSkip } = {}) {
        this._files       = naturalSort(files);
        this._onFrame     = null;
        this._onProgress  = onProgress ?? null;
        this._onEnd       = onEnd ?? null;
        this._onSkip      = onSkip ?? null;
        this._processing  = false;
        this._idleWaiter  = null;
        this._stopped     = false;
        this._framesSent  = 0;
        this._header      = null;
        this.timings      = { read: [], process: [] };
    }

    // --- interface WsFrameReceiver ----------------------------------------
    set onFrame(cb) { this._onFrame = cb; }
    get framesReceived() { return this._framesSent; }
    get droppedFrames()  { return 0; }
    /** En-tête du premier fichier (dimensions, Bayer, pose…). */
    get header()         { return this._header; }
    get fileCount()      { return this._files.length; }

    setProcessing(busy) {
        this._processing = busy;
        if (!busy && this._idleWaiter) { this._idleWaiter(); this._idleWaiter = null; }
    }
    // Réglages caméra : sans objet pour des fichiers.
    flush() {}
    setRate() {}
    setRoi() {}
    setBitDepth() {}
    setFormat() {}
    setCompression() {}
    setFlowControl() {}

    async start() {
        this._stopped = false;
        if (!this._files.length) throw new Error('Aucun fichier DNG');
        this._header = await readDngHeader(this._files[0]);
        this._run();   // en tâche de fond, comme le flux WebSocket
    }

    stop() {
        this._stopped = true;
        this.setProcessing(false);
    }

    async _run() {
        const t = this.timings;
        const t0 = performance.now();
        const n = this._files.length;
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
            ? `moy ${(a.reduce((x, y) => x + y, 0) / a.length).toFixed(0)} / max ${Math.max(...a).toFixed(0)} ms`
            : '—';
        console.log(`[DNG] ${t.process.length}/${n} images en ${((performance.now() - t0) / 1000).toFixed(1)} s — `
            + `lecture ${stat(t.read)}, traitement ${stat(t.process)}`);
        this._onEnd?.();
    }

    async _prepare(i) {
        const file = this._files[i];
        const t = performance.now();
        try {
            const h = await readDngHeader(file);
            const ref = this._header;
            if (ref && (h.width !== ref.width || h.height !== ref.height || h.bayer !== ref.bayer))
                throw new Error(`${h.width}×${h.height} ${h.bayer} ≠ ${ref.width}×${ref.height} ${ref.bayer} du 1er fichier`);
            const pixels = await readDngPixels(file, h);
            this.timings.read.push(performance.now() - t);
            return [pixels, {
                width: h.width, height: h.height, bayer: h.bayer, bit_depth: 16, format: 'raw',
                gain: h.iso / 100, exposure_ms: h.exposureMs, exposure_us: Math.round(h.exposureMs * 1000),
                black_level: h.blackLevel, white_level: h.whiteLevel,
                ts: (file.lastModified ?? Date.now()) / 1000, file: file.name,
            }];
        } catch (err) {
            console.warn(`[DNG] ${file.name} ignoré : ${err.message}`);
            this._onSkip?.(file, err);
            return null;
        }
    }
}
