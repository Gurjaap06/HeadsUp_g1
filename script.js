// ================================================================
// PUNJABI CHARADES — ROBUST MOTION + GAME ENGINE
// iPhone Safari / Android Chrome
// ================================================================

const WORDS = ["ELEPHANT", "PIZZA", "BATMAN", "CRICKET", "MOUNTAIN"];

const GAME_TIME = 60;

const MOTION = {
  CALIBRATION_WINDOW_MS: 800,
  CALIBRATION_MIN_SAMPLES: 10,
  CALIBRATION_MAX_SPREAD: 3.5,

  TRIGGER_MIN: 18,
  TRIGGER_MAX: 24,

  RESET_MIN: 7,
  RESET_MAX: 11,

  CANDIDATE_HOLD_MS: 95,
  CANDIDATE_HOLD_WITH_GYRO_MS: 45,

  GYRO_CONFIRM_DPS: 18,

  RETURN_HOLD_MS: 180,
  ACTION_COOLDOWN_MS: 350,

  MOTION_SOURCE_PRIORITY_MS: 180,
  SENSOR_TIMEOUT_MS: 2800,
};

const game = {
  running: false,
  roundActive: false,
  phase: "idle",

  score: 0,
  passes: 0,

  timeLeft: GAME_TIME,
  remainingMs: GAME_TIME * 1000,
  deadline: 0,

  currentWord: "",
  usedWords: [],

  timer: null,
  countdownTimer: null,

  // Touch
  touchStartX: 0,
  touchStartY: 0,
  touchTarget: null,

  // Motion
  motionMode: "manual",
  motionState: "idle",
  motionPermission: "unknown",
  motionListenersAttached: false,

  currentGravity: null,
  neutralGravity: null,

  lastGravityAt: 0,
  lastMotionGravityAt: 0,

  sensorSeen: false,
  sensorTimeout: null,

  calibrationSamples: [],
  motionTriggerThreshold: 20,
  motionResetThreshold: 9,

  candidateDirection: null,
  candidateSince: 0,

  returnSince: 0,
  motionLastAction: 0,

  currentGyroMagnitude: 0,
  lastGyroAt: 0,
  gyroPeak: 0,

  screenAngle: 0,

  setupTimer: null,
  recalibrationResume: false,

  pausedForPortraitFrom: null,

  wakeLock: null,
};

// ================================================================
// DOM
// ================================================================

const startScreen = document.getElementById("start-screen");
const gameScreen = document.getElementById("game-screen");
const endScreen = document.getElementById("end-screen");

const wordElement = document.getElementById("word");
const scoreElement = document.getElementById("score");
const passElement = document.getElementById("final-passes");
const timerElement = document.getElementById("timer");
const finalScoreElement = document.getElementById("final-score");

const startButton = document.getElementById("start-btn");
const correctButton = document.getElementById("correct-btn");
const passButton = document.getElementById("pass-btn");
const playAgainButton = document.getElementById("play-again-btn");

const manualStartButton = document.getElementById("manual-start-btn");

const gestureHint = document.querySelector(".gesture-hint");

// ================================================================
// BASIC HELPERS
// ================================================================

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalizeVector(x, y, z) {
  const length = Math.hypot(x, y, z);

  if (!Number.isFinite(length) || length < 0.0001) {
    return null;
  }

  return {
    x: x / length,
    y: y / length,
    z: z / length,
  };
}

function mixVectors(a, b, amount) {
  if (!a) return b;
  if (!b) return a;

  return normalizeVector(
    a.x + (b.x - a.x) * amount,
    a.y + (b.y - a.y) * amount,
    a.z + (b.z - a.z) * amount,
  );
}

function averageVectors(samples) {
  if (!samples.length) return null;

  let x = 0;
  let y = 0;
  let z = 0;

  for (const sample of samples) {
    x += sample.v.x;
    y += sample.v.y;
    z += sample.v.z;
  }

  return normalizeVector(
    x / samples.length,
    y / samples.length,
    z / samples.length,
  );
}

function median(values) {
  const filtered = values.filter(Number.isFinite).sort((a, b) => a - b);

  if (!filtered.length) return 0;

  const middle = Math.floor(filtered.length / 2);

  if (filtered.length % 2) {
    return filtered[middle];
  }

  return (filtered[middle - 1] + filtered[middle]) / 2;
}

function percentile(values, amount) {
  if (!values.length) return 0;

  const sorted = [...values].filter(Number.isFinite).sort((a, b) => a - b);

  if (!sorted.length) return 0;

  const index = Math.min(
    sorted.length - 1,
    Math.floor((sorted.length - 1) * amount),
  );

  return sorted[index];
}

function angleBetweenVectors(a, b) {
  if (!a || !b) return null;

  const dot = clamp(a.x * b.x + a.y * b.y + a.z * b.z, -1, 1);

  return (Math.acos(dot) * 180) / Math.PI;
}

