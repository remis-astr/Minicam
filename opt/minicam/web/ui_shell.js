'use strict';
/**
 * Comportements communs de l'interface (ui.css) : mode nuit, onglets,
 * taille réelle et plein écran de l'aperçu. Chaque élément est facultatif :
 * une page sans onglets ou sans aperçu appelle simplement initShell().
 *
 * Le thème est aussi posé avant le premier rendu par un petit script en
 * tête de page (pas de flash), ce module ne fait que le bouton.
 */

/** Mode nuit : bouton #btn-theme, choix commun à toutes les pages. */
function initTheme() {
    const btn = document.getElementById('btn-theme');
    const apply = (night) => {
        if (night) document.documentElement.dataset.theme = 'night';
        else delete document.documentElement.dataset.theme;
        btn?.setAttribute('aria-pressed', night ? 'true' : 'false');
    };
    apply(document.documentElement.dataset.theme === 'night');
    btn?.addEventListener('click', () => {
        const night = document.documentElement.dataset.theme !== 'night';
        apply(night);
        try { localStorage.setItem('minicam.theme', night ? 'night' : 'day'); } catch {}
    });
}

/**
 * Onglets : boutons `.tabs [data-tab]`, panneaux `[data-panel]`, onglet
 * courant dans body[data-tab]. L'onglet « capture » n'existe qu'en largeur
 * mobile (la colonne de gauche est toujours visible sur bureau).
 */
function initTabs(storageKey, fallback) {
    const tabs = [...document.querySelectorAll('.tabs [data-tab]')];
    if (!tabs.length) return;
    const mobile = matchMedia('(max-width: 999px)');
    const show = (name) => {
        if (!tabs.some((t) => t.dataset.tab === name)) name = fallback;
        if (name === 'capture' && !mobile.matches) name = fallback;
        document.body.dataset.tab = name;
        for (const t of tabs) t.setAttribute('aria-selected', t.dataset.tab === name ? 'true' : 'false');
        for (const p of document.querySelectorAll('[data-panel]')) p.hidden = p.dataset.panel !== name;
    };
    for (const t of tabs) t.addEventListener('click', () => {
        show(t.dataset.tab);
        try { localStorage.setItem(storageKey, t.dataset.tab); } catch {}
    });
    // passage mobile → bureau avec « Capture » ouvert : revenir à l'onglet par défaut
    mobile.addEventListener('change', () => show(document.body.dataset.tab));
    let saved = fallback;
    try { saved = localStorage.getItem(storageKey) || fallback; } catch {}
    show(saved);
}

