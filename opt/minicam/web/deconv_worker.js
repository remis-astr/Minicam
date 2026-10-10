'use strict';
/**
 * Worker de déconvolution (voir deconv.js) : calcul lourd hors du fil
 * principal, avancement par itération.
 *   { rgba (Float32Array RGBA), w, h, params } → { type: 'progress', done, total }…
 *                                              → { type: 'done', result } | { type: 'error', error }
 */
import { prepareDeconv } from './deconv.js';

self.onmessage = async ({ data }) => {
    try {
        const r = await prepareDeconv(data.rgba, data.w, data.h, data.params,
                                (done, total) => self.postMessage({ type: 'progress', done, total }));
        if (r.error) { self.postMessage({ type: 'error', error: r.error }); return; }
        delete r.masks;   // Map recréée côté page
        self.postMessage({ type: 'done', result: r }, [r.D.buffer, r.L.buffer, r.Ls.buffer]);
    } catch (e) {
        self.postMessage({ type: 'error', error: e.message });
    }
};
