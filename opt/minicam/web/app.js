'use strict';

const WS_URL = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/control`;

let ws = null;
let reconnectTimer = null;

const elStatus      = document.getElementById('ws-status');
const elGainInput   = document.getElementById('gain-input');
const elGainHint    = document.getElementById('gain-hint');
const elExpoInput   = document.getElementById('expo-input');
const elWbRedInput       = document.getElementById('wb-red-input');
const elWbBlueInput      = document.getElementById('wb-blue-input');
const elContrastInput    = document.getElementById('contrast-input');
const elSharpnessInput   = document.getElementById('sharpness-input');
const elSaturationInput  = document.getElementById('saturation-input');
const elBrightnessInput  = document.getElementById('brightness-input');
const elNrInput          = document.getElementById('nr-input');
const elResSelect        = document.getElementById('res-select');
const elCameraErrorBanner = document.getElementById('camera-error-banner');
const elReconnect   = document.getElementById('btn-reconnect');
const elStatusBar   = document.getElementById('status-bar');

function setStatus(msg) { elStatusBar.textContent = msg; }


function setControls(enabled) {
  elGainInput.disabled       = !enabled;
  elExpoInput.disabled       = !enabled;
  elWbRedInput.disabled      = !enabled;
  elWbBlueInput.disabled     = !enabled;
  elContrastInput.disabled   = !enabled;
  elSharpnessInput.disabled  = !enabled;
  elSaturationInput.disabled = !enabled;
  elBrightnessInput.disabled = !enabled;
  elNrInput.disabled         = !enabled;
  elResSelect.disabled       = !enabled;
  if (document.getElementById('btn-tl-start'))
    document.getElementById('btn-tl-start').disabled = !enabled;
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
    syncClock();
    send({ cmd: 'status' });
    send({ cmd: 'indi_status' });
    send({ cmd: 'timelapse_status' });
  };

  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);

    if (msg.cmd === 'status' || msg.cmd === 'ack') {
      if (msg.camera_error !== undefined) {
        if (msg.camera_error) {
          elCameraErrorBanner.textContent = 'Caméra indisponible : ' + msg.camera_error;
          elCameraErrorBanner.classList.remove('hidden');
        } else {
          elCameraErrorBanner.classList.add('hidden');
        }
      }
      if (msg.gain_max !== undefined) {
        elGainInput.max = msg.gain_max;
        elGainHint.textContent = `(1 – ${msg.gain_max})`;
      }
      if (msg.gain !== undefined) {
        elGainInput.value = parseFloat(msg.gain).toFixed(1);
        elGainInput.classList.remove('input-error');
      }
      if (msg.open !== undefined) setControls(msg.open);
      if (msg.exposure_ms !== undefined) {
        elExpoInput.value = parseFloat(msg.exposure_ms).toFixed(1);
        elExpoInput.classList.remove('input-error');
      }
      if (msg.raw_modes_info) {
        // libellés « nom — L×H (binning) », comme Lucky/Live Stack
        msg.raw_modes_info.forEach((m, i) => {
          const label = `${m.name} — ${m.width}×${m.height}${m.binned ? ' (binning)' : ''}`;
          if (elResSelect.options[i]?.value === m.name) elResSelect.options[i].textContent = label;
          else if (elResSelect.options.length === i) elResSelect.add(new Option(label, m.name));
        });
      } else if (msg.raw_modes && elResSelect.options.length === 0) {
        msg.raw_modes.forEach(r => {
          const o = document.createElement('option');
          o.value = o.textContent = r;
          elResSelect.appendChild(o);
        });
      }
      if (msg.raw_mode !== undefined) elResSelect.value = msg.raw_mode;
      if (msg.wb_red !== undefined) {
        elWbBlueInput.value = parseFloat(msg.wb_red).toFixed(2);
        elWbBlueInput.classList.remove('input-error');
      }
      if (msg.wb_blue !== undefined) {
        elWbRedInput.value = parseFloat(msg.wb_blue).toFixed(2);
        elWbRedInput.classList.remove('input-error');
      }
      if (msg.contrast !== undefined)       elContrastInput.value   = parseFloat(msg.contrast).toFixed(1);
      if (msg.sharpness !== undefined)      elSharpnessInput.value  = parseFloat(msg.sharpness).toFixed(1);
      if (msg.saturation !== undefined)     elSaturationInput.value = parseFloat(msg.saturation).toFixed(1);
      if (msg.brightness !== undefined)     elBrightnessInput.value = parseFloat(msg.brightness).toFixed(2);
      if (msg.noise_reduction !== undefined) elNrInput.value = msg.noise_reduction;
    }

    if (msg.cmd === 'error')        setStatus('Erreur : ' + msg.detail);
    if (msg.cmd === 'indi_started') _onIndiStarted();
    if (msg.cmd === 'indi_stopped') _onIndiStopped();
    if (msg.cmd === 'indi_status')  _onIndiStatus(msg);
    if (msg.cmd === 'indi_error')   _onIndiError(msg);
    if (msg.cmd === 'tl_started')   _onTlStarted(msg);
    if (msg.cmd === 'tl_frame')     _onTlFrame(msg);
    if (msg.cmd === 'tl_done')      _onTlDone(msg);
    if (msg.cmd === 'tl_error')     _onTlError(msg);
    if (msg.cmd === 'tl_status')    _onTlStatus(msg);
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

// Le minicam n'a pas d'horloge temps réel matérielle : en mode hotspot il
// n'a jamais d'accès Internet pour se synchroniser en NTP. Le navigateur a
// en général l'heure correcte, donc on la lui transmet à chaque connexion.
function syncClock() {
  fetch('/system/time', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ epoch_ms: Date.now() }),
  }).catch(() => {});
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

attachValueInput(elExpoInput, 0.1, 120000, v => send({ cmd: 'set_exposure', value_ms: v }));

function sendWb() {
  send({ cmd: 'set_wb', red: parseFloat(elWbBlueInput.value), blue: parseFloat(elWbRedInput.value) });
}

attachValueInput(elWbRedInput,  0.1, 8, sendWb);
attachValueInput(elWbBlueInput, 0.1, 8, sendWb);

function sendIsp() {
  send({
    cmd: 'set_isp',
    contrast:       parseFloat(elContrastInput.value),
    sharpness:      parseFloat(elSharpnessInput.value),
    saturation:     parseFloat(elSaturationInput.value),
    brightness:     parseFloat(elBrightnessInput.value),
    noise_reduction: parseInt(elNrInput.value),
  });
}

attachValueInput(elContrastInput,   0,  32, () => sendIsp());
attachValueInput(elSharpnessInput,  0,  16, () => sendIsp());
attachValueInput(elSaturationInput, 0,  32, () => sendIsp());
attachValueInput(elBrightnessInput, -1,  1, () => sendIsp());
elNrInput.addEventListener('change', sendIsp);

elResSelect.addEventListener('change', () => {
  send({ cmd: 'set_mode', value: elResSelect.value });
  setStatus('Changement de mode…');
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
  const hx = Math.floor((W - hw) / 2);
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

// --- Focus assist (client-side only) ---
// Score = énergie de gradient moyenne dans une zone recadrée/zoomée, en ne
// comptant que les pixels au-dessus d'un seuil de luminance — ignore le
// bruit de fond du ciel nocturne pour ne suivre que la netteté de l'étoile
// (ou du sujet) ciblée. Fonctionne identiquement sur les deux capteurs
// puisqu'il n'analyse que l'image ISP déjà affichée, jamais le RAW.

const elFocusBtn         = document.getElementById('btn-focus');
const elFocusPanel       = document.getElementById('focus-panel');
const elFocusZoomCanvas  = document.getElementById('focus-zoom-canvas');
const focusZoomCtx       = elFocusZoomCanvas.getContext('2d');
const elFocusReticle     = document.getElementById('focus-reticle-canvas');
const elFocusScore       = document.getElementById('focus-score');
const elFocusPeak        = document.getElementById('focus-peak');
const elFocusBarFill     = document.getElementById('focus-bar-fill');
const elBtnFocusReset    = document.getElementById('btn-focus-reset');

let focusEnabled  = false;
let focusTimer    = null;
let focusPeak     = 0;
let focusRoi      = { x: 0.5, y: 0.5 };  // fraction du canvas, 0-1
const FOCUS_LUMA_THRESHOLD = 40;         // ignore le bruit de fond noir du ciel
const FOCUS_CROP_FRACTION  = 0.12;       // taille de la zone recadrée (% du plus petit côté)

function _cropRect() {
  const w = elPreviewCanvas.width, h = elPreviewCanvas.height;
  const size = Math.max(8, Math.round(Math.min(w, h) * FOCUS_CROP_FRACTION));
  const cx = focusRoi.x * w, cy = focusRoi.y * h;
  const x = Math.max(0, Math.min(w - size, Math.round(cx - size / 2)));
  const y = Math.max(0, Math.min(h - size, Math.round(cy - size / 2)));
  return { x, y, size };
}

function _sharpnessScore(data, w, h) {
  let sum = 0, count = 0;
  for (let y = 0; y < h - 1; y++) {
    for (let x = 0; x < w - 1; x++) {
      const i = (y * w + x) * 4;
      const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      if (lum < FOCUS_LUMA_THRESHOLD) continue;
      const iR = i + 4, iD = i + w * 4;
      const lumR = 0.299 * data[iR] + 0.587 * data[iR + 1] + 0.114 * data[iR + 2];
      const lumD = 0.299 * data[iD] + 0.587 * data[iD + 1] + 0.114 * data[iD + 2];
      const gx = lum - lumR, gy = lum - lumD;
      sum += gx * gx + gy * gy;
      count++;
    }
  }
  return count > 0 ? sum / count : 0;
}

function _drawReticle() {
  elFocusReticle.width  = elPreviewCanvas.width;
  elFocusReticle.height = elPreviewCanvas.height;
  const ctx = elFocusReticle.getContext('2d');
  ctx.clearRect(0, 0, elFocusReticle.width, elFocusReticle.height);
  const { x, y, size } = _cropRect();
  ctx.strokeStyle = 'rgba(255,179,0,0.9)';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(x + 0.5, y + 0.5, size, size);
}

function updateFocus() {
  if (!focusEnabled) return;
  try {
    if (elPreviewCanvas.width > 0 && elPreviewCanvas.height > 0) {
      const { x, y, size } = _cropRect();
      const imgData = previewCtx.getImageData(x, y, size, size);
      const score = _sharpnessScore(imgData.data, size, size);
      focusPeak = Math.max(focusPeak, score);

      focusZoomCtx.imageSmoothingEnabled = false;
      focusZoomCtx.clearRect(0, 0, elFocusZoomCanvas.width, elFocusZoomCanvas.height);
      focusZoomCtx.drawImage(
        elPreviewCanvas, x, y, size, size,
        0, 0, elFocusZoomCanvas.width, elFocusZoomCanvas.height
      );

      elFocusScore.textContent = score.toFixed(1);
      elFocusPeak.textContent = 'pic ' + focusPeak.toFixed(1);
      const fillPct = focusPeak > 0 ? Math.min(100, (score / focusPeak) * 100) : 0;
      elFocusBarFill.style.width = fillPct + '%';
      elFocusBarFill.style.background = score >= focusPeak && focusPeak > 0 ? '#ffb300' : '#4caf50';
      _drawReticle();
    }
  } catch (e) {
    console.error('Focus assist error:', e);
  } finally {
    if (focusEnabled) focusTimer = setTimeout(updateFocus, 150);
  }
}

function toggleFocus() {
  focusEnabled = !focusEnabled;
  elFocusBtn.classList.toggle('active', focusEnabled);
  if (focusEnabled) {
    focusPeak = 0;
    elFocusPanel.classList.remove('hidden');
    elFocusReticle.classList.remove('hidden');
    updateFocus();  // se replanifie via setTimeout
  } else {
    clearTimeout(focusTimer);
    elFocusPanel.classList.add('hidden');
    elFocusReticle.classList.add('hidden');
    elFocusReticle.getContext('2d').clearRect(0, 0, elFocusReticle.width, elFocusReticle.height);
  }
}

elFocusBtn.addEventListener('click', toggleFocus);

elBtnFocusReset.addEventListener('click', () => { focusPeak = 0; });

elPreviewCanvas.addEventListener('click', (e) => {
  if (!focusEnabled) return;
  const rect = elPreviewCanvas.getBoundingClientRect();
  focusRoi = {
    x: (e.clientX - rect.left) / rect.width,
    y: (e.clientY - rect.top) / rect.height,
  };
  focusPeak = 0;
});

window.addEventListener('resize', resizePreviewCanvas);

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

// --- Capteur ---

const elSensorSelect    = document.getElementById('sensor-select');
const elBtnSensorApply  = document.getElementById('btn-sensor-apply');
const elSensorStatus    = document.getElementById('sensor-status');

async function _sensorRefresh() {
  try {
    const r = await fetch('/system/sensor');
    const j = await r.json();
    if (!j.ok) return;
    if (elSensorSelect.options.length === 0) {
      j.sensors.forEach(s => {
        const o = document.createElement('option');
        o.value = o.textContent = s;
        elSensorSelect.appendChild(o);
      });
    }
    elSensorSelect.value = j.sensor;
  } catch (_) {}
}

elBtnSensorApply.addEventListener('click', async () => {
  const sensor = elSensorSelect.value;
  if (!confirm(
    `Confirmer le passage au capteur ${sensor} ?\n` +
    `Le Pi0 va redémarrer. Assure-toi d'avoir déjà branché physiquement ce capteur.`
  )) return;
  elBtnSensorApply.disabled = true;
  elSensorStatus.textContent = 'Application en cours…';
  try {
    const r = await fetch('/system/sensor', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sensor }),
    });
    const j = await r.json();
    elSensorStatus.textContent = j.ok
      ? `Capteur ${j.sensor} appliqué — redémarrage en cours.`
      : `Erreur : ${j.detail}`;
    if (!j.ok) elBtnSensorApply.disabled = false;
  } catch (e) {
    elSensorStatus.textContent = `Erreur : ${e}`;
    elBtnSensorApply.disabled = false;
  }
});