/*
 * Signed rotation around the CURRENT SCREEN'S horizontal axis.
 *
 * Neutral phone on forehead:
 *   screen Y points upward
 *   screen Z points outward
 *
 * Tilting the screen DOWN produces a negative value.
 * Tilting the screen UP produces a positive value.
 */
function getSignedForeheadTilt(neutral, current) {
  if (!neutral || !current) return null;

  const neutralLength = Math.hypot(neutral.y, neutral.z);

  const currentLength = Math.hypot(current.y, current.z);

  if (neutralLength < 0.15 || currentLength < 0.15) {
    return null;
  }

  const ny = neutral.y / neutralLength;
  const nz = neutral.z / neutralLength;

  const cy = current.y / currentLength;
  const cz = current.z / currentLength;

  const cross = ny * cz - nz * cy;
  const dot = ny * cy + nz * cz;

  return (Math.atan2(cross, dot) * 180) / Math.PI;
}

function isLandscape() {
  if (
    window.matchMedia &&
    window.matchMedia("(orientation: landscape)").matches
  ) {
    return true;
  }

  return window.innerWidth > window.innerHeight;
}

// ================================================================
// SCREEN COORDINATE SYSTEM
// ================================================================

function getScreenAngle() {
  let angle = 0;

  if (screen.orientation && Number.isFinite(screen.orientation.angle)) {
    angle = screen.orientation.angle;
  } else if (Number.isFinite(window.orientation)) {
    angle = window.orientation;
  }

  angle = ((angle % 360) + 360) % 360;

  // Sensor APIs normally report quarter turns.
  return (Math.round(angle / 90) * 90) % 360;
}

function deviceVectorToScreen(vector) {
  if (!vector) return null;

  const { x, y, z } = vector;
  const angle = getScreenAngle();

  if (angle === 90) {
    return { x: y, y: -x, z };
  }

  if (angle === 180) {
    return { x: -x, y: -y, z };
  }

  if (angle === 270) {
    return { x: -y, y: x, z };
  }

  return { x, y, z };
}

/*
 * Convert beta/gamma into an approximate gravity / g-force vector.
 * This is used when accelerationIncludingGravity is unavailable.
 */
function orientationToGravity(beta, gamma) {
  if (!Number.isFinite(beta) || !Number.isFinite(gamma)) {
    return null;
  }

  const betaRad = (beta * Math.PI) / 180;
  const gammaRad = (gamma * Math.PI) / 180;

  const deviceVector = {
    x: Math.sin(gammaRad) * Math.cos(betaRad),
    y: Math.sin(betaRad),
    z: Math.cos(gammaRad) * Math.cos(betaRad),
  };

  const screenVector = deviceVectorToScreen(deviceVector);

  if (!screenVector) return null;

  return normalizeVector(screenVector.x, screenVector.y, screenVector.z);
}

// ================================================================
// MOTION PERMISSION
// ================================================================

/*
 * IMPORTANT:
 * This function intentionally is NOT async.
 *
 * requestPermission() calls are started synchronously from the
 * button click so iOS/Chrome retain transient user activation.
 */
function requestMotionPermissionsFromGesture() {
  if (!window.isSecureContext) {
    return Promise.resolve({
      allowed: false,
      reason: "insecure",
    });
  }

  const hasOrientation = typeof DeviceOrientationEvent !== "undefined";

  const hasMotion = typeof DeviceMotionEvent !== "undefined";

  if (!hasOrientation && !hasMotion) {
    return Promise.resolve({
      allowed: false,
      reason: "unsupported",
    });
  }

  if (game.motionPermission === "granted") {
    return Promise.resolve({
      allowed: true,
      reason: "already-granted",
    });
  }

  const requests = [];

  try {
    if (
      hasMotion &&
      typeof DeviceMotionEvent.requestPermission === "function"
    ) {
      requests.push(DeviceMotionEvent.requestPermission());
    }

    if (
      hasOrientation &&
      typeof DeviceOrientationEvent.requestPermission === "function"
    ) {
      requests.push(DeviceOrientationEvent.requestPermission());
    }
  } catch (error) {
    console.warn("Motion permission request failed:", error);

    game.motionPermission = "denied";

    return Promise.resolve({
      allowed: false,
      reason: "permission-error",
    });
  }

  // Browsers that do not expose requestPermission()
  // can normally receive the events directly.
  if (!requests.length) {
    game.motionPermission = "granted";

    return Promise.resolve({
      allowed: true,
      reason: "not-required",
    });
  }

  return Promise.all(requests)
    .then((results) => {
      const allowed = results.every((result) => result === "granted");

      game.motionPermission = allowed ? "granted" : "denied";

      return {
        allowed,
        reason: allowed ? "granted" : "denied",
      };
    })
    .catch((error) => {
      console.warn("Motion permission rejected:", error);

      game.motionPermission = "denied";

      return {
        allowed: false,
        reason: "permission-error",
      };
    });
}

