'use strict';

const WS_URL = `ws://${location.host}/ws/control`;

let ws = null;
let reconnectTimer = null;

const elStatus      = document.getElementById('ws-status');
const elGainInput   = document.getElementById('gain-input');
const elExpoInput   = document.getElementById('expo-input');
const elWbRedInput  = document.getElementById('wb-red-input');
const elWbBlueInput = document.getElementById('wb-blue-input');
const elResSelect   = document.getElementById('res-select');
const elReconnect   = document.getElementById('btn-reconnect');
const elStatusBar   = document.getElementById('status-bar');

function setStatus(msg) { elStatusBar.textContent = msg; }


function setControls(enabled) {
  elGainInput.disabled   = !enabled;
  elExpoInput.disabled   = !enabled;
  elWbRedInput.disabled  = !enabled;
  elWbBlueInput.disabled = !enabled;
  elResSelect.disabled   = !enabled;
  elBtnSeqStart.disabled = !enabled;
}

// --- WebSocket ---

function connect() {
  if (ws) ws.close();
  elStatus.className  = 'badge connecting';
  elStatus.textContent = 'Connexion…';
  setControls(false);

  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    elStatus.className  = 'badge connected';
    elStatus.textContent = 'Connecté';
    setStatus('Connecté');
    send({ cmd: 'status' });
    send({ cmd: 'indi_status' });
  };

  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);

    if (msg.cmd === 'status' || msg.cmd === 'ack') {
      if (msg.gain !== undefined) {
        elGainInput.value = parseFloat(msg.gain).toFixed(1);
        elGainInput.classList.remove('input-error');
        setControls(true);
      }
      if (msg.exposure_ms !== undefined) {
        elExpoInput.value = parseFloat(msg.exposure_ms).toFixed(1);
        elExpoInput.classList.remove('input-error');
      }
      if (msg.resolutions && elResSelect.options.length === 0) {
        msg.resolutions.forEach(r => {
          const o = document.createElement('option');
          o.value = o.textContent = r;
          elResSelect.appendChild(o);
        });
      }
      if (msg.resolution !== undefined) elResSelect.value = msg.resolution;
      if (msg.wb_red !== undefined) {
        // wb_red picamera2 → visuel bleu → champ "Bleu"
        elWbBlueInput.value = parseFloat(msg.wb_red).toFixed(2);
        elWbBlueInput.classList.remove('input-error');
      }
      if (msg.wb_blue !== undefined) {
        // wb_blue picamera2 → visuel rouge → champ "Rouge"
        elWbRedInput.value = parseFloat(msg.wb_blue).toFixed(2);
        elWbRedInput.classList.remove('input-error');
      }
    }

    if (msg.cmd === 'error')        setStatus('Erreur : ' + msg.detail);
    if (msg.cmd === 'seq_frame')    _onSeqFrame(msg);
    if (msg.cmd === 'seq_done')     _onSeqDone(msg);
    if (msg.cmd === 'seq_error')    _onSeqError(msg);
    if (msg.cmd === 'indi_started') _onIndiStarted();
    if (msg.cmd === 'indi_stopped') _onIndiStopped();
    if (msg.cmd === 'indi_status')  _onIndiStatus(msg);
    if (msg.cmd === 'indi_error')   _onIndiError(msg);
  };

  ws.onclose = () => {
    elStatus.className  = 'badge disconnected';
    elStatus.textContent = 'Déconnecté';
    setControls(false);
    setStatus('Déconnecté — reconnexion dans 5 s…');
    reconnectTimer = setTimeout(connect, 5000);
  };

  ws.onerror = () => ws.close();
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN)
    ws.send(JSON.stringify(obj));
}

// --- Champs de saisie avec validation ---

function attachValueInput(el, min, max, onValid) {
  function commit() {
    const v = parseFloat(el.value);
    if (isNaN(v) || v < min || v > max) {
      el.classList.add('input-error');
    } else {
      el.classList.remove('input-error');
      onValid(v);
    }
  }
  el.addEventListener('change', commit);
  el.addEventListener('keydown', e => { if (e.key === 'Enter') { commit(); el.blur(); } });
}