_sensorRefresh();

// --- Timelapse ---

const elTlMode       = document.getElementById('tl-mode');
const elTlEndTime    = document.getElementById('tl-end-time');
const elTlInterval   = document.getElementById('tl-interval');
const elBtnTlStart   = document.getElementById('btn-tl-start');
const elBtnTlStop    = document.getElementById('btn-tl-stop');
const elTlStatus     = document.getElementById('tl-status');
const elTlPreviewBox = document.getElementById('tl-preview-box');
const elTlPreviewImg = document.getElementById('tl-preview-img');
const elTlAutoGain   = document.getElementById('tl-auto-gain');
const elTlAutoGainOpts = document.getElementById('tl-auto-gain-opts');
const elTlAgTarget   = document.getElementById('tl-ag-target');
const elTlAgMax      = document.getElementById('tl-ag-max');

elTlAutoGain.addEventListener('change', () => {
  elTlAutoGainOpts.classList.toggle('hidden', !elTlAutoGain.checked);
});

let tlPreviewTimer = null;

elBtnTlStart.addEventListener('click', () => {
  const msg = { cmd: 'start_timelapse', mode: elTlMode.value, end_time: elTlEndTime.value };
  const intervalS = parseFloat(elTlInterval.value) || 0;
  if (intervalS > 0) msg.interval_s = intervalS;
  if (elTlAutoGain.checked) {
    msg.auto_gain        = true;
    msg.auto_gain_target = parseFloat(elTlAgTarget.value) || 80;
    msg.auto_gain_max    = parseFloat(elTlAgMax.value)    || 16;
  }
  send(msg);
});