// ================================================================
// MOTION SETUP UI
// ================================================================

function motionUI() {
  return {
    overlay: document.getElementById("motion-setup"),
    title: document.getElementById("motion-title"),
    instruction: document.getElementById("motion-instruction"),
    status: document.getElementById("motion-status"),

    dots: [
      document.getElementById("setup-dot-1"),
      document.getElementById("setup-dot-2"),
      document.getElementById("setup-dot-3"),
    ],

    manual: document.getElementById("manual-start-btn"),
  };
}

function setMotionUI(stage, status) {
  const ui = motionUI();

  if (!ui.overlay) return;

  ui.dots.forEach((dot) => {
    dot?.classList.remove("active", "done");
  });

  if (stage >= 1) {
    ui.dots[0]?.classList.add("done");
  }

  if (stage >= 2) {
    ui.dots[1]?.classList.add("done");
  }

  if (stage >= 3) {
    ui.dots[2]?.classList.add("done");
  }

  if (stage >= 0 && stage < 3) {
    ui.dots[stage]?.classList.add("active");
  }

  if (ui.status) {
    ui.status.textContent = status;
  }
}

function showMotionSetup(recalibrating = false) {
  const ui = motionUI();

  if (!ui.overlay) return;

  ui.overlay.classList.remove("hidden", "motion-ready");

  if (ui.title) {
    ui.title.textContent = recalibrating
      ? "HOLD STILL"
      : "PUT PHONE TO FOREHEAD";
  }

  if (ui.instruction) {
    ui.instruction.textContent = recalibrating
      ? "Keep the phone in landscape against your forehead while the controls recalibrate."
      : "Hold the phone in landscape against your forehead and keep it still for a moment.";
  }

  if (ui.manual) {
    ui.manual.textContent = "PLAY WITHOUT MOTION";
  }

  setMotionUI(
    0,
    isLandscape() ? "Waiting for motion sensor…" : "Turn your phone sideways…",
  );
}

function hideMotionSetup() {
  const ui = motionUI();

  if (!ui.overlay) return;

  ui.overlay.classList.add("hidden");
  ui.overlay.classList.remove("motion-ready");
}

function setControlHint(mode) {
  if (!gestureHint) return;

  if (mode === "sensor") {
    gestureHint.innerHTML =
      "TILT UP = PASS &nbsp; • &nbsp; TILT DOWN = CORRECT &nbsp; • &nbsp; BUTTONS ALWAYS WORK";
  } else {
    gestureHint.innerHTML =
      "SWIPE ← = PASS &nbsp; • &nbsp; SWIPE → = CORRECT &nbsp; • &nbsp; USE THE BUTTONS BELOW";
  }
}

// ================================================================
// SENSOR STATE
// ================================================================

function resetSensorReadings() {
  game.currentGravity = null;
  game.neutralGravity = null;

  game.lastGravityAt = 0;
  game.lastMotionGravityAt = 0;

  game.sensorSeen = false;

  game.calibrationSamples = [];

  game.candidateDirection = null;
  game.candidateSince = 0;

  game.returnSince = 0;
  game.motionLastAction = 0;

  game.currentGyroMagnitude = 0;
  game.lastGyroAt = 0;
  game.gyroPeak = 0;

  game.motionTriggerThreshold = 20;
  game.motionResetThreshold = 9;
}

function resetMotionRuntime() {
  clearTimeout(game.sensorTimeout);
  clearTimeout(game.setupTimer);

  game.motionMode = "manual";
  game.motionState = "idle";

  game.recalibrationResume = false;

  resetSensorReadings();
}

// ================================================================
// SENSOR LISTENERS
// ================================================================

function ensureMotionListeners() {
  if (game.motionListenersAttached) return;

  window.addEventListener("devicemotion", handleDeviceMotion, true);

  window.addEventListener("deviceorientation", handleDeviceOrientation, true);

  game.motionListenersAttached = true;
}

