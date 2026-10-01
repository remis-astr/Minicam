'use strict';
/**
 * Messages du mode « étoiles » (Live Stack ciel profond), partagés par
 * webgpu_stacking_worker.js et cpu_stacking_worker.js — voir dso_stacker.js.
 *
 *   init-stacking { starAlign: {…options}, width, height }  → init-stacking-done
 *   stack-frame-stars { requestId, rgbaBuffer, weight }      → stack-stars-done { requestId, report }
 *   get-stack-snapshot (mode étoiles actif)                  → stack-snapshot-complete
 *   cleanup                                                  → libère, puis traitement habituel
 *
 * handleDsoMessage() renvoie true si le message est traité ici.
 */

import { DsoStacker } from './dso_stacker.js';

let dso = null;

export async function handleDsoMessage(data, { forceCpu = false } = {}) {
    const { type } = data ?? {};

    if (type === 'init-stacking' && data.starAlign) {
        try {
            dso?.destroy();
            dso = null;
            dso = await DsoStacker.create({ width: data.width, height: data.height, forceCpu, ...data.starAlign });
            self.postMessage({ type: 'init-stacking-done', outWidth: data.width, outHeight: data.height,
                               backend: dso.backend });
        } catch (err) {
            self.postMessage({ type: 'init-stacking-error', error: err.message });
        }
        return true;
    }

    if (type === 'stack-frame-stars') {
        const { requestId } = data;
        if (!dso) {
            self.postMessage({ type: 'stack-frame-error', requestId, error: 'Empilement étoiles non initialisé' });
            return true;
        }
        try {
            const rgba = data.rgbaBuffer instanceof Float32Array ? data.rgbaBuffer : new Float32Array(data.rgbaBuffer);
            const report = await dso.addFrame(rgba, { weight: data.weight ?? 1, black: data.black ?? 0 });
            delete report.M;
            self.postMessage({ type: 'stack-stars-done', requestId, report });
        } catch (err) {
            self.postMessage({ type: 'stack-frame-error', requestId, error: err.message });
        }
        return true;
    }

    if (type === 'get-stack-snapshot' && dso) {
        try {
            const snap = await dso.snapshot();
            self.postMessage({ type: 'stack-snapshot-complete', float32Buffer: snap.data.buffer,
                               width: snap.width, height: snap.height, count: snap.count },
                             [snap.data.buffer]);
        } catch (err) {
            self.postMessage({ type: 'snapshot-error', error: err.message });
        }
        return true;
    }

    if (type === 'cleanup') {
        dso?.destroy();
        dso = null;
        return false;   // le worker fait aussi son nettoyage habituel (et répond cleanup-done)
    }

    return false;
}