attachValueInput(elGainInput, 1, 64, v => send({ cmd: 'set_gain', value: v }));

attachValueInput(elExpoInput, 0.1, 10000, v => send({ cmd: 'set_exposure', value_ms: v }));

function sendWb() {
  // IMX462 : wb_red picamera2 = bleu visuel, wb_blue picamera2 = rouge visuel
  send({ cmd: 'set_wb', red: parseFloat(elWbBlueInput.value), blue: parseFloat(elWbRedInput.value) });
}

attachValueInput(elWbRedInput,  0.1, 8, sendWb);
attachValueInput(elWbBlueInput, 0.1, 8, sendWb);

elResSelect.addEventListener('change', () => {
  send({ cmd: 'set_resolution', value: elResSelect.value });
  setStatus('Changement de résolution…');
});

// --- Fullscreen ---

const elPreviewBox  = document.getElementById('preview-box');
const elFullscreen  = document.getElementById('btn-fullscreen');

function toggleFullscreen() {
  if (!document.fullscreenElement) elPreviewBox.requestFullscreen();
  else document.exitFullscreen();
}

elFullscreen.addEventListener('click', toggleFullscreen);
elPreviewBox.addEventListener('dblclick', toggleFullscreen);

document.addEventListener('fullscreenchange', () => {
  elFullscreen.textContent = document.fullscreenElement ? '✕' : '⛶';
});

elReconnect.addEventListener('click', () => {
  clearTimeout(reconnectTimer);
  connect();
});

// --- Canvas preview (remplace <img> MJPEG — fonctionne sur tous les navigateurs) ---

const elPreviewCanvas = document.getElementById('preview-canvas');
const previewCtx      = elPreviewCanvas.getContext('2d');
let   previewRunning  = false;

function resizePreviewCanvas() {
  const w = elPreviewBox.clientWidth;
  const h = elPreviewBox.clientHeight;
  if (w > 0 && h > 0 && (elPreviewCanvas.width !== w || elPreviewCanvas.height !== h)) {
    elPreviewCanvas.width  = w;
    elPreviewCanvas.height = h;
  }
}

async function runPreview() {
  previewRunning = true;
  while (previewRunning) {
    const t0 = performance.now();
    try {
      const resp = await fetch('/preview_frame.jpg');
      if (resp.ok) {
        const blob = await resp.blob();
        const bmp  = await createImageBitmap(blob);
        resizePreviewCanvas();
        previewCtx.drawImage(bmp, 0, 0, elPreviewCanvas.width, elPreviewCanvas.height);
        bmp.close();
      }
    } catch (e) {}
    const wait = Math.max(0, 100 - (performance.now() - t0));  // cible ~10 fps
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
  }
}

// --- Histogram (client-side only, never in captured files) ---

const elHistCanvas = document.getElementById('hist-canvas');
const elHistBtn    = document.getElementById('btn-histogram');

let histEnabled = false;
let histTimer   = null;

const offCanvas = document.createElement('canvas');
offCanvas.width  = 320;
offCanvas.height = 180;
const offCtx = offCanvas.getContext('2d', { willReadFrequently: true });

function resizeHistCanvas() {
  elHistCanvas.width  = elPreviewBox.clientWidth;
  elHistCanvas.height = elPreviewBox.clientHeight;
}