function handleDeviceMotion(event) {
  if (!game.running || game.motionMode !== "sensor") {
    return;
  }

  const now = performance.now();

  const rotationRate = event.rotationRate;

  if (rotationRate) {
    const values = [
      rotationRate.alpha,
      rotationRate.beta,
      rotationRate.gamma,
    ].filter(Number.isFinite);

    if (values.length) {
      const alpha = Number.isFinite(rotationRate.alpha)
        ? rotationRate.alpha
        : 0;

      const beta = Number.isFinite(rotationRate.beta) ? rotationRate.beta : 0;

      const gamma = Number.isFinite(rotationRate.gamma)
        ? rotationRate.gamma
        : 0;

      game.currentGyroMagnitude = Math.hypot(alpha, beta, gamma);

      game.lastGyroAt = now;
    }
  }

  const gravity = event.accelerationIncludingGravity;

  if (
    gravity &&
    Number.isFinite(gravity.x) &&
    Number.isFinite(gravity.y) &&
    Number.isFinite(gravity.z)
  ) {
    const screenVector = deviceVectorToScreen({
      x: gravity.x,
      y: gravity.y,
      z: gravity.z,
    });

    if (!screenVector) return;

    const normalized = normalizeVector(
      screenVector.x,
      screenVector.y,
      screenVector.z,
    );

    if (normalized) {
      game.lastMotionGravityAt = now;

      feedGravity(normalized, "motion");
    }
  }
}

function handleDeviceOrientation(event) {
  if (!game.running || game.motionMode !== "sensor") {
    return;
  }

  const now = performance.now();

  /*
   * accelerationIncludingGravity is preferred.
   * Do not let orientation events fight with the accelerometer
   * when a recent motion reading exists.
   */
  if (now - game.lastMotionGravityAt < MOTION.MOTION_SOURCE_PRIORITY_MS) {
    return;
  }

  const vector = orientationToGravity(event.beta, event.gamma);

  if (vector) {
    feedGravity(vector, "orientation");
  }
}

function feedGravity(vector, source) {
  if (!isLandscape()) return;

  const now = performance.now();

  if (
    source === "orientation" &&
    now - game.lastMotionGravityAt < MOTION.MOTION_SOURCE_PRIORITY_MS
  ) {
    return;
  }

  if (!game.currentGravity) {
    game.currentGravity = vector;
  } else {
    const dt = clamp(now - game.lastGravityAt, 8, 100);

    /*
     * Time-based low-pass filter.
     * Roughly 70 ms response time.
     */
    const filterAmount = 1 - Math.exp(-dt / 70);

    game.currentGravity = mixVectors(game.currentGravity, vector, filterAmount);
  }

  game.lastGravityAt = now;

  if (!game.sensorSeen) {
    game.sensorSeen = true;

    setMotionUI(1, "Sensor connected — keep the phone still…");
  }

  if (game.phase === "setup" || game.phase === "recalibrating") {
    collectCalibrationSample();
    return;
  }

  if (game.phase === "countdown") {
    refineNeutralDuringCountdown();
    return;
  }

  if (game.phase === "playing") {
    processGesture();
  }
}

// ================================================================
// CALIBRATION
// ================================================================

function startSensorCalibration({ resumeRound = false } = {}) {
  if (!game.running) return;

  ensureMotionListeners();

  clearTimeout(game.sensorTimeout);
  clearTimeout(game.setupTimer);

  resetSensorReadings();

  game.motionMode = "sensor";
  game.motionState = "calibrating";
  game.recalibrationResume = resumeRound;

  game.phase = resumeRound ? "recalibrating" : "setup";

  game.roundActive = false;

  setControlHint("sensor");
  showMotionSetup(resumeRound);

  game.sensorTimeout = setTimeout(() => {
    if (
      !game.running ||
      game.motionMode !== "sensor" ||
      (game.phase !== "setup" && game.phase !== "recalibrating")
    ) {
      return;
    }

    if (!game.sensorSeen) {
      setMotionUI(0, "No motion data detected — use PLAY WITHOUT MOTION.");
    }
  }, MOTION.SENSOR_TIMEOUT_MS);
}

function collectCalibrationSample() {
  if (!game.currentGravity) return;

  const now = performance.now();

  game.calibrationSamples.push({
    t: now,
    v: {
      ...game.currentGravity,
    },
  });

  const oldestAllowed = now - MOTION.CALIBRATION_WINDOW_MS;

  while (
    game.calibrationSamples.length &&
    game.calibrationSamples[0].t < oldestAllowed
  ) {
    game.calibrationSamples.shift();
  }

  if (game.calibrationSamples.length < MOTION.CALIBRATION_MIN_SAMPLES) {
    return;
  }

  const duration =
    game.calibrationSamples[game.calibrationSamples.length - 1].t -
    game.calibrationSamples[0].t;

  if (duration < 550) {
    return;
  }

  const average = averageVectors(game.calibrationSamples);

  if (!average) return;

  const deviations = game.calibrationSamples.map((sample) =>
    angleBetweenVectors(average, sample.v),
  );

  const spread = percentile(deviations, 0.9);

  if (duration > 350 && spread < 5) {
    setMotionUI(2, "Almost ready — keep still…");
  }

  if (spread > MOTION.CALIBRATION_MAX_SPREAD) {
    setMotionUI(1, "Keep the phone still…");

    return;
  }

  const noise = median(deviations);

  game.neutralGravity = average;

  /*
   * Slightly adapt thresholds to the noise measured on
   * this particular phone without becoming over-sensitive.
   */
  game.motionTriggerThreshold = clamp(
    18 + noise * 1.8,
    MOTION.TRIGGER_MIN,
    MOTION.TRIGGER_MAX,
  );

  game.motionResetThreshold = clamp(
    7 + noise,
    MOTION.RESET_MIN,
    MOTION.RESET_MAX,
  );

  finishCalibration();
}

