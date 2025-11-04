// Minimal dead-reckoning using compass heading + step detection
// iOS requires user permission for motion/orientation. We gate sensors behind a button.

const elements = {
  status: document.getElementById('status'),
  btnPermissions: document.getElementById('btn-permissions'),
  btnStart: document.getElementById('btn-start'),
  btnReset: document.getElementById('btn-reset'),
  btnCalibrate: document.getElementById('btn-calibrate'),
  btnGuide: document.getElementById('btn-guide'),
  btnPause: document.getElementById('btn-pause'),
  stepLength: document.getElementById('stepLength'),
  distance: document.getElementById('distance'),
  heading: document.getElementById('heading'),
  steps: document.getElementById('steps'),
  backDist: document.getElementById('backDist'),
  backBearing: document.getElementById('backBearing'),
  altitude: document.getElementById('altitude'),
  canvas: document.getElementById('canvas'),
  // calibration modal
  calibModal: document.getElementById('calibModal'),
  calibSteps: document.getElementById('calibSteps'),
  calibSeconds: document.getElementById('calibSeconds'),
  calibStart: document.getElementById('calibStart'),
  calibStop: document.getElementById('calibStop'),
  calibApply: document.getElementById('calibApply'),
  calibClose: document.getElementById('calibClose'),
  // reset modal
  resetModal: document.getElementById('resetModal'),
  resetCancel: document.getElementById('resetCancel'),
  resetConfirm: document.getElementById('resetConfirm'),
};

// Canvas setup
const ctx = elements.canvas.getContext('2d');
let canvasWidth = 0;
let canvasHeight = 0;
function resizeCanvas() {
  const dpr = Math.max(1, Math.floor(window.devicePixelRatio || 1));
  const rect = elements.canvas.getBoundingClientRect();
  elements.canvas.width = Math.floor(rect.width * dpr);
  elements.canvas.height = Math.floor(rect.height * dpr);
  canvasWidth = elements.canvas.width;
  canvasHeight = elements.canvas.height;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.scale(dpr, dpr);
  redrawAll();
}
window.addEventListener('resize', resizeCanvas);
window.addEventListener('load', resizeCanvas);

// World state in meters; origin is start point, positive x to the right, positive y downward (canvas coords)
let pathPoints = []; // Array of {x, y} in meters relative to origin
let originSet = false;
let currentPosition = { x: 0, y: 0 };
let totalDistance = 0;
let stepCount = 0;
let lastHeadingDeg = null; // 0..360, 0 = North (we map to -Y in canvas)
let backToStart = { distance: 0, bearingDeg: 0 };
let headingLPF = null; // low-pass filtered heading
let pitchLPF = 0; // radians, device pitch (vor/zurück)
let altitudeMeters = 0; // relative
let guidingEnabled = false; // show guidance arrow only on demand
let paused = false;

// Hoisted globals to avoid ReferenceError before initialization
let fullscreen = false;
let originalCanvasParent = null; // set after DOM ready
let overlayDiv = null;

// Calibration state hoisted
let calibActive = false;
let calibStepCount = 0;
let stepCountAtCalibStart = 0;
let calibStartTime = 0;
let calibTimer = null;

// Rendering parameters
const metersPerPixel = 0.02; // 1 pixel = 2 cm; scale factor for drawing
let viewOffsetPx = { x: 0, y: 0 }; // pan offset in pixels

function metersToCanvas(m) {
  return m / metersPerPixel;
}