elBtnTlStop.addEventListener('click', () => {
  send({ cmd: 'stop_timelapse' });
  elTlStatus.textContent = 'Arrêt en cours — fin de l\'exposition…';
  elBtnTlStop.disabled = true;
});

function _tlSetRunning(running) {
  elBtnTlStart.classList.toggle('hidden', running);
  elBtnTlStop.classList.toggle('hidden', !running);
  elBtnTlStop.disabled = false;
  // ISP controls disabled during timelapse (settings apply at start)
  elContrastInput.disabled   = running;
  elSharpnessInput.disabled  = running;
  elSaturationInput.disabled = running;
  elBrightnessInput.disabled = running;
  elNrInput.disabled         = running;
  if (running) {
    elTlPreviewBox.classList.remove('hidden');
    _startTlPreview();
  }
}

function _onTlStarted(msg) {
  _tlSetRunning(true);
  elTlStatus.textContent = `En cours (${msg.mode}) — fin a ${msg.end_time} | 0 image`;
}

function _onTlFrame(msg) {
  const rem = msg.remaining_s || 0;
  const h = Math.floor(rem / 3600);
  const m = Math.floor((rem % 3600) / 60);
  const gainInfo = msg.gain !== undefined ? ` | gain ${msg.gain}` : '';
  elTlStatus.textContent =
    `En cours — ${msg.frame} images | fin dans ${h}h${String(m).padStart(2,'0')} | ` +
    `intervalle ${msg.interval_ms} ms${gainInfo}`;
}