function finishCalibration() {
  clearTimeout(game.sensorTimeout);

  game.calibrationSamples = [];
  game.motionState = "calibrated";

  const ui = motionUI();

  setMotionUI(3, "Calibrated");

  ui.overlay?.classList.add("motion-ready");

  if (game.recalibrationResume) {
    game.setupTimer = setTimeout(() => {
      if (!game.running) return;

      hideMotionSetup();

      game.phase = "playing";
      game.roundActive = true;

      /*
       * Start latched. The player must be neutral
       * briefly before another gesture can fire.
       */
      game.motionState = "latched";
      game.returnSince = 0;

      resumeTimer();
    }, 300);

    return;
  }

  game.phase = "pre-countdown";

  game.setupTimer = setTimeout(() => {
    if (!game.running) return;

    hideMotionSetup();
    startCountdown();
  }, 350);
}

function refineNeutralDuringCountdown() {
  if (!game.currentGravity || !game.neutralGravity) {
    return;
  }

  const distance = angleBetweenVectors(
    game.currentGravity,
    game.neutralGravity,
  );

  if (!Number.isFinite(distance) || distance > 6) {
    return;
  }

  const now = performance.now();

  const gyroIsQuiet =
    now - game.lastGyroAt > 200 || game.currentGyroMagnitude < 15;

  if (!gyroIsQuiet) return;

  /*
   * Very slow baseline refinement during 3-2-1.
   * This corrects for the player settling the phone
   * slightly differently after calibration.
   */
  game.neutralGravity = mixVectors(
    game.neutralGravity,
    game.currentGravity,
    0.035,
  );
}

// ================================================================
// GESTURE STATE MACHINE
// ================================================================

function processGesture() {
  if (
    !game.running ||
    !game.roundActive ||
    game.phase !== "playing" ||
    game.motionMode !== "sensor" ||
    !game.neutralGravity ||
    !game.currentGravity
  ) {
    return;
  }

  const now = performance.now();

  const signedTilt = getSignedForeheadTilt(
    game.neutralGravity,
    game.currentGravity,
  );

  if (!Number.isFinite(signedTilt)) {
    return;
  }

  const totalDistance = angleBetweenVectors(
    game.neutralGravity,
    game.currentGravity,
  );

  // ------------------------------------------------------------
  // LATCHED: require a clear return to neutral.
  // ------------------------------------------------------------

  if (game.motionState === "latched") {
    const neutralEnough =
      Math.abs(signedTilt) <= game.motionResetThreshold &&
      Number.isFinite(totalDistance) &&
      totalDistance <= game.motionResetThreshold + 3;

    if (!neutralEnough) {
      game.returnSince = 0;
      return;
    }

    if (!game.returnSince) {
      game.returnSince = now;
      return;
    }

    if (now - game.returnSince >= MOTION.RETURN_HOLD_MS) {
      game.motionState = "ready";
      game.returnSince = 0;

      game.candidateDirection = null;
      game.candidateSince = 0;
      game.gyroPeak = 0;
    }

    return;
  }

  if (game.motionState !== "ready") {
    return;
  }

  if (now - game.motionLastAction < MOTION.ACTION_COOLDOWN_MS) {
    return;
  }

  // ------------------------------------------------------------
  // DEAD ZONE
  // ------------------------------------------------------------

  if (Math.abs(signedTilt) < game.motionTriggerThreshold) {
    game.candidateDirection = null;
    game.candidateSince = 0;
    game.gyroPeak = 0;
    return;
  }

  /*
   * DOWN = negative = PASS
   * UP   = positive = CORRECT
   */
  const direction = signedTilt < 0 ? "pass" : "correct";

  const recentGyro = now - game.lastGyroAt < 220;

  const gyroNow = recentGyro ? game.currentGyroMagnitude : 0;

  if (game.candidateDirection !== direction) {
    game.candidateDirection = direction;
    game.candidateSince = now;
    game.gyroPeak = gyroNow;

    return;
  }

  game.gyroPeak = Math.max(game.gyroPeak, gyroNow);

  /*
   * Gyroscope data lets us confirm intentional rotation
   * faster, but is NOT mandatory. Some browsers/devices
   * expose gravity without a usable rotationRate.
   */
  const requiredHold =
    recentGyro && game.gyroPeak >= MOTION.GYRO_CONFIRM_DPS
      ? MOTION.CANDIDATE_HOLD_WITH_GYRO_MS
      : MOTION.CANDIDATE_HOLD_MS;

  if (now - game.candidateSince < requiredHold) {
    return;
  }

  triggerMotionAction(direction);
}

