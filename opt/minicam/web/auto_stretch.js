/**
 * auto_stretch.js — étirement automatique de l'aperçu (Live Stack)
 *
 * Arcsinh à couleurs préservées (Lupton et al. 2004) : la courbe est calculée
 * sur la luminance I = (R+G+B)/3 et les trois canaux sont multipliés par le
 * même facteur f(I)/I, ce qui garde la teinte et les rapports de couleur (le
 * cœur d'une galaxie ne délave plus en blanc).
 *
 * Paramètres déduits de l'image à chaque aperçu, sur un échantillon 1/16 :
 *  - noir de chaque canal : médiane − 2,8 σ (σ = 1,4826 × MAD, moyen des
 *    trois canaux) → fond neutre, au même niveau sur R, G, B ;
 *  - balance des blancs sur le signal (monde gris des pixels > 10 σ au-dessus
 *    du fond et non saturés : étoiles et objet), le fond restant neutre ;
 *  - blanc : quantile 99,995 % de la luminance ;
 *  - β tel que le fond tombe au niveau visé (« Fond »). En automatique, ce
 *    niveau monte de 10 % à 18 % à mesure que le bruit du stack baisse
 *    (équivalent de 1 à 25 images d'après la baisse du σ mesuré).
 * Options : contraste local grande échelle (flou large calculé sur l'image
 * réduite ÷4, hautes lumières protégées) et retrait du vert (SCNR neutre moyen
 * lissé, luminosité conservée : voir removeGreen8).
 *
 * N'agit que sur l'affichage : les données du stack (export FITS) restent brutes.
 */

const HB = 65536;   // cases d'histogramme des statistiques
const LN = 65536;   // entrées de la table de la courbe

export const AUTO_STRETCH_DEFAULTS = {
    shadowsClip:   -2.8,
    targetMin:     0.10,   // fond visé au premier aperçu (stack bruité)
    targetMax:     0.18,   // fond visé une fois le bruit divisé par 5 (≈ 25 images)
    rampImages:    25,
    lceAmount:     0.8,
    lceRadiusFrac: 1 / 40, // rayon du contraste local / plus grande dimension
    smoothing:     0.5,    // poids du nouvel aperçu dans le lissage des statistiques
};

// Médiane, MAD (σ robuste), min et quantile haut par histogramme : O(n), sans tri
function robustStats(d, n, ch, step) {
    let lo = Infinity, hi = -Infinity, cnt = 0;
    const val = ch < 3 ? (i) => d[i * 4 + ch] : (i) => (d[i * 4] + d[i * 4 + 1] + d[i * 4 + 2]) / 3;
    for (let i = 0; i < n; i += step) {
        if (d[i * 4 + 3] <= 0) continue;
        const v = val(i);
        if (v < lo) lo = v;
        if (v > hi) hi = v;
        cnt++;
    }
    if (!cnt) return null;
    const k = (HB - 1) / Math.max(hi - lo, 1e-12);
    const hist = new Uint32Array(HB);
    for (let i = 0; i < n; i += step) if (d[i * 4 + 3] > 0) hist[((val(i) - lo) * k) | 0]++;
    const quant = (h, q) => {
        const t = q * cnt;
        let acc = 0;
        for (let b = 0; b < HB; b++) { acc += h[b]; if (acc >= t) return b; }
        return HB - 1;
    };
    const med = lo + (quant(hist, 0.5) + 0.5) / k;
    const top = lo + (quant(hist, 0.99995) + 0.5) / k;
    hist.fill(0);
    for (let i = 0; i < n; i += step)
        if (d[i * 4 + 3] > 0) hist[Math.min(HB - 1, (Math.abs(val(i) - med) * k) | 0)]++;
    const sigma = 1.4826 * (quant(hist, 0.5) + 0.5) / k;
    return { med, sigma, min: lo, max: hi, top };
}