function redrawAll() {
  const rect = elements.canvas.getBoundingClientRect();
  ctx.clearRect(0, 0, rect.width, rect.height);
  if (!fullscreen) { viewOffsetPx.x = 0; viewOffsetPx.y = 0; }

  // Draw grid
  drawGrid(rect.width, rect.height);

  // Draw path
  if (pathPoints.length > 0) {
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#22c55e';
    ctx.beginPath();
    const start = toCanvasPoint(pathPoints[0]);
    ctx.moveTo(start.x, start.y);
    for (let i = 1; i < pathPoints.length; i++) {
      const p = toCanvasPoint(pathPoints[i]);
      ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();

    // Draw current position
    const head = toCanvasPoint(currentPosition);
    ctx.fillStyle = '#f59e0b';
    ctx.beginPath();
    ctx.arc(head.x, head.y, 5, 0, Math.PI * 2);
    ctx.fill();

    // Heading arrow
    let arrowAngleRad = null;
    if (lastMoveHeadingDeg != null && Date.now() - lastStepTime < 3000) {
      arrowAngleRad = headingToCanvasAngleRad(lastMoveHeadingDeg);
    } else if (lastHeadingDeg != null) {
      arrowAngleRad = headingToCanvasAngleRad(lastHeadingDeg);
    }
    if (arrowAngleRad != null) drawArrow(head.x, head.y, arrowAngleRad, 28, '#f59e0b');

    // Return-to-start arrow from current position (only when guiding)
    if (originSet && guidingEnabled) {
      const angleToOriginRad = Math.atan2(-currentPosition.y, -currentPosition.x); // world coords
      drawArrow(head.x, head.y, angleToOriginRad, 34, '#60a5fa');
    }
  }

  if (!fullscreen) drawHud();
}

function drawGrid(w, h) {
  const gridEveryMeters = 1;
  const gridPx = metersToCanvas(gridEveryMeters);
  ctx.strokeStyle = 'rgba(148,163,184,0.15)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 0; x <= w; x += gridPx) {
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
  }
  for (let y = 0; y <= h; y += gridPx) {
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
  }
  ctx.stroke();

  // Origin marker at canvas center
  if (originSet) {
    const c = toCanvasPoint({ x: 0, y: 0 });
    ctx.strokeStyle = 'rgba(59,130,246,0.8)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(c.x - 10, c.y);
    ctx.lineTo(c.x + 10, c.y);
    ctx.moveTo(c.x, c.y - 10);
    ctx.lineTo(c.x, c.y + 10);
    ctx.stroke();
  }
}

// Map world meters to canvas pixels with origin centered
function toCanvasPoint(p) {
  const rect = elements.canvas.getBoundingClientRect();
  const cx = rect.width / 2;
  const cy = rect.height / 2;
  return {
    x: cx + metersToCanvas(p.x) + viewOffsetPx.x,
    y: cy + metersToCanvas(p.y) + viewOffsetPx.y,
  };
}

function headingToCanvasAngleRad(headingDeg) {
  // Heading 0° (North) points up; canvas angle 0 rad points along +X. Convert:
  // canvasAngle = 90° - heading
  const canvasDeg = 90 - headingDeg;
  return (canvasDeg * Math.PI) / 180;
}

function drawArrow(x, y, angleRad, lengthPx, color) {
  const lx = Math.cos(angleRad) * lengthPx;
  const ly = Math.sin(angleRad) * lengthPx;
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + lx, y + ly);
  ctx.stroke();
  // Arrowhead
  const ah = 8;
  const left = angleRad + Math.PI - 0.4;
  const right = angleRad + Math.PI + 0.4;
  ctx.beginPath();
  ctx.moveTo(x + lx, y + ly);
  ctx.lineTo(x + lx + Math.cos(left) * ah, y + ly + Math.sin(left) * ah);
  ctx.lineTo(x + lx + Math.cos(right) * ah, y + ly + Math.sin(right) * ah);
  ctx.closePath();
  ctx.fill();
}

function drawHud() {
  // Simple text HUD in top-left
  const rect = elements.canvas.getBoundingClientRect();
  const pad = 10;
  const x = pad;
  const y = pad + 12;
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.fillRect(6, 6, 140, 44);
  ctx.fillStyle = '#e5e7eb';
  ctx.font = '12px system-ui, -apple-system, Segoe UI, Roboto';
  const hTxt = (lastHeadingDeg == null ? '—' : lastHeadingDeg.toFixed(0)) + '°';
  ctx.fillText('Heading: ' + hTxt, x, y);
  ctx.fillText('Zum Start: ' + backToStart.distance.toFixed(1) + ' m', x, y + 16);
}

