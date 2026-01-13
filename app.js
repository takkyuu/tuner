// app.js
'use strict';

/**
 * ============================================================
 * 既存構造を維持:
 * 1) AudioInput
 * 2) PitchDetector
 * 3) TunerUI
 * 4) ShareAdapter（ダミー）
 *
 * 追加:
 * 5) ToneEngine   : 発音（Osc/Sample切替、エンベロープ付）
 * 6) KeyboardUI   : 鍵盤描画＆入力（pointer events）
 * 7) DisplayUI    : 鳴っている音名を大きく表示（TunerUIと独立）
 *
 * ※AudioContext設計
 * - マイク入力(AudioInput) と 発音(ToneEngine) は別AudioContextにしています。
 *   理由: 将来サンプル再生やミキサ機能を足しても、入力系の停止/再開やノード構成に影響しにくい。
 *   （1つのAudioContextにまとめる設計も可能ですが、初心者が改造する際の事故が減ります）
 * ============================================================
 */

/* ------------------------------------------------------------
 * 4) ShareAdapter（ダミー）
 * ------------------------------------------------------------ */
const ShareAdapter = (() => {
  return {
    publish(_state) {},
    subscribe(_cb) {
      return () => {};
    }
  };
})();

/* ------------------------------------------------------------
 * 1) AudioInput（既存）
 * ------------------------------------------------------------ */
const AudioInput = (() => {
  const DEFAULT_FFT_SIZE = 8192;
  const HIGHPASS_HZ = 30;

  let audioCtx = null;
  let stream = null;
  let source = null;
  let analyser = null;
  let hp = null;

  const timeDomain = new Float32Array(DEFAULT_FFT_SIZE);

  async function start({ fftSize = DEFAULT_FFT_SIZE } = {}) {
    if (audioCtx) return;

    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      }
    });

    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    await audioCtx.resume();

    source = audioCtx.createMediaStreamSource(stream);

    hp = audioCtx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = HIGHPASS_HZ;
    hp.Q.value = 0.707;

    analyser = audioCtx.createAnalyser();
    analyser.fftSize = fftSize;
    analyser.smoothingTimeConstant = 0;
    analyser.minDecibels = -100;
    analyser.maxDecibels = -10;

    source.connect(hp);
    hp.connect(analyser);

    if (timeDomain.length !== analyser.fftSize) {
      console.warn('fftSize changed; consider recreating timeDomain buffer.');
    }
  }

  function stop() {
    if (stream) {
      for (const t of stream.getTracks()) t.stop();
    }
    stream = null;

    if (audioCtx) audioCtx.close();
    audioCtx = null;
    source = null;
    analyser = null;
    hp = null;
  }

  function isRunning() {
    return !!audioCtx && !!analyser;
  }

  function getSampleRate() {
    return audioCtx ? audioCtx.sampleRate : 0;
  }

  function getPCM() {
    if (!analyser) return null;
    analyser.getFloatTimeDomainData(timeDomain);
    return timeDomain;
  }

  return { start, stop, isRunning, getSampleRate, getPCM, DEFAULT_FFT_SIZE };
})();

/* ------------------------------------------------------------
 * 2) PitchDetector（既存）
 * ------------------------------------------------------------ */
