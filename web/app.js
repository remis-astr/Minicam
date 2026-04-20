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

elReconnect.addEventListener('click', () => {
  clearTimeout(reconnectTimer);
  connect();
});

connect();