/** Statistiques brutes de l'image (avant lissage). null si rien de couvert. */
export function measureAutoStretch(rgba, w, h, opts = {}) {
    const o = { ...AUTO_STRETCH_DEFAULTS, ...opts };
    const n = w * h, step = 16;
    const st = [0, 1, 2].map((c) => robustStats(rgba, n, c, step));
    if (st.some((s) => !s)) return null;
    // balance des blancs sur le signal, gains rapportés au vert
    let gains = [1, 1, 1];
    const maxAll = Math.max(st[0].max, st[1].max, st[2].max);
    const sum = [0, 0, 0];
    let cnt = 0;
    for (let i = 0; i < n; i += 4) {
        if (rgba[i * 4 + 3] <= 0) continue;
        const r = rgba[i * 4] - st[0].med, g = rgba[i * 4 + 1] - st[1].med, b = rgba[i * 4 + 2] - st[2].med;
        if (r < 10 * st[0].sigma || g < 10 * st[1].sigma || b < 10 * st[2].sigma) continue;
        if (Math.max(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]) > 0.9 * maxAll) continue;
        sum[0] += r; sum[1] += g; sum[2] += b; cnt++;
    }
    if (cnt > 100 && sum[0] > 0 && sum[2] > 0)
        gains = [sum[1] / sum[0], 1, sum[1] / sum[2]].map((v) => Math.max(0.25, Math.min(4, v)));
    // après balance (appliquée autour du fond) : σ et noirs par canal
    const sig = st.map((s, c) => s.sigma * gains[c]);
    const sigMean = (sig[0] + sig[1] + sig[2]) / 3;
    const c0 = st.map((s) => s.med + o.shadowsClip * sigMean);
    // luminance après noir : fond et blanc (le haut de la luminance mesurée,
    // corrigé de la balance comme moyenne des gains)
    const bg = -o.shadowsClip * sigMean;                       // fond au-dessus du noir
    const sL = robustStats(rgba, n, 3, step);
    const gMean = (gains[0] + gains[1] + gains[2]) / 3;
    const medMean = (st[0].med + st[1].med + st[2].med) / 3;
    const white = Math.max((sL.top - medMean) * gMean + bg, bg * 4, 1e-6);
    return { med: st.map((s) => s.med), gains, c0, bg, white, sigma: sigMean };
}

// β tel que asinh(β x)/asinh(β) = t (bissection en échelle log)
function betaFor(x, t) {
    if (!(x > 0) || x >= t) return 1e-3;
    let a = 1e-3, b = 1e8;
    for (let k = 0; k < 70; k++) {
        const c = Math.sqrt(a * b);
        if (Math.asinh(c * x) / Math.asinh(c) < t) a = c; else b = c;
    }
    return Math.sqrt(a * b);
}

/**
 * Paramètres de l'aperçu, lissés d'un aperçu à l'autre.
 * @param state  objet conservé par l'appelant entre deux aperçus ({} au départ,
 *               remis à {} quand le stack repart de zéro)
 * @param key    identité du snapshot : même clé = simple re-rendu (curseur
 *               déplacé), les statistiques mémorisées sont réutilisées
 * @param target niveau du fond visé (0–1), ou null = automatique
 */
export function autoStretchParams(rgba, w, h, state, key, target = null, opts = {}) {
    const o = { ...AUTO_STRETCH_DEFAULTS, ...opts };
    if (state.key !== key || !state.stats) {
        const m = measureAutoStretch(rgba, w, h, o);
        if (!m) return null;
        const p = state.stats;
        if (p) {
            const a = o.smoothing, mix = (x, y) => a * x + (1 - a) * y;
            for (const k of ['bg', 'white', 'sigma']) m[k] = mix(m[k], p[k]);
            for (const k of ['med', 'gains', 'c0']) m[k] = m[k].map((v, c) => mix(v, p[k][c]));
        }
        // nombre d'images équivalent : le σ baisse comme 1/√N
        if (state.sigmaRef == null) { state.sigmaRef = m.sigma; state.nRef = Math.max(1, opts.count ?? 1); }
        state.nEff = state.nRef * (state.sigmaRef / Math.max(m.sigma, 1e-12)) ** 2;
        state.stats = m;
        state.key = key;
    }
    const m = state.stats;
    let t = target;
    if (t == null) {
        const r = Math.max(0, Math.min(1, Math.log(Math.max(1, state.nEff)) / Math.log(o.rampImages)));
        t = o.targetMin + (o.targetMax - o.targetMin) * r;
    }
    const beta = betaFor(m.bg / m.white, t);
    return { ...m, target: t, beta, nEff: state.nEff };
}

