(() => {
  "use strict";

  const DEFAULT_DECK = {
    id: "punjabi-starter",
    name: "Punjabi Starter",
    emoji: "🪘",
    words: [
      "Bhangra",
      "Lassi",
      "Diljit Dosanjh",
      "Golden Temple",
      "Kabaddi",
      "Gol Gappe",
      "Punjabi Jutti",
      "Tractor",
      "Giddha",
      "Patiala Peg",
    ],
  };

  const STORAGE_KEY = "punjabiHeadsUpCustomDecksV1";
  const SETTINGS_KEY = "punjabiHeadsUpSettingsV1";
  const CORRECT_THRESHOLD = 28;
  const PASS_THRESHOLD = -28;
  const NEUTRAL_THRESHOLD = 11;
  const NEUTRAL_HOLD_MS = 220;
  const GESTURE_COOLDOWN_MS = 650;
  const CALIBRATION_SAMPLE_COUNT = 12;

  const $ = (id) => document.getElementById(id);
  const screens = [...document.querySelectorAll(".screen")];
  const timerChips = [...document.querySelectorAll(".timer-chip")];

  const state = {
    selectedDeckId: DEFAULT_DECK.id,
    seconds: 60,
    reverseTilt: false,
    words: [],
    currentIndex: 0,
    score: 0,
    results: [],
    timerId: null,
    roundEndsAt: 0,
    orientationEnabled: false,
    orientationSeen: false,
    pitch: null,
    baselinePitch: null,
    calibrationSamples: [],
    gestureArmed: false,
    neutralSince: 0,
    lastGestureAt: 0,
    gameActive: false,
    audioContext: null,
  };

  function loadCustomDecks() {
    try {
      const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
      return Array.isArray(parsed)
        ? parsed.filter((d) => d && d.id && d.name && Array.isArray(d.words))
        : [];
    } catch {
      return [];
    }
  }

  function saveCustomDecks(decks) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(decks));
  }

  function allDecks() {
    return [DEFAULT_DECK, ...loadCustomDecks()];
  }

  function currentDeck() {
    return (
      allDecks().find((d) => d.id === state.selectedDeckId) || DEFAULT_DECK
    );
  }

  function loadSettings() {
    try {
      const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
      if ([30, 60, 90].includes(saved.seconds)) state.seconds = saved.seconds;
      state.reverseTilt = Boolean(saved.reverseTilt);
      if (
        saved.selectedDeckId &&
        allDecks().some((d) => d.id === saved.selectedDeckId)
      ) {
        state.selectedDeckId = saved.selectedDeckId;
      }
    } catch {
      /* ignore corrupt settings */
    }
  }

  function saveSettings() {
    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({
        seconds: state.seconds,
        reverseTilt: state.reverseTilt,
        selectedDeckId: state.selectedDeckId,
      }),
    );
  }

  function showScreen(id) {
    screens.forEach((s) => s.classList.toggle("active", s.id === id));
    document.body.classList.toggle(
      "playing",
      ["readyScreen", "countdownScreen", "gameScreen"].includes(id),
    );
    window.scrollTo(0, 0);
  }

  function renderDecks() {
    const deckList = $("deckList");
    deckList.replaceChildren();

    allDecks().forEach((deck) => {
      const card = document.createElement("button");
      card.type = "button";
      card.className = `deck-card${deck.id === state.selectedDeckId ? " selected" : ""}`;
      card.dataset.deckId = deck.id;

      const emoji = document.createElement("span");
      emoji.className = "deck-emoji";
      emoji.textContent = deck.emoji || "🎴";

      const text = document.createElement("span");
      const title = document.createElement("strong");
      const sub = document.createElement("small");
      title.textContent = deck.name;
      sub.textContent = `${deck.words.length} ${deck.words.length === 1 ? "word" : "words"}`;
      text.append(title, sub);

      card.append(emoji, text);

      if (deck.id !== DEFAULT_DECK.id) {
        const del = document.createElement("button");
        del.type = "button";
        del.className = "delete-deck";
        del.setAttribute("aria-label", `Delete ${deck.name}`);
        del.textContent = "×";
        del.addEventListener("click", (event) => {
          event.stopPropagation();
          deleteDeck(deck.id);
        });
        card.append(del);
      }

      card.addEventListener("click", () => {
        state.selectedDeckId = deck.id;
        saveSettings();
        renderDecks();
      });
      deckList.append(card);
    });
  }

  function deleteDeck(id) {
    const decks = loadCustomDecks().filter((deck) => deck.id !== id);
    saveCustomDecks(decks);
    if (state.selectedDeckId === id) state.selectedDeckId = DEFAULT_DECK.id;
    saveSettings();
    renderDecks();
  }

  function parseWords(text) {
    return [
      ...new Set(
        text
          .split(/\n|,/)
          .map((word) => word.trim())
          .filter(Boolean),
      ),
    ];
  }

  function slugId() {
    return `deck-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  }

  function shuffle(array) {
    const copy = [...array];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  }

  function getScreenAngle() {
    const raw = screen.orientation?.angle ?? window.orientation ?? 0;
    return ((Number(raw) % 360) + 360) % 360;
  }

  // Convert device beta/gamma into a front/back pitch value relative to the current screen orientation.
  function normalizedPitch(beta, gamma) {
    const angle = getScreenAngle();
    if (angle === 90) return -gamma;
    if (angle === 270) return gamma;
    if (angle === 180) return -beta;
    return beta;
  }

  function onDeviceOrientation(event) {
    if (event.beta == null || event.gamma == null) return;
    state.orientationSeen = true;
    const nextPitch = normalizedPitch(event.beta, event.gamma);
    if (!Number.isFinite(nextPitch)) return;
    state.pitch = nextPitch;

    if (
      state.calibrationSamples.length < CALIBRATION_SAMPLE_COUNT &&
      !state.gameActive
    ) {
      state.calibrationSamples.push(nextPitch);
      return;
    }

    if (state.gameActive) processTilt(nextPitch);
  }

  async function requestOrientationAccess() {
    if (!("DeviceOrientationEvent" in window)) {
      state.orientationEnabled = false;
      return {
        ok: false,
        message:
          "Motion sensors are not available here. You can still use the on-screen buttons.",
      };
    }

    try {
      if (typeof DeviceOrientationEvent.requestPermission === "function") {
        const permission = await DeviceOrientationEvent.requestPermission();
        if (permission !== "granted") {
          state.orientationEnabled = false;
          return {
            ok: false,
            message:
              "Motion permission was not granted. You can still use the on-screen buttons.",
          };
        }
      }

      if (!state.orientationEnabled) {
        window.addEventListener("deviceorientation", onDeviceOrientation, true);
        state.orientationEnabled = true;
      }
      return { ok: true, message: "Motion controls ready." };
    } catch (error) {
      state.orientationEnabled = false;
      return {
        ok: false,
        message:
          "Could not enable motion controls. You can still use the buttons.",
      };
    }
  }

  function calibrateNeutral() {
    const samples = state.calibrationSamples.filter(Number.isFinite);
    if (Number.isFinite(state.pitch)) samples.push(state.pitch);
    if (!samples.length) {
      state.baselinePitch = 0;
      return;
    }
    const sorted = [...samples].sort((a, b) => a - b);
    state.baselinePitch = sorted[Math.floor(sorted.length / 2)];
  }

  function processTilt(pitch) {
    if (!Number.isFinite(state.baselinePitch)) return;

    let delta = pitch - state.baselinePitch;
    if (state.reverseTilt) delta *= -1;

    const now = performance.now();
    const absDelta = Math.abs(delta);

    if (absDelta <= NEUTRAL_THRESHOLD) {
      if (!state.neutralSince) state.neutralSince = now;
      if (
        now - state.neutralSince >= NEUTRAL_HOLD_MS &&
        now - state.lastGestureAt >= GESTURE_COOLDOWN_MS
      ) {
        state.gestureArmed = true;
        $("motionHint").textContent =
          "Ready — tilt down for Correct, up for Pass";
      }
      return;
    }

    state.neutralSince = 0;
    if (
      !state.gestureArmed ||
      now - state.lastGestureAt < GESTURE_COOLDOWN_MS
    ) {
      $("motionHint").textContent = "Return to neutral";
      return;
    }

    if (delta >= CORRECT_THRESHOLD) {
      state.gestureArmed = false;
      state.lastGestureAt = now;
      registerAnswer("correct");
    } else if (delta <= PASS_THRESHOLD) {
      state.gestureArmed = false;
      state.lastGestureAt = now;
      registerAnswer("pass");
    }
  }

  function currentWord() {
    return state.words[state.currentIndex] || "";
  }

  function nextWord() {
    state.currentIndex += 1;
    if (state.currentIndex >= state.words.length) {
      state.words = shuffle(currentDeck().words);
      state.currentIndex = 0;
    }
    $("gameWord").textContent = currentWord();
  }

  function ensureAudio() {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    if (!state.audioContext) state.audioContext = new Ctx();
    if (state.audioContext.state === "suspended")
      state.audioContext.resume().catch(() => {});
  }

  function playTone(type) {
    const ctx = state.audioContext;
    if (!ctx || ctx.state !== "running") return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type === "correct" ? "sine" : "triangle";
    osc.frequency.setValueAtTime(
      type === "correct" ? 660 : 230,
      ctx.currentTime,
    );
    if (type === "correct")
      osc.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.11);
    else
      osc.frequency.exponentialRampToValueAtTime(170, ctx.currentTime + 0.12);
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.18);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.2);
  }

  function haptic(type) {
    if (!navigator.vibrate) return;
    navigator.vibrate(type === "correct" ? [35, 35, 70] : 90);
  }

  function showFeedback(type) {
    const overlay = $("feedbackOverlay");
    $("feedbackText").textContent = type === "correct" ? "CORRECT!" : "PASS!";
    overlay.className = `feedback-overlay ${type} show`;
    window.setTimeout(() => {
      overlay.classList.remove("show");
    }, 380);
  }

  function registerAnswer(type) {
    if (!state.gameActive) return;
    const word = currentWord();
    if (!word) return;

    state.results.push({ word, type });
    if (type === "correct") {
      state.score += 1;
      $("scoreDisplay").textContent = String(state.score);
    }

    showFeedback(type);
    playTone(type);
    haptic(type);
    nextWord();
    $("motionHint").textContent = "Return to neutral";
  }

  function startCountdown() {
    state.calibrationSamples = [];
    state.baselinePitch = null;
    state.gestureArmed = false;
    state.neutralSince = 0;
    state.lastGestureAt = 0;
    showScreen("countdownScreen");

    let n = 3;
    $("countdownNumber").textContent = String(n);
    const id = setInterval(() => {
      n -= 1;
      if (n > 0) {
        $("countdownNumber").textContent = String(n);
      } else {
        clearInterval(id);
        $("countdownNumber").textContent = "GO!";
        setTimeout(beginRound, 420);
      }
    }, 800);
  }

  function beginRound() {
    const deck = currentDeck();
    state.words = shuffle(deck.words);
    state.currentIndex = 0;
    state.score = 0;
    state.results = [];
    state.gameActive = true;
    state.gestureArmed = false;
    state.neutralSince = performance.now();
    calibrateNeutral();

    $("gameDeckName").textContent = deck.name;
    $("scoreDisplay").textContent = "0";
    $("gameWord").textContent = currentWord();
    $("motionHint").textContent = state.orientationEnabled
      ? "Hold neutral for a moment"
      : "Motion unavailable — use the buttons";
    $("timerDisplay").textContent = String(state.seconds);
    showScreen("gameScreen");

    state.roundEndsAt = performance.now() + state.seconds * 1000;
    clearInterval(state.timerId);
    state.timerId = setInterval(updateTimer, 100);
    updateTimer();
  }

  function updateTimer() {
    const remainingMs = state.roundEndsAt - performance.now();
    const remaining = Math.max(0, Math.ceil(remainingMs / 1000));
    $("timerDisplay").textContent = String(remaining);
    if (remainingMs <= 0) endRound();
  }

  function endRound() {
    if (!state.gameActive) return;
    state.gameActive = false;
    clearInterval(state.timerId);
    state.timerId = null;
    renderResults();
    showScreen("resultsScreen");
  }

  function renderResults() {
    $("finalScore").textContent = String(state.score);
    const passed = state.results.filter((r) => r.type === "pass").length;
    $("resultsSummary").textContent =
      `${state.results.length} played · ${passed} passed`;
    const list = $("resultsList");
    list.replaceChildren();

    if (!state.results.length) {
      const row = document.createElement("div");
      row.className = "result-row";
      row.textContent = "No words were played this round.";
      list.append(row);
      return;
    }

    state.results.forEach((result) => {
      const row = document.createElement("div");
      row.className = "result-row";
      const word = document.createElement("strong");
      word.textContent = result.word;
      const status = document.createElement("span");
      status.className = `result-status ${result.type}`;
      status.textContent = result.type === "correct" ? "✓ CORRECT" : "↗ PASS";
      row.append(word, status);
      list.append(row);
    });
  }

  function bindEvents() {
    timerChips.forEach((chip) => {
      chip.addEventListener("click", () => {
        state.seconds = Number(chip.dataset.seconds);
        timerChips.forEach((c) => c.classList.toggle("selected", c === chip));
        saveSettings();
      });
    });

    $("reverseTilt").addEventListener("change", (event) => {
      state.reverseTilt = event.target.checked;
      saveSettings();
    });

    $("newDeckBtn").addEventListener("click", () => showScreen("deckScreen"));
    document
      .querySelectorAll('[data-back="home"]')
      .forEach((btn) =>
        btn.addEventListener("click", () => showScreen("homeScreen")),
      );

    $("deckWords").addEventListener("input", () => {
      $("wordCount").textContent = String(
        parseWords($("deckWords").value).length,
      );
    });

    $("deckForm").addEventListener("submit", (event) => {
      event.preventDefault();
      const name = $("deckName").value.trim();
      const words = parseWords($("deckWords").value);
      if (!name || words.length < 2) {
        alert("Add a deck name and at least 2 words.");
        return;
      }
      const deck = { id: slugId(), name, emoji: "🎴", words };
      const decks = loadCustomDecks();
      decks.push(deck);
      saveCustomDecks(decks);
      state.selectedDeckId = deck.id;
      saveSettings();
      $("deckForm").reset();
      $("wordCount").textContent = "0";
      renderDecks();
      showScreen("homeScreen");
    });

    $("startBtn").addEventListener("click", () => {
      ensureAudio();
      showScreen("readyScreen");
    });

    $("permissionBtn").addEventListener("click", async () => {
      ensureAudio();
      const button = $("permissionBtn");
      button.disabled = true;
      button.textContent = "CHECKING MOTION…";
      const result = await requestOrientationAccess();
      $("permissionStatus").textContent = result.message;
      button.disabled = false;
      button.textContent = "I'M READY";
      // Start even if sensors are unsupported; manual buttons remain available.
      startCountdown();
    });

    $("correctBtn").addEventListener("click", () => registerAnswer("correct"));
    $("passBtn").addEventListener("click", () => registerAnswer("pass"));

    $("playAgainBtn").addEventListener("click", () => {
      ensureAudio();
      showScreen("readyScreen");
    });
    $("homeBtn").addEventListener("click", () => showScreen("homeScreen"));

    window.addEventListener("keydown", (event) => {
      if (!state.gameActive) return;
      if (event.key === "ArrowDown" || event.key.toLowerCase() === "c")
        registerAnswer("correct");
      if (event.key === "ArrowUp" || event.key.toLowerCase() === "p")
        registerAnswer("pass");
    });

    document.addEventListener("visibilitychange", () => {
      if (document.hidden && state.gameActive) endRound();
    });
  }

  function init() {
    loadSettings();
    renderDecks();
    timerChips.forEach((chip) =>
      chip.classList.toggle(
        "selected",
        Number(chip.dataset.seconds) === state.seconds,
      ),
    );
    $("reverseTilt").checked = state.reverseTilt;
    bindEvents();
  }

  init();
})();