function _onTlDone(msg) {
  _tlSetRunning(false);
  elTlStatus.textContent = `Termine — ${msg.frames} images sauvegardees`;
  _stopTlPreview();
  if (typeof _loadGallery === 'function') _loadGallery();
}

function _onTlError(msg) {
  _tlSetRunning(false);
  elTlStatus.textContent = `Erreur : ${msg.detail}`;
  _stopTlPreview();
}

function _onTlStatus(msg) {
  if (msg.running) {
    _tlSetRunning(true);
    const s = msg.session;
    if (s) {
      elTlStatus.textContent =
        `En cours (${s.mode}) — ${s.frame_count} images | fin a ${s.end_time}`;
    }
  }
  elBtnTlStart.disabled = !msg.running && elBtnTlStart.disabled;
}

function _startTlPreview() {
  _stopTlPreview();
  _refreshTlPreview();
  tlPreviewTimer = setInterval(_refreshTlPreview, 5000);
}

function _stopTlPreview() {
  if (tlPreviewTimer) { clearInterval(tlPreviewTimer); tlPreviewTimer = null; }
}

function _refreshTlPreview() {
  elTlPreviewImg.src = `/timelapse/last.jpg?t=${Date.now()}`;
}

// --- Gallery ---

const elGalleryList    = document.getElementById('gallery-list');
const elGalleryEmpty   = document.getElementById('gallery-empty');
const elGalleryDisk    = document.getElementById('gallery-disk');
const elBtnRefresh     = document.getElementById('btn-gallery-refresh');
const elBtnPurge       = document.getElementById('btn-gallery-purge');