/**
 * Rendu RGBA 8 bits de l'aperçu (ImageData.data) avec les paramètres ci-dessus.
 * Pixels jamais couverts (alpha 0) : noirs.
 */
export function autoStretchRender(rgba, w, h, p, out, { localContrast = 0, opts = {} } = {}) {
    const o = { ...AUTO_STRETCH_DEFAULTS, ...opts };
    const n = w * h, { gains, med, c0, white, beta } = p;
    const inv = 1 / white, ab = Math.asinh(beta);
    // canal après balance et noir, normalisé : ((v − med)·g + med − c0) / white
    const off = [0, 1, 2].map((c) => (med[c] - c0[c]) * inv);
    const sc = gains.map((g) => g * inv);
    // luminance normalisée
    const I = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        const j = i * 4;
        I[i] = ((rgba[j] - med[0]) * sc[0] + off[0] + (rgba[j + 1] - med[1]) * sc[1] + off[1]
              + (rgba[j + 2] - med[2]) * sc[2] + off[2]) / 3;
    }
    // facteur calculé sur une luminance lissée 3×3 : le bruit du fond ne module
    // pas chaque canal à sa façon (bruit chromatique)
    const Ig = box3(I, w, h);
    // table de f(x) sur [0, 1] (au-delà : formule directe)
    const lut = new Float32Array(LN);
    for (let i = 0; i < LN; i++) lut[i] = Math.asinh(beta * i / (LN - 1)) / ab;
    const f = (x) => x <= 0 ? 0 : x < 1 ? lut[(x * (LN - 1) + 0.5) | 0] : Math.asinh(beta * x) / ab;
    const g0 = beta / ab;   // pente à l'origine : f(x)/x quand x → 0
    // contraste local : étiré + a·(étiré − flou large de l'étiré)·(1 − étiré)
    let small = null, sw = 0, sh = 0;
    const F = 4;
    if (localContrast > 0) {
        sw = Math.ceil(w / F); sh = Math.ceil(h / F);
        small = new Float32Array(sw * sh);
        const cntS = new Float32Array(sw * sh);
        for (let y = 0; y < h; y++) {
            const ys = ((y / F) | 0) * sw, row = y * w;
            for (let x = 0; x < w; x++) { const s = ys + ((x / F) | 0); small[s] += f(Ig[row + x]); cntS[s]++; }
        }
        for (let s = 0; s < small.length; s++) small[s] /= cntS[s];
        const r = Math.max(1, Math.round(Math.max(w, h) * o.lceRadiusFrac / F));
        small = boxBlur(boxBlur(boxBlur(small, sw, sh, r), sw, sh, r), sw, sh, r);   // ≈ gaussienne
    }
    const a = localContrast === true ? o.lceAmount : localContrast;
    for (let y = 0; y < h; y++) {
        let fy = 0, y0 = 0, ty = 0;
        if (small) { fy = Math.min(sh - 1.0001, Math.max(0, (y + 0.5) / F - 0.5)); y0 = fy | 0; ty = fy - y0; }
        for (let x = 0; x < w; x++) {
            const i = y * w + x, j = i * 4;
            if (rgba[j + 3] <= 0) { out[j] = out[j + 1] = out[j + 2] = 0; out[j + 3] = 255; continue; }
            const ig = Ig[i];
            let k;
            if (small) {
                const s = f(ig);
                const fx = Math.min(sw - 1.0001, Math.max(0, (x + 0.5) / F - 0.5)), x0 = fx | 0, tx = fx - x0, q = y0 * sw + x0;
                const b = (small[q] * (1 - tx) + small[q + 1] * tx) * (1 - ty)
                        + (small[q + sw] * (1 - tx) + small[q + sw + 1] * tx) * ty;
                const v = Math.max(0, s + a * (s - b) * (1 - Math.min(s, 1)));
                k = ig > 1e-7 ? v / ig : g0;
            } else {
                k = ig > 1e-7 ? f(ig) / ig : g0;
            }
            let r = ((rgba[j] - med[0]) * sc[0] + off[0]) * k;
            let g = ((rgba[j + 1] - med[1]) * sc[1] + off[1]) * k;
            let b = ((rgba[j + 2] - med[2]) * sc[2] + off[2]) * k;
            const mx = Math.max(r, g, b);
            if (mx > 1) { r /= mx; g /= mx; b /= mx; }   // hors gamut : teinte conservée
            out[j]     = r > 0 ? r * 255 + 0.5 : 0;
            out[j + 1] = g > 0 ? g * 255 + 0.5 : 0;
            out[j + 2] = b > 0 ? b * 255 + 0.5 : 0;
            out[j + 3] = 255;
        }
    }
}