const PitchDetector = (() => {
  const DEFAULT_MIN_HZ = 50;
  const DEFAULT_MAX_HZ = 1000;
  const DEFAULT_YIN_THRESHOLD = 0.15;

  function detectPitch(pcm, sampleRate, opts = {}) {
    if (!pcm || pcm.length < 512 || !sampleRate) {
      return { hz: null, confidence: 0 };
    }

    const minHz = opts.minHz ?? DEFAULT_MIN_HZ;
    const maxHz = opts.maxHz ?? DEFAULT_MAX_HZ;
    const threshold = opts.threshold ?? DEFAULT_YIN_THRESHOLD;

    let mean = 0;
    for (let i = 0; i < pcm.length; i++) mean += pcm[i];
    mean /= pcm.length;

    const tauMin = Math.max(2, Math.floor(sampleRate / maxHz));
    const tauMax = Math.min(Math.floor(sampleRate / minHz), pcm.length - 2);

    const d = new Float32Array(tauMax + 1);
    for (let tau = 0; tau <= tauMax; tau++) d[tau] = 0;

    const half = Math.floor(pcm.length / 2);

    for (let tau = tauMin; tau <= tauMax; tau++) {
      let sum = 0;
      for (let i = 0; i < half; i++) {
        const x0 = pcm[i] - mean;
        const x1 = pcm[i + tau] - mean;
        const diff = x0 - x1;
        sum += diff * diff;
      }
      d[tau] = sum;
    }

    const cmnd = new Float32Array(tauMax + 1);
    cmnd[0] = 1;

    let runningSum = 0;
    for (let tau = 1; tau <= tauMax; tau++) {
      runningSum += d[tau];
      cmnd[tau] = d[tau] * tau / (runningSum + 1e-12);
    }

    let tauEstimate = -1;
    for (let tau = tauMin; tau <= tauMax; tau++) {
      if (cmnd[tau] < threshold) {
        while (tau + 1 <= tauMax && cmnd[tau + 1] < cmnd[tau]) tau++;
        tauEstimate = tau;
        break;
      }
    }

    if (tauEstimate === -1) {
      let minVal = Infinity;
      let minTau = -1;
      for (let tau = tauMin; tau <= tauMax; tau++) {
        if (cmnd[tau] < minVal) {
          minVal = cmnd[tau];
          minTau = tau;
        }
      }
      tauEstimate = minTau;
    }

    const betterTau = parabolicInterpolation(cmnd, tauEstimate);
    const hz = betterTau > 0 ? (sampleRate / betterTau) : null;

    const rawConf = 1 - (cmnd[tauEstimate] ?? 1);
    const confidence = clamp(rawConf, 0, 1);

    if (!hz || hz < minHz || hz > maxHz) {
      return { hz: null, confidence: 0 };
    }
    return { hz, confidence };
  }

  function parabolicInterpolation(arr, i) {
    const x0 = i - 1;
    const x1 = i;
    const x2 = i + 1;
    if (x0 < 0 || x2 >= arr.length) return i;

    const y0 = arr[x0];
    const y1 = arr[x1];
    const y2 = arr[x2];

    const denom = (y0 - 2 * y1 + y2);
    if (Math.abs(denom) < 1e-12) return i;

    const delta = 0.5 * (y0 - y2) / denom;
    return i + delta;
  }

  function clamp(v, a, b) {
    return Math.max(a, Math.min(b, v));
  }

  return { detectPitch };
})();

/* ------------------------------------------------------------
 * 3) TunerUI（既存）
 * ------------------------------------------------------------ */
const TunerUI = (() => {
  const el = {};

  function init() {
    el.hzText = document.getElementById('hzText');
    el.noteText = document.getElementById('noteText');
    el.centText = document.getElementById('centText');
    el.confText = document.getElementById('confText');
    el.detectText = document.getElementById('detectText');
    el.needle = document.getElementById('needle');
    el.inTune = document.getElementById('inTune');
    el.levelBar = document.getElementById('levelBar');
    el.levelText = document.getElementById('levelText');
    el.status = document.getElementById('status');
  }

  function setStatus(kind, text) {
    if (!el.status) return;
    el.status.classList.remove('idle', 'running', 'error');
    el.status.classList.add(kind);
    el.status.textContent = text;
  }

  function render(state) {
    const rms = state.rms ?? 0;
    const db = rmsToDb(rms);
    const levelPct = dbToPercent(db);

    el.levelBar.style.width = `${levelPct.toFixed(1)}%`;
    el.levelText.textContent = Number.isFinite(db) ? `${db.toFixed(1)} dB` : `— dB`;

    const hasPitch = typeof state.hz === 'number' && state.hz > 0 && state.noteName;
    const conf = state.confidence ?? 0;

    if (!hasPitch) {
      el.hzText.textContent = '—';
      el.noteText.textContent = '—';
      el.centText.textContent = '—';
      el.confText.textContent = conf > 0 ? `${Math.round(conf * 100)}%` : '—';
      el.detectText.textContent = (rms > 0.01) ? '検出中…' : '無音/ゲート中';
      setNeedle(0, 0.15);
      el.inTune.style.width = `0px`;
      return;
    }

    el.hzText.textContent = state.hz.toFixed(2);
    el.noteText.textContent = `${state.noteName}${state.octave}`;
    el.centText.textContent = formatSigned(state.cents, 0);
    el.confText.textContent = `${Math.round(conf * 100)}%`;

    const cents = clamp(state.cents ?? 0, -50, 50);
    const opacity = clamp(0.25 + conf * 0.75, 0.25, 1.0);
    setNeedle(cents, opacity);

    const inTune = Math.abs(cents) <= 5;
    el.inTune.style.width = inTune ? `52px` : `0px`;

    el.detectText.textContent = inTune ? 'OK' : (cents < 0 ? '低い' : '高い');
  }

  function setNeedle(cents, opacity) {
    const track = el.needle?.parentElement;
    const w = track ? track.clientWidth : 300;
    const half = w / 2;
    const x = (cents / 50) * (half - 8);
    el.needle.style.transform = `translateX(${x}px)`;
    el.needle.style.opacity = `${opacity}`;
  }

  function formatSigned(v, digits = 0) {
    if (!Number.isFinite(v)) return '—';
    const s = v >= 0 ? '+' : '';
    return `${s}${v.toFixed(digits)}`;
  }

  function rmsToDb(rms) {
    if (rms <= 0) return -Infinity;
    return 20 * Math.log10(rms);
  }

  function dbToPercent(db) {
    if (!Number.isFinite(db)) return 0;
    const clamped = clamp(db, -60, 0);
    return ((clamped + 60) / 60) * 100;
  }

  function clamp(v, a, b) {
    return Math.max(a, Math.min(b, v));
  }

  return { init, render, setStatus };
})();

