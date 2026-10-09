'use strict';
/**
 * Histogramme de l'image affichée et barre d'état (ui.css), communs à
 * Lucky Stack et Live Stack.
 */

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/**
 * Histogramme R, V, B de ce qui est affiché (après étirement et
 * accentuation) : échelle logarithmique — le fond noir d'une planète
 * écraserait tout le reste en linéaire —, part des pixels écrêtés au blanc.
 * Recalculé périodiquement sur une copie réduite du canvas (~2 ms), et
 * seulement si l'onglet est visible.
 */
export class HistogramStrip {
    /**
     * @param {HTMLCanvasElement} source  canvas de l'aperçu
     * @param {HTMLCanvasElement} target  canvas de l'histogramme
     * @param {HTMLElement} [clipLabel]   reçoit « écrêté x % »
     */
    constructor(source, target, clipLabel = null, intervalMs = 700) {
        this._src = source;
        this._dst = target;
        this._label = clipLabel;
        this._interval = intervalMs;
        this._off = document.createElement('canvas');
        this._offCtx = this._off.getContext('2d', { willReadFrequently: true });
        this._timer = null;
    }

    start() {
        if (this._timer) return;
        const tick = () => {
            if (!document.hidden) this.update();
            this._timer = setTimeout(tick, this._interval);
        };
        tick();
    }

    stop() { clearTimeout(this._timer); this._timer = null; }

    update() {
        const sw = this._src.width, sh = this._src.height;
        if (!sw || !sh) { this._clear(); return; }
        const k = Math.min(1, 320 / Math.max(sw, sh));
        const w = Math.max(1, Math.round(sw * k)), h = Math.max(1, Math.round(sh * k));
        if (this._off.width !== w || this._off.height !== h) { this._off.width = w; this._off.height = h; }
        this._offCtx.drawImage(this._src, 0, 0, w, h);
        const d = this._offCtx.getImageData(0, 0, w, h).data;
        const r = new Uint32Array(256), g = new Uint32Array(256), b = new Uint32Array(256);
        let clipped = 0, lit = 0;
        for (let i = 0; i < d.length; i += 4) {
            r[d[i]]++; g[d[i + 1]]++; b[d[i + 2]]++;
            if (d[i] >= 255 || d[i + 1] >= 255 || d[i + 2] >= 255) clipped++;
            if (d[i] + d[i + 1] + d[i + 2] > 24) lit++;
        }
        this._draw([r, g, b]);
        if (this._label) {
            // part des pixels éclairés (pas du fond noir) qui sont écrêtés
            const pct = lit ? (clipped / lit) * 100 : 0;
            this._label.textContent = lit ? `écrêté ${pct < 0.1 && pct > 0 ? '< 0,1' : pct.toFixed(1).replace('.', ',')} %` : '';
            this._label.classList.toggle('warn', pct >= 1);
        }
    }

    _clear() {
        const ctx = this._dst.getContext('2d');
        ctx.clearRect(0, 0, this._dst.width, this._dst.height);
        if (this._label) this._label.textContent = '';
    }

    _draw(channels) {
        const c = this._dst;
        const W = Math.max(1, Math.round(c.clientWidth * devicePixelRatio));
        const H = Math.max(1, Math.round(c.clientHeight * devicePixelRatio));
        if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
        const ctx = c.getContext('2d');
        ctx.clearRect(0, 0, W, H);
        const night = document.documentElement.dataset.theme === 'night';
        const colors = night
            ? [css('--text'), css('--muted'), css('--line')]
            : ['#e5675c', '#5cb98a', '#5fa8dc'];
        let max = 1;
        for (const ch of channels) for (let i = 1; i < 255; i++) max = Math.max(max, ch[i]);
        const lmax = Math.log1p(max);
        ctx.globalCompositeOperation = night ? 'source-over' : 'lighter';
        channels.forEach((ch, n) => {
            ctx.beginPath();
            ctx.moveTo(0, H);
            for (let i = 0; i < 256; i++) {
                const x = (i / 255) * W;
                const y = H - (Math.log1p(Math.min(ch[i], max)) / lmax) * (H - 2);
                ctx.lineTo(x, y);
            }
            ctx.lineTo(W, H);
            ctx.closePath();
            ctx.globalAlpha = 0.35;
            ctx.fillStyle = colors[n];
            ctx.fill();
            ctx.globalAlpha = 0.9;
            ctx.strokeStyle = colors[n];
            ctx.lineWidth = devicePixelRatio;
            ctx.stroke();
        });
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
    }
}

/**
 * Barre d'état : éléments `[data-status="clé"]` dans `.statusbar` ; la
 * valeur va dans leur `<b>`. Ajoute la santé du Pi (température, sous-
 * tension) depuis /system/health et le GPU utilisé.
 */
export class StatusBar {
    constructor(root = document.querySelector('.statusbar')) {
        this._root = root;
        this._healthTimer = null;
    }

    set(key, value, level = null) {
        const el = this._root?.querySelector(`[data-status="${key}"]`);
        if (!el) return;
        const b = el.querySelector('b') ?? el;
        b.textContent = value;
        el.classList.toggle('warn', level === 'warn');
        el.classList.toggle('bad', level === 'bad');
    }

    /** Cadence (images/s) sur une fenêtre glissante de `windowS` secondes. */
    rateMeter(windowS = 5) {
        const ts = [];
        return {
            tick: () => {
                const now = performance.now();
                ts.push(now);
                while (ts.length && now - ts[0] > windowS * 1000) ts.shift();
            },
            value: () => {
                const now = performance.now();
                while (ts.length && now - ts[0] > windowS * 1000) ts.shift();
                if (ts.length < 2) return 0;
                return (ts.length - 1) / ((ts[ts.length - 1] - ts[0]) / 1000 || 1);
            },
        };
    }

    /** Santé du Pi toutes les `periodMs` (route /system/health). */
    watchHealth(periodMs = 15000) {
        const poll = async () => {
            try {
                const r = await fetch('/system/health', { cache: 'no-store' });
                if (!r.ok) throw new Error(r.status);
                const h = await r.json();
                if (h.cpu_temp_c != null) {
                    const t = h.cpu_temp_c;
                    this.set('pi-temp', `${t.toFixed(0)} °C`, t >= 80 ? 'bad' : t >= 70 ? 'warn' : null);
                }
                if (h.undervoltage != null)
                    this.set('pi-power', h.undervoltage ? 'sous-tension' : 'OK', h.undervoltage ? 'bad' : null);
            } catch {
                this.set('pi-temp', '—');
            }
        };
        poll();
        this._healthTimer = setInterval(() => { if (!document.hidden) poll(); }, periodMs);
    }
}
