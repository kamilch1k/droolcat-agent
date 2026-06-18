// voice.js — polished hands-free Voice Mode for the board.
//
// A full-screen overlay with an audio-reactive orb. It listens (Web Speech),
// sends each utterance as a prompt into the active lane, then reads Claude's
// reply back aloud and listens again — a continuous voice conversation with the
// board. Degrades gracefully: no speech-recognition -> a typed fallback; no mic
// for the level meter -> a synthetic breathing animation; no TTS -> silent.

const COLORS = {
  listening: "13,138,118",   // teal
  thinking: "181,121,27",    // amber
  speaking: "28,95,199",     // blue
  paused: "155,152,143",     // grey
  idle: "155,152,143",
  nostt: "178,59,52",        // danger
};
const STATUS = {
  listening: "Listening…",
  thinking: "Claude is working…",
  speaking: "Speaking…",
  paused: "Paused",
  idle: "",
  nostt: "Voice input isn’t available here — type below",
};

// strip markdown/code so the spoken text reads naturally
function speakable(s) {
  return String(s || "")
    .replace(/```[\s\S]*?```/g, " . ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\[(.*?)\]\((.*?)\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "link")
    .replace(/\s+/g, " ")
    .trim();
}

export class VoiceMode {
  constructor(els, { onUtterance, getLaneLabel } = {}) {
    this.root = els.root;
    this.canvas = els.canvas;
    this.core = els.core;
    this.statusEl = els.status;
    this.transcriptEl = els.transcript;
    this.laneEl = els.lane;
    this.pauseBtn = els.pause;
    this.exitBtn = els.exit;
    this.fallback = els.fallback;
    this.fallbackInput = els.fallbackInput;
    this.onUtterance = onUtterance;
    this.getLaneLabel = getLaneLabel;

    this.SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    this.synth = window.speechSynthesis || null;
    this.active = false;
    this.paused = false;
    this.state = "idle";
    this.recog = null;
    this.stream = null;
    this.ac = null;
    this.analyser = null;
    this.raf = 0;
    this.pendingChat = null;   // set by the host when an utterance is submitted
    this.pendingLane = null;
    this._t = 0; this._lvl = 0; this._bump = 0;

    this._wire();
  }

  _wire() {
    this.pauseBtn.addEventListener("click", () => this.togglePause());
    this.exitBtn.addEventListener("click", () => this.exit());
    this.root.addEventListener("mousedown", (e) => e.stopPropagation());
    if (this.fallbackInput) {
      this.fallbackInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          const v = this.fallbackInput.value.trim();
          if (v) { this.fallbackInput.value = ""; this._submit(v); }
        }
      });
    }
  }

  enter() {
    if (this.active) return;
    this.active = true; this.paused = false;
    this.root.style.display = "flex";
    this.laneEl.textContent = (this.getLaneLabel && this.getLaneLabel()) || "main";
    this.pauseBtn.textContent = "pause";
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = 320 * dpr; this.canvas.height = 320 * dpr;
    this.canvas.style.width = "320px"; this.canvas.style.height = "320px";
    this.ctx = this.canvas.getContext("2d");
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this._startMicLevel();
    this._draw();
    if (this.SR) { this._showFallback(false); this._listen(); }
    else { this._setState("nostt"); this._showFallback(true); if (this.fallbackInput) setTimeout(() => this.fallbackInput.focus(), 50); }
  }

  exit() {
    if (!this.active) return;
    this.active = false;
    this.root.style.display = "none";
    this._stopListen();
    if (this.synth) try { this.synth.cancel(); } catch {}
    this._stopMicLevel();
    cancelAnimationFrame(this.raf); this.raf = 0;
    this._setState("idle");
    this.transcriptEl.textContent = "";
  }

  togglePause() {
    if (!this.active) return;
    this.paused = !this.paused;
    if (this.paused) {
      this._stopListen();
      if (this.synth) try { this.synth.cancel(); } catch {}
      this._setState("paused");
      this.pauseBtn.textContent = "resume";
    } else {
      this.pauseBtn.textContent = "pause";
      if (this.SR) this._listen(); else this._setState("nostt");
    }
  }

  // ---- recognition (listen) --------------------------------------------
  _listen() {
    if (!this.SR || !this.active || this.paused) return;
    this._setState("listening");
    this.transcriptEl.textContent = "";
    let finalText = "";
    const rec = this.recog = new this.SR();
    rec.lang = "en-US"; rec.interimResults = true; rec.continuous = false;
    rec.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalText += r[0].transcript; else interim += r[0].transcript;
      }
      this.transcriptEl.textContent = (finalText + " " + interim).trim();
    };
    rec.onerror = (ev) => {
      if (ev.error === "not-allowed" || ev.error === "service-not-allowed") {
        this._setState("nostt"); this._showFallback(true);
        if (this.fallbackInput) this.fallbackInput.focus();
      }
    };
    rec.onend = () => {
      if (this.recog === rec) this.recog = null;
      const text = finalText.trim();
      if (!this.active || this.paused) return;
      if (text) this._submit(text);
      else if (this.state === "listening") this._listen();   // heard nothing — keep an ear open
    };
    try { rec.start(); } catch {}
  }
  _stopListen() {
    const r = this.recog; this.recog = null;
    if (r) { try { r.onend = null; r.abort(); } catch {} }
  }
  _submit(text) {
    this.transcriptEl.textContent = "“" + text + "”";
    this._showFallback(false);
    this._setState("thinking");
    this.onUtterance && this.onUtterance(text);
  }

  // ---- read Claude's reply back (called by the host on turn end) --------
  speak(text) {
    if (!this.active) return;
    const say = speakable(text);
    if (!this.synth || !say) { this._afterSpeak(); return; }
    this._setState("speaking");
    this.transcriptEl.textContent = say.length > 240 ? say.slice(0, 240) + "…" : say;
    try { this.synth.cancel(); } catch {}
    const u = new SpeechSynthesisUtterance(say.slice(0, 1400));
    const v = this._pickVoice(); if (v) u.voice = v;
    u.rate = 1.03; u.pitch = 1.0;
    u.onboundary = () => { this._bump = 1; };
    u.onend = () => this._afterSpeak();
    u.onerror = () => this._afterSpeak();
    try { this.synth.speak(u); } catch { this._afterSpeak(); }
  }
  _afterSpeak() {
    if (!this.active || this.paused) return;
    if (this.SR) this._listen(); else this._setState("nostt");
  }
  _pickVoice() {
    if (!this.synth) return null;
    const vs = this.synth.getVoices() || [];
    return vs.find((v) => /en[-_]US/i.test(v.lang) && /natural|google|zira|aria|jenny/i.test(v.name))
      || vs.find((v) => /^en/i.test(v.lang)) || null;
  }

  // ---- orb ---------------------------------------------------------------
  async _startMicLevel() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !AC) return;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.ac = new AC();
      const src = this.ac.createMediaStreamSource(this.stream);
      this.analyser = this.ac.createAnalyser();
      this.analyser.fftSize = 512;
      this._buf = new Uint8Array(this.analyser.fftSize);
      src.connect(this.analyser);
    } catch { this.analyser = null; }
  }
  _stopMicLevel() {
    if (this.stream) { this.stream.getTracks().forEach((t) => t.stop()); this.stream = null; }
    if (this.ac) { try { this.ac.close(); } catch {} this.ac = null; }
    this.analyser = null;
  }
  _draw() {
    if (!this.active || !this.ctx) return;
    const ctx = this.ctx, S = 320, cx = S / 2, cy = S / 2;
    ctx.clearRect(0, 0, S, S);
    this._t++;
    let level;
    if (this.state === "listening" && this.analyser) {
      this.analyser.getByteTimeDomainData(this._buf);
      let sum = 0; for (let i = 0; i < this._buf.length; i++) { const v = (this._buf[i] - 128) / 128; sum += v * v; }
      level = Math.min(1, Math.sqrt(sum / this._buf.length) * 3.4);
    } else if (this.state === "speaking") {
      level = 0.34 + 0.26 * Math.abs(Math.sin(this._t * 0.13)) + 0.4 * this._bump;
    } else if (this.state === "listening") {
      level = 0.2 + 0.1 * Math.sin(this._t * 0.06);
    } else {
      level = 0.12 + 0.05 * Math.sin(this._t * 0.045);   // idle / thinking breathing
    }
    this._bump = Math.max(0, this._bump - 0.06);
    this._lvl = this._lvl * 0.72 + level * 0.28;          // smooth
    const col = COLORS[this.state] || COLORS.idle;
    const base = 60, reach = 90;
    for (let i = 4; i >= 1; i--) {
      const r = base + i * 11 + reach * this._lvl * (i / 3);
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${col},${0.05 * i})`; ctx.fill();
    }
    if (this.state === "thinking") {
      const a = this._t * 0.09;
      ctx.beginPath(); ctx.arc(cx, cy, base + 34, a, a + Math.PI * 0.7);
      ctx.strokeStyle = `rgba(${col},.85)`; ctx.lineWidth = 3; ctx.lineCap = "round"; ctx.stroke();
    }
    if (this.core) this.core.style.setProperty("--lvl", (1 + this._lvl * 0.45).toFixed(3));
    this.raf = requestAnimationFrame(() => this._draw());
  }

  // ---- helpers -----------------------------------------------------------
  _setState(s) {
    this.state = s;
    this.statusEl.textContent = STATUS[s] || "";
    this.root.className = "voicemode s-" + s;
    this.root.style.display = this.active ? "flex" : "none";
    this.core.style.setProperty("--vm-accent", "rgb(" + (COLORS[s] || COLORS.idle) + ")");
  }
  _showFallback(show) {
    if (this.fallback) this.fallback.classList.toggle("show", !!show);
  }
}
