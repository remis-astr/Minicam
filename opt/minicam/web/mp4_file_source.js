'use strict';
/**
 * Mp4FileSource — rejoue une vidéo MP4/MOV (H.264) locale à la place du flux
 * /ws/raw, comme SerFileSource : même interface, passée à
 * StreamingStacker.start(), rien n'est envoyé au Pi.
 *
 * Démultiplexage maison (tables d'échantillons du moov : stsz, stco/co64,
 * stsc, stts, ctts, stss) et décodage WebCodecs (VideoDecoder, matériel si
 * disponible) : chaque image est décodée dans l'ordre, aucune n'est sautée,
 * contrairement à une lecture par <video>. Le décodeur rend les images dans
 * l'ordre d'affichage (B-frames réordonnées).
 *
 * Une image 4032×3024 est trop lourde pour l'empilement (float32 RGBA sur le
 * GPU) : chaque image est réduite (÷scale, lissage du canvas) puis recadrée
 * au centre (crop, en pixels après réduction) avant d'être servie en RGBA
 * 8 bits (format 'rgba', comme un SER RGB).
 *
 * WebCodecs demande un contexte sécurisé (HTTPS ou localhost), comme WebGPU.
 */

// ── Démultiplexage MP4 ──────────────────────────────────────────────────────

const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts']);

/** Boîtes d'un tampon : [{ type, start (contenu), end }] */
function boxes(dv, start, end) {
    const out = [];
    let p = start;
    while (p + 8 <= end) {
        let size = dv.getUint32(p);
        const type = String.fromCharCode(dv.getUint8(p + 4), dv.getUint8(p + 5), dv.getUint8(p + 6), dv.getUint8(p + 7));
        let hdr = 8;
        if (size === 1) { size = Number(dv.getBigUint64(p + 8)); hdr = 16; }
        else if (size === 0) size = end - p;
        if (size < hdr || p + size > end) break;
        out.push({ type, start: p + hdr, end: p + size });
        p += size;
    }
    return out;
}

/** Cherche la boîte moov au premier niveau du fichier (début ou fin). */
async function readMoov(file) {
    let p = 0;
    while (p + 8 <= file.size) {
        const dv = new DataView(await file.slice(p, p + 16).arrayBuffer());
        let size = dv.getUint32(0);
        const type = String.fromCharCode(dv.getUint8(4), dv.getUint8(5), dv.getUint8(6), dv.getUint8(7));
        if (size === 1) size = Number(dv.getBigUint64(8));
        else if (size === 0) size = file.size - p;
        if (size < 8) break;
        if (type === 'moov') return new DataView(await file.slice(p, p + size).arrayBuffer());
        p += size;
    }
    throw new Error('MP4 sans boîte moov (fichier incomplet ou fragmenté)');
}

function child(dv, box, type) {
    return boxes(dv, box.start, box.end).find((b) => b.type === type) ?? null;
}

function parseVideoTrack(moov) {
    const top = boxes(moov, 0, moov.byteLength)[0];
    for (const trak of boxes(moov, top.start, top.end).filter((b) => b.type === 'trak')) {
        const mdia = child(moov, trak, 'mdia');
        const hdlr = mdia && child(moov, mdia, 'hdlr');
        if (!hdlr) continue;
        const handler = String.fromCharCode(...new Uint8Array(moov.buffer, moov.byteOffset + hdlr.start + 8, 4));
        if (handler !== 'vide') continue;
        const mdhd = child(moov, mdia, 'mdhd');
        const timescale = moov.getUint8(mdhd.start) === 1 ? moov.getUint32(mdhd.start + 20) : moov.getUint32(mdhd.start + 12);
        const stbl = child(moov, child(moov, mdia, 'minf'), 'stbl');
        return { stbl, timescale };
    }
    throw new Error('MP4 sans piste vidéo');
}