/**
 * Contraste local sur une image RGBA 8 bits déjà étirée (mode manuel ; le
 * mode auto l'applique dans autoStretchRender, sur la luminance flottante) :
 * même formule, L + a·(L − flou large de L)·(1 − L), flou calculé sur
 * l'image réduite ÷4, R, G, B multipliés par le même facteur.
 */
export function localContrast8(d, w, h, amount, opts = {}) {
    if (!(amount > 0)) return;
    const o = { ...AUTO_STRETCH_DEFAULTS, ...opts };
    const F = 4, sw = Math.ceil(w / F), sh = Math.ceil(h / F), ns = sw * sh;
    const S = new Float32Array(ns), C = new Float32Array(ns);
    for (let y = 0; y < h; y++) {
        const ys = (y >> 2) * sw;   // F = 4
        let j = y * w * 4;
        for (let x = 0; x < w; x++, j += 4) {
            const s = ys + (x >> 2);
            S[s] += d[j] + d[j + 1] + d[j + 2]; C[s]++;
        }
    }
    for (let s = 0; s < ns; s++) S[s] /= C[s] * 765;
    const r = Math.max(1, Math.round(Math.max(w, h) * o.lceRadiusFrac / F));
    const Bs = boxBlur(boxBlur(boxBlur(S, sw, sh, r), sw, sh, r), sw, sh, r);
    const X0 = new Int32Array(w), TX = new Float32Array(w);
    for (let x = 0; x < w; x++) {
        const fx = Math.min(sw - 1.0001, Math.max(0, (x + 0.5) / F - 0.5));
        X0[x] = fx | 0; TX[x] = fx - X0[x];
    }
    const row = new Float32Array(sw);
    for (let y = 0; y < h; y++) {
        const fy = Math.min(sh - 1.0001, Math.max(0, (y + 0.5) / F - 0.5)), y0 = fy | 0, ty = fy - y0;
        const o0 = y0 * sw, o1 = o0 + sw;
        for (let s = 0; s < sw; s++) row[s] = Bs[o0 + s] * (1 - ty) + Bs[o1 + s] * ty;
        let j = y * w * 4;
        for (let x = 0; x < w; x++, j += 4) {
            const L = (d[j] + d[j + 1] + d[j + 2]) / 765;
            if (L <= 0) continue;
            const b = row[X0[x]] * (1 - TX[x]) + row[X0[x] + 1] * TX[x];
            const v = Math.max(0, L + amount * (L - b) * (1 - Math.min(L, 1)));
            const k = v / L;
            let rr = d[j] * k, g = d[j + 1] * k, bb = d[j + 2] * k;
            const mx = Math.max(rr, g, bb);
            if (mx > 255) { const q = 255 / mx; rr *= q; g *= q; bb *= q; }
            d[j] = rr + 0.5; d[j + 1] = g + 0.5; d[j + 2] = bb + 0.5;
        }
    }
}

/**
 * Retrait du vert sur une image RGBA 8 bits déjà étirée (les deux modes).
 * SCNR « neutre moyen » (G ≤ (R+B)/2) calculé sur les moyennes locales
 * (≈ 12 px : image ÷4 floutée) et appliqué comme facteur doux, puis
 * luminosité (R+G+B) rétablie avec le même facteur lissé. Un SCNR pixel par
 * pixel remplace le vert, le canal le moins bruité, par le bruit du rouge et
 * du bleu (grain du cœur de M31 +35 %) et assombrit les zones verdâtres.
 */
