'use strict';

const WS_URL = `ws://${location.host}/ws/control`;
const SEND_DEBOUNCE_MS = 150;

let ws = null;
let reconnectTimer = null;

const elStatus  = document.getElementById('ws-status');
const elGainSlider = document.getElementById('gain-slider');
const elExpoSlider = document.getElementById('expo-slider');
const elGainVal = document.getElementById('gain-val');
const elExpoVal = document.getElementById('expo-val');
const elWbRedSlider = document.getElementById('wb-red-slider');
const elWbBlueSlider = document.getElementById('wb-blue-slider');
const elWbRedVal = document.getElementById('wb-red-val');
const elWbBlueVal = document.getElementById('wb-blue-val');
const elResSelect = document.getElementById('res-select');
const elReconnect = document.getElementById('btn-reconnect');
const elStatusBar = document.getElementById('status-bar');

function setStatus(msg) { elStatusBar.textContent = msg; }

function fmtExpo(ms) {
  if (ms >= 1000) return (ms / 1000).toFixed(1) + ' s';
  return ms.toFixed(0) + ' ms';
}

function setControls(enabled) {
  elGainSlider.disabled = !enabled;
  elExpoSlider.disabled = !enabled;
  elWbRedSlider.disabled = !enabled;
  elWbBlueSlider.disabled = !enabled;
  elResSelect.disabled = !enabled;
}

// --- WebSocket ---

function connect() {
  if (ws) ws.close();
  elStatus.className = 'badge connecting';
  elStatus.textContent = 'Connexion…';
  setControls(false);

  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    elStatus.className = 'badge connected';
    elStatus.textContent = 'Connecté';
    setStatus('Connecté');
    send({ cmd: 'status' });
  };

  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.cmd === 'status' || msg.cmd === 'ack') {
      if (msg.gain !== undefined) {
        elGainSlider.value = msg.gain;
        elGainVal.textContent = parseFloat(msg.gain).toFixed(1);
        setControls(true);
      }
      if (msg.exposure_ms !== undefined) {
        elExpoSlider.value = msg.exposure_ms;
        elExpoVal.textContent = fmtExpo(msg.exposure_ms);
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
        elWbRedSlider.value = msg.wb_red;
        elWbRedVal.textContent = parseFloat(msg.wb_red).toFixed(2);
      }
      if (msg.wb_blue !== undefined) {
        elWbBlueSlider.value = msg.wb_blue;
        elWbBlueVal.textContent = parseFloat(msg.wb_blue).toFixed(2);
      }
    }
    if (msg.cmd === 'error') setStatus('Erreur : ' + msg.detail);
  };

  ws.onclose = () => {
    elStatus.className = 'badge disconnected';
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

// --- Debounced sliders ---

function debounce(fn, delay) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), delay); };
}

elGainSlider.addEventListener('input', debounce(() => {
  const v = parseFloat(elGainSlider.value);
  elGainVal.textContent = v.toFixed(1);
  send({ cmd: 'set_gain', value: v });
}, SEND_DEBOUNCE_MS));

elExpoSlider.addEventListener('input', debounce(() => {
  const v = parseFloat(elExpoSlider.value);
  elExpoVal.textContent = fmtExpo(v);
  send({ cmd: 'set_exposure', value_ms: v });
}, SEND_DEBOUNCE_MS));

function sendWb() {
  send({ cmd: 'set_wb', red: parseFloat(elWbRedSlider.value), blue: parseFloat(elWbBlueSlider.value) });
}

elWbRedSlider.addEventListener('input', debounce(() => {
  elWbRedVal.textContent = parseFloat(elWbRedSlider.value).toFixed(2);
  sendWb();
}, SEND_DEBOUNCE_MS));

elWbBlueSlider.addEventListener('input', debounce(() => {
  elWbBlueVal.textContent = parseFloat(elWbBlueSlider.value).toFixed(2);
  sendWb();
}, SEND_DEBOUNCE_MS));

elResSelect.addEventListener('change', () => {
  send({ cmd: 'set_resolution', value: elResSelect.value });
  setStatus('Changement de résolution…');
});

// Fullscreen
const elPreviewBox = document.getElementById('preview-box');
const elFullscreen = document.getElementById('btn-fullscreen');

function toggleFullscreen() {
  if (!document.fullscreenElement) {
    elPreviewBox.requestFullscreen();
  } else {
    document.exitFullscreen();
  }
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

connect();
