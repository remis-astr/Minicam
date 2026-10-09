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
}
