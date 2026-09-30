'use strict';

/**
 * WsFrameReceiver — consomme le flux /ws/raw du Pi Zero 2W.
 *
 * Protocole binaire (un seul message par frame) :
 *   [4 octets big-endian : longueur JSON][JSON UTF-8][uint16 LE pixels]
 *
 * JSON meta : { width, height, gain, exposure_ms, bayer, exposure_us, format, ts }
 * Pixels    : format='raw' (défaut) → Uint16Array (ou Uint8Array si bit_depth=8),
 *             width × height valeurs, motif Bayer donné par meta.bayer.
 *             format='jpeg'|'png'   → Uint8Array, bytes JPEG/PNG bruts (déjà
 *             débayerisés par l'ISP) — à décoder côté consommateur.
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
        this._initialFormat   = null;
        // Contrôle de flux par crédits (0 = désactivé, cadence fixe du serveur).
        // Avec N > 0 : le serveur n'envoie qu'une image par crédit, et les
        // images arrivées pendant un traitement attendent dans une file FIFO
        // (N au plus) au lieu d'être jetées ; un crédit est rendu à chaque
        // image sortie de la file. Absorbe l'écart entre images rejetées
        // (rapides) et acceptées (lentes) sans jamais perdre d'image.
        this._flowCredits     = 0;
        this._queue           = [];
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
    setProcessing(busy) {
        const wasBusy = this._processing;
        this._processing = busy;
        if (this._flowCredits > 0 && wasBusy && !busy) {
            this._grantCredit();
            this._pump();
        }
    }

    /** Active le contrôle de flux avec un buffer de n images (avant start()). */
    setFlowControl(n) { this._flowCredits = Math.max(0, n | 0); }

    /** Images en attente dans le buffer. */
    get queued() { return this._queue.length; }

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
    async start(fps, roi, bitDepth, format) {
        this._stopped         = false;
        this._targetFps       = fps ?? null;
        this._initialRoi      = roi ?? null;
        this._initialBitDepth = bitDepth ?? null;
        this._initialFormat   = format ?? null;
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

    /** Définit le format de frame : 'raw' (Bayer, défaut), 'jpeg' ou 'png' (déjà débayerisé par l'ISP). */
    setFormat(format) {
        this._initialFormat = format;
        if (this._ws?.readyState === WebSocket.OPEN)
            this._ws.send(JSON.stringify({ cmd: 'set_format', format }));
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
                if (this._initialFormat != null)
                    ws.send(JSON.stringify({ cmd: 'set_format', format: this._initialFormat }));
                // Crédits envoyés en dernier : les réglages ci-dessus s'appliquent
                // dès la première image capturée.
                this._queue = [];
                if (this._flowCredits > 0)
                    ws.send(JSON.stringify({ cmd: 'credit', n: this._flowCredits }));
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

    _grantCredit() {
        if (this._ws?.readyState === WebSocket.OPEN)
            this._ws.send(JSON.stringify({ cmd: 'credit', n: 1 }));
    }

    // Mode crédits : délivre les images en attente tant que le consommateur
    // est libre ; une image qui ne déclenche pas de traitement (flush, message
    // invalide, stacker en pause) rend son crédit tout de suite.
    _pump() {
        while (!this._processing && this._queue.length) {
            this._deliver(this._queue.shift());
            if (!this._processing) this._grantCredit();
        }
    }

    _onMessage(event) {
        if (this._flowCredits > 0) {
            if (typeof event.data === 'string') return;   // messages texte (erreurs) : pas de crédit
            this._queue.push(event);
            this._pump();
            return;
        }
        // Backpressure : le stacker traite encore la frame précédente → dropper
        if (this._processing) {
            this._droppedFrames++;
            return;
        }

        this._deliver(event);
    }

    _deliver(event) {
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
        if (meta.format === 'jpeg' || meta.format === 'png') {
            // Bytes JPEG/PNG opaques (déjà débayerisés côté ISP) — pas un tableau
            // de pixels typé, le consommateur (stacker.js) les décode lui-même.
            pixels = new Uint8Array(buf, rawOffset);
        } else if ((meta.bit_depth ?? 16) === 8) {
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