/** Aperçu : #btn-zoom (1:1 / ajusté) et #btn-fullscreen sur #preview-box. */
function initViewport() {
    const box = document.getElementById('preview-box');
    if (!box) return;
    const btnZoom = document.getElementById('btn-zoom');
    btnZoom?.addEventListener('click', () => {
        const on = box.classList.toggle('actual');
        btnZoom.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    const btnFs = document.getElementById('btn-fullscreen');
    btnFs?.addEventListener('click', () => {
        if (document.fullscreenElement) document.exitFullscreen();
        else box.requestFullscreen().catch((e) => console.warn('Fullscreen:', e));
    });
    document.addEventListener('fullscreenchange', () => {
        btnFs?.setAttribute('aria-pressed', document.fullscreenElement ? 'true' : 'false');
    });
}

/**
 * Zoom à deux doigts (et molette) sur l'aperçu en plein écran : pincer
 * zoome autour du point pincé (×1 à ×8), un doigt déplace l'image zoomée,
 * double-tap revient à l'image entière. Transformation CSS de l'image (ou de
 * la scène qui la contient) : les clics restent justes (getBoundingClientRect
 * suit la transformation). Remis à zéro en sortant du plein écran.
 */
function initPinchZoom() {
    const box = document.getElementById('preview-box');
    if (!box) return;
    const target = () => box.querySelector('.stage') || box.querySelector('canvas, img');
    let s = 1, tx = 0, ty = 0;
    const pts = new Map();
    let gesture = null;     // état au début du geste courant
    let moved = false;      // geste réel : avaler le clic qui suit
    let lastTap = 0;

    const active = () => document.fullscreenElement === box;
    const apply = () => {
        const t = target();
        if (!t) return;
        t.style.transformOrigin = '0 0';
        t.style.transform = s === 1 ? '' : `translate(${tx}px, ${ty}px) scale(${s})`;
    };
    const reset = () => { s = 1; tx = 0; ty = 0; apply(); };
    // coin de l'image sans transformation (origine 0 0 : rect.left = L + tx)
    const origin = () => { const r = target().getBoundingClientRect(); return { L: r.left - tx, T: r.top - ty }; };
    // garde un point local fixe sous (mx, my) en passant à l'échelle ns
    const zoomAt = (ns, mx, my, base) => {
        const { L, T } = origin();
        const qx = (mx - L - base.tx) / base.s, qy = (my - T - base.ty) / base.s;
        s = Math.min(8, Math.max(1, ns));
        if (s === 1) { tx = 0; ty = 0; } else { tx = mx - L - s * qx; ty = my - T - s * qy; }
        apply();
    };
    const start = () => {
        const p = [...pts.values()];
        if (p.length >= 2) {
            const [a, b] = p;
            gesture = { s, tx, ty, d: Math.hypot(a.x - b.x, a.y - b.y) || 1, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
        } else if (p.length === 1) {
            gesture = { s, tx, ty, x: p[0].x, y: p[0].y };
        } else gesture = null;
    };

    box.addEventListener('pointerdown', (e) => {
        if (!active() || !target()) return;
        pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (pts.size === 1) moved = false;
        start();
    });
    box.addEventListener('pointermove', (e) => {
        if (!pts.has(e.pointerId) || !gesture) return;
        pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
        const p = [...pts.values()];
        if (p.length >= 2) {
            const [a, b] = p;
            const d = Math.hypot(a.x - b.x, a.y - b.y);
            const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
            // zoom autour du point de départ du pincement, puis suivi du milieu des doigts
            zoomAt(gesture.s * d / gesture.d, gesture.mx, gesture.my, gesture);
            if (s > 1) { tx += mx - gesture.mx; ty += my - gesture.my; apply(); }
            moved = true;
        } else if (s > 1) {
            const dx = e.clientX - gesture.x, dy = e.clientY - gesture.y;
            if (Math.abs(dx) + Math.abs(dy) > 6) moved = true;
            tx = gesture.tx + dx; ty = gesture.ty + dy;
            apply();
        }
    });
    const end = (e) => {
        if (!pts.delete(e.pointerId)) return;
        start();    // un doigt levé : le geste continue avec ceux qui restent
        if (e.type === 'pointerup' && pts.size === 0 && !moved && e.pointerType === 'touch') {
            const now = performance.now();
            if (now - lastTap < 300) { reset(); lastTap = 0; } else lastTap = now;
        }
    };
    box.addEventListener('pointerup', end);
    box.addEventListener('pointercancel', end);
    // un geste ne doit pas se terminer en clic (ciblage de la mise au point…)
    box.addEventListener('click', (e) => { if (moved) { e.stopPropagation(); e.preventDefault(); moved = false; } }, true);
    // double-tap tactile = dézoom ; ne pas le laisser aussi quitter le plein écran
    // (la page Caméra quitte le plein écran sur double-clic)
    let lastPointerType = 'mouse';
    box.addEventListener('pointerdown', (e) => { lastPointerType = e.pointerType; }, true);
    box.addEventListener('dblclick', (e) => {
        if (active() && lastPointerType === 'touch') { e.stopPropagation(); e.preventDefault(); }
    }, true);
    box.addEventListener('wheel', (e) => {
        if (!active() || !target()) return;
        e.preventDefault();
        zoomAt(s * Math.exp(-e.deltaY * 0.0015), e.clientX, e.clientY, { s, tx, ty });
    }, { passive: false });
    document.addEventListener('fullscreenchange', () => { if (!active()) { pts.clear(); reset(); } });
}

/**
 * @param {object} [opts]
 * @param {string} [opts.tabsKey]     clé localStorage de l'onglet ouvert
 * @param {string} [opts.defaultTab]  onglet par défaut (bureau)
 * @param {boolean} [opts.viewport]   1:1 et plein écran de l'aperçu (false si
 *                                    la page les gère elle-même)
 */
export function initShell({ tabsKey = null, defaultTab = null, viewport = true } = {}) {
    initTheme();
    if (tabsKey) initTabs(tabsKey, defaultTab);
    if (viewport) initViewport();
    initPinchZoom();     // aussi quand la page gère son plein écran (Caméra)
}