// Motion handling
let motionListenerActive = false;
let orientationListenerActive = false;
let accelBuffer = [];
const accelBufferSize = 64;
let lastStepTime = 0;
let lastAbove = false;
let lastMagnitude = 0;
let lastMoveHeadingDeg = null;

function setStatus(text) {
  elements.status.textContent = text;
}

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

async function requestPermissions() {
  try {
    // iOS requires explicit permission per API
    const orientationPerm = (window.DeviceOrientationEvent && typeof DeviceOrientationEvent.requestPermission === 'function')
      ? await DeviceOrientationEvent.requestPermission().catch(() => 'denied')
      : 'granted';
    const motionPerm = (window.DeviceMotionEvent && typeof DeviceMotionEvent.requestPermission === 'function')
      ? await DeviceMotionEvent.requestPermission().catch(() => 'denied')
      : 'granted';

    if (orientationPerm !== 'granted' || motionPerm !== 'granted') {
      setStatus('Erlaubnis abgelehnt. Tippe erneut und entsperre in Safari-Einstellungen.');
      return false;
    }

    startSensors();
    elements.btnStart.disabled = false;
    elements.btnReset.disabled = false;
    elements.btnCalibrate.disabled = false;
    if (elements.btnGuide) elements.btnGuide.disabled = false;
    try { localStorage.setItem('sensorsGranted', '1'); } catch (_) {}
    hidePermissionsButton();
    setStatus('Sensoren aktiv. Setze Startpunkt.');
    return true;
  } catch (e) {
    setStatus('Fehler bei Berechtigungen: ' + e.message);
    return false;
  }
}

function startSensors() {
  if (!orientationListenerActive) {
    window.addEventListener('deviceorientation', onOrientation, { passive: true });
    orientationListenerActive = true;
  }
  if (!motionListenerActive) {
    window.addEventListener('devicemotion', onMotion, { passive: true });
    motionListenerActive = true;
  }
}

function onOrientation(e) {
  // Prefer webkitCompassHeading on iOS (0 = North, clockwise)
  const iosHeading = (e.webkitCompassHeading != null) ? e.webkitCompassHeading : null;
  let heading = iosHeading;
  if (heading == null) {
    // Fallback using alpha; not reliable on all devices
    heading = (typeof e.alpha === 'number') ? (360 - e.alpha) : null;
  }
  if (typeof heading === 'number' && isFinite(heading)) {
    const raw = ((heading % 360) + 360) % 360;
    // Low-pass filter to smooth jitter
    if (headingLPF == null) headingLPF = raw;
    const alpha = 0.15; // smoothing factor
    // Handle wrap-around (0/360)
    let diff = raw - headingLPF;
    if (diff > 180) diff -= 360; else if (diff < -180) diff += 360;
    headingLPF = headingLPF + alpha * diff;
    lastHeadingDeg = ((headingLPF % 360) + 360) % 360;
    elements.heading.textContent = lastHeadingDeg.toFixed(0);
    // Always redraw so der Pfeil dreht sich auch ohne Schritte
    redrawAll();
  }

  // Device pitch (front-back tilt). On most devices, e.beta ~ [-180,180]. Use as incline proxy.
  if (typeof e.beta === 'number') {
    const beta = clamp(e.beta, -90, 90); // limit extremes
    const pitchRad = (beta * Math.PI) / 180;
    const a = 0.15;
    pitchLPF = pitchLPF + a * (pitchRad - pitchLPF);
  }
}

function magnitude(x, y, z) {
  return Math.sqrt(x * x + y * y + z * z);
}