function triggerMotionAction(direction) {
  const now = performance.now();

  /*
   * Latch BEFORE changing the word.
   * This is what guarantees one physical tilt = one action.
   */
  game.motionState = "latched";
  game.motionLastAction = now;

  game.returnSince = 0;
  game.candidateDirection = null;
  game.candidateSince = 0;
  game.gyroPeak = 0;

  try {
    navigator.vibrate?.(25);
  } catch {
    // Vibration is optional.
  }

  if (direction === "correct") {
    correctAnswer("motion");
  } else {
    passWord("motion");
  }
}

function latchMotionAfterManualAction() {
  if (game.motionMode !== "sensor" || game.phase !== "playing") {
    return;
  }

  /*
   * If somebody taps a button while the phone is already
   * tilted, do not let that tilt immediately answer the
   * newly displayed word as well.
   */
  game.motionState = "latched";
  game.returnSince = 0;

  game.candidateDirection = null;
  game.candidateSince = 0;
  game.gyroPeak = 0;

  game.motionLastAction = performance.now();
}

// ================================================================
// MANUAL FALLBACK
// ================================================================

function useManualControls() {
  if (!game.running) return;

  clearTimeout(game.sensorTimeout);
  clearTimeout(game.setupTimer);

  const resumeExistingRound =
    game.phase === "recalibrating" && game.recalibrationResume;

  game.motionMode = "manual";
  game.motionState = "idle";

  game.recalibrationResume = false;

  hideMotionSetup();
  setControlHint("manual");

  if (resumeExistingRound) {
    game.phase = "playing";
    game.roundActive = true;
    resumeTimer();
    return;
  }

  startCountdown();
}

// ================================================================
// ROUND START
// ================================================================

function showGameScreen() {
  startScreen?.classList.add("hidden");
  gameScreen?.classList.remove("hidden");
}

function prepareRound() {
  clearInterval(game.timer);
  clearInterval(game.countdownTimer);

  resetMotionRuntime();

  game.running = true;
  game.roundActive = false;
  game.phase = "starting";

  game.score = 0;
  game.passes = 0;

  game.timeLeft = GAME_TIME;
  game.remainingMs = GAME_TIME * 1000;
  game.deadline = 0;

  game.currentWord = "";
  game.usedWords = [];

  game.pausedForPortraitFrom = null;

  game.screenAngle = getScreenAngle();

  endScreen?.classList.add("hidden");

  updateScore();
  updateTimer();

  showGameScreen();

  nextWord();
}

function startGameFromGesture() {
  /*
   * Permission calls MUST start before any await/fullscreen
   * operation. Do this first.
   */
  const permissionPromise = requestMotionPermissionsFromGesture();

  prepareRound();

  void requestWakeLock();

  permissionPromise.then((result) => {
    if (!game.running) return;

    if (result.allowed) {
      startSensorCalibration({
        resumeRound: false,
      });
    } else {
      /*
       * Permission denied / no sensors / insecure page:
       * game still works normally with buttons and swipes.
       */
      game.motionMode = "manual";
      game.motionState = "idle";

      setControlHint("manual");

      startCountdown();
    }
  });
}

// ================================================================
// WORDS / SCORE
// ================================================================

function nextWord() {
  if (!game.running) return;

  if (game.usedWords.length >= WORDS.length) {
    game.usedWords = [];
  }

  const availableWords = WORDS.filter((word) => !game.usedWords.includes(word));

  const randomIndex = Math.floor(Math.random() * availableWords.length);

  game.currentWord = availableWords[randomIndex];

  game.usedWords.push(game.currentWord);

  if (wordElement && game.phase === "playing") {
    displayCurrentWord();
  }
}

function displayCurrentWord() {
  if (!wordElement) return;

  wordElement.textContent = game.currentWord;

  if (typeof wordElement.animate === "function") {
    wordElement.animate(
      [
        {
          opacity: 0,
          transform: "scale(.94)",
        },
        {
          opacity: 1,
          transform: "scale(1)",
        },
      ],
      {
        duration: 140,
        easing: "ease-out",
      },
    );
  }
}

function correctAnswer(source = "manual") {
  if (!game.running || !game.roundActive || game.phase !== "playing") {
    return;
  }

  if (source !== "motion") {
    latchMotionAfterManualAction();
  }

  game.score += 1;

  updateScore();
  nextWord();
}

