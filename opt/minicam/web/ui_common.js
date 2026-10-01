'use strict';

// ---------------------------------------------------------------------------
// GPU detection
// ---------------------------------------------------------------------------

/** URL WebSocket du Pi : wss:// sur une page HTTPS (sinon bloqué), ws:// sinon. */
export function wsUrl(path) {
    return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${path}`;
}

export async function detectGpu() {
    if (!navigator.gpu) return { ok: false, reason: 'WebGPU non disponible dans ce navigateur.' };
    try {
        const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
        if (!adapter) return { ok: false, reason: 'Pas de GPU WebGPU accessible (adaptateur null).' };
        // Même critère que StreamingStacker : SwiftShader (GPU émulé sur le
        // processeur) est refusé, le calcul part sur les workers CPU.
        const info = adapter.info ?? {};
        if (info.isFallbackAdapter || info.architecture === 'swiftshader')
            return { ok: false, emulated: true,
                     reason: `GPU émulé (${info.description || 'SwiftShader'}). Sous Linux, activer `
                           + 'chrome://flags/#enable-vulkan et #enable-unsafe-webgpu puis relancer Chrome.' };
        return { ok: true, name: info.description || `${info.vendor ?? ''} ${info.architecture ?? ''}`.trim() };
    } catch (e) {
        return { ok: false, reason: String(e) };
    }
}

// ---------------------------------------------------------------------------
// Minimal /ws/control helper
// ---------------------------------------------------------------------------

export class ControlWs {
    constructor() {
        this._ws    = null;
        this._url   = wsUrl('/ws/control');
        this.onStatus = null;  // (msg) => void
        this.onError  = null;  // (detail) => void
    }

    connect() {
        if (this._ws && this._ws.readyState <= WebSocket.OPEN) return;
        const ws = new WebSocket(this._url);
        this._ws = ws;
        ws.onopen  = () => this._send({ cmd: 'status' });
        ws.onclose = () => { this._ws = null; };
        ws.onerror = () => { if (this.onError) this.onError('Connexion /ws/control échouée'); };
        ws.onmessage = (ev) => {
            try {
                const msg = JSON.parse(ev.data);
                if ((msg.cmd === 'status' || msg.cmd === 'ack') && this.onStatus) this.onStatus(msg);
                if (msg.cmd === 'error' && this.onError) this.onError(msg.detail);
            } catch { /* ignore */ }
        };
    }

    _send(msg) {
        if (this._ws?.readyState === WebSocket.OPEN) this._ws.send(JSON.stringify(msg));
    }

    setGain(gain)     { this._send({ cmd: 'set_gain',     value: gain }); }
    setExposure(ms)   { this._send({ cmd: 'set_exposure', value_ms: ms }); }
    requestStatus()   { this._send({ cmd: 'status' }); }
    close()           { this._ws?.close(); this._ws = null; }
}

// ---------------------------------------------------------------------------
// Save helpers
// ---------------------------------------------------------------------------

export function savePng(canvas, filename) {
    canvas.toBlob((blob) => {
        if (!blob) return;
        const url = URL.createObjectURL(blob);
        const a   = document.createElement('a');
        a.href = url; a.download = filename;
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
    }, 'image/png');
}

export function saveFits(result, filename) {
    const { float32Data, width, height, stackedCount, totalExpMs, gainMean } = result;
    if (!float32Data) throw new Error('Pas de données à sauvegarder');

    // Build FITS header (cards of exactly 80 ASCII chars)
    function card(key, value, comment = '') {
        const k = key.slice(0, 8).padEnd(8);
        let v;
        if (typeof value === 'boolean') v = `=                    ${value ? 'T' : 'F'}`;
        else if (typeof value === 'number')
            v = `= ${(Number.isInteger(value) ? String(value) : value.toFixed(6)).padStart(20)}`;
        else if (typeof value === 'string')
            v = `= '${value}'`.padEnd(21);
        else
            return k.padEnd(80);   // blank card
        const c = comment ? ` / ${comment}` : '';
        return (k + v + c).slice(0, 80).padEnd(80);
    }

    const cards = [
        card('SIMPLE',   true,         'FITS standard'),
        card('BITPIX',   -32,          'IEEE float32'),
        card('NAXIS',    3,            'Dimensions'),
        card('NAXIS1',   width,        'Width'),
        card('NAXIS2',   height,       'Height'),
        card('NAXIS3',   3,            'RGB planes'),
        card('BSCALE',   1.0),
        card('BZERO',    0.0),
        card('EXPTIME',  totalExpMs / 1000, 'Total exposure [s]'),
        card('GAIN',     gainMean,     'Mean analog gain'),
        card('STACKCNT', stackedCount, 'Stacked frames'),
        card('INSTRUME', 'MiniCam IMX462'),
        card('CREATOR',  'MiniCam WebGPU Stacker'),
        card('END'),
    ];

    let hdr = cards.join('');
    hdr = hdr.padEnd(Math.ceil(hdr.length / 2880) * 2880);
    const hdrBuf = new Uint8Array(hdr.length);
    for (let i = 0; i < hdr.length; i++) hdrBuf[i] = hdr.charCodeAt(i) & 0x7f;

    // Data: float32 big-endian, 3 planes, rows Y-flipped (FITS bottom-to-top)
    const npix = width * height;
    const dblocks = Math.ceil(npix * 3 * 4 / 2880);
    const dataBuf = new ArrayBuffer(dblocks * 2880);
    const dv = new DataView(dataBuf);
    for (let ch = 0; ch < 3; ch++) {
        for (let row = 0; row < height; row++) {
            const srcRow = height - 1 - row;
            for (let col = 0; col < width; col++) {
                const srcIdx = (srcRow * width + col) * 4 + ch;
                const dstOff = ((ch * height + row) * width + col) * 4;
                dv.setFloat32(dstOff, float32Data[srcIdx] ?? 0, false);  // big-endian
            }
        }
    }

    const blob = new Blob([hdrBuf, dataBuf], { type: 'application/octet-stream' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

export function formatDate() {
    return new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
}