function onMotion(e) {
  const a = e.accelerationIncludingGravity || e.acceleration;
  if (!a) return;
  const m = magnitude(a.x || 0, a.y || 0, a.z || 0);
  accelBuffer.push({ t: Date.now(), m });
  if (accelBuffer.length > accelBufferSize) accelBuffer.shift();

  // Detect steps always; advance only when origin is set
  const stepDetected = detectStep();
  if (stepDetected) {
    stepCount += 1;
    const stepMeters = clamp(parseFloat(elements.stepLength.value || '0.75'), 0.3, 1.5);
    if (originSet) {
      advanceByStep(stepMeters);
    } else if (calibActive) {
      const liveSteps = Math.max(0, stepCount - stepCountAtCalibStart);
      elements.calibSteps.textContent = String(liveSteps);
    }
  }
  if (calibActive) {
    const liveSteps = Math.max(0, stepCount - stepCountAtCalibStart);
    elements.calibSteps.textContent = String(liveSteps);
  }
}

function detectStep() {
  // Simple peak detection relative to rolling mean
  if (accelBuffer.length < 12) return false;
  const now = Date.now();
  const recent = accelBuffer.slice(-20);
  const mean = recent.reduce((s, v) => s + v.m, 0) / recent.length;
  const variance = recent.reduce((s, v) => s + (v.m - mean) * (v.m - mean), 0) / recent.length;
  const std = Math.sqrt(variance);
  const last = recent[recent.length - 1];
  if (std < 0.6) return false; // reject jitter when not walking
  const threshold = mean + Math.max(0.7, 1.0 * std);

  const minMsBetweenSteps = 400;
  const risingEdge = !lastAbove && last.m > threshold && (last.m - lastMagnitude) > 0.6;
  lastAbove = last.m > threshold;
  if (risingEdge && now - lastStepTime > minMsBetweenSteps) {
    lastStepTime = now;
    lastMagnitude = last.m;
    return true;
  }
  lastMagnitude = last.m;
  return false;
}

function advanceByStep(stepMeters) {
  // Heading: 0° = North (up). Canvas Y grows down, so dy = +meters for South. We invert.
  const heading = (lastHeadingDeg == null) ? 0 : lastHeadingDeg;
  const rad = heading * Math.PI / 180;
  // Convert to canvas/world coordinates (x to right, y down). North means y decreases.
  const dx = Math.sin(rad) * stepMeters; // east-west component
  const dy = -Math.cos(rad) * stepMeters; // north-south component (negative for north)
  const next = { x: currentPosition.x + dx, y: currentPosition.y + dy };

  // Update movement heading
  lastMoveHeadingDeg = ((Math.atan2(dx, -dy) * 180 / Math.PI) + 360) % 360;

  // Update path only if not paused
  if (!paused) {
    pathPoints.push({ x: currentPosition.x, y: currentPosition.y });
    pathPoints.push({ x: next.x, y: next.y });
    totalDistance += stepMeters;
  }

  currentPosition = next;

  // Vertical estimate from pitch per step (dz = step * sin(pitch))
  const pitch = pitchLPF || 0;
  const absPitch = Math.abs(pitch);
  if (absPitch > 0.17) { // > ~10°
    const dzRaw = stepMeters * Math.sin(pitch);
    const dz = clamp(dzRaw, -stepMeters * 0.8, stepMeters * 0.8);
    altitudeMeters += dz;
    // Snap near baseline to 1.00
    if (Math.abs(altitudeMeters - 1) < 0.05) altitudeMeters = 1;
  }

  // recompute return-to-start
  const dx0 = -currentPosition.x;
  const dy0 = -currentPosition.y;
  backToStart.distance = Math.hypot(dx0, dy0);
  const angleRad = Math.atan2(dy0, dx0); // canvas/world
  // Convert to compass bearing (0° north, clockwise)
  const bearingFromNorth = ((90 - (angleRad * 180 / Math.PI)) % 360 + 360) % 360;
  backToStart.bearingDeg = bearingFromNorth;

  // UI updates
  elements.steps.textContent = String(stepCount);
  elements.distance.textContent = totalDistance.toFixed(2);
  elements.backDist.textContent = backToStart.distance.toFixed(2);
  elements.backBearing.textContent = backToStart.bearingDeg.toFixed(0);
  elements.altitude.textContent = altitudeMeters.toFixed(2);

  redrawAll();
}

