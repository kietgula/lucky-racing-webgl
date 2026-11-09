/**
 * Lucky Racing 3D Online — WebGL 3D Engine & Gameplay Runtime
 * Ported directly from the Unity 6 (C#) architecture:
 *   - MultiLaneTrackSpline (5-lane Catmull-Rom S-curve, 1.5m lane width, arc-length table)
 *   - TopDownRaceCameraController (Pack Follow + Full Diorama Overview in 9:16 Portrait)
 *   - ServerRaceSimulator (10Hz tick, Chaotic Surge RNG [-0.008, +0.028], 4 Chaos Charms)
 *   - NetworkBetRegistry & MockBackendService (Persistent Player Name, Custom Room Joining, Rewarded Ads +100 Coins)
 *   - 3x/2x/1x/0x payouts with full career history persistence
 */
(function () {
  "use strict";

  // ============================================================================
  // 1. CONSTANTS & CONFIG SCHEMAS
  // ============================================================================
  const RACER_COUNT = 5;
  const LANE_WIDTH = 1.5;
  const SAMPLE_COUNT = 256;

  const BOT_NAMES = ["BOT_LOC", "BOT_LONG", "BOT_MINH", "BOT_KHANG"];
  const STANDARD_BET_CHIPS = [10, 20, 50, 100, 500];

  const RACER_CONFIGS = [
    { index: 0, shortName: "#1 ĐỎ", fullName: "Xe #1 (Đỏ Viper)", pickLabel: "#1 ĐỎ VIPER", colorHex: 0xe63232, cssColor: "#ef4444" },
    { index: 1, shortName: "#2 XANH", fullName: "Xe #2 (Xanh Bolt)", pickLabel: "#2 XANH BOLT", colorHex: 0x2878f0, cssColor: "#3b82f6" },
    { index: 2, shortName: "#3 HỒNG", fullName: "Xe #3 (Hồng Star)", pickLabel: "#3 HỒNG STAR", colorHex: 0xf046aa, cssColor: "#ec4899" },
    { index: 3, shortName: "#4 VÀNG", fullName: "Xe #4 (Vàng Flash)", pickLabel: "#4 VÀNG FLASH", colorHex: 0xf5c828, cssColor: "#eab308" },
    { index: 4, shortName: "#5 LÁ", fullName: "Xe #5 (Xanh Lá)", pickLabel: "#5 XANH LÁ", colorHex: 0x28c850, cssColor: "#22c55e" }
  ];

  const CHARM_NAMES = ["CHOÁNG", "VỀ ĐÍCH", "HOÁN ĐỔI", "QUAY ĐẦU"];
  const CHARM_COSTS = [50, 100, 250, 400];

  const MatchPhase = {
    MainMenu: "MainMenu",
    Betting: "Betting",
    Racing: "Racing",
    Podium: "Podium"
  };

  const StatusFlags = {
    None: 0,
    DizzyStunned: 1 << 0,
    FinishBoosted: 1 << 1,
    SwappedRecently: 1 << 2,
    TurningReversed: 1 << 3
  };

  function clamp(val, min, max) {
    return Math.max(min, Math.min(max, val));
  }

  function clamp01(val) {
    return Math.max(0.0, Math.min(1.0, val));
  }

  function lerp(a, b, t) {
    return a + (b - a) * clamp01(t);
  }

  function randRangeFloat(min, max) {
    return min + Math.random() * (max - min);
  }

  function randRangeInt(minInclusive, maxExclusive) {
    return Math.floor(minInclusive + Math.random() * (maxExclusive - minInclusive));
  }

  // ============================================================================
  // 2. WEB AUDIO SYNTHESIZER (Zero External Audio Asset Dependencies)
  // ============================================================================
  class SoundEffects {
    constructor() {
      this.enabled = true;
      this.ctx = null;
    }

    ensureContext() {
      if (!this.enabled) return null;
      if (!this.ctx) {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (AudioCtx) this.ctx = new AudioCtx();
      }
      if (this.ctx && this.ctx.state === "suspended") {
        this.ctx.resume().catch(() => {});
      }
      return this.ctx;
    }

    playTone(freq, durationSec, type = "triangle", gainVal = 0.08, slideFreq = null) {
      const ctx = this.ensureContext();
      if (!ctx) return;
      try {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = type;
        osc.frequency.setValueAtTime(freq, ctx.currentTime);
        if (slideFreq !== null) {
          osc.frequency.exponentialRampToValueAtTime(Math.max(40, slideFreq), ctx.currentTime + durationSec);
        }
        gain.gain.setValueAtTime(gainVal, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + durationSec);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start();
        osc.stop(ctx.currentTime + durationSec);
      } catch (_) {}
    }

    playClick() { this.playTone(580, 0.06, "sine", 0.06, 760); }
    playLockIn() {
      this.playTone(523.25, 0.12, "triangle", 0.09, 659.25);
      setTimeout(() => this.playTone(783.99, 0.18, "triangle", 0.10, 1046.5), 90);
    }
    playRaceStart() {
      this.playTone(440, 0.12, "square", 0.07);
      setTimeout(() => this.playTone(880, 0.28, "sawtooth", 0.09), 110);
    }
    playCharm(charmIndex) {
      if (charmIndex === 0) this.playTone(620, 0.25, "sawtooth", 0.09, 210);
      else if (charmIndex === 1) this.playTone(330, 0.30, "triangle", 0.10, 1180);
      else if (charmIndex === 2) this.playTone(480, 0.22, "sine", 0.10, 960);
      else this.playTone(740, 0.26, "square", 0.08, 190);
    }
    playPodium(isWin) {
      if (isWin) {
        [523.25, 659.25, 783.99, 1046.5].forEach((f, idx) => {
          setTimeout(() => this.playTone(f, 0.18, "triangle", 0.10), idx * 95);
        });
      } else {
        [392.0, 349.23, 311.13].forEach((f, idx) => {
          setTimeout(() => this.playTone(f, 0.18, "sawtooth", 0.06), idx * 110);
        });
      }
    }
  }

  const sfx = new SoundEffects();

  // ============================================================================
  // 3. MOCK BACKEND SERVICE (Name-based Onboarding & Rewarded Ads)
  // ============================================================================
  class MockBackendService {
    constructor() {
      let activeName = null;
      try {
        activeName = window.localStorage.getItem("lucky_racing_active_player_name");
      } catch (_) {}

      if (!activeName || !activeName.trim()) {
        activeName = `Racer_${randRangeInt(100, 999)}`;
        try {
          window.localStorage.setItem("lucky_racing_active_player_name", activeName);
        } catch (_) {}
      }

      this.currentProfile = this.loadOrCreateProfile(activeName);
    }

    static getStorageKey(slotName) {
      const safe = (slotName || "racer").trim().toLowerCase();
      return `lucky_racing_profile_${safe}`;
    }

    static ensureValidProfile(p, fallbackName = "Racer_459") {
      if (!p || typeof p !== "object") {
        p = {};
      }
      p.PlayerId = p.PlayerId || `user_${fallbackName.toLowerCase()}`;
      p.DisplayName = p.DisplayName || fallbackName;
      p.Coins = typeof p.Coins === "number" && !isNaN(p.Coins) ? Math.max(0, Math.floor(p.Coins)) : 500;
      p.Gems = typeof p.Gems === "number" && !isNaN(p.Gems) ? Math.max(0, Math.floor(p.Gems)) : 25;
      if (!Array.isArray(p.CharmCounts) || p.CharmCounts.length !== 4) {
        p.CharmCounts = [2, 1, 1, 1];
      }
      p.TotalRaces = typeof p.TotalRaces === "number" ? Math.max(0, Math.floor(p.TotalRaces)) : 0;
      if (!Array.isArray(p.RankCounts) || p.RankCounts.length !== 5) {
        p.RankCounts = [0, 0, 0, 0, 0];
      }
      return p;
    }

    loadOrCreateProfile(name) {
      const normalized = (name || "Racer_459").trim();
      const key = MockBackendService.getStorageKey(normalized);
      try {
        const raw = window.localStorage.getItem(key);
        if (raw) {
          const parsed = JSON.parse(raw);
          return MockBackendService.ensureValidProfile(parsed, normalized);
        }
      } catch (_) {}

      const created = MockBackendService.ensureValidProfile({
        PlayerId: `user_${normalized.toLowerCase()}`,
        DisplayName: normalized,
        Coins: 500,
        Gems: 25,
        CharmCounts: [2, 1, 1, 1],
        TotalRaces: 0,
        RankCounts: [0, 0, 0, 0, 0]
      }, normalized);

      this.saveProfile(created);
      return created;
    }

    saveProfile(profile = this.currentProfile) {
      if (!profile) return;
      try {
        const key = MockBackendService.getStorageKey(profile.DisplayName);
        window.localStorage.setItem(key, JSON.stringify(profile));
      } catch (_) {}
    }

    updateDisplayName(newName) {
      let safe = (newName || "").trim();
      if (!safe) safe = `Racer_${randRangeInt(100, 999)}`;
      if (safe.length > 16) safe = safe.substring(0, 16);

      this.currentProfile.DisplayName = safe;
      try {
        window.localStorage.setItem("lucky_racing_active_player_name", safe);
      } catch (_) {}

      this.saveProfile();
      return safe;
    }

    tryPlaceBet(amount) {
      const p = this.currentProfile;
      if (amount <= 0 || amount > p.Coins) {
        return false;
      }
      p.Coins -= amount;
      this.saveProfile();
      return true;
    }

    static computeGrossReturn(betAmount, finishRank) {
      if (betAmount <= 0) return 0;
      if (finishRank === 1) return betAmount * 3;
      if (finishRank === 2) return betAmount * 2;
      if (finishRank === 3) return betAmount * 1;
      return 0;
    }

    static computeNetPayoutDelta(betAmount, finishRank) {
      return MockBackendService.computeGrossReturn(betAmount, finishRank) - Math.max(0, betAmount);
    }

    settleRaceResult(betAmount, finishRank) {
      const p = this.currentProfile;
      const clampedRank = clamp(finishRank, 1, 5);
      const grossReturn = MockBackendService.computeGrossReturn(betAmount, clampedRank);
      const netDelta = grossReturn - betAmount;

      p.Coins = Math.max(0, p.Coins + grossReturn);
      p.TotalRaces += 1;
      p.RankCounts[clampedRank - 1] += 1;
      this.saveProfile();
      return { grossReturn, netDelta, newBalance: p.Coins };
    }

    tryBuyCharm(charmIndex, cost) {
      const p = this.currentProfile;
      if (charmIndex < 0 || charmIndex > 3) return false;
      if (cost <= 0 || p.Coins < cost) return false;
      p.Coins -= cost;
      p.CharmCounts[charmIndex] += 1;
      this.saveProfile();
      return true;
    }

    tryConsumeCharm(charmIndex) {
      const p = this.currentProfile;
      if (charmIndex < 0 || charmIndex > 3 || p.CharmCounts[charmIndex] <= 0) {
        return false;
      }
      p.CharmCounts[charmIndex] -= 1;
      this.saveProfile();
      return true;
    }

    grantAdReward(coins = 100) {
      if (coins <= 0) return this.currentProfile.Coins;
      this.currentProfile.Coins += Math.floor(coins);
      this.saveProfile();
      return this.currentProfile.Coins;
    }

    grantMiniGameReward(coins) {
      return this.grantAdReward(coins);
    }
  }

  // ============================================================================
  // 4. 5-LANE TRACK SPLINE ENGINE (Exact Port of MultiLaneTrackSpline.cs)
  // ============================================================================
  class MultiLaneTrackSpline {
    constructor() {
      this.laneWidth = LANE_WIDTH;
      this.laneOffsets = [-3.0, -1.5, 0.0, 1.5, 3.0]; // 5 lanes

      // Map 1: HCMUS Campus Park S-Curve / Loop Control Points
      this.controlPoints = [
        new THREE.Vector3(0.0, 0.0, -22.0),
        new THREE.Vector3(7.5, 0.0, -14.0),
        new THREE.Vector3(12.0, 0.0, -2.0),
        new THREE.Vector3(8.0, 0.0, 10.0),
        new THREE.Vector3(-4.0, 0.0, 18.0),
        new THREE.Vector3(-11.0, 0.0, 12.0),
        new THREE.Vector3(-12.5, 0.0, -1.0),
        new THREE.Vector3(-7.0, 0.0, -15.0),
        new THREE.Vector3(0.0, 0.0, -22.0)
      ];

      this.precomputeArcLengthTable();
    }

    catmullRom(p0, p1, p2, p3, t) {
      const t2 = t * t;
      const t3 = t2 * t;
      const v = new THREE.Vector3();
      v.x = 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3);
      v.y = 0.5 * ((2 * p1.y) + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3);
      v.z = 0.5 * ((2 * p1.z) + (-p0.z + p2.z) * t + (2 * p0.z - 5 * p1.z + 4 * p2.z - p3.z) * t2 + (-p0.z + 3 * p1.z - 3 * p2.z + p3.z) * t3);
      return v;
    }

    catmullRomTangent(p0, p1, p2, p3, t) {
      const t2 = t * t;
      const v = new THREE.Vector3();
      v.x = 0.5 * ((-p0.x + p2.x) + (4 * p0.x - 10 * p1.x + 8 * p2.x - 2 * p3.x) * t + (-3 * p0.x + 9 * p1.x - 9 * p2.x + 3 * p3.x) * t2);
      v.y = 0.5 * ((-p0.y + p2.y) + (4 * p0.y - 10 * p1.y + 8 * p2.y - 2 * p3.y) * t + (-3 * p0.y + 9 * p1.y - 9 * p2.y + 3 * p3.y) * t2);
      v.z = 0.5 * ((-p0.z + p2.z) + (4 * p0.z - 10 * p1.z + 8 * p2.z - 2 * p3.z) * t + (-3 * p0.z + 9 * p1.z - 9 * p2.z + 3 * p3.z) * t2);
      return v.normalize();
    }

    precomputeArcLengthTable() {
      this.samples = [];
      this.cumulativeLengths = [0];
      let total = 0;
      let prevPt = this.evaluateRaw(0);

      this.samples.push({ t: 0, pt: prevPt });

      for (let i = 1; i <= SAMPLE_COUNT; i++) {
        const u = i / SAMPLE_COUNT;
        const curPt = this.evaluateRaw(u);
        const dist = prevPt.distanceTo(curPt);
        total += dist;
        this.cumulativeLengths.push(total);
        this.samples.push({ t: u, pt: curPt });
        prevPt = curPt;
      }
      this.totalLength = total;
    }

    evaluateRaw(u) {
      u = clamp01(u);
      const segCount = this.controlPoints.length - 1;
      const scaled = u * segCount;
      const seg = Math.min(Math.floor(scaled), segCount - 1);
      const localT = scaled - seg;

      const p0 = this.controlPoints[seg === 0 ? segCount - 1 : seg - 1];
      const p1 = this.controlPoints[seg];
      const p2 = this.controlPoints[seg + 1];
      const p3 = this.controlPoints[seg + 2 >= this.controlPoints.length ? 1 : seg + 2];

      return this.catmullRom(p0, p1, p2, p3, localT);
    }

    evaluateRawTangent(u) {
      u = clamp01(u);
      const segCount = this.controlPoints.length - 1;
      const scaled = u * segCount;
      const seg = Math.min(Math.floor(scaled), segCount - 1);
      const localT = scaled - seg;

      const p0 = this.controlPoints[seg === 0 ? segCount - 1 : seg - 1];
      const p1 = this.controlPoints[seg];
      const p2 = this.controlPoints[seg + 1];
      const p3 = this.controlPoints[seg + 2 >= this.controlPoints.length ? 1 : seg + 2];

      return this.catmullRomTangent(p0, p1, p2, p3, localT);
    }

    // Arc-length parameterized evaluation (t in [0.0, 1.0])
    evaluateCenter(t) {
      t = clamp01(t);
      const targetDist = t * this.totalLength;

      let low = 0;
      let high = SAMPLE_COUNT;
      while (low <= high) {
        const mid = (low + high) >> 1;
        if (this.cumulativeLengths[mid] < targetDist) {
          low = mid + 1;
        } else {
          high = mid - 1;
        }
      }

      const idx = Math.max(0, Math.min(SAMPLE_COUNT - 1, high));
      const d0 = this.cumulativeLengths[idx];
      const d1 = this.cumulativeLengths[idx + 1];
      const segFraction = d1 > d0 ? (targetDist - d0) / (d1 - d0) : 0;
      const u = (idx + segFraction) / SAMPLE_COUNT;

      const pos = this.evaluateRaw(u);
      const tangent = this.evaluateRawTangent(u);
      return { pos, tangent };
    }

    evaluateLanePoint(laneIndex, t) {
      const clampedLane = clamp(laneIndex, 0, 4);
      const center = this.evaluateCenter(t);
      const normal = new THREE.Vector3(-center.tangent.z, 0, center.tangent.x).normalize();
      const offsetDist = this.laneOffsets[clampedLane];

      const lanePos = center.pos.clone().addScaledVector(normal, offsetDist);
      const yaw = Math.atan2(center.tangent.x, center.tangent.z);
      return { position: lanePos, tangent: center.tangent, normal, yaw };
    }
  }

  // ============================================================================
  // 5. SERVER RACE SIMULATOR & CHAOS CHARM LOGIC (ServerRaceSimulator.cs)
  // ============================================================================
  class ServerRaceSimulator {
    constructor(spline, onRaceFinished, onCharmBroadcast) {
      this.spline = spline;
      this.onRaceFinished = onRaceFinished;
      this.onCharmBroadcast = onCharmBroadcast;

      this.isRaceRunning = false;
      this.fastForward = false;
      this.finishedCount = 0;
      this.finishOrder = [];

      this.racerStates = [];
      for (let i = 0; i < RACER_COUNT; i++) {
        this.racerStates.push({
          Index: i,
          NormalizedT: 0.0,
          VelocityT: 0.0,
          StatusFlags: StatusFlags.None,
          StatusDuration: 0.0,
          FinishRank: 0
        });
      }

      this.tickAccumulator = 0.0;
      this.tickInterval = 0.10; // 10Hz authoritative tick
    }

    toggleFastForward() {
      this.fastForward = !this.fastForward;
      return this.fastForward;
    }

    resetRacersToStartLine() {
      this.isRaceRunning = false;
      this.finishedCount = 0;
      this.finishOrder = [];
      for (let i = 0; i < RACER_COUNT; i++) {
        const s = this.racerStates[i];
        s.NormalizedT = 0.0;
        s.VelocityT = 0.0;
        s.StatusFlags = StatusFlags.None;
        s.StatusDuration = 0.0;
        s.FinishRank = 0;
      }
    }

    startRaceServer() {
      this.resetRacersToStartLine();
      this.isRaceRunning = true;
    }

    update(dt) {
      if (!this.isRaceRunning) return;

      const simDt = dt * (this.fastForward ? 3.5 : 1.0);
      this.tickAccumulator += simDt;

      while (this.tickAccumulator >= this.tickInterval) {
        this.tickAccumulator -= this.tickInterval;
        this.executeAuthoritativeTick(this.tickInterval);
      }
    }

    executeAuthoritativeTick(dtTick) {
      for (let i = 0; i < RACER_COUNT; i++) {
        const state = this.racerStates[i];
        if (state.FinishRank > 0) continue;

        // Decrement status timers
        if (state.StatusDuration > 0) {
          state.StatusDuration = Math.max(0, state.StatusDuration - dtTick);
          if (state.StatusDuration <= 0) {
            state.StatusFlags = StatusFlags.None;
          }
        }

        // Stunned racers cannot move
        if ((state.StatusFlags & StatusFlags.DizzyStunned) !== 0) {
          continue;
        }

        // Classic Lucky Racing Chaotic Step RNG: [-0.008, +0.028]
        let step = randRangeFloat(-0.008, 0.028);

        // Reverse step during Turning Charm
        if ((state.StatusFlags & StatusFlags.TurningReversed) !== 0) {
          step = -Math.abs(step) * 1.35;
        }

        // Forward boost during Finish Boost
        if ((state.StatusFlags & StatusFlags.FinishBoosted) !== 0) {
          step = Math.max(step, 0.038);
        }

        state.NormalizedT = clamp01(state.NormalizedT + step);

        // Deterministic finish detection
        if (state.NormalizedT >= 1.0 && state.FinishRank === 0) {
          this.finishedCount += 1;
          state.FinishRank = this.finishedCount;
          state.StatusFlags = StatusFlags.None;
          this.finishOrder.push(state.Index);
        }
      }

      // Check if all 5 racers finished
      if (this.finishedCount >= RACER_COUNT && this.isRaceRunning) {
        this.isRaceRunning = false;
        const ranks = new Array(RACER_COUNT);
        for (let i = 0; i < RACER_COUNT; i++) {
          ranks[i] = this.racerStates[i].FinishRank;
        }
        if (typeof this.onRaceFinished === "function") {
          this.onRaceFinished(ranks);
        }
      }
    }

    applyCharmEffectServer(charmIndex, casterName = "YOU") {
      let affectedMask = 0;
      const unfinished = this.racerStates.filter((s) => s.FinishRank === 0);
      if (unfinished.length === 0) return;

      if (charmIndex === 0) {
        // Dizzy Charm: Stun 1–3 random racers
        const count = Math.min(unfinished.length, randRangeInt(1, 4));
        const shuffled = [...unfinished].sort(() => Math.random() - 0.5);
        for (let k = 0; k < count; k++) {
          shuffled[k].StatusFlags |= StatusFlags.DizzyStunned;
          shuffled[k].StatusDuration = 2.8;
          affectedMask |= 1 << shuffled[k].Index;
        }
      } else if (charmIndex === 1) {
        // Finish Charm: Boost 1 random unfinished racer
        const pick = unfinished[randRangeInt(0, unfinished.length)];
        pick.StatusFlags |= StatusFlags.FinishBoosted;
        pick.StatusDuration = 2.4;
        pick.NormalizedT = Math.max(pick.NormalizedT, 0.88);
        affectedMask |= 1 << pick.Index;
      } else if (charmIndex === 2) {
        // Swap Charm: Cyclically swap progress of unfinished cars
        if (unfinished.length >= 2) {
          const firstT = unfinished[0].NormalizedT;
          for (let k = 0; k < unfinished.length - 1; k++) {
            unfinished[k].NormalizedT = unfinished[k + 1].NormalizedT;
            unfinished[k].StatusFlags |= StatusFlags.SwappedRecently;
            unfinished[k].StatusDuration = 1.8;
            affectedMask |= 1 << unfinished[k].Index;
          }
          unfinished[unfinished.length - 1].NormalizedT = firstT;
          unfinished[unfinished.length - 1].StatusFlags |= StatusFlags.SwappedRecently;
          unfinished[unfinished.length - 1].StatusDuration = 1.8;
          affectedMask |= 1 << unfinished[unfinished.length - 1].Index;
        }
      } else if (charmIndex === 3) {
        // Turning Charm: Reverse racers for 2.0s
        for (let k = 0; k < unfinished.length; k++) {
          unfinished[k].StatusFlags |= StatusFlags.TurningReversed;
          unfinished[k].StatusDuration = 2.0;
          affectedMask |= 1 << unfinished[k].Index;
        }
      }

      if (typeof this.onCharmBroadcast === "function") {
        this.onCharmBroadcast(charmIndex, casterName, affectedMask);
      }
    }
  }

  // ============================================================================
  // 6. THREE.JS 3D DIORAMA & CAR RENDERER (Map 1 Campus Park + Set 2 Cars)
  // ============================================================================
  class LuckyRacing3DWorld {
    constructor(canvas, carLabelsLayer, spline) {
      this.canvas = canvas;
      this.carLabelsLayer = carLabelsLayer;
      this.spline = spline;

      this.scene = new THREE.Scene();
      this.scene.background = new THREE.Color(0x0a1122);
      this.scene.fog = new THREE.FogExp2(0x0a1122, 0.012);

      this.camera = new THREE.PerspectiveCamera(48, 9 / 16, 0.1, 200);
      this.camPos = new THREE.Vector3(0, 36, -26);
      this.camLookAt = new THREE.Vector3(0, 0, -4);
      this.camera.position.copy(this.camPos);
      this.camera.lookAt(this.camLookAt);

      this.renderer = new THREE.WebGLRenderer({
        canvas: this.canvas,
        antialias: true,
        powerPreference: "high-performance"
      });
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      this.renderer.shadowMap.enabled = true;
      this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

      this.isOverviewMode = false;
      this.betRacerIndex = 0;

      this.buildLighting();
      this.buildTrackAndParkDiorama();
      this.buildRacerCars();
      this.onResize();

      window.addEventListener("resize", () => this.onResize());
    }

    onResize() {
      const rect = this.canvas.parentElement.getBoundingClientRect();
      const w = rect.width;
      const h = rect.height;
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    }

    buildLighting() {
      const hemiLight = new THREE.HemisphereLight(0xdbeafe, 0x1e293b, 0.95);
      this.scene.add(hemiLight);

      const dirLight = new THREE.DirectionalLight(0xfef08a, 1.4);
      dirLight.position.set(24, 45, 18);
      dirLight.castShadow = true;
      dirLight.shadow.mapSize.width = 1024;
      dirLight.shadow.mapSize.height = 1024;
      dirLight.shadow.camera.near = 5;
      dirLight.shadow.camera.far = 120;
      dirLight.shadow.camera.left = -30;
      dirLight.shadow.camera.right = 30;
      dirLight.shadow.camera.top = 30;
      dirLight.shadow.camera.bottom = -30;
      this.scene.add(dirLight);

      const rimLight = new THREE.DirectionalLight(0x38bdf8, 0.45);
      rimLight.position.set(-20, 20, -25);
      this.scene.add(rimLight);
    }

    buildTrackAndParkDiorama() {
      // Park Grass Island
      const groundMat = new THREE.MeshLambertMaterial({ color: 0x1b4332 });
      const ground = new THREE.Mesh(new THREE.CylinderGeometry(34, 36, 1.2, 32), groundMat);
      ground.position.y = -0.65;
      ground.receiveShadow = true;
      this.scene.add(ground);

      // Inner Lake Water Patch
      const waterMat = new THREE.MeshPhongMaterial({
        color: 0x0284c7,
        shininess: 90,
        transparent: true,
        opacity: 0.85
      });
      const water = new THREE.Mesh(new THREE.CylinderGeometry(8, 8.5, 0.4, 24), waterMat);
      water.position.set(-1.5, -0.4, 0);
      this.scene.add(water);

      // Build 5-Lane Road Ribbon & Red-White Curbs
      const roadMat = new THREE.MeshLambertMaterial({ color: 0x1f2937 });
      const curbRedMat = new THREE.MeshLambertMaterial({ color: 0xdc2626 });
      const curbWhiteMat = new THREE.MeshLambertMaterial({ color: 0xf8fafc });
      const laneLineMat = new THREE.MeshBasicMaterial({ color: 0xfacc15, wireframe: false });

      const roadRibbonGeo = new THREE.BufferGeometry();
      const roadVerts = [];
      const roadIndices = [];

      const totalLanesWidth = RACER_COUNT * LANE_WIDTH;
      const halfWidth = totalLanesWidth * 0.5;

      const segments = 180;
      for (let s = 0; s <= segments; s++) {
        const u = s / segments;
        const center = this.spline.evaluateCenter(u);
        const normal = new THREE.Vector3(-center.tangent.z, 0, center.tangent.x).normalize();

        const leftPt = center.pos.clone().addScaledVector(normal, -halfWidth - 0.4);
        const rightPt = center.pos.clone().addScaledVector(normal, halfWidth + 0.4);

        roadVerts.push(leftPt.x, 0.02, leftPt.z);
        roadVerts.push(rightPt.x, 0.02, rightPt.z);

        if (s < segments) {
          const base = s * 2;
          roadIndices.push(base, base + 1, base + 2);
          roadIndices.push(base + 1, base + 3, base + 2);
        }

        // Alternating Curbs every 2 segments
        const curbMat = s % 2 === 0 ? curbRedMat : curbWhiteMat;
        const leftCurb = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.14, 0.75), curbMat);
        leftCurb.position.copy(leftPt);
        leftCurb.position.y = 0.07;
        leftCurb.rotation.y = Math.atan2(center.tangent.x, center.tangent.z);
        this.scene.add(leftCurb);

        const rightCurb = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.14, 0.75), curbMat);
        rightCurb.position.copy(rightPt);
        rightCurb.position.y = 0.07;
        rightCurb.rotation.y = Math.atan2(center.tangent.x, center.tangent.z);
        this.scene.add(rightCurb);
      }

      roadRibbonGeo.setAttribute("position", new THREE.Float32BufferAttribute(roadVerts, 3));
      roadRibbonGeo.setIndex(roadIndices);
      roadRibbonGeo.computeVertexNormals();

      const roadMesh = new THREE.Mesh(roadRibbonGeo, roadMat);
      roadMesh.receiveShadow = true;
      this.scene.add(roadMesh);

      // 4 Internal Dashed Lane Dividers
      for (let l = 1; l < RACER_COUNT; l++) {
        const offset = -halfWidth + l * LANE_WIDTH;
        for (let s = 0; s < segments; s += 2) {
          const u = s / segments;
          const center = this.spline.evaluateCenter(u);
          const normal = new THREE.Vector3(-center.tangent.z, 0, center.tangent.x).normalize();
          const markerPt = center.pos.clone().addScaledVector(normal, offset);

          const dash = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.02, 0.45), laneLineMat);
          dash.position.copy(markerPt);
          dash.position.y = 0.03;
          dash.rotation.y = Math.atan2(center.tangent.x, center.tangent.z);
          this.scene.add(dash);
        }
      }

      // Start & Finish Gantry Gate (Checkered)
      this.buildGantryGate(0.0, "START / FINISH");

      // Environment: HCMUS Campus Festival Tent
      this.buildFestivalTent(new THREE.Vector3(-3.5, 0, -4.5));

      // Environment: Stylized Trees, Boulders, Street Lamps
      this.buildDioramaFoliage();
    }

    buildGantryGate(progressT, labelText) {
      const center = this.spline.evaluateCenter(progressT);
      const normal = new THREE.Vector3(-center.tangent.z, 0, center.tangent.x).normalize();
      const yaw = Math.atan2(center.tangent.x, center.tangent.z);

      const gantryGroup = new THREE.Group();
      gantryGroup.position.copy(center.pos);
      gantryGroup.rotation.y = yaw;

      const postMat = new THREE.MeshLambertMaterial({ color: 0x475569 });
      const topMat = new THREE.MeshLambertMaterial({ color: 0xf1f5f9 });

      const totalW = RACER_COUNT * LANE_WIDTH + 1.2;
      const leftPost = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 4.2, 8), postMat);
      leftPost.position.set(-totalW * 0.5, 2.1, 0);
      gantryGroup.add(leftPost);

      const rightPost = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 4.2, 8), postMat);
      rightPost.position.set(totalW * 0.5, 2.1, 0);
      gantryGroup.add(rightPost);

      const crossbar = new THREE.Mesh(new THREE.BoxGeometry(totalW + 0.6, 0.6, 0.4), topMat);
      crossbar.position.set(0, 4.0, 0);
      gantryGroup.add(crossbar);

      // Checkered stripe plate
      const checkerMat = new THREE.MeshBasicMaterial({ color: 0xf59e0b });
      const checkerPlate = new THREE.Mesh(new THREE.BoxGeometry(totalW * 0.75, 0.35, 0.45), checkerMat);
      checkerPlate.position.set(0, 4.0, 0);
      gantryGroup.add(checkerPlate);

      this.scene.add(gantryGroup);
    }

    buildFestivalTent(pos) {
      const tentGroup = new THREE.Group();
      tentGroup.position.copy(pos);

      const canopyMat = new THREE.MeshLambertMaterial({ color: 0xef4444 });
      const whiteStripeMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
      const poleMat = new THREE.MeshLambertMaterial({ color: 0x94a3b8 });

      // 4 Metal Tent Legs
      [-2.2, 2.2].forEach((x) => {
        [-2.2, 2.2].forEach((z) => {
          const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 2.8, 6), poleMat);
          leg.position.set(x, 1.4, z);
          tentGroup.add(leg);
        });
      });

      // Pyramid Canopy Roof
      const roof = new THREE.Mesh(new THREE.ConeGeometry(3.6, 2.0, 4), canopyMat);
      roof.position.y = 3.6;
      roof.rotation.y = Math.PI * 0.25;
      tentGroup.add(roof);

      // Iconic HCMUS Banner
      const banner = new THREE.Mesh(new THREE.BoxGeometry(4.2, 0.45, 0.1), whiteStripeMat);
      banner.position.set(0, 2.65, 2.2);
      tentGroup.add(banner);

      this.scene.add(tentGroup);
    }

    buildDioramaFoliage() {
      const trunkMat = new THREE.MeshLambertMaterial({ color: 0x78350f });
      const foliageMatA = new THREE.MeshLambertMaterial({ color: 0x15803d });
      const foliageMatB = new THREE.MeshLambertMaterial({ color: 0x16a34a });
      const rockMat = new THREE.MeshLambertMaterial({ color: 0x64748b });

      const treeCoords = [
        [14, -18], [-14, -14], [16, 2], [-16, 8], [6, 22], [-6, 22],
        [-1, 8], [-7, -3], [5, -4], [-14, 2]
      ];

      treeCoords.forEach(([tx, tz], i) => {
        const tree = new THREE.Group();
        tree.position.set(tx, 0, tz);

        const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.32, 1.6, 6), trunkMat);
        trunk.position.y = 0.8;
        tree.add(trunk);

        const fMat = i % 2 === 0 ? foliageMatA : foliageMatB;
        const leavesBottom = new THREE.Mesh(new THREE.ConeGeometry(1.6, 2.0, 7), fMat);
        leavesBottom.position.y = 2.2;
        tree.add(leavesBottom);

        const leavesTop = new THREE.Mesh(new THREE.ConeGeometry(1.2, 1.8, 7), fMat);
        leavesTop.position.y = 3.2;
        tree.add(leavesTop);

        this.scene.add(tree);
      });

      // Scatter low-poly boulders
      const rockCoords = [
        [3, -12], [-8, 6], [10, 16], [-12, -20], [8, -20]
      ];
      rockCoords.forEach(([rx, rz]) => {
        const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(0.75, 0), rockMat);
        rock.position.set(rx, 0.4, rz);
        rock.rotation.set(Math.random(), Math.random(), Math.random());
        this.scene.add(rock);
      });
    }

    // Builds all 5 3D Blockout Arcade Cars (1.1m W x 0.7m H x 2.0m L)
    buildRacerCars() {
      this.racerVisuals = [];
      this.carLabelDomNodes = [];
      this.carLabelsLayer.innerHTML = "";

      const tireMat = new THREE.MeshLambertMaterial({ color: 0x18181b });
      const glassMat = new THREE.MeshPhongMaterial({ color: 0x7dd3fc, shininess: 90 });
      const headlightMat = new THREE.MeshBasicMaterial({ color: 0xfef08a });
      const goldArrowMat = new THREE.MeshBasicMaterial({ color: 0xfacc15 });

      for (let i = 0; i < RACER_COUNT; i++) {
        const cfg = RACER_CONFIGS[i];
        const root = new THREE.Group();
        const visuals = new THREE.Group();
        root.add(visuals);

        const bodyMat = new THREE.MeshPhongMaterial({ color: cfg.colorHex, shininess: 65 });

        // Lower Chassis (1.05m W x 0.36m H x 1.95m L)
        const chassis = new THREE.Mesh(new THREE.BoxGeometry(1.05, 0.36, 1.95), bodyMat);
        chassis.position.set(0, 0.28, 0);
        chassis.castShadow = true;
        visuals.add(chassis);

        // Upper Cabin
        const cabin = new THREE.Mesh(new THREE.BoxGeometry(0.86, 0.30, 0.95), bodyMat);
        cabin.position.set(0, 0.58, -0.10);
        cabin.castShadow = true;
        visuals.add(cabin);

        // Front Windshield
        const windshield = new THREE.Mesh(new THREE.BoxGeometry(0.80, 0.24, 0.25), glassMat);
        windshield.position.set(0, 0.57, 0.32);
        visuals.add(windshield);

        // Rear Spoiler Wing
        const spoiler = new THREE.Mesh(new THREE.BoxGeometry(1.08, 0.08, 0.28), bodyMat);
        spoiler.position.set(0, 0.62, -0.82);
        visuals.add(spoiler);

        // Headlights
        [-0.34, 0.34].forEach((hx) => {
          const hl = new THREE.Mesh(new THREE.BoxGeometry(0.20, 0.12, 0.08), headlightMat);
          hl.position.set(hx, 0.30, 0.98);
          visuals.add(hl);
        });

        // 4 Spinning Wheels
        const wheels = [];
        const wheelPositions = [
          [-0.56, 0.20, 0.62],
          [0.56, 0.20, 0.62],
          [-0.56, 0.20, -0.62],
          [0.56, 0.20, -0.62]
        ];
        wheelPositions.forEach(([wx, wy, wz]) => {
          const wPivot = new THREE.Group();
          wPivot.position.set(wx, wy, wz);
          const wMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.20, 12), tireMat);
          wMesh.rotation.z = Math.PI * 0.5;
          wPivot.add(wMesh);
          visuals.add(wPivot);
          wheels.push(wPivot);
        });

        // Golden Bet Indicator Arrow (MuiTen)
        const arrowGroup = new THREE.Group();
        arrowGroup.position.set(0, 1.85, 0);
        const cone = new THREE.Mesh(new THREE.ConeGeometry(0.38, 0.72, 6), goldArrowMat);
        cone.rotation.x = Math.PI; // Point downward at the car
        arrowGroup.add(cone);
        root.add(arrowGroup);

        // Status VFX Ring above car
        const vfxRing = new THREE.Mesh(
          new THREE.TorusGeometry(0.68, 0.07, 8, 20),
          new THREE.MeshBasicMaterial({ color: 0xfde047 })
        );
        vfxRing.rotation.x = Math.PI * 0.5;
        vfxRing.position.set(0, 1.05, 0);
        vfxRing.visible = false;
        root.add(vfxRing);

        this.scene.add(root);

        // Floating DOM Label
        const domTag = document.createElement("div");
        domTag.className = "car-world-tag";
        domTag.textContent = cfg.shortName;
        this.carLabelsLayer.appendChild(domTag);
        this.carLabelDomNodes.push(domTag);

        const controller = {
          index: i,
          root,
          visuals,
          wheels,
          arrowGroup,
          vfxRing,
          displayedT: 0.0,
          targetT: 0.0,
          statusFlags: StatusFlags.None,
          isLocalBetTarget: i === 0
        };
        this.racerVisuals.push(controller);
      }

      this.snapAllCarsImmediate(0.0);
    }

    snapAllCarsImmediate(t = 0.0) {
      for (let i = 0; i < this.racerVisuals.length; i++) {
        const rv = this.racerVisuals[i];
        rv.displayedT = clamp01(t);
        rv.targetT = rv.displayedT;
        const evalPt = this.spline.evaluateLanePoint(i, rv.displayedT);
        rv.root.position.copy(evalPt.position);
        rv.root.rotation.set(0, evalPt.yaw, 0);
        rv.visuals.rotation.set(0, 0, 0);
      }
    }

    syncFromSimulator(racerStates, betRacerIndex) {
      this.betRacerIndex = betRacerIndex;
      for (let i = 0; i < RACER_COUNT; i++) {
        const rv = this.racerVisuals[i];
        const sim = racerStates[i];
        rv.targetT = sim.NormalizedT;
        rv.statusFlags = sim.StatusFlags;
        rv.isLocalBetTarget = i === betRacerIndex;
      }
    }

    updateAndRender(dt, timeSec, currentPhase) {
      // 1. Smoothly interpolate 3D cars along spline
      for (let i = 0; i < RACER_COUNT; i++) {
        const rv = this.racerVisuals[i];
        const oldT = rv.displayedT;

        // Smooth visual damp (18.0f lerp rate matching RacerVisualController.cs)
        const frameDeltaT = (rv.targetT - rv.displayedT) * clamp01(dt * 18.0);
        rv.displayedT = clamp01(rv.displayedT + frameDeltaT);

        const pt = this.spline.evaluateLanePoint(i, rv.displayedT);
        rv.root.position.copy(pt.position);
        rv.root.rotation.set(0, pt.yaw, 0);

        // Visual banking & surge jolt
        const surgeVelocity = (rv.displayedT - oldT) / Math.max(0.0001, dt);
        const pitchJolt = clamp(-surgeVelocity * 0.14, -0.16, 0.12);
        rv.visuals.rotation.x = lerp(rv.visuals.rotation.x, pitchJolt, clamp01(dt * 12.0));

        // Spin 4 wheels proportionally to spline delta
        if (Math.abs(frameDeltaT) > 0.00001) {
          const spinRad = frameDeltaT * 320.0;
          for (let w = 0; w < rv.wheels.length; w++) {
            rv.wheels[w].rotation.x += spinRad;
          }
        }

        // Golden Bet Arrow (MuiTen) bobbing & spinning
        rv.arrowGroup.visible = rv.isLocalBetTarget;
        if (rv.arrowGroup.visible) {
          rv.arrowGroup.position.y = 1.85 + Math.sin(timeSec * 4.2) * 0.22;
          rv.arrowGroup.rotation.y += dt * 2.5;
        }

        // Status VFX Ring
        if (rv.statusFlags !== StatusFlags.None) {
          rv.vfxRing.visible = true;
          rv.vfxRing.rotation.z += dt * 6.0;
          if ((rv.statusFlags & StatusFlags.DizzyStunned) !== 0) rv.vfxRing.material.color.setHex(0xfacc15);
          else if ((rv.statusFlags & StatusFlags.FinishBoosted) !== 0) rv.vfxRing.material.color.setHex(0x22c55e);
          else if ((rv.statusFlags & StatusFlags.SwappedRecently) !== 0) rv.vfxRing.material.color.setHex(0xa855f7);
          else rv.vfxRing.material.color.setHex(0xef4444);
        } else {
          rv.vfxRing.visible = false;
        }
      }

      // 2. Update Top-Down Portrait Camera (TopDownRaceCameraController.cs)
      let desiredPos = new THREE.Vector3();
      let desiredLook = new THREE.Vector3();
      let desiredFov = 48;

      if (currentPhase === MatchPhase.MainMenu) {
        // Gentle orbital showcase over the HCMUS Campus Park Diorama
        const orbitAngle = Math.sin(timeSec * 0.28) * 0.32;
        desiredPos.set(Math.sin(orbitAngle) * 18, 34, -26);
        desiredLook.set(0, 0, -4);
        desiredFov = 52;
      } else if (this.isOverviewMode) {
        // Full Track Diorama Overview Mode (Portrait 9:16)
        desiredPos.set(0, 52, -16);
        desiredLook.set(0, 0, 2);
        desiredFov = 58;
      } else {
        // Pack Follow Mode with 0.45 bias toward the player's bet racer
        const packCenter = new THREE.Vector3();
        for (let i = 0; i < RACER_COUNT; i++) {
          packCenter.add(this.racerVisuals[i].root.position);
        }
        packCenter.multiplyScalar(1 / RACER_COUNT);

        if (this.betRacerIndex >= 0 && this.betRacerIndex < RACER_COUNT) {
          packCenter.lerp(this.racerVisuals[this.betRacerIndex].root.position, 0.45);
        }

        const focusZ = clamp(packCenter.z, -24, 22);
        const focusX = clamp(packCenter.x * 0.45, -3.5, 3.5);
        desiredPos.set(focusX, 23, focusZ - 13.5);
        desiredLook.set(focusX, 0, focusZ + 3.5);
        desiredFov = 48;
      }

      const camLerp = clamp01(dt * 6.5);
      this.camPos.lerp(desiredPos, camLerp);
      this.camLookAt.lerp(desiredLook, camLerp);
      this.camera.position.copy(this.camPos);
      this.camera.lookAt(this.camLookAt);
      if (Math.abs(this.camera.fov - desiredFov) > 0.05) {
        this.camera.fov = lerp(this.camera.fov, desiredFov, camLerp);
        this.camera.updateProjectionMatrix();
      }

      // 3. Render 3D Scene
      this.renderer.render(this.scene, this.camera);

      // 4. Project 3D Car Positions to Screen Badges
      this.updateCarScreenBadges(currentPhase !== MatchPhase.MainMenu);
    }

    updateCarScreenBadges(visible) {
      const width = this.canvas.clientWidth;
      const height = this.canvas.clientHeight;
      const projVec = new THREE.Vector3();

      for (let i = 0; i < RACER_COUNT; i++) {
        const domTag = this.carLabelDomNodes[i];
        if (!visible) {
          domTag.style.display = "none";
          continue;
        }
        const rv = this.racerVisuals[i];
        projVec.copy(rv.root.position);
        projVec.y += 1.25;
        projVec.project(this.camera);

        if (projVec.z > 1.0) {
          domTag.style.display = "none";
          continue;
        }

        const x = (projVec.x * 0.5 + 0.5) * width;
        const y = (-projVec.y * 0.5 + 0.5) * height;
        domTag.style.display = "block";
        domTag.style.left = `${x.toFixed(1)}px`;
        domTag.style.top = `${y.toFixed(1)}px`;

        const isMyBet = i === this.betRacerIndex;
        domTag.className = isMyBet ? "car-world-tag my-bet" : "car-world-tag";
        domTag.textContent = isMyBet ? `★ ${RACER_CONFIGS[i].shortName}` : RACER_CONFIGS[i].shortName;
      }
    }
  }

  // ============================================================================
  // 7. APPLICATION CONTROLLER & UI STATE MACHINE (NetworkMatchManager + Views)
  // ============================================================================
  class LuckyRacingWebGLApp {
    constructor() {
      this.backend = new MockBackendService();
      this.spline = new MultiLaneTrackSpline();
      this.simulator = new ServerRaceSimulator(
        this.spline,
        (ranks) => this.handleAllRacersFinished(ranks),
        (charmIdx, caster, mask) => this.handleCharmBroadcast(charmIdx, caster, mask)
      );

      const canvas = document.getElementById("webgl-canvas");
      const labelsLayer = document.getElementById("car-labels-layer");
      this.world = new LuckyRacing3DWorld(canvas, labelsLayer, this.spline);

      // Match & Room State
      this.phase = MatchPhase.MainMenu;
      this.roomCode = "SẴN SÀNG";
      this.phaseTimerRemaining = 15.0;
      this.bettingPhaseDuration = 15.0;
      this.postBetLockDelay = 1.2;

      // Betting State (NetworkBetRegistry)
      this.selectedRacerIndex = 0;
      this.selectedBetAmount = 20;
      this.hasLockedBet = false;
      this.localBet = { RacerIndex: 0, BetAmount: 20, GrossReturn: 0, PayoutDelta: 0 };
      this.roomBets = [];

      this.bindUIEvents();
      this.refreshHeaderUI();
      this.setPhase(MatchPhase.MainMenu);

      this.lastFrameTime = performance.now();
      requestAnimationFrame((now) => this.tickLoop(now));
    }

    bindUIEvents() {
      // Audio Toggle
      document.getElementById("btn-audio-toggle").addEventListener("click", (e) => {
        sfx.enabled = !sfx.enabled;
        e.currentTarget.textContent = sfx.enabled ? "🔊 SFX" : "🔇 MUTE";
        if (sfx.enabled) sfx.playClick();
      });

      // Quick Match / Create Room
      document.getElementById("btn-play-online").addEventListener("click", () => {
        sfx.playClick();
        this.startQuickMatch();
      });

      // Join Specific Room Modal
      document.getElementById("btn-join-room").addEventListener("click", () => {
        sfx.playClick();
        this.openJoinRoomModal();
      });

      document.getElementById("btn-confirm-join-room").addEventListener("click", () => {
        this.confirmJoinRoomModal();
      });

      document.getElementById("btn-close-join-room").addEventListener("click", () => {
        sfx.playClick();
        document.getElementById("modal-join-room").classList.add("hidden");
      });

      document.querySelectorAll(".btn-room-preset").forEach((chip) => {
        chip.addEventListener("click", () => {
          sfx.playClick();
          document.getElementById("input-room-code").value = chip.getAttribute("data-code");
        });
      });

      // Edit Name Modal
      document.getElementById("ui-profile-name").addEventListener("click", () => {
        sfx.playClick();
        this.openNameModal();
      });

      document.getElementById("btn-confirm-name").addEventListener("click", () => {
        this.confirmNameModal();
      });

      document.getElementById("btn-close-name").addEventListener("click", () => {
        sfx.playClick();
        document.getElementById("modal-name").classList.add("hidden");
      });

      document.querySelectorAll(".btn-name-preset").forEach((chip) => {
        chip.addEventListener("click", () => {
          sfx.playClick();
          document.getElementById("input-player-name").value = chip.getAttribute("data-name");
        });
      });

      // Rewarded Ads Button (+100 Coins)
      document.getElementById("btn-watch-ad").addEventListener("click", () => {
        this.watchRewardedAd();
      });

      // Career History Modal
      document.getElementById("btn-open-history").addEventListener("click", () => {
        sfx.playClick();
        this.openHistoryModal();
      });

      document.getElementById("btn-close-history").addEventListener("click", () => {
        sfx.playClick();
        document.getElementById("modal-history").classList.add("hidden");
      });

      // Charm Shop Modal
      document.getElementById("btn-open-shop").addEventListener("click", () => {
        sfx.playClick();
        this.openShopModal();
      });

      document.getElementById("btn-close-shop").addEventListener("click", () => {
        sfx.playClick();
        document.getElementById("modal-shop").classList.add("hidden");
      });

      document.querySelectorAll(".btn-buy-charm").forEach((btn) => {
        btn.addEventListener("click", () => {
          const charmIdx = parseInt(btn.getAttribute("data-charm"), 10);
          const cost = parseInt(btn.getAttribute("data-cost"), 10);
          this.buyCharmInShop(charmIdx, cost);
        });
      });

      // Betting Phase Controls
      document.querySelectorAll(".racer-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
          const idx = parseInt(btn.getAttribute("data-racer"), 10);
          this.selectRacer(idx);
        });
      });

      document.querySelectorAll(".chip-btn[data-chip]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const amt = parseInt(btn.getAttribute("data-chip"), 10);
          this.selectBetChip(amt);
        });
      });

      document.getElementById("btn-chip-allin").addEventListener("click", () => {
        this.selectBetChip(this.backend.currentProfile.Coins);
      });

      document.getElementById("btn-lock-bet").addEventListener("click", () => {
        this.lockInBet();
      });

      document.getElementById("btn-leave-lobby").addEventListener("click", () => {
        sfx.playClick();
        this.roomCode = "SẴN SÀNG";
        this.setPhase(MatchPhase.MainMenu);
      });

      // Racing Phase Controls
      document.getElementById("btn-cam-toggle").addEventListener("click", () => {
        sfx.playClick();
        this.world.isOverviewMode = !this.world.isOverviewMode;
        document.getElementById("btn-cam-toggle").textContent = this.world.isOverviewMode
          ? "🎥 GÓC QUAY: TOÀN CẢNH"
          : "🎥 GÓC QUAY: THEO DÕI";
      });

      document.getElementById("btn-speed-toggle").addEventListener("click", () => {
        sfx.playClick();
        const isFast = this.simulator.toggleFastForward();
        document.getElementById("btn-speed-toggle").textContent = isFast
          ? "⏩ TỐC ĐỘ: 3.5x NHANH"
          : "⏩ TỐC ĐỘ: 1.0x";
      });

      document.querySelectorAll(".charm-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
          const charmIdx = parseInt(btn.getAttribute("data-charm"), 10);
          this.castCharmInRace(charmIdx);
        });
      });

      // Podium Controls
      document.getElementById("btn-play-again").addEventListener("click", () => {
        sfx.playClick();
        this.startBettingPhase();
      });

      document.getElementById("btn-podium-menu").addEventListener("click", () => {
        sfx.playClick();
        this.roomCode = "SẴN SÀNG";
        this.setPhase(MatchPhase.MainMenu);
      });
    }

    showToast(msg) {
      const banner = document.getElementById("ui-toast-banner");
      banner.textContent = msg;
      banner.classList.remove("hidden");
      clearTimeout(this.toastTimeout);
      this.toastTimeout = setTimeout(() => banner.classList.add("hidden"), 3500);
    }

    refreshHeaderUI() {
      const p = this.backend.currentProfile;
      document.getElementById("ui-profile-name").textContent = `TÊN: ${p.DisplayName} ✏️`;
      document.getElementById("ui-coins").textContent = `$${p.Coins.toLocaleString()}`;
      document.getElementById("ui-gems").textContent = `${p.Gems} GEMS`;
      document.getElementById("ui-room-code").textContent = this.roomCode;
    }

    openNameModal() {
      const p = this.backend.currentProfile;
      const input = document.getElementById("input-player-name");
      input.value = p.DisplayName;
      document.getElementById("modal-name").classList.remove("hidden");
      input.focus();
    }

    confirmNameModal() {
      const input = document.getElementById("input-player-name");
      const saved = this.backend.updateDisplayName(input.value);
      sfx.playLockIn();
      document.getElementById("modal-name").classList.add("hidden");
      this.refreshHeaderUI();
      this.showToast(`✅ Đã đổi tên thành: ${saved}`);
    }

    openJoinRoomModal() {
      const input = document.getElementById("input-room-code");
      input.value = "LR-1001";
      document.getElementById("modal-join-room").classList.remove("hidden");
      input.focus();
    }

    confirmJoinRoomModal() {
      const input = document.getElementById("input-room-code");
      let code = (input.value || "").trim().toUpperCase();
      if (!code) code = `LR-${randRangeInt(1000, 9999)}`;
      this.roomCode = code;
      sfx.playLockIn();
      document.getElementById("modal-join-room").classList.add("hidden");
      this.showToast(`🚪 Đang vào phòng đua: ${this.roomCode}`);
      this.startBettingPhase();
    }

    watchRewardedAd() {
      const btn = document.getElementById("btn-watch-ad");
      if (!btn || btn.disabled) return;
      btn.disabled = true;
      btn.textContent = "⏳ ĐANG XEM QUẢNG CÁO (1.2s)...";
      sfx.playClick();
      this.showToast("📺 Đang phát quảng cáo giả lập (1.2s)...");

      setTimeout(() => {
        this.backend.grantAdReward(100);
        sfx.playLockIn();
        this.refreshHeaderUI();
        this.showToast("🎉 Bạn đã nhận được +100 Coins từ Quảng Cáo!");
        btn.disabled = false;
        btn.textContent = "📺 XEM QUẢNG CÁO (+100 VÀNG)";
      }, 1200);
    }

    openHistoryModal() {
      const p = this.backend.currentProfile;
      const body = document.getElementById("ui-history-body");
      body.innerHTML = `
        <div><strong>Người chơi:</strong> <span style="color:#38bdf8;">${p.DisplayName}</span></div>
        <div><strong>Tổng số trận đua:</strong> <span style="color:#fde047;">${p.TotalRaces}</span></div>
        <hr style="border-color:rgba(255,255,255,0.1);margin:6px 0;" />
        <div>🥇 Hạng 1 (Vàng - Ăn 3x): <strong>${p.RankCounts[0]} trận</strong></div>
        <div>🥈 Hạng 2 (Bạc - Ăn 2x): <strong>${p.RankCounts[1]} trận</strong></div>
        <div>🥉 Hạng 3 (Đồng - Hoàn vốn 1x): <strong>${p.RankCounts[2]} trận</strong></div>
        <div>&nbsp;&nbsp;&nbsp;Hạng 4 (Mất cược 0x): <strong>${p.RankCounts[3]} trận</strong></div>
        <div>&nbsp;&nbsp;&nbsp;Hạng 5 (Mất cược 0x): <strong>${p.RankCounts[4]} trận</strong></div>
        <hr style="border-color:rgba(255,255,255,0.1);margin:6px 0;" />
        <div style="font-size:12px;color:#cbd5e1;">
          <strong>Kho Bùa Sở Hữu:</strong> Choáng (${p.CharmCounts[0]}) | Về Đích (${p.CharmCounts[1]}) | Hoán Đổi (${p.CharmCounts[2]}) | Quay Đầu (${p.CharmCounts[3]})
        </div>
      `;
      document.getElementById("modal-history").classList.remove("hidden");
    }

    openShopModal() {
      this.refreshShopModal();
      document.getElementById("modal-shop").classList.remove("hidden");
    }

    refreshShopModal() {
      const p = this.backend.currentProfile;
      document.getElementById("ui-shop-wallet").textContent = `VÍ CỦA BẠN: $${p.Coins.toLocaleString()}`;
      for (let i = 0; i < 4; i++) {
        document.getElementById(`shop-cnt-${i}`).textContent = `(Có: ${p.CharmCounts[i]})`;
      }
      document.querySelectorAll(".btn-buy-charm").forEach((btn) => {
        const cost = parseInt(btn.getAttribute("data-cost"), 10);
        btn.disabled = p.Coins < cost;
      });
    }

    buyCharmInShop(charmIdx, cost) {
      const bought = this.backend.tryBuyCharm(charmIdx, cost);
      if (bought) {
        sfx.playLockIn();
        this.refreshHeaderUI();
        this.refreshShopModal();
        this.showToast(`Đã mua +1 Bùa ${CHARM_NAMES[charmIdx]} ($${cost})!`);
      } else {
        this.showToast(`Không đủ tiền! Bạn cần $${cost}.`);
      }
    }

    startQuickMatch() {
      const num = randRangeInt(1000, 9999);
      this.roomCode = `LR-${num}`;
      this.startBettingPhase();
    }

    startBettingPhase() {
      this.hasLockedBet = false;
      this.simulator.resetRacersToStartLine();
      this.world.snapAllCarsImmediate(0.0);
      this.world.isOverviewMode = true;

      // Emergency $20 bailout if wallet is < $10 so player can always playtest
      if (this.backend.currentProfile.Coins < 10) {
        this.backend.grantAdReward(20);
        this.showToast("Cứu trợ cháy túi: +20 Vàng được cấp tự động!");
      }

      const wallet = this.backend.currentProfile.Coins;
      this.selectedBetAmount = clamp(this.selectedBetAmount, 10, Math.max(10, wallet));

      // Populate 4 Bot Bets
      this.roomBets = [];
      for (let i = 0; i < 4; i++) {
        this.roomBets.push({
          PlayerName: BOT_NAMES[i],
          IsBot: true,
          RacerIndex: randRangeInt(0, RACER_COUNT),
          BetAmount: STANDARD_BET_CHIPS[randRangeInt(0, STANDARD_BET_CHIPS.length - 1)]
        });
      }

      this.phaseTimerRemaining = this.bettingPhaseDuration;
      this.world.syncFromSimulator(this.simulator.racerStates, this.selectedRacerIndex);
      this.setPhase(MatchPhase.Betting);
      this.refreshBettingDrawerUI();
    }

    selectRacer(racerIdx) {
      if (this.hasLockedBet) return;
      sfx.playClick();
      this.selectedRacerIndex = clamp(racerIdx, 0, RACER_COUNT - 1);
      this.world.syncFromSimulator(this.simulator.racerStates, this.selectedRacerIndex);
      this.refreshBettingDrawerUI();
    }

    selectBetChip(amount) {
      if (this.hasLockedBet) return;
      sfx.playClick();
      const wallet = this.backend.currentProfile.Coins;
      this.selectedBetAmount = clamp(amount, 10, Math.max(10, wallet));
      this.refreshBettingDrawerUI();
    }

    lockInBet() {
      if (this.hasLockedBet) return;
      if (this.backend.currentProfile.Coins < 10) {
        this.backend.grantAdReward(20);
      }
      const validBet = clamp(this.selectedBetAmount, 10, this.backend.currentProfile.Coins);
      if (!this.backend.tryPlaceBet(validBet)) return;

      sfx.playLockIn();
      this.hasLockedBet = true;
      this.localBet = {
        PlayerName: this.backend.currentProfile.DisplayName,
        IsBot: false,
        RacerIndex: this.selectedRacerIndex,
        BetAmount: validBet,
        GrossReturn: 0,
        PayoutDelta: 0
      };
      this.roomBets.unshift(this.localBet);

      // Shorten remaining countdown to 1.2s so player doesn't wait 15 full seconds
      if (this.phaseTimerRemaining > this.postBetLockDelay) {
        this.phaseTimerRemaining = this.postBetLockDelay;
      }

      this.refreshHeaderUI();
      this.refreshBettingDrawerUI();
    }

    refreshBettingDrawerUI() {
      const wallet = this.backend.currentProfile.Coins;
      const racerCfg = RACER_CONFIGS[this.selectedRacerIndex];

      document.getElementById("ui-betting-room-banner").textContent = `PHÒNG: ${this.roomCode}`;

      document.querySelectorAll(".racer-btn").forEach((btn) => {
        const idx = parseInt(btn.getAttribute("data-racer"), 10);
        btn.classList.toggle("selected", idx === this.selectedRacerIndex);
        btn.disabled = this.hasLockedBet;
      });

      document.querySelectorAll(".chip-btn[data-chip]").forEach((btn) => {
        const chip = parseInt(btn.getAttribute("data-chip"), 10);
        btn.classList.toggle("selected", !this.hasLockedBet && this.selectedBetAmount === chip);
        btn.disabled = this.hasLockedBet || (wallet < chip && chip !== 10);
      });

      const allInBtn = document.getElementById("btn-chip-allin");
      allInBtn.classList.toggle("selected", !this.hasLockedBet && this.selectedBetAmount === wallet && wallet > 0);
      allInBtn.disabled = this.hasLockedBet || wallet <= 0;

      const summaryEl = document.getElementById("ui-bet-selection-summary");
      summaryEl.textContent = this.hasLockedBet
        ? `ĐÃ KHÓA: ${racerCfg.pickLabel} VỚI MỨC CƯỢC $${this.localBet.BetAmount}!`
        : `CHỌN: ${racerCfg.pickLabel}  |  MỨC CƯỢC: $${this.selectedBetAmount}`;

      const lockBtn = document.getElementById("btn-lock-bet");
      lockBtn.disabled = this.hasLockedBet;
      lockBtn.textContent = this.hasLockedBet ? "✅ ĐÃ KHÓA CƯỢC" : "🔒 KHÓA CƯỢC";

      const feedEl = document.getElementById("ui-room-bets-feed");
      feedEl.innerHTML = `<strong>DANH SÁCH ĐẶT CƯỢC TRONG PHÒNG:</strong><br/>` +
        this.roomBets.map((b) => {
          const tag = b.IsBot ? `<span style="color:#94a3b8;">[BOT]</span>` : `<span style="color:#fde047;">[BẠN]</span>`;
          return `${tag} <strong>${b.PlayerName}</strong> &rarr; Xe #${b.RacerIndex + 1} ($${b.BetAmount})`;
        }).join("<br/>");
    }

    startRacingPhase() {
      if (this.phase === MatchPhase.Racing) return;
      if (!this.hasLockedBet) {
        this.lockInBet();
      }

      sfx.playRaceStart();
      this.world.isOverviewMode = false;
      document.getElementById("btn-cam-toggle").textContent = "🎥 GÓC QUAY: THEO DÕI";
      document.getElementById("btn-speed-toggle").textContent = "⏩ TỐC ĐỘ: 1.0x";
      document.getElementById("ui-charm-killfeed").innerHTML = "Kích hoạt Bùa Chú bên dưới để lật ngược tình thế!";

      this.simulator.startRaceServer();
      this.world.syncFromSimulator(this.simulator.racerStates, this.localBet.RacerIndex);
      this.refreshCharmHudButtons();
      this.setPhase(MatchPhase.Racing);
    }

    castCharmInRace(charmIdx) {
      if (this.phase !== MatchPhase.Racing || !this.simulator.isRaceRunning) return;
      const p = this.backend.currentProfile;
      if (!this.backend.tryConsumeCharm(charmIdx)) {
        document.getElementById("ui-charm-killfeed").textContent =
          `Đã hết Bùa ${CHARM_NAMES[charmIdx]}! Hãy mua thêm tại Cửa Hàng.`;
        return;
      }

      sfx.playCharm(charmIdx);
      this.simulator.applyCharmEffectServer(charmIdx, p.DisplayName);
      this.world.syncFromSimulator(this.simulator.racerStates, this.localBet.RacerIndex);
      this.refreshCharmHudButtons();
    }

    handleCharmBroadcast(charmIdx, casterName, affectedMask) {
      const feed = document.getElementById("ui-charm-killfeed");
      const targets = [];
      for (let i = 0; i < RACER_COUNT; i++) {
        if ((affectedMask & (1 << i)) !== 0) targets.push(`#${i + 1}`);
      }
      feed.innerHTML = `⚡ <strong>${casterName}</strong> kích hoạt <strong>BÙA ${CHARM_NAMES[charmIdx]}</strong> (${targets.join(", ") || "Tất cả"})!`;
    }

    refreshCharmHudButtons() {
      const counts = this.backend.currentProfile.CharmCounts;
      for (let i = 0; i < 4; i++) {
        document.getElementById(`lbl-charm-${i}`).textContent = `(x${counts[i]})`;
        document.getElementById(`btn-charm-${i}`).disabled = counts[i] <= 0;
      }
    }

    updateRacingHudStandings() {
      const states = this.simulator.racerStates;
      const order = [0, 1, 2, 3, 4];

      for (let i = 0; i < RACER_COUNT; i++) {
        const pct = Math.round(states[i].NormalizedT * 100);
        const bar = document.getElementById(`bar-racer-${i}`);
        if (bar) bar.style.width = `${pct}%`;
      }

      order.sort((idxA, idxB) => {
        const a = states[idxA];
        const b = states[idxB];
        if (a.FinishRank > 0 && b.FinishRank > 0) return a.FinishRank - b.FinishRank;
        if ((a.FinishRank > 0) !== (b.FinishRank > 0)) return b.FinishRank > 0 ? 1 : -1;
        return b.NormalizedT - a.NormalizedT;
      });

      const myRacer = this.localBet.RacerIndex;
      const stripText = order.map((carIdx, place) => {
        const pct = Math.round(states[carIdx].NormalizedT * 100);
        const star = carIdx === myRacer ? "★" : "";
        return `${place + 1}.${RACER_CONFIGS[carIdx].shortName}${star}(${pct}%)`;
      }).join("  ");

      document.getElementById("ui-live-leaderboard").textContent = stripText;
    }

    handleAllRacersFinished(finishRanks) {
      const localCar = clamp(this.localBet.RacerIndex, 0, RACER_COUNT - 1);
      const localFinishRank = finishRanks[localCar] || 1;
      const settlement = this.backend.settleRaceResult(this.localBet.BetAmount, localFinishRank);

      this.localBet.GrossReturn = settlement.grossReturn;
      this.localBet.PayoutDelta = settlement.netDelta;

      sfx.playPodium(localFinishRank <= 2);
      this.refreshHeaderUI();
      this.renderPodiumScreen(finishRanks, localCar, localFinishRank, settlement);
      this.setPhase(MatchPhase.Podium);
    }

    renderPodiumScreen(finishRanks, localCar, localFinishRank, settlement) {
      const headline = document.getElementById("ui-podium-headline");
      if (localFinishRank === 1) headline.textContent = "🏆 HẠNG 1 CHIẾN THẮNG! (ĂN 3X)";
      else if (localFinishRank === 2) headline.textContent = "🥈 HẠNG 2 XUẤT SẮC! (ĂN 2X)";
      else if (localFinishRank === 3) headline.textContent = "🥉 HẠNG 3 VỀ ĐÍCH! (HOÀN VỐN 1X)";
      else headline.textContent = `HẠNG #${localFinishRank} — CHÚC BẠN MAY MẮN TRẬN SAU!`;

      const lines = ["<strong>BẢNG XẾP HẠNG CHÍNH THỨC:</strong>"];
      for (let rank = 1; rank <= RACER_COUNT; rank++) {
        let carAtRank = finishRanks.indexOf(rank);
        if (carAtRank < 0) carAtRank = rank - 1;
        const medal = rank === 1 ? "🥇 HẠNG 1 [VÀNG - ĂN 3x]"
                    : rank === 2 ? "🥈 HẠNG 2 [BẠC - ĂN 2x]"
                    : rank === 3 ? "🥉 HẠNG 3 [ĐỒNG - HOÀN 1x]"
                    : `&nbsp;&nbsp;&nbsp;HẠNG ${rank} [0x]`;
        const yourTag = carAtRank === localCar
          ? ` <span style="color:#fde047;font-weight:900;">&larr; CƯỢC CỦA BẠN</span>`
          : "";
        lines.push(`${medal}: <strong>${RACER_CONFIGS[carAtRank].fullName}</strong>${yourTag}`);
      }
      document.getElementById("ui-podium-rankings").innerHTML = lines.join("<br/>");

      const sign = settlement.netDelta >= 0 ? "+" : "";
      document.getElementById("ui-podium-payout").innerHTML =
        `Tiền cược: <strong>$${this.localBet.BetAmount}</strong> &nbsp;|&nbsp; Tổng thu về: <strong>$${settlement.grossReturn}</strong><br/>` +
        `Lãi ròng: <strong style="color:#fde047;">${sign}$${settlement.netDelta}</strong> &nbsp;|&nbsp; Số dư ví mới: <strong>$${settlement.newBalance.toLocaleString()}</strong>`;
    }

    setPhase(nextPhase) {
      this.phase = nextPhase;
      this.refreshHeaderUI();

      document.getElementById("screen-main-menu").classList.toggle("hidden", nextPhase !== MatchPhase.MainMenu);
      document.getElementById("screen-betting").classList.toggle("hidden", nextPhase !== MatchPhase.Betting);
      document.getElementById("screen-racing").classList.toggle("hidden", nextPhase !== MatchPhase.Racing);
      document.getElementById("screen-podium").classList.toggle("hidden", nextPhase !== MatchPhase.Podium);
    }

    tickLoop(nowMs) {
      const dt = Math.min(0.1, Math.max(0.001, (nowMs - this.lastFrameTime) / 1000.0));
      this.lastFrameTime = nowMs;
      const timeSec = nowMs / 1000.0;

      if (this.phase === MatchPhase.Betting) {
        this.phaseTimerRemaining = Math.max(0, this.phaseTimerRemaining - dt);
        document.getElementById("ui-bet-countdown").textContent =
          `ĐẶT CƯỢC KẾT THÚC SAU: ${this.phaseTimerRemaining.toFixed(1)}s`;
        if (this.phaseTimerRemaining <= 0) {
          this.startRacingPhase();
        }
      } else if (this.phase === MatchPhase.Racing) {
        this.simulator.update(dt);
        this.world.syncFromSimulator(this.simulator.racerStates, this.localBet.RacerIndex);
        this.updateRacingHudStandings();
      }

      this.world.updateAndRender(dt, timeSec, this.phase);
      requestAnimationFrame((nextNow) => this.tickLoop(nextNow));
    }
  }

  // Boot WebGL Application & Expose Telemetry Hook for Automated Playtesting
  window.addEventListener("DOMContentLoaded", () => {
    const app = new LuckyRacingWebGLApp();
    window.__LUCKY_RACING__ = app;
    console.log("[LuckyRacing WebGL] Initialized 60 FPS Portrait (9:16) 3D Diorama Engine.");
  });
})();