function passWord(source = "manual") {
  if (!game.running || !game.roundActive || game.phase !== "playing") {
    return;
  }

  if (source !== "motion") {
    latchMotionAfterManualAction();
  }

  game.passes += 1;

  nextWord();
}

function updateScore() {
  if (scoreElement) {
    scoreElement.textContent = game.score;
  }
}

function updateTimer() {
  if (!timerElement) return;

  timerElement.textContent = game.timeLeft;

  timerElement.style.borderColor =
    game.timeLeft <= 10 ? "rgba(236,72,153,.65)" : "rgba(255,255,255,.13)";
}

function updateEndScreen() {
  if (finalScoreElement) {
    finalScoreElement.textContent = game.score;
  }

  if (passElement) {
    passElement.textContent = game.passes;
  }
}

// ================================================================
// COUNTDOWN
// ================================================================

function startCountdown() {
  if (!game.running) return;

  clearInterval(game.countdownTimer);

  game.phase = "countdown";
  game.roundActive = false;

  if (game.motionMode === "sensor") {
    game.motionState = "countdown";
  }

  let count = 3;

  if (wordElement) {
    wordElement.textContent = String(count);
  }

  game.countdownTimer = setInterval(() => {
    if (!game.running) {
      clearInterval(game.countdownTimer);
      return;
    }

    count -= 1;

    if (count > 0) {
      if (wordElement) {
        wordElement.textContent = String(count);
      }

      return;
    }

    clearInterval(game.countdownTimer);

    game.countdownTimer = null;

    beginActiveRound();
  }, 700);
}

function beginActiveRound() {
  if (!game.running) return;

  game.phase = "playing";
  game.roundActive = true;

  displayCurrentWord();

  if (game.motionMode === "sensor") {
    /*
     * Never arm directly at GO.
     * Require a brief confirmed neutral position first.
     */
    game.motionState = "latched";
    game.returnSince = 0;
  }

  startTimer();
}

// ================================================================
// TIMER
// ================================================================

function startTimer() {
  clearInterval(game.timer);

  game.remainingMs = GAME_TIME * 1000;

  resumeTimer();
}

function resumeTimer() {
  clearInterval(game.timer);

  if (!game.running) return;

  if (game.remainingMs <= 0) {
    endGame();
    return;
  }

  game.deadline = performance.now() + game.remainingMs;

  tickTimer();

  game.timer = setInterval(tickTimer, 150);
}

function pauseTimer() {
  if (!game.timer) return;

  game.remainingMs = Math.max(0, game.deadline - performance.now());

  clearInterval(game.timer);
  game.timer = null;
}

function tickTimer() {
  if (!game.running || game.phase !== "playing") {
    return;
  }

  const remaining = Math.max(0, game.deadline - performance.now());

  game.remainingMs = remaining;

  const seconds = Math.ceil(remaining / 1000);

  if (seconds !== game.timeLeft) {
    game.timeLeft = seconds;
    updateTimer();
  }

  if (remaining <= 0) {
    endGame();
  }
}

// ================================================================
// ORIENTATION CHANGES
// ================================================================

function handleScreenOrientationChange() {
  const previousAngle = game.screenAngle;

  const newAngle = getScreenAngle();

  game.screenAngle = newAngle;

  if (!game.running) return;

  // Portrait: pause the round instead of allowing hidden play.
  if (!isLandscape()) {
    if (game.phase === "playing") {
      pauseTimer();

      game.roundActive = false;
      game.pausedForPortraitFrom = "playing";

      game.phase = "paused-portrait";
    } else if (game.phase === "countdown") {
      clearInterval(game.countdownTimer);

      game.countdownTimer = null;

      game.pausedForPortraitFrom = "countdown";

      game.phase = "paused-portrait";
    }

    return;
  }

  // Returned from portrait.
  if (game.phase === "paused-portrait") {
    const previousPhase = game.pausedForPortraitFrom;

    game.pausedForPortraitFrom = null;

    if (previousPhase === "playing") {
      if (game.motionMode === "sensor") {
        startSensorCalibration({
          resumeRound: true,
        });
      } else {
        game.phase = "playing";
        game.roundActive = true;
        resumeTimer();
      }

      return;
    }

    if (previousPhase === "countdown") {
      if (game.motionMode === "sensor") {
        startSensorCalibration({
          resumeRound: false,
        });
      } else {
        startCountdown();
      }

      return;
    }
  }

  const angleChanged = previousAngle !== newAngle;

  if (!angleChanged || game.motionMode !== "sensor") {
    return;
  }

  /*
   * landscape-primary <-> landscape-secondary changes the
   * screen coordinate transform. Recalibrate instead of
   * allowing that rotation to become an answer.
   */
  if (game.phase === "playing") {
    pauseTimer();

    game.roundActive = false;

    startSensorCalibration({
      resumeRound: true,
    });

    return;
  }

  if (game.phase === "countdown" || game.phase === "pre-countdown") {
    clearInterval(game.countdownTimer);

    game.countdownTimer = null;

    startSensorCalibration({
      resumeRound: false,
    });

    return;
  }

  if (game.phase === "setup") {
    startSensorCalibration({
      resumeRound: false,
    });
  }
}