function setStartPoint() {
  originSet = true;
  pathPoints = [{ x: 0, y: 0 }];
  currentPosition = { x: 0, y: 0 };
  stepCount = 0;
  totalDistance = 0;
  elements.steps.textContent = '0';
  elements.distance.textContent = '0.00';
  elements.backDist.textContent = '0.00';
  elements.backBearing.textContent = '—';
  altitudeMeters = 1;
  elements.altitude.textContent = '1.00';
  setStatus('Startpunkt gesetzt. Lauf los.');
  enableWakeLock();
  paused = false;
  if (elements.btnPause) { elements.btnPause.textContent = 'Pause'; elements.btnPause.disabled = false; }
  redrawAll();
}

function resetAll() {
  originSet = false;
  pathPoints = [];
  currentPosition = { x: 0, y: 0 };
  stepCount = 0;
  totalDistance = 0;
  elements.steps.textContent = '0';
  elements.distance.textContent = '0.00';
  elements.backDist.textContent = '0.00';
  elements.backBearing.textContent = '—';
  setStatus('Zurückgesetzt. Sensoren aktiv.');
  disableWakeLock();
  redrawAll();
}

// Wire up UI
elements.btnPermissions.addEventListener('click', requestPermissions);
elements.btnStart.addEventListener('click', () => {
  if (!motionListenerActive || !orientationListenerActive) {
    setStatus('Bitte zuerst Sensoren erlauben.');
    return;
  }
  setStartPoint();
});
elements.btnReset.addEventListener('click', () => {
  elements.resetModal.classList.remove('hidden');
});
elements.btnCalibrate.addEventListener('click', openCalibration);
if (elements.btnGuide) {
  elements.btnGuide.addEventListener('click', () => {
    guidingEnabled = !guidingEnabled;
    elements.btnGuide.textContent = guidingEnabled ? 'Zurück zum Start (an)' : 'Zurück zum Start';
    redrawAll();
  });
}
if (elements.btnPause) {
  elements.btnPause.addEventListener('click', () => {
    if (!originSet) return;
    paused = !paused;
    elements.btnPause.textContent = paused ? 'Start' : 'Pause';
  });
}
// no photo/video buttons anymore

// PWA service worker
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('service-worker.js').catch(() => {});
  });
}

// Initial draw
resizeCanvas();

// ---- Canvas panning (drag to move view) ----
let isDragging = false;
let lastDrag = { x: 0, y: 0 };
elements.canvas.addEventListener('pointerdown', (e) => {
  if (!fullscreen) return; // nur im Vollbild pannen, sonst normales Scrollen zulassen
  isDragging = true;
  lastDrag = { x: e.clientX, y: e.clientY };
  try { elements.canvas.setPointerCapture(e.pointerId); } catch(_) {}
});
elements.canvas.addEventListener('pointermove', (e) => {
  if (!fullscreen || !isDragging) return;
  const dx = e.clientX - lastDrag.x;
  const dy = e.clientY - lastDrag.y;
  lastDrag = { x: e.clientX, y: e.clientY };
  viewOffsetPx.x += dx;
  viewOffsetPx.y += dy;
  e.preventDefault();
  redrawAll();
}, { passive: false });
elements.canvas.addEventListener('pointerup', (e) => {
  if (!fullscreen) return;
  isDragging = false;
  try { elements.canvas.releasePointerCapture(e.pointerId); } catch(_) {}
});
elements.canvas.addEventListener('pointercancel', () => { isDragging = false; });

// ---- Calibration ----

function openCalibration() {
  elements.calibSteps.textContent = '0';
  elements.calibStart.disabled = false;
  elements.calibStop.disabled = true;
  elements.calibModal.classList.remove('hidden');
}