function readSampleEntry(dv, stbl) {
    const stsd = child(dv, stbl, 'stsd');
    const entry = boxes(dv, stsd.start + 8, stsd.end)[0];
    if (!entry) throw new Error('MP4 : description de piste absente');
    const width  = dv.getUint16(entry.start + 24);
    const height = dv.getUint16(entry.start + 26);
    // VisualSampleEntry : 78 octets avant les boîtes filles (avcC…)
    const sub = boxes(dv, entry.start + 78, entry.end);
    if (entry.type === 'avc1' || entry.type === 'avc3') {
        const avcC = sub.find((b) => b.type === 'avcC');
        if (!avcC) throw new Error('MP4 H.264 sans avcC');
        const desc = new Uint8Array(dv.buffer.slice(dv.byteOffset + avcC.start, dv.byteOffset + avcC.end));
        const hex = (v) => v.toString(16).padStart(2, '0');
        const codec = `avc1.${hex(desc[1])}${hex(desc[2])}${hex(desc[3])}`;
        return { codec, description: desc, width, height };
    }
    throw new Error(`Codec vidéo « ${entry.type} » non pris en charge (H.264 seulement)`);
}

/** Table des échantillons, dans l'ordre de décodage. */
function readSamples(dv, stbl, timescale) {
    const get = (t) => child(dv, stbl, t);
    // tailles
    const stsz = get('stsz');
    const fixed = dv.getUint32(stsz.start + 4), count = dv.getUint32(stsz.start + 8);
    const sizes = new Array(count);
    for (let i = 0; i < count; i++) sizes[i] = fixed || dv.getUint32(stsz.start + 12 + 4 * i);
    // décalages des blocs (chunks)
    const stco = get('stco'), co64 = get('co64');
    const chunks = [];
    if (stco) for (let i = 0, n = dv.getUint32(stco.start + 4); i < n; i++) chunks.push(dv.getUint32(stco.start + 8 + 4 * i));
    else for (let i = 0, n = dv.getUint32(co64.start + 4); i < n; i++) chunks.push(Number(dv.getBigUint64(co64.start + 8 + 8 * i)));
    // échantillons par bloc
    const stsc = get('stsc');
    const sc = [];
    for (let i = 0, n = dv.getUint32(stsc.start + 4); i < n; i++)
        sc.push([dv.getUint32(stsc.start + 8 + 12 * i), dv.getUint32(stsc.start + 12 + 12 * i)]);
    const offsets = new Array(count);
    let s = 0;
    for (let e = 0; e < sc.length && s < count; e++) {
        const last = e + 1 < sc.length ? sc[e + 1][0] - 1 : chunks.length;
        for (let c = sc[e][0]; c <= last && s < count; c++) {
            let off = chunks[c - 1];
            for (let k = 0; k < sc[e][1] && s < count; k++, s++) { offsets[s] = off; off += sizes[s]; }
        }
    }
    // horodatages : dts (stts) + décalage de composition (ctts)
    const dts = new Array(count);
    const stts = get('stts');
    let t = 0;
    s = 0;
    for (let i = 0, n = dv.getUint32(stts.start + 4); i < n; i++) {
        const cnt = dv.getUint32(stts.start + 8 + 8 * i), delta = dv.getUint32(stts.start + 12 + 8 * i);
        for (let k = 0; k < cnt && s < count; k++, s++) { dts[s] = t; t += delta; }
    }
    for (; s < count; s++) dts[s] = t;
    const cts = dts.slice();
    const ctts = get('ctts');
    if (ctts) {
        const v1 = dv.getUint8(ctts.start) === 1;
        s = 0;
        for (let i = 0, n = dv.getUint32(ctts.start + 4); i < n; i++) {
            const cnt = dv.getUint32(ctts.start + 8 + 8 * i);
            const off = v1 ? dv.getInt32(ctts.start + 12 + 8 * i) : dv.getUint32(ctts.start + 12 + 8 * i);
            for (let k = 0; k < cnt && s < count; k++, s++) cts[s] += off;
        }
    }
    // images clés (toutes si stss absent)
    const stss = get('stss');
    const key = new Array(count).fill(!stss);
    if (stss) for (let i = 0, n = dv.getUint32(stss.start + 4); i < n; i++) key[dv.getUint32(stss.start + 8 + 4 * i) - 1] = true;
    const us = 1e6 / timescale;
    return sizes.map((size, i) => ({ offset: offsets[i], size, key: key[i],
                                     ts: Math.round(cts[i] * us), dur: Math.round(((dts[i + 1] ?? t) - dts[i]) * us) }));
}