/* ------------------------------------------------------------
 * 5) ToneEngine（新規）
 *   - Oscillator / Sample の切替
 *   - noteOn / noteOff を提供（単音）
 *   - クリックノイズ対策：GainNodeで短いAttack/Release
 *   - 将来：AudioBufferをロードして鳴らすための差し込み口を用意
 * ------------------------------------------------------------ */
const ToneEngine = (() => {
  // 発音用AudioContext（入力用とは分ける）
  let ctx = null;

  // 単音エンジン（今は1つだけ）
  let oscNode = null;
  let gainNode = null;

  // 将来サンプル再生用（ダミー）
  // ここに AudioBuffer を保存していく想定
  const sampleBank = new Map();

  let mode = 'osc';        // 'osc' | 'sample'
  let waveform = 'sine';   // oscillator波形
  let masterVol = 0.25;

  // エンベロープ（クリックノイズ対策）
  // 触りたい場合はここをいじる（初心者向け）
  const ATTACK_SEC = 0.008;
  const RELEASE_SEC = 0.06;

  async function ensureContextResumed() {
    if (!ctx) {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (ctx.state !== 'running') {
      // ユーザー操作の直後に呼ばれる前提
      await ctx.resume();
    }
  }

  function setMode(nextMode) {
    mode = (nextMode === 'sample') ? 'sample' : 'osc';
  }

  function setWaveform(w) {
    // OscillatorNodeのtypeで許される値のみ
    const ok = ['sine', 'square', 'triangle', 'sawtooth'];
    waveform = ok.includes(w) ? w : 'sine';
    // 発音中なら反映（鳴り替え）
    if (oscNode) {
      try { oscNode.type = waveform; } catch (_) {}
    }
  }

  function setVolume(v) {
    masterVol = clamp(Number(v), 0, 1);
    if (gainNode) {
      const t = ctx.currentTime;
      gainNode.gain.setTargetAtTime(masterVol, t, 0.01);
    }
  }

  /**
   * noteOn
   * - 引数は midiNote または freqHz のどちらでもOKにしておく（拡張しやすい）
   * - opts: { midiNote?: number, freq?: number, a4?: number }
   */
  async function noteOn(opts = {}) {
    await ensureContextResumed();

    // まず単音なので、前の音は止めてから鳴らす（将来ポリフォニーにするならここを改造）
    noteOff();

    const a4 = opts.a4 ?? 440;

    if (mode === 'sample') {
      // ダミー：将来ここでAudioBufferSourceNodeを作って鳴らす
      // 今は「それっぽく」短いクリックを避けるために、代わりにオシレータを鳴らす（UIはSampleとして見せる）
      // → 将来サンプル実装が入ったら、ここを差し替えるだけでOK。
      const freq = opts.freq ?? midiToHz(opts.midiNote ?? 69, a4);
      playOsc(freq);
      return;
    }

    const freq = opts.freq ?? midiToHz(opts.midiNote ?? 69, a4);
    playOsc(freq);
  }

  function playOsc(freq) {
    // ノード構成: Oscillator -> Gain(Envelope) -> Destination
    oscNode = ctx.createOscillator();
    oscNode.type = waveform;
    oscNode.frequency.value = freq;

    gainNode = ctx.createGain();

    // エンベロープ：0→masterVolへattack、止めるときreleaseで0へ
    const t = ctx.currentTime;
    gainNode.gain.cancelScheduledValues(t);
    gainNode.gain.setValueAtTime(0.0001, t);
    gainNode.gain.exponentialRampToValueAtTime(Math.max(0.0001, masterVol), t + ATTACK_SEC);

    oscNode.connect(gainNode);
    gainNode.connect(ctx.destination);

    oscNode.start();
  }

  function noteOff() {
    if (!ctx) return;

    const t = ctx.currentTime;

    if (gainNode) {
      // releaseで0へ
      gainNode.gain.cancelScheduledValues(t);
      // setTargetAtTimeは自然に減衰させやすい（0へ近づける）
      gainNode.gain.setTargetAtTime(0.0001, t, RELEASE_SEC);
    }

    if (oscNode) {
      // releaseが終わる少し後にstop
      try { oscNode.stop(t + RELEASE_SEC * 4); } catch (_) {}
      try { oscNode.disconnect(); } catch (_) {}
    }

    if (gainNode) {
      try { gainNode.disconnect(); } catch (_) {}
    }

    oscNode = null;
    gainNode = null;
  }

  /**
   * （将来用）サンプルを読み込む差し込み口
   * - manifest例（将来）:
   *   [{ name:'C4', url:'samples/C4.wav' }, ...]
   * - 今はダミー：呼んでも何もしない（構造だけ用意）
   */
  async function loadSamples(_manifest) {
    await ensureContextResumed();

    // 将来やること（コメント）:
    // 1) fetch(url) で ArrayBuffer を取得
    // 2) ctx.decodeAudioData(arrayBuffer) で AudioBuffer に
    // 3) sampleBank.set(name, audioBuffer)
    // 4) playSample(noteName) で AudioBufferSourceNode を作って再生

    return;
  }

  /**
   * （将来用）AudioBufferを鳴らす
   * - 今はダミー。mode==='sample'の時はnoteOn内で代替オシレータを鳴らしている
   */
  function playSample(_noteName) {
    // 将来はここで sampleBank.get(noteName) を取り出して鳴らす
  }

  function midiToHz(midiNote, a4) {
    return a4 * Math.pow(2, (midiNote - 69) / 12);
  }

  function clamp(v, a, b) {
    return Math.max(a, Math.min(b, v));
  }

  return {
    noteOn,
    noteOff,
    setMode,
    setWaveform,
    setVolume,
    loadSamples,
    playSample
  };
})();

/* ------------------------------------------------------------
 * 6) DisplayUI（新規）
 *   - 鳴っている音名を大きく表示
 *   - TunerUIとは別。stateは「発音側」の状態を持つだけ。
 * ------------------------------------------------------------ */
const DisplayUI = (() => {
  let el = null;

  function init() {
    el = document.getElementById('playDisplay');
  }

  function setPlaying(noteTextOrNull) {
    if (!el) return;

    if (!noteTextOrNull) {
      el.textContent = '——';
      el.classList.remove('is-on');
      el.classList.add('is-off');
      return;
    }

    el.textContent = noteTextOrNull;
    el.classList.remove('is-off');
    el.classList.add('is-on');
  }

  return { init, setPlaying };
})();

/* ------------------------------------------------------------
 * 7) KeyboardUI（新規）
 *   - 鍵盤を描画し、pointerdown/upでToneEngineを呼ぶ
 *   - 単音（とりあえず）: 押し替え時は前の音を止めて新しい音を鳴らす
 *   - 将来ポリフォニー: activePointersを複数保持し、ノードも複数にする
 * ------------------------------------------------------------ */
const KeyboardUI = (() => {
  // チューナー用途として扱いやすいレンジの提案:
  // - 声(男)の基音: 80〜150Hz (E2〜D3近辺)
  // - ギター: E2(82Hz)〜E4(330Hz)が中心、ハイフレットでさらに上
  // → 2オクターブで「C3〜B4」は汎用的で見やすく、基準音練習にも向く
  const START_MIDI = 48; // C3
  const END_MIDI = 71;   // B4

  // 白鍵の並び（Cメジャー）
  const WHITE_PCS = new Set([0, 2, 4, 5, 7, 9, 11]); // pitch class for white keys

  let rootEl = null;

  // 単音：どのpointerが押しているか追跡（マルチタッチ拡張の足場）
  let activePointerId = null;
  let activeKeyEl = null;
  let getA4 = () => 440; // 外部から注入

  function init({ keyboardElementId = 'keyboard', getA4Fn }) {
    rootEl = document.getElementById(keyboardElementId);
    if (!rootEl) return;

    if (typeof getA4Fn === 'function') getA4 = getA4Fn;

    renderKeyboard();
    bindEvents();
  }

  function renderKeyboard() {
    // まず空にする
    rootEl.innerHTML = '';

    // 白鍵の数を数えて、幅を割り当てる
    const whiteMidi = [];
    for (let m = START_MIDI; m <= END_MIDI; m++) {
      if (isWhite(m)) whiteMidi.push(m);
    }
    const whiteCount = whiteMidi.length;
    const whiteW = 100 / whiteCount; // %でレイアウト（レスポンシブ）
    const blackW = whiteW * 0.65;    // 黒鍵は細め

    // 白鍵を配置
    const whiteIndexByMidi = new Map();
    let wi = 0;
    for (let m = START_MIDI; m <= END_MIDI; m++) {
      if (!isWhite(m)) continue;

      const key = document.createElement('div');
      key.className = 'key white';
      key.dataset.midi = String(m);
      key.dataset.note = midiToNoteText(m);

      key.style.left = `${wi * whiteW}%`;
      key.style.width = `${whiteW}%`;

      const label = document.createElement('div');
      label.className = 'label';
      label.textContent = midiToNoteText(m);
      key.appendChild(label);

      rootEl.appendChild(key);
      whiteIndexByMidi.set(m, wi);
      wi++;
    }

    // 黒鍵を配置（白鍵の間に乗せる）
    // 黒鍵のあるpitch class: C#, D#, F#, G#, A#（= 1,3,6,8,10）
    for (let m = START_MIDI; m <= END_MIDI; m++) {
      if (isWhite(m)) continue;

      const pc = ((m % 12) + 12) % 12;

      // 黒鍵の位置は「直前の白鍵」と「次の白鍵」の間に置く
      const prevWhiteMidi = findPrevWhite(m);
      const prevIndex = whiteIndexByMidi.get(prevWhiteMidi);
      if (prevIndex == null) continue;

      // 白鍵幅の中で少し右寄せに置く（簡易）
      // pitch classごとに見た目がズレやすいので軽く補正を入れる
      let offset = 0.68; // 基本は白鍵の右寄り
      if (pc === 1) offset = 0.70;  // C#
      if (pc === 3) offset = 0.73;  // D#
      if (pc === 6) offset = 0.65;  // F#
      if (pc === 8) offset = 0.68;  // G#
      if (pc === 10) offset = 0.71; // A#

      const key = document.createElement('div');
      key.className = 'key black';
      key.dataset.midi = String(m);
      key.dataset.note = midiToNoteText(m);

      key.style.left = `${(prevIndex + offset) * whiteW}%`;
      key.style.width = `${blackW}%`;

      const label = document.createElement('div');
      label.className = 'label';
      label.textContent = midiToNoteText(m);
      key.appendChild(label);

      rootEl.appendChild(key);
    }
  }

  function bindEvents() {
    // pointer events推奨：マウス/タッチ/ペンに対応
    rootEl.addEventListener('pointerdown', (ev) => {
      const key = findKeyFromEvent(ev);
      if (!key) return;

      // 既に別pointerで押しているなら無視（単音仕様）
      if (activePointerId !== null && activePointerId !== ev.pointerId) return;

      activePointerId = ev.pointerId;
      rootEl.setPointerCapture(ev.pointerId);

      pressKey(key);
      startToneForKey(key);
      ev.preventDefault();
    });

    rootEl.addEventListener('pointermove', (ev) => {
      // 押下中だけ「スライドして鍵盤をなぞる」操作に対応
      if (activePointerId === null || ev.pointerId !== activePointerId) return;

      const key = findKeyFromEvent(ev);
      if (!key) return;

      if (key !== activeKeyEl) {
        // 別キーに移動したら押し替え
        releaseActiveKeyOnly();
        pressKey(key);
        startToneForKey(key);
      }
      ev.preventDefault();
    });

    const end = (ev) => {
      if (activePointerId === null || ev.pointerId !== activePointerId) return;

      try { rootEl.releasePointerCapture(ev.pointerId); } catch (_) {}
      activePointerId = null;

      releaseActiveKeyOnly();
      ToneEngine.noteOff();
      DisplayUI.setPlaying(null);

      ev.preventDefault();
    };

    rootEl.addEventListener('pointerup', end);
    rootEl.addEventListener('pointercancel', end);
    rootEl.addEventListener('pointerleave', (ev) => {
      // pointerleaveは環境により出ないので、保険程度
      if (activePointerId === null) return;
      if (ev.pointerId !== activePointerId) return;
      end(ev);
    });
  }

  function startToneForKey(keyEl) {
    const midi = Number(keyEl.dataset.midi);
    const noteText = keyEl.dataset.note;

    // 鍵盤発音は「チューナーのA4設定」に合わせる（統一感）
    const a4 = getA4();

    ToneEngine.noteOn({ midiNote: midi, a4 });
    DisplayUI.setPlaying(noteText);
  }

  function pressKey(keyEl) {
    activeKeyEl = keyEl;
    keyEl.classList.add('is-down');
  }

  function releaseActiveKeyOnly() {
    if (!activeKeyEl) return;
    activeKeyEl.classList.remove('is-down');
    activeKeyEl = null;
  }

  function findKeyFromEvent(ev) {
    // 黒鍵が白鍵の上にあるので、elementFromPointで拾うのが確実
    const el = document.elementFromPoint(ev.clientX, ev.clientY);
    if (!el) return null;
    const key = el.classList?.contains('key') ? el : el.closest?.('.key');
    if (!key || !rootEl.contains(key)) return null;
    return key;
  }

  function isWhite(midi) {
    const pc = ((midi % 12) + 12) % 12;
    return WHITE_PCS.has(pc);
  }

  function findPrevWhite(midi) {
    for (let m = midi - 1; m >= START_MIDI; m--) {
      if (isWhite(m)) return m;
    }
    return START_MIDI;
  }

  function midiToNoteText(midiInt) {
    const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    const noteIndex = ((midiInt % 12) + 12) % 12;
    const octave = Math.floor(midiInt / 12) - 1;
    return `${names[noteIndex]}${octave}`;
  }

  return { init };
})();

/* ------------------------------------------------------------
 * アプリ本体（既存の解析更新 20〜30Hz / 描画 60fps を維持）
 * ------------------------------------------------------------ */
(() => {
  const btnStart = document.getElementById('btnStart');
  const btnStop = document.getElementById('btnStop');
  const a4Select = document.getElementById('a4Select');

  // 追加UI（発音側）
  const sourceSelect = document.getElementById('sourceSelect');
  const waveSelect = document.getElementById('waveSelect');
  const toneVol = document.getElementById('toneVol');

  const state = {
    hz: null,
    noteName: null,
    octave: null,
    cents: null,
    rms: 0,
    confidence: 0,
    a4: 440,
    ts: Date.now()
  };

  // ---- チューナー挙動の調整ポイント（既存）----
  const GATE_DB = -50;
  const MIN_CONFIDENCE = 0.55;
  const ANALYSIS_HZ = 25;
  const SMOOTH_ALPHA = 0.18;

  TunerUI.init();
  DisplayUI.init();
  TunerUI.setStatus('idle', 'Idle');
  DisplayUI.setPlaying(null);

  // 鍵盤初期化（A4取得を注入して統一）
  KeyboardUI.init({
    keyboardElementId: 'keyboard',
    getA4Fn: () => state.a4
  });

  // 発音エンジン初期設定
  ToneEngine.setMode(sourceSelect.value);
  ToneEngine.setWaveform(waveSelect.value);
  ToneEngine.setVolume(toneVol.value);

  // 将来サンプルをロードする場合：
  // ToneEngine.loadSamples([{name:'C4', url:'samples/C4.wav'}, ...]);
  // ※今回は追加ファイル禁止なので、ダミーだけ用意しています。

  // 発音UIイベント
  sourceSelect.addEventListener('change', () => {
    ToneEngine.setMode(sourceSelect.value);
    // Sampleモードでは波形は意味が薄いので、見た目だけでも無効化
    const isSample = sourceSelect.value === 'sample';
    waveSelect.disabled = isSample;
  });

  waveSelect.addEventListener('change', () => {
    ToneEngine.setWaveform(waveSelect.value);
  });

  toneVol.addEventListener('input', () => {
    ToneEngine.setVolume(toneVol.value);
  });

  let analysisTimer = null;
  let smoothedMidi = null;

  function rafLoop() {
    TunerUI.render(state);
    requestAnimationFrame(rafLoop);
  }
  requestAnimationFrame(rafLoop);

  btnStart.addEventListener('click', async () => {
    try {
      btnStart.disabled = true;
      TunerUI.setStatus('idle', 'Requesting mic...');

      await AudioInput.start({ fftSize: AudioInput.DEFAULT_FFT_SIZE });
      TunerUI.setStatus('running', 'Running');

      btnStop.disabled = false;
      startAnalysisLoop();
    } catch (err) {
      console.error(err);
      TunerUI.setStatus('error', 'Mic error');
      btnStart.disabled = false;
      btnStop.disabled = true;
      stopAnalysisLoop();
    }
  });

  btnStop.addEventListener('click', () => {
    stopAnalysisLoop();
    AudioInput.stop();

    // 発音も止める（停止ボタンでまとめて止まる方が安全）
    ToneEngine.noteOff();
    DisplayUI.setPlaying(null);

    btnStart.disabled = false;
    btnStop.disabled = true;
    TunerUI.setStatus('idle', 'Idle');

    state.hz = null;
    state.noteName = null;
    state.octave = null;
    state.cents = null;
    state.confidence = 0;
    state.rms = 0;
    state.ts = Date.now();
    smoothedMidi = null;
  });

  a4Select.addEventListener('change', () => {
    const v = Number(a4Select.value);
    state.a4 = (v === 442) ? 442 : 440;
  });

  function startAnalysisLoop() {
    stopAnalysisLoop();

    const intervalMs = Math.round(1000 / ANALYSIS_HZ);
    analysisTimer = setInterval(() => {
      if (!AudioInput.isRunning()) return;

      const pcm = AudioInput.getPCM();
      const sr = AudioInput.getSampleRate();
      if (!pcm || !sr) return;

      const rms = calcRms(pcm);
      state.rms = rms;

      const db = rmsToDb(rms);
      const gateOn = db < GATE_DB;

      const { hz, confidence } = PitchDetector.detectPitch(pcm, sr, {
        minHz: 50,
        maxHz: 1000,
        threshold: 0.15
      });

      state.confidence = confidence;

      if (gateOn || !hz || confidence < MIN_CONFIDENCE) {
        state.hz = null;
        state.noteName = null;
        state.octave = null;
        state.cents = null;
        state.ts = Date.now();

        ShareAdapter.publish(state);
        return;
      }

      const rawMidi = hzToMidiFloat(hz, state.a4);

      if (smoothedMidi == null) {
        smoothedMidi = rawMidi;
      } else {
        const alpha = clamp(SMOOTH_ALPHA * (0.6 + 0.4 * confidence), 0.05, 0.35);
        smoothedMidi = lerp(smoothedMidi, rawMidi, alpha);
      }

      const midiRounded = Math.round(smoothedMidi);
      const cents = (smoothedMidi - midiRounded) * 100;
      const { noteName, octave } = midiToNoteName(midiRounded);
      const hzShown = midiFloatToHz(smoothedMidi, state.a4);

      state.hz = hzShown;
      state.noteName = noteName;
      state.octave = octave;
      state.cents = cents;
      state.ts = Date.now();

      ShareAdapter.publish(state);
    }, intervalMs);
  }

  function stopAnalysisLoop() {
    if (analysisTimer) clearInterval(analysisTimer);
    analysisTimer = null;
  }

  // ----------------- ユーティリティ -----------------
  function calcRms(buf) {
    let sum = 0;
    for (let i = 0; i < buf.length; i++) {
      const x = buf[i];
      sum += x * x;
    }
    return Math.sqrt(sum / buf.length);
  }

  function rmsToDb(rms) {
    if (rms <= 0) return -Infinity;
    return 20 * Math.log10(rms);
  }

  function hzToMidiFloat(hz, a4) {
    return 69 + 12 * (Math.log(hz / a4) / Math.log(2));
  }

  function midiFloatToHz(midiFloat, a4) {
    return a4 * Math.pow(2, (midiFloat - 69) / 12);
  }

  function midiToNoteName(midiInt) {
    const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    const noteIndex = ((midiInt % 12) + 12) % 12;
    const octave = Math.floor(midiInt / 12) - 1;
    return { noteName: names[noteIndex], octave };
  }

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  function clamp(v, a, b) {
    return Math.max(a, Math.min(b, v));
  }
})();