function startCalibration() {
  calibActive = true;
  stepCountAtCalibStart = stepCount;
  calibStepCount = 0;
  elements.calibSteps.textContent = '0';
  elements.calibStart.disabled = true;
  elements.calibStop.disabled = false;
  calibStartTime = Date.now();
  const secs = clamp(parseInt(elements.calibSeconds.value || '15', 10), 5, 120);
  if (calibTimer) clearTimeout(calibTimer);
  calibTimer = setTimeout(() => { if (calibActive) stopCalibration(); }, secs * 1000);
  setStatus('Kalibrierung läuft … Gehe normal.');
}

function stopCalibration() {
  calibActive = false;
  calibStepCount = Math.max(0, stepCount - stepCountAtCalibStart);
  elements.calibSteps.textContent = String(calibStepCount);
  elements.calibStart.disabled = false;
  elements.calibStop.disabled = true;
  if (calibTimer) { clearTimeout(calibTimer); calibTimer = null; }
  finalizeCalibration();
}

function finalizeCalibration() {
  const elapsedSecs = Math.max(1, Math.round((Date.now() - calibStartTime) / 1000));
  const speed = 1.4; // m/s default average walking speed
  if (calibStepCount <= 0 || !isFinite(speed)) return;
  const dist = speed * elapsedSecs;
  const sLen = dist / calibStepCount;
  elements.stepLength.value = sLen.toFixed(2);
  elements.calibModal.classList.add('hidden');
  setStatus('Schrittlänge gesetzt: ' + sLen.toFixed(2) + ' m');
}

function closeCalibration() {
  elements.calibModal.classList.add('hidden');
  suppressCanvasTapUntil = Date.now() + 400;
}

function safeBind(el, type, handler) {
  if (!el) return;
  el.addEventListener(type, (e) => { e.preventDefault(); e.stopPropagation(); handler(e); }, { passive: false });
}
safeBind(elements.calibStart, 'click', startCalibration);
safeBind(elements.calibStart, 'pointerup', startCalibration);
safeBind(elements.calibStop, 'click', stopCalibration);
safeBind(elements.calibStop, 'pointerup', stopCalibration);
safeBind(elements.calibClose, 'click', closeCalibration);
safeBind(elements.calibClose, 'pointerup', closeCalibration);

// While calibrating, reuse step detection (no changes). We only compute final count on stop.

// ---- Reset confirmation ----
elements.resetCancel.addEventListener('click', () => elements.resetModal.classList.add('hidden'));
elements.resetConfirm.addEventListener('click', () => {
  elements.resetModal.classList.add('hidden');
  resetAll();
});

// ---- Fullscreen (overlay) ----
originalCanvasParent = elements.canvas.parentElement;
function toggleFullscreen() {
  if (!fullscreen) {
    overlayDiv = document.createElement('div');
    overlayDiv.className = 'fullscreen-overlay';
    document.body.appendChild(overlayDiv);
    overlayDiv.appendChild(elements.canvas);
    fullscreen = true;
    document.body.classList.add('is-fullscreen');
    document.documentElement.style.overflow = 'hidden';
  } else {
    if (overlayDiv) {
      originalCanvasParent.appendChild(elements.canvas);
      document.body.removeChild(overlayDiv);
    }
    fullscreen = false;
    document.body.classList.remove('is-fullscreen');
    document.documentElement.style.overflow = '';
  }
  resizeCanvas();
}

// Double tap on canvas toggles fullscreen; allow normal scroll otherwise
let suppressCanvasTapUntil = 0;
elements.canvas.addEventListener('click', () => {
  // Ignore while any modal is open
  const modalOpen = (elements.calibModal && !elements.calibModal.classList.contains('hidden')) || (elements.resetModal && !elements.resetModal.classList.contains('hidden'));
  if (modalOpen) return;
  if (Date.now() < suppressCanvasTapUntil) return;
  toggleFullscreen();
});

// ---- Wake Lock (keep screen on) ----
let wakeLock = null;
async function enableWakeLock() {
  try {
    if ('wakeLock' in navigator && wakeLock == null) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    }
  } catch (_) { /* ignore */ }
}
function disableWakeLock() {
  try { if (wakeLock) { wakeLock.release(); wakeLock = null; } } catch(_) {}
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && originSet) enableWakeLock();
});