export function removeGreen8(d, w, h) {
    const F = 4, sw = Math.ceil(w / F), sh = Math.ceil(h / F), ns = sw * sh;
    const R = new Float32Array(ns), G = new Float32Array(ns), B = new Float32Array(ns), C = new Float32Array(ns);
    for (let y = 0; y < h; y++) {
        const ys = (y >> 2) * sw;   // F = 4
        let j = y * w * 4;
        for (let x = 0; x < w; x++, j += 4) {
            const s = ys + (x >> 2);
            R[s] += d[j]; G[s] += d[j + 1]; B[s] += d[j + 2]; C[s]++;
        }
    }
    for (let s = 0; s < ns; s++) { R[s] /= C[s]; G[s] /= C[s]; B[s] /= C[s]; }
    const Rb = boxBlur(R, sw, sh, 1), Gb = boxBlur(G, sw, sh, 1), Bb = boxBlur(B, sw, sh, 1);
    // par case : facteur du vert f et facteur de luminosité l
    const fG = new Float32Array(ns), fL = new Float32Array(ns);
    for (let s = 0; s < ns; s++) {
        const r = Rb[s], g = Gb[s], b = Bb[s];
        const f = g > 1e-3 ? Math.min(1, (r + b) / (2 * g)) : 1;
        fG[s] = f;
        fL[s] = (r + f * g + b) > 1e-3 ? (r + g + b) / (r + f * g + b) : 1;
    }
    // interpolation bilinéaire : colonnes précalculées, lignes interpolées une fois par y
    const X0 = new Int32Array(w), TX = new Float32Array(w);
    for (let x = 0; x < w; x++) {
        const fx = Math.min(sw - 1.0001, Math.max(0, (x + 0.5) / F - 0.5));
        X0[x] = fx | 0; TX[x] = fx - X0[x];
    }
    const rowG = new Float32Array(sw), rowL = new Float32Array(sw);
    for (let y = 0; y < h; y++) {
        const fy = Math.min(sh - 1.0001, Math.max(0, (y + 0.5) / F - 0.5)), y0 = fy | 0, ty = fy - y0;
        const o0 = y0 * sw, o1 = o0 + sw;
        let any = false;
        for (let s = 0; s < sw; s++) {
            rowG[s] = fG[o0 + s] * (1 - ty) + fG[o1 + s] * ty;
            rowL[s] = fL[o0 + s] * (1 - ty) + fL[o1 + s] * ty;
            if (rowG[s] < 0.999) any = true;
        }
        if (!any) continue;
        for (let x = 0; x < w; x++) {
            const x0 = X0[x], tx = TX[x];
            const f = rowG[x0] * (1 - tx) + rowG[x0 + 1] * tx;
            if (f >= 0.999) continue;
            const l = rowL[x0] * (1 - tx) + rowL[x0 + 1] * tx, j = (y * w + x) * 4;
            let r = d[j] * l, g = d[j + 1] * f * l, b = d[j + 2] * l;
            const mx = Math.max(r, g, b);
            if (mx > 255) { const k = 255 / mx; r *= k; g *= k; b *= k; }   // teinte conservée
            d[j] = r + 0.5; d[j + 1] = g + 0.5; d[j + 2] = b + 0.5;
        }
    }
}

function box3(src, w, h) {
    return boxBlur(src, w, h, 1);
}

// Flou boîte séparable de rayon r, bords répétés, O(n) quel que soit r
function boxBlur(src, w, h, r) {
    const tmp = new Float32Array(src.length), dst = new Float32Array(src.length), k = 1 / (2 * r + 1);
    for (let y = 0; y < h; y++) {
        const o = y * w;
        let acc = 0;
        for (let x = -r; x <= r; x++) acc += src[o + Math.min(w - 1, Math.max(0, x))];
        for (let x = 0; x < w; x++) {
            tmp[o + x] = acc * k;
            acc += src[o + Math.min(w - 1, x + r + 1)] - src[o + Math.max(0, x - r)];
        }
    }
    for (let x = 0; x < w; x++) {
        let acc = 0;
        for (let y = -r; y <= r; y++) acc += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
        for (let y = 0; y < h; y++) {
            dst[y * w + x] = acc * k;
            acc += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
        }
    }
    return dst;
}