function _fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('fr-FR') + ' ' + d.toLocaleTimeString('fr-FR', {hour:'2-digit', minute:'2-digit'});
}

function _modeLabel(m) {
  return m === 'isp_jpeg' ? 'JPEG' : m === 'isp_png' ? 'PNG' : m === 'raw_fits' ? 'FITS' : m;
}

async function _loadGallery() {
  try {
    const [resp, diskResp] = await Promise.all([
      fetch('/timelapse/sessions'),
      fetch('/timelapse/disk'),
    ]);
    const sessions = await resp.json();

    if (diskResp.ok) {
      const d = await diskResp.json();
      const freePct = 100 - d.used_pct;
      elGalleryDisk.textContent = `Carte SD : ${d.free_gb} Go libres / ${d.total_gb} Go (${freePct}% libre)`;
      elGalleryDisk.className = 'gallery-disk' + (freePct < 5 ? ' disk-crit' : freePct < 15 ? ' disk-warn' : '');
    }
    elGalleryList.innerHTML = '';
    if (sessions.length === 0) {
      elGalleryEmpty.classList.remove('hidden');
      return;
    }
    elGalleryEmpty.classList.add('hidden');
    sessions.forEach(s => {
      const card = document.createElement('div');
      card.className = 'gallery-card';

      const thumb = s.has_preview
        ? `<img class="gallery-thumb" src="/timelapse/sessions/${s.session_id}/preview.jpg" alt="">`
        : `<div class="gallery-thumb-placeholder">&#128247;</div>`;

      card.innerHTML = `
        ${thumb}
        <div class="gallery-info">
          <div class="gallery-info-title">${s.session_id}</div>
          <div class="gallery-info-meta">
            ${_modeLabel(s.mode)} &bull; ${s.frame_count} images &bull; ${s.size_mb} Mo<br>
            Debut : ${_fmtDate(s.started_at)} &bull; Fin prog. : ${s.end_time || '—'}
          </div>
        </div>
        <button class="gallery-del" data-sid="${s.session_id}" title="Supprimer">&#10005;</button>
      `;
      elGalleryList.appendChild(card);
    });

    elGalleryList.querySelectorAll('.gallery-del').forEach(btn => {
      btn.addEventListener('click', async () => {
        const sid = btn.dataset.sid;
        if (!confirm(`Supprimer la session ${sid} ?`)) return;
        const r = await fetch(`/timelapse/sessions/${sid}`, { method: 'DELETE' });
        if (r.ok) _loadGallery();
      });
    });
  } catch (e) {
    elGalleryEmpty.textContent = 'Erreur de chargement.';
    elGalleryEmpty.classList.remove('hidden');
  }
}