/**
 * En-tête d'une vidéo : dimensions, nombre d'images, cadence, codec.
 * Lève une erreur si le fichier ou le codec n'est pas utilisable.
 */
export async function readMp4Header(file) {
    if (typeof VideoDecoder === 'undefined')
        throw new Error('WebCodecs indisponible (navigateur trop ancien ou page non HTTPS)');
    const moov = await readMoov(file);
    const { stbl, timescale } = parseVideoTrack(moov);
    const entry = readSampleEntry(moov, stbl);
    const samples = readSamples(moov, stbl, timescale);
    // échantillons tronqués (enregistrement interrompu) : ignorés
    const usable = samples.filter((s) => s.offset + s.size <= file.size);
    const config = { codec: entry.codec, description: entry.description,
                     codedWidth: entry.width, codedHeight: entry.height };
    const support = await VideoDecoder.isConfigSupported(config);
    if (!support.supported) throw new Error(`Décodage ${entry.codec} ${entry.width}×${entry.height} non pris en charge par ce navigateur`);
    const span = usable.length > 1 ? (usable[usable.length - 1].ts - usable[0].ts) / 1e6 : 0;
    return { width: entry.width, height: entry.height, frames: usable.length, codec: entry.codec,
             fps: span > 0 ? (usable.length - 1) / span : 0, config, samples: usable,
             depth: 8, colorId: 'mp4' };
}

/** Géométrie de sortie : réduction ÷scale puis recadrage centré w×h (pixels réduits). */
export function mp4OutputSize(header, scale, crop) {
    const sw = Math.floor(header.width / scale), sh = Math.floor(header.height / scale);
    const [cw, ch] = crop ? [Math.min(crop[0], sw), Math.min(crop[1], sh)] : [sw, sh];
    // largeur paire : même convention que les ROI du Pi
    return { scaledW: sw, scaledH: sh, width: cw & ~1, height: ch & ~1 };
}

// ── Source d'images pour StreamingStacker ───────────────────────────────────

const AHEAD = 4;   // images décodées d'avance (RGBA), au plus