// ================================================================
// END GAME
// ================================================================

function endGame() {
  if (!game.running) return;

  game.running = false;
  game.roundActive = false;
  game.phase = "ended";

  clearInterval(game.timer);
  clearInterval(game.countdownTimer);

  clearTimeout(game.sensorTimeout);
  clearTimeout(game.setupTimer);

  game.timer = null;
  game.countdownTimer = null;

  updateEndScreen();

  hideMotionSetup();

  endScreen?.classList.remove("hidden");

  game.motionState = "idle";

  void releaseWakeLock();
}

// ================================================================
// WAKE LOCK
// ================================================================

async function requestWakeLock() {
  if (!("wakeLock" in navigator) || document.hidden) {
    return;
  }

  try {
    if (game.wakeLock && !game.wakeLock.released) {
      return;
    }

    game.wakeLock = await navigator.wakeLock.request("screen");
  } catch (error) {
    console.log("Wake lock unavailable:", error);
  }
}

async function releaseWakeLock() {
  try {
    if (game.wakeLock && !game.wakeLock.released) {
      await game.wakeLock.release();
    }
  } catch {
    // Optional feature.
  }

  game.wakeLock = null;
}

// ================================================================
// BUTTONS
// ================================================================

startButton?.addEventListener("click", startGameFromGesture);

playAgainButton?.addEventListener("click", startGameFromGesture);

correctButton?.addEventListener("click", () => correctAnswer("button"));

passButton?.addEventListener("click", () => passWord("button"));

manualStartButton?.addEventListener("click", useManualControls);

wordElement?.addEventListener("click", () => correctAnswer("word"));

// ================================================================
// SWIPE FALLBACK
// ================================================================

function isInteractiveTarget(target) {
  return !!target?.closest("button, a, input, select, textarea");
}

gameScreen?.addEventListener(
  "touchstart",
  (event) => {
    if (
      !game.running ||
      !game.roundActive ||
      isInteractiveTarget(event.target)
    ) {
      return;
    }

    const touch = event.changedTouches[0];

    game.touchStartX = touch.clientX;

    game.touchStartY = touch.clientY;

    game.touchTarget = event.target;
  },
  {
    passive: true,
  },
);

gameScreen?.addEventListener(
  "touchend",
  (event) => {
    if (
      !game.running ||
      !game.roundActive ||
      isInteractiveTarget(event.target) ||
      isInteractiveTarget(game.touchTarget)
    ) {
      return;
    }

    const touch = event.changedTouches[0];

    const deltaX = touch.clientX - game.touchStartX;

    const deltaY = touch.clientY - game.touchStartY;

    const absX = Math.abs(deltaX);

    const absY = Math.abs(deltaY);

    if (absX < 55 || absX <= absY * 1.15) {
      return;
    }

    event.preventDefault();

    if (deltaX < 0) {
      passWord("swipe");
    } else {
      correctAnswer("swipe");
    }
  },
  {
    passive: false,
  },
);

// ================================================================
// KEYBOARD
// ================================================================

document.addEventListener("keydown", (event) => {
  if (!game.running || !game.roundActive) {
    return;
  }

  if (
    [
      "Space",
      "Enter",
      "ArrowUp",
      "ArrowDown",
      "ArrowLeft",
      "ArrowRight",
    ].includes(event.code)
  ) {
    event.preventDefault();
  }

  if (["Space", "Enter", "ArrowUp", "ArrowRight"].includes(event.code)) {
    correctAnswer("keyboard");
  }

  if (["ArrowDown", "ArrowLeft"].includes(event.code)) {
    passWord("keyboard");
  }
});

// ================================================================
// SCREEN ORIENTATION EVENTS
// ================================================================

if (
  screen.orientation &&
  typeof screen.orientation.addEventListener === "function"
) {
  screen.orientation.addEventListener("change", handleScreenOrientationChange);
}

window.addEventListener("orientationchange", () => {
  /*
   * Let the browser finish updating the viewport and
   * screen.orientation.angle before reading it.
   */
  setTimeout(handleScreenOrientationChange, 100);
});

// Reacquire wake lock after returning to the game.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && game.running) {
    void requestWakeLock();
  }
});

// ================================================================
// SERVICE WORKER
// ================================================================

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("./sw.js", {
        updateViaCache: "none",
      })
      .then((registration) => {
        registration.update().catch(() => {});
      })
      .catch((error) => {
        console.error("Service Worker error:", error);
      });
  });
}