// Hide permissions button once granted (persisted across sessions)
function hidePermissionsButton() {
  if (elements.btnPermissions) {
    elements.btnPermissions.style.display = 'none';
  }
}
try {
  if (localStorage.getItem('sensorsGranted') === '1') {
    hidePermissionsButton();
  }
} catch (_) {}

// ---- In-app camera so tracking continues without leaving the page ----
let camStream = null;
let recorder = null;
let recordedChunks = [];
async function openCamera() {
  try {
    elements.cameraModal.classList.remove('hidden');
    if (!camStream) {
      camStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
    }
    elements.camVideo.srcObject = camStream;
  } catch (e) {
    setStatus('Kamera nicht verfügbar: ' + (e.message || e));
  }
}
function closeCamera() {
  elements.cameraModal.classList.add('hidden');
}
function capturePhoto() {
  try {
    const video = elements.camVideo;
    const c = document.createElement('canvas');
    c.width = video.videoWidth || 1280;
    c.height = video.videoHeight || 720;
    const cx = c.getContext('2d');
    cx.drawImage(video, 0, 0, c.width, c.height);
    const url = c.toDataURL('image/jpeg', 0.92);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'brodkrumen.jpg';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  } catch (_) {}
}
elements.camClose.addEventListener('click', closeCamera);
elements.camCapture.addEventListener('click', capturePhoto);

// ---- Persist and restore state ----
function saveState() {
  try {
    const state = {
      pathPoints,
      originSet,
      currentPosition,
      totalDistance,
      stepCount,
      backToStart,
      altitudeMeters
    };
    localStorage.setItem('brodkrumen_state', JSON.stringify(state));
  } catch (_) {}
}
function loadState() {
  try {
    const raw = localStorage.getItem('brodkrumen_state');
    if (!raw) return;
    const s = JSON.parse(raw);
    pathPoints = Array.isArray(s.pathPoints) ? s.pathPoints : [];
    originSet = !!s.originSet;
    currentPosition = s.currentPosition || { x: 0, y: 0 };
    totalDistance = Number(s.totalDistance) || 0;
    stepCount = Number(s.stepCount) || 0;
    backToStart = s.backToStart || { distance: 0, bearingDeg: 0 };
    altitudeMeters = Number(s.altitudeMeters) || 0;
    elements.steps.textContent = String(stepCount);
    elements.distance.textContent = totalDistance.toFixed(2);
    elements.backDist.textContent = (backToStart.distance||0).toFixed(2);
    elements.backBearing.textContent = isFinite(backToStart.bearingDeg) ? backToStart.bearingDeg.toFixed(0) : '—';
    elements.altitude.textContent = altitudeMeters.toFixed(2);
    redrawAll();
  } catch (_) {}
}
// Save on every step and before unload
window.addEventListener('beforeunload', saveState);
loadState();

// ---- Video recording (experimental on iOS Safari) ----
async function ensureCamStream() {
  if (!camStream) {
    camStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: true });
  }
}
async function toggleVideo() {
  try {
    if (!recorder) {
      await ensureCamStream();
      recordedChunks = [];
      const options = { mimeType: 'video/webm;codecs=vp9' };
      recorder = new MediaRecorder(camStream, options);
      recorder.ondataavailable = (e) => { if (e.data && e.data.size) recordedChunks.push(e.data); };
      recorder.onstop = () => {
        const blob = new Blob(recordedChunks, { type: 'video/webm' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = 'brodkrumen.webm';
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        URL.revokeObjectURL(url);
        recorder = null;
        elements.btnVideo.textContent = 'Video';
      };
      recorder.start();
      elements.btnVideo.textContent = 'Stop';
      setStatus('Videoaufnahme läuft …');
    } else {
      recorder.stop();
      setStatus('Video gespeichert.');
    }
  } catch (e) {
    setStatus('Video nicht verfügbar: ' + (e.message || e));
  }
}