export class Mp4FileSource {
    /**
     * @param {File} file
     * @param {object} [opts]
     * @param {number} [opts.scale]  réduction (1 = pleine résolution)
     * @param {[number, number]|null} [opts.crop]  recadrage centré après réduction
     * @param {(i:number, n:number) => void} [opts.onProgress]
     * @param {() => void} [opts.onEnd]
     */
    constructor(file, { scale = 1, crop = null, onProgress, onEnd } = {}) {
        this._file       = file;
        this._scale      = scale;
        this._crop       = crop;
        this._onFrame    = null;
        this._onProgress = onProgress ?? null;
        this._onEnd      = onEnd ?? null;
        this._processing = false;
        this._idleWaiter = null;
        this._stopped    = false;
        this._framesSent = 0;
        this._header     = null;
        this.timings     = { read: [], convert: [], process: [] };
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
    flush() {}
    setRate() {}
    setRoi() {}
    setBitDepth() {}
    setFormat() {}
    setCompression() {}

    async start() {
        this._stopped = false;
        this._header  = await readMp4Header(this._file);
        this._run();
    }

    stop() {
        this._stopped = true;
        this.setProcessing(false);
        this._wake?.();
    }

    // --- décodage -------------------------------------------------------------
    async _run() {
        const h = this._header;
        const t = this.timings;
        const t0 = performance.now();
        const out = mp4OutputSize(h, this._scale, this._crop);
        // recadrage centré dans l'image réduite → rectangle source pleine résolution
        const sx = ((out.scaledW - out.width) / 2) * this._scale;
        const sy = ((out.scaledH - out.height) / 2) * this._scale;
        const sw = out.width * this._scale, sh = out.height * this._scale;
        const canvas = new OffscreenCanvas(out.width, out.height);
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';

        const ready = [];          // [rgba, meta] décodées, dans l'ordre d'affichage
        let decodeError = null;
        let flushed = false;      // flush() demandé
        let flushDone = false;    // flush() résolu : toutes les images sont sorties
        this._wake = null;
        const wake = () => { const w = this._wake; this._wake = null; w?.(); };
        const decoder = new VideoDecoder({
            output: (frame) => {
                const tc = performance.now();
                try {
                    ctx.drawImage(frame, sx, sy, sw, sh, 0, 0, out.width, out.height);
                    const img = ctx.getImageData(0, 0, out.width, out.height);
                    ready.push([new Uint8Array(img.data.buffer), {
                        width: out.width, height: out.height, gain: 0, exposure_ms: 0, exposure_us: 0,
                        format: 'rgba', ts: Date.now() / 1000 }]);
                } finally {
                    frame.close();
                }
                t.convert.push(performance.now() - tc);
                wake();
            },
            error: (e) => { decodeError = e; wake(); },
        });
        // file du décodeur vidée sans sortie (réordonnancement) : réalimenter
        decoder.ondequeue = wake;
        decoder.configure(h.config);

        let next = 0;              // prochain échantillon à envoyer au décodeur
        const feed = async () => {
            // garder au plus AHEAD images en attente (décodées + en cours)
            while (next < h.samples.length && !this._stopped && !decodeError
                   && ready.length + decoder.decodeQueueSize < AHEAD) {
                const smp = h.samples[next++];
                const tr = performance.now();
                const data = await this._file.slice(smp.offset, smp.offset + smp.size).arrayBuffer();
                t.read.push(performance.now() - tr);
                if (decoder.state !== 'configured') return;
                decoder.decode(new EncodedVideoChunk({ type: smp.key ? 'key' : 'delta',
                                                       timestamp: smp.ts, duration: smp.dur, data }));
            }
            if (next >= h.samples.length && !flushed && decoder.state === 'configured') {
                flushed = true;
                decoder.flush().then(() => { flushDone = true; wake(); }, (e) => { decodeError ??= e; wake(); });
            }
        };

        let sent = 0;
        try {
            while (!this._stopped) {
                await feed();
                if (!ready.length) {
                    if (decodeError || flushDone) break;
                    await new Promise((r) => { this._wake = r; });
                    continue;
                }
                const [pixels, meta] = ready.shift();
                const tp = performance.now();
                this._framesSent++;
                sent++;
                this._onFrame?.(pixels, meta);
                this._onProgress?.(sent, h.frames);
                if (this._processing) await new Promise((r) => { this._idleWaiter = r; });
                t.process.push(performance.now() - tp);
            }
        } finally {
            if (decoder.state !== 'closed') decoder.close();
        }
        if (this._stopped) return;
        if (decodeError) console.warn(`[MP4] décodage arrêté après ${sent} images :`, decodeError);
        const stat = (a) => a.length
            ? `moy ${(a.reduce((x, y) => x + y, 0) / a.length).toFixed(0)} / max ${Math.max(...a).toFixed(0)} ms`
            : '—';
        console.log(`[MP4] ${sent} images ${out.width}×${out.height} en ${((performance.now() - t0) / 1000).toFixed(1)} s — `
            + `lecture ${stat(t.read)}, conversion ${stat(t.convert)}, traitement ${stat(t.process)}`);
        this._onEnd?.();
    }
}