elBtnRefresh.addEventListener('click', _loadGallery);

elBtnPurge.addEventListener('click', async () => {
  if (!confirm('Supprimer toutes les sessions timelapse ?')) return;
  await fetch('/timelapse/sessions', { method: 'DELETE' });
  _loadGallery();
});

_loadGallery();

// --- Viewer ---

const elViewerOverlay = document.getElementById('viewer-overlay');
const elViewerImg     = document.getElementById('viewer-img');
const elViewerCounter = document.getElementById('viewer-counter');
const elViewerTitle   = document.getElementById('viewer-title');
const elBtnViewerPrev = document.getElementById('btn-viewer-prev');
const elBtnViewerNext = document.getElementById('btn-viewer-next');
const elBtnViewerClose = document.getElementById('btn-viewer-close');

let _viewerSid   = null;
let _viewerIdx   = 1;
let _viewerCount = 0;

async function _openViewer(sid, startIdx) {
  const resp = await fetch(`/timelapse/sessions/${sid}/frames`);
  if (!resp.ok) return;
  const { count, mode } = await resp.json();
  if (count === 0) return;
  _viewerSid   = sid;
  _viewerCount = count;
  _viewerIdx   = Math.min(Math.max(startIdx || 1, 1), count);
  elViewerTitle.textContent = `${sid}  [${_modeLabel(mode)}]`;
  elViewerOverlay.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  _viewerLoad();
}

function _viewerLoad() {
  elViewerImg.src = `/timelapse/sessions/${_viewerSid}/frame/${_viewerIdx}`;
  elViewerCounter.textContent = `${_viewerIdx} / ${_viewerCount}`;
  elBtnViewerPrev.disabled = (_viewerIdx <= 1);
  elBtnViewerNext.disabled = (_viewerIdx >= _viewerCount);
  // Prefetch next
  if (_viewerIdx < _viewerCount) new Image().src = `/timelapse/sessions/${_viewerSid}/frame/${_viewerIdx + 1}`;
}

function _closeViewer() {
  elViewerOverlay.classList.add('hidden');
  elViewerImg.src = '';
  document.body.style.overflow = '';
}

elBtnViewerClose.addEventListener('click', _closeViewer);
elBtnViewerPrev.addEventListener('click', () => { if (_viewerIdx > 1) { _viewerIdx--; _viewerLoad(); } });
elBtnViewerNext.addEventListener('click', () => { if (_viewerIdx < _viewerCount) { _viewerIdx++; _viewerLoad(); } });

elViewerOverlay.addEventListener('click', e => {
  if (e.target === elViewerOverlay) _closeViewer();
});

document.addEventListener('keydown', e => {
  if (elViewerOverlay.classList.contains('hidden')) return;
  if (e.key === 'Escape') _closeViewer();
  if (e.key === 'ArrowLeft'  && _viewerIdx > 1)             { _viewerIdx--; _viewerLoad(); }
  if (e.key === 'ArrowRight' && _viewerIdx < _viewerCount)  { _viewerIdx++; _viewerLoad(); }
});

