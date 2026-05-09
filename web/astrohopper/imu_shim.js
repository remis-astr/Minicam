'use strict';

// Doit être chargé AVANT le JS de SkyHopper.
// Bloque les événements deviceorientation natifs du smartphone et injecte
// à la place les données du MPU6050 du RPi0 via WebSocket.

(function () {
  // --- Bloquer les listeners natifs deviceorientation ---
  const _origAEL = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function (type, handler, ...rest) {
    if (type === 'deviceorientation' || type === 'deviceorientationabsolute' || type === 'devicemotion') {
      return; // silently drop — RPi0 IMU takes over
    }
    return _origAEL.call(this, type, handler, ...rest);
  };

  // --- Connexion WebSocket IMU ---
  const WS_URL = 'ws://' + location.host + '/ws/imu';
  let ws = null;

  function updateStatusDot(color) {
    const el = document.getElementById('rpi0-imu-dot');
    if (el) el.style.color = color;
  }

  function connect() {
    ws = new WebSocket(WS_URL);

    ws.onopen = function () {
      updateStatusDot('#4d4');
    };

    ws.onmessage = function (ev) {
      if (typeof gdata === 'undefined') return;
      const d = JSON.parse(ev.data);
      gdata.alpha_gyro = d.alpha;
      gdata.alpha      = d.alpha;
      gdata.beta       = d.beta;
      gdata.gamma      = d.gamma;
      // Efface le message "No Gyro" si présent
      const orient = document.getElementById('orient');
      if (orient && orient.innerHTML !== '') orient.innerHTML = '';
    };

    ws.onclose = function () {
      updateStatusDot('#d44');
      setTimeout(connect, 2000);
    };

    ws.onerror = function () { ws.close(); };
  }

  window.addEventListener('DOMContentLoaded', connect);
})();
