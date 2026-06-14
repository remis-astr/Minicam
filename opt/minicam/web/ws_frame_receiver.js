'use strict';

/**
 * WsFrameReceiver — consomme le flux /ws/raw du Pi Zero 2W.
 *
 * Protocole binaire (un seul message par frame) :
 *   [4 octets big-endian : longueur JSON][JSON UTF-8][uint16 LE pixels]
 *
 * JSON meta : { width, height, gain, exposure_ms, bayer, exposure_us, ts }
 * Pixels    : Uint16Array, width × height valeurs, Bayer RGGB, échelle 0–65520
 *             (RAW12 décalé à gauche de 4 bits par routes_raw_stream.py)
 *
 * Usage :
 *   const rx = new WsFrameReceiver('ws://192.168.7.2/ws/raw');
 *   rx.onFrame = (pixels, meta) => {
 *     rx.setProcessing(true);          // ← bloquer jusqu'à fin du traitement GPU
 *     worker.postMessage(...);
 *   };
 *   worker.onmessage = () => rx.setProcessing(false);  // ← libérer
 *   await rx.start();
 *   // ...
 *   rx.stop();
 */
export class WsFrameReceiver {
    constructor(url) {
        this._url            = url;
        this._ws             = null;
        this._onFrame        = null;
        this._processing     = false;
        this._flushRemaining = 0;
        this._framesReceived = 0;
        this._droppedFrames  = 0;
        this._stopped        = false;
        this._reconnectDelay = 1000;
        this._decoder        = new TextDecoder();
        this._targetFps       = null;
        this._initialRoi      = null;
        this._initialBitDepth = null;
    }

    // --- API publique --------------------------------------------------

    set onFrame(cb)  { this._onFrame = cb; }

    get framesReceived() { return this._framesReceived; }
    get droppedFrames()  { return this._droppedFrames; }

    /**
     * Indique si un traitement GPU est en cours.
     * Le stacker appelle setProcessing(true) avant d'envoyer au worker,
     * puis setProcessing(false) dans le handler de réponse worker.
     * Quand processing=true, les frames entrantes sont droppées silencieusement.
     */
    setProcessing(busy) { this._processing = busy; }

    /**
     * Ignorer les N prochaines frames reçues.
     * Utilisé par le scheduler après un changement de gain/expo,
     * le temps que le capteur applique les nouveaux paramètres.
     */
    flush(n = 3) { this._flushRemaining = n; }

    /**
     * Ouvre la connexion WebSocket.
     * Résout quand la connexion est établie.
     * La reconnexion automatique est gérée en interne.
     * @param {number} [fps] - Débit cible à envoyer au serveur après connexion (1–15).
     */
    async start(fps, roi, bitDepth) {
        this._stopped         = false;
        this._targetFps       = fps ?? null;
        this._initialRoi      = roi ?? null;
        this._initialBitDepth = bitDepth ?? null;
        return this._connect();
    }

    /** Demande au serveur de changer le débit d'envoi des frames. */
    setRate(fps) {
        this._targetFps = fps;
        if (this._ws?.readyState === WebSocket.OPEN)
            this._ws.send(JSON.stringify({ cmd: 'set_rate', fps }));
    }

    /** Définit la profondeur de bits (8 ou 16). */
    setBitDepth(bitDepth) {
        this._initialBitDepth = bitDepth;
        if (this._ws?.readyState === WebSocket.OPEN)
            this._ws.send(JSON.stringify({ cmd: 'set_bitdepth', bit_depth: bitDepth }));
    }

    /** Définit le ROI centré (w × h). null = plein champ. */
    setRoi(w, h) {
        this._initialRoi = (w && h) ? [w, h] : null;
        const cmd = (w && h) ? { cmd: 'set_roi', w, h } : { cmd: 'set_roi', w: null, h: null };
        if (this._ws?.readyState === WebSocket.OPEN)
            this._ws.send(JSON.stringify(cmd));
    }

    /** Envoie une commande JSON quelconque sur le WebSocket. */
    sendCommand(cmd) {
        if (this._ws?.readyState === WebSocket.OPEN)
            this._ws.send(JSON.stringify(cmd));
    }

    /** Ferme la connexion et inhibe toute reconnexion. */
    stop() {
        this._stopped = true;
        if (this._ws) {
            this._ws.onclose = null;
            this._ws.close();
            this._ws = null;
        }
    }

    // --- Internals -----------------------------------------------------

    _connect() {
        return new Promise((resolve, reject) => {
            let resolved = false;

            const ws = new WebSocket(this._url);
            ws.binaryType = 'arraybuffer';
            this._ws = ws;

            ws.onopen = () => {
                this._reconnectDelay = 1000;
                if (this._targetFps != null)
                    ws.send(JSON.stringify({ cmd: 'set_rate', fps: this._targetFps }));
                if (this._initialRoi)
                    ws.send(JSON.stringify({ cmd: 'set_roi', w: this._initialRoi[0], h: this._initialRoi[1] }));
                if (this._initialBitDepth != null)
                    ws.send(JSON.stringify({ cmd: 'set_bitdepth', bit_depth: this._initialBitDepth }));
                resolved = true;
                resolve();
            };

            ws.onerror = (e) => {
                if (!resolved) reject(e);
            };

            ws.onclose = () => {
                this._ws = null;
                if (!this._stopped) this._scheduleReconnect();
            };

            ws.onmessage = (event) => this._onMessage(event);
        });
    }

    _scheduleReconnect() {
        const delay = this._reconnectDelay;
        this._reconnectDelay = Math.min(this._reconnectDelay * 2, 30_000);
        setTimeout(() => {
            if (!this._stopped) this._connect().catch(() => {});
        }, delay);
    }

    _onMessage(event) {
        // Backpressure : le stacker traite encore la frame précédente → dropper
        if (this._processing) {
            this._droppedFrames++;
            return;
        }

        // Flush : ignorer les N premières frames après un changement de paramètres
        if (this._flushRemaining > 0) {
            this._flushRemaining--;
            return;
        }

        const buf = event.data;
        if (!(buf instanceof ArrayBuffer) || buf.byteLength < 4) return;

        // Décodage du message : [4 octets BE longueur][JSON UTF-8][uint16 LE pixels]
        const view    = new DataView(buf);
        const jsonLen = view.getUint32(0, false);   // big-endian
        if (buf.byteLength < 4 + jsonLen) return;

        let meta;
        try {
            meta = JSON.parse(this._decoder.decode(new Uint8Array(buf, 4, jsonLen)));
        } catch {
            return;
        }

        // Uint16Array nécessite un offset aligné sur 2 octets.
        // Le serveur pad le JSON à longueur paire, donc rawOffset est normalement aligné.
        // Fallback: slice() pour les éventuels messages legacy non-paddés.
        const rawOffset = 4 + jsonLen;
        if (buf.byteLength <= rawOffset) return;

        let pixels;
        if ((meta.bit_depth ?? 16) === 8) {
            // 8-bit : Uint8Array, pas de contrainte d'alignement
            pixels = new Uint8Array(buf, rawOffset);
        } else if (rawOffset % 2 === 0) {
            pixels = new Uint16Array(buf, rawOffset);   // zero-copy
        } else {
            pixels = new Uint16Array(buf.slice(rawOffset)); // copy (legacy)
        }

        this._framesReceived++;
        this._onFrame?.(pixels, meta);
    }
}