// Attach viewer open to gallery cards (called after render)
function _attachViewerToCards() {
  elGalleryList.querySelectorAll('.gallery-card').forEach(card => {
    const sid = card.querySelector('.gallery-del')?.dataset.sid;
    if (!sid) return;
    card.style.cursor = 'pointer';
    card.addEventListener('click', e => {
      if (e.target.classList.contains('gallery-del')) return;
      _openViewer(sid, 1);
    });
  });
}

new MutationObserver(_attachViewerToCards).observe(elGalleryList, { childList: true });

// --- LED verte RPi ---

const elBtnLedOn  = document.getElementById('btn-led-on');
const elBtnLedOff = document.getElementById('btn-led-off');
const elLedStatus = document.getElementById('led-status');

function _ledSetUI(on) {
  elBtnLedOn.disabled  = on === true;
  elBtnLedOff.disabled = on === false;
  elLedStatus.textContent = on === null ? '' : on ? 'LED allumee' : 'LED eteinte';
}

async function _ledAction(state) {
  elBtnLedOn.disabled  = true;
  elBtnLedOff.disabled = true;
  elLedStatus.textContent = '…';
  try {
    const r = await fetch(`/system/led/${state}`, { method: 'POST' });
    const j = await r.json();
    if (j.ok) _ledSetUI(j.on);
    else elLedStatus.textContent = 'Erreur : ' + j.detail;
  } catch (e) {
    elLedStatus.textContent = 'Erreur : ' + e;
    _ledSetUI(null);
  }
}

elBtnLedOn.addEventListener('click',  () => _ledAction('on'));
elBtnLedOff.addEventListener('click', () => _ledAction('off'));

fetch('/system/led').then(r => r.json()).then(j => { if (j.ok) _ledSetUI(j.on); }).catch(() => {});

// --- WiFi / Hotspot ---

const elWifiState         = document.getElementById('wifi-state');
const elWifiIpRow         = document.getElementById('wifi-ip-row');
const elWifiIpBar         = document.getElementById('wifi-ip-bar');
const elBtnWifiCopy       = document.getElementById('btn-wifi-copy');
const elBtnWifiFixip      = document.getElementById('btn-wifi-fixip');
const elWifiProfileSelect = document.getElementById('wifi-profile-select');
const elWifiNewFields     = document.getElementById('wifi-new-fields');
const elWifiSsid          = document.getElementById('wifi-ssid');
const elWifiPass          = document.getElementById('wifi-pass');
const elBtnWifiConn       = document.getElementById('btn-wifi-connect');
const elBtnWifiDisc       = document.getElementById('btn-wifi-disconnect');

function _wifiSetUI(st) {
  if (st.connected && st.ip) {
    const label = st.ip_method === 'static' ? `IP fixe — ${st.ssid}` : `Connecte — ${st.ssid}`;
    elWifiState.textContent = label;
    elWifiState.className = 'wifi-state wifi-ok';
    elWifiIpBar.textContent = `http://${st.ip}:8000/`;
    elWifiIpRow.classList.remove('hidden');
    const fixed = st.ip_method === 'static';
    elBtnWifiFixip.disabled = fixed;
    elBtnWifiFixip.textContent = fixed ? 'IP fixee' : 'Fixer cette IP';
    elBtnWifiFixip.className = fixed ? 'btn-wifi-fixip fixed' : 'btn-wifi-fixip';
  } else if (st.connected) {
    elWifiState.textContent = `Connecte — ${st.ssid}`;
    elWifiState.className = 'wifi-state wifi-ok';
    elWifiIpRow.classList.add('hidden');
  } else if (st.enabled) {
    elWifiState.textContent = 'WiFi actif, non connecte';
    elWifiState.className = 'wifi-state';
    elWifiIpRow.classList.add('hidden');
  } else {
    elWifiState.textContent = 'WiFi desactive';
    elWifiState.className = 'wifi-state';
    elWifiIpRow.classList.add('hidden');
  }
}