function _drawHistFromImageData(data) {
  resizeHistCanvas();
  const r = new Uint32Array(256);
  const g = new Uint32Array(256);
  const b = new Uint32Array(256);
  for (let i = 0; i < data.length; i += 4) {
    r[data[i]]++; g[data[i + 1]]++; b[data[i + 2]]++;
  }
  let maxV = 1;
  for (let i = 0; i < 256; i++) {
    if (r[i] > maxV) maxV = r[i];
    if (g[i] > maxV) maxV = g[i];
    if (b[i] > maxV) maxV = b[i];
  }
  const ctx = elHistCanvas.getContext('2d');
  const W = elHistCanvas.width, H = elHistCanvas.height;
  ctx.clearRect(0, 0, W, H);
  const hw = Math.floor(W * 0.32);
  const hh = Math.floor(H * 0.26);
  const hx = W - hw - 10;
  const hy = H - hh - 10;
  ctx.fillStyle = 'rgba(0,0,0,0.58)';
  ctx.fillRect(hx - 3, hy - 3, hw + 6, hh + 6);
  function drawCh(hist, color) {
    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    for (let i = 0; i < 256; i++) {
      const x = hx + (i / 255) * hw;
      const y = hy + hh - (hist[i] / maxV) * hh;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  drawCh(b, 'rgba(80,130,255,0.85)');
  drawCh(g, 'rgba(80,220,80,0.85)');
  drawCh(r, 'rgba(255,80,80,0.85)');
}

async function updateHistogram() {
  if (!histEnabled) return;
  try {
    if (elPreviewCanvas.width > 0 && elPreviewCanvas.height > 0) {
      // Lire depuis le canvas preview déjà à jour — zéro fetch supplémentaire
      offCtx.drawImage(elPreviewCanvas, 0, 0, offCanvas.width, offCanvas.height);
      _drawHistFromImageData(offCtx.getImageData(0, 0, offCanvas.width, offCanvas.height).data);
    }
  } catch (e) {
    console.error('Histogram error:', e);
  } finally {
    if (histEnabled) histTimer = setTimeout(updateHistogram, 500);
  }
}

function toggleHistogram() {
  histEnabled = !histEnabled;
  elHistBtn.classList.toggle('active', histEnabled);
  if (histEnabled) {
    elHistCanvas.classList.remove('hidden');
    updateHistogram();  // schedule itself via setTimeout
  } else {
    clearTimeout(histTimer);
    elHistCanvas.classList.add('hidden');
    elHistCanvas.getContext('2d').clearRect(0, 0, elHistCanvas.width, elHistCanvas.height);
  }
}

elHistBtn.addEventListener('click', toggleHistogram);

window.addEventListener('resize', resizePreviewCanvas);

// --- Sequence scheduler ---

const elSeqGain  = document.getElementById('seq-gain');
const elSeqExpo  = document.getElementById('seq-expo');
const elSeqCount = document.getElementById('seq-count');
const elBtnSeqStart      = document.getElementById('btn-seq-start');
const elBtnSeqStop       = document.getElementById('btn-seq-stop');
const elSeqProgressBar   = document.getElementById('seq-progress-bar');
const elSeqProgressFill  = document.getElementById('seq-progress-fill');
const elSeqProgressLabel = document.getElementById('seq-progress-label');
const elSeqStatus        = document.getElementById('seq-status');
const elSeqZipLink       = document.getElementById('seq-zip-link');

attachValueInput(elSeqGain, 1, 64, () => {});
attachValueInput(elSeqExpo, 0.1, 10000, () => {});

elBtnSeqStart.addEventListener('click', () => {
  const gain  = parseFloat(elSeqGain.value);
  const expo  = parseFloat(elSeqExpo.value);
  const count = Math.max(1, Math.min(100, parseInt(elSeqCount.value, 10) || 1));
  elSeqZipLink.classList.add('hidden');
  elSeqProgressBar.classList.remove('hidden');
  elSeqProgressFill.style.width = '0%';
  elSeqProgressLabel.textContent = `0 / ${count}`;
  elBtnSeqStart.classList.add('hidden');
  elBtnSeqStop.classList.remove('hidden');
  elSeqStatus.textContent = 'Démarrage…';
  send({ cmd: 'start_sequence', gain, exposure_ms: expo, count });
});

elBtnSeqStop.addEventListener('click', () => {
  send({ cmd: 'stop_sequence' });
  elSeqStatus.textContent = 'Arrêt en cours…';
  elBtnSeqStop.classList.add('hidden');
  elBtnSeqStart.classList.remove('hidden');
});

function _onSeqFrame(msg) {
  const done  = msg.index + 1;
  const total = msg.total;
  const pct   = Math.round((done / total) * 100);
  elSeqProgressFill.style.width  = pct + '%';
  elSeqProgressLabel.textContent = `${done} / ${total}`;
  elSeqStatus.textContent = `Capture ${done}/${total}…`;
}

function _onSeqDone(msg) {
  elSeqProgressFill.style.width  = '100%';
  elSeqProgressLabel.textContent = `${msg.captured} / ${msg.captured}`;
  elSeqStatus.textContent = `Séquence terminée — ${msg.captured} image(s)`;
  elBtnSeqStop.classList.add('hidden');
  elBtnSeqStart.classList.remove('hidden');
  elSeqZipLink.href = msg.zip_url;
  elSeqZipLink.download = `minicam_seq_${msg.session}.zip`;
  elSeqZipLink.classList.remove('hidden');
}

function _onSeqError(msg) {
  elSeqStatus.textContent = 'Erreur : ' + msg.detail;
  elBtnSeqStop.classList.add('hidden');
  elBtnSeqStart.classList.remove('hidden');
}

// --- INDI mode ---

const elBtnIndiStart = document.getElementById('btn-indi-start');
const elBtnIndiStop  = document.getElementById('btn-indi-stop');
const elIndiStatus   = document.getElementById('indi-status');

function _onIndiStarted() {
  elBtnIndiStart.classList.add('hidden');
  elBtnIndiStop.classList.remove('hidden');
  elIndiStatus.textContent = 'INDI actif — port 7624 (preview suspendu)';
  elIndiStatus.className = 'indi-status indi-active';
  previewRunning = false;  // suspend preview loop
  setStatus('Mode INDI actif');
}

function _onIndiStopped() {
  elBtnIndiStop.classList.add('hidden');
  elBtnIndiStart.classList.remove('hidden');
  elIndiStatus.textContent = 'Mode API actif';
  elIndiStatus.className = 'indi-status';
  runPreview();  // resume preview loop
  setStatus('Mode API actif');
  send({ cmd: 'status' });
}

function _onIndiStatus(msg) {
  if (msg.running) _onIndiStarted(); else _onIndiStopped();
}

function _onIndiError(msg) {
  elIndiStatus.textContent = 'Erreur INDI : ' + msg.detail;
  elIndiStatus.className = 'indi-status indi-error';
  elBtnIndiStop.classList.add('hidden');
  elBtnIndiStart.classList.remove('hidden');
  if (!previewRunning) runPreview();
}

elBtnIndiStart.addEventListener('click', () => {
  elIndiStatus.textContent = 'Démarrage INDI…';
  send({ cmd: 'start_indi' });
});

elBtnIndiStop.addEventListener('click', () => {
  elIndiStatus.textContent = 'Arrêt INDI…';
  send({ cmd: 'stop_indi' });
});

// --- System (reboot / shutdown) ---

const elBtnReboot   = document.getElementById('btn-reboot');
const elBtnShutdown = document.getElementById('btn-shutdown');
const elSysStatus   = document.getElementById('sys-status');

async function sysAction(action, label) {
  if (!confirm(`Confirmer : ${label} du Pi0 ?`)) return;
  elSysStatus.textContent = `${label} en cours…`;
  elBtnReboot.disabled   = true;
  elBtnShutdown.disabled = true;
  try {
    const r = await fetch(`/system/${action}`, { method: 'POST' });
    const j = await r.json();
    elSysStatus.textContent = j.ok
      ? `${label} demandé — la connexion va se couper.`
      : `Erreur : ${JSON.stringify(j)}`;
  } catch (e) {
    elSysStatus.textContent = `Erreur : ${e}`;
    elBtnReboot.disabled   = false;
    elBtnShutdown.disabled = false;
  }
}

elBtnReboot.addEventListener('click',   () => sysAction('reboot',   'Redémarrage'));
elBtnShutdown.addEventListener('click', () => sysAction('shutdown', 'Arrêt'));

connect();
runPreview();