async function _wifiRefreshProfiles() {
  try {
    const r = await fetch('/system/wifi/profiles');
    const j = await r.json();
    if (!j.ok) return;
    const current = elWifiProfileSelect.value;
    while (elWifiProfileSelect.options.length > 1) elWifiProfileSelect.remove(1);
    for (const name of j.profiles) {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      elWifiProfileSelect.appendChild(opt);
    }
    if (j.profiles.includes(current)) elWifiProfileSelect.value = current;
  } catch (_) {}
}

async function _wifiRefresh() {
  try {
    const r = await fetch('/system/wifi');
    const j = await r.json();
    if (j.ok) _wifiSetUI(j);
  } catch (_) {}
}

elBtnWifiCopy.addEventListener('click', () => {
  const url = elWifiIpBar.textContent;
  if (!url) return;
  navigator.clipboard.writeText(url).then(() => {
    const prev = elBtnWifiCopy.textContent;
    elBtnWifiCopy.textContent = '✓';
    setTimeout(() => { elBtnWifiCopy.textContent = prev; }, 1500);
  }).catch(() => {});
});

elBtnWifiFixip.addEventListener('click', async () => {
  elBtnWifiFixip.disabled = true;
  elBtnWifiFixip.textContent = 'En cours…';
  try {
    const r = await fetch('/system/wifi/fixip', { method: 'POST' });
    const j = await r.json();
    if (j.ok) {
      await _wifiRefresh();
    } else {
      elWifiState.textContent = 'Erreur fixip : ' + j.detail;
      elWifiState.className = 'wifi-state wifi-err';
      elBtnWifiFixip.disabled = false;
      elBtnWifiFixip.textContent = 'Fixer cette IP';
    }
  } catch (e) {
    elWifiState.textContent = 'Erreur : ' + e;
    elWifiState.className = 'wifi-state wifi-err';
    elBtnWifiFixip.disabled = false;
    elBtnWifiFixip.textContent = 'Fixer cette IP';
  }
});

elWifiProfileSelect.addEventListener('change', () => {
  const isNew = elWifiProfileSelect.value === '';
  elWifiNewFields.classList.toggle('hidden', !isNew);
});

elBtnWifiConn.addEventListener('click', async () => {
  const profile = elWifiProfileSelect.value;
  const ssid = profile || elWifiSsid.value.trim();
  if (!ssid) {
    elWifiState.textContent = 'Entrez un nom de reseau (SSID)';
    elWifiState.className = 'wifi-state wifi-err';
    return;
  }
  elBtnWifiConn.disabled = true;
  elBtnWifiDisc.disabled = true;
  elWifiState.textContent = 'Connexion en cours…';
  elWifiState.className = 'wifi-state wifi-busy';
  try {
    const r = await fetch('/system/wifi/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ssid, password: profile ? '' : elWifiPass.value }),
    });
    const j = await r.json();
    if (j.ok) {
      await _wifiRefresh();
    } else {
      elWifiState.textContent = 'Erreur : ' + j.detail;
      elWifiState.className = 'wifi-state wifi-err';
    }
  } catch (e) {
    elWifiState.textContent = 'Erreur : ' + e;
    elWifiState.className = 'wifi-state wifi-err';
  } finally {
    elBtnWifiConn.disabled = false;
    elBtnWifiDisc.disabled = false;
  }
});

elBtnWifiDisc.addEventListener('click', async () => {
  elBtnWifiConn.disabled = true;
  elBtnWifiDisc.disabled = true;
  elWifiState.textContent = 'Deconnexion…';
  elWifiState.className = 'wifi-state wifi-busy';
  try {
    await fetch('/system/wifi/disconnect', { method: 'POST' });
    await _wifiRefresh();
  } catch (e) {
    elWifiState.textContent = 'Erreur : ' + e;
    elWifiState.className = 'wifi-state wifi-err';
  } finally {
    elBtnWifiConn.disabled = false;
    elBtnWifiDisc.disabled = false;
  }
});

_wifiRefreshProfiles();
_wifiRefresh();
setInterval(_wifiRefresh, 10_000);

connect();
runPreview();
