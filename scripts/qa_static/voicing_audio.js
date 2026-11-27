// Shared triangle-wave synthesis for Harmony playback and isolated guitar auditions.
(function (root) {
  "use strict";
  const OPEN_MIDI = [40, 45, 50, 55, 59, 64];
  let context = null, master = null, auditionVoices = [], request = 0;

  function supported() { return Boolean(root.AudioContext || root.webkitAudioContext); }
  function voicingMidis(voicing) {
    const values = String(voicing).split(",").map((v) => v.trim());
    if (values.length !== 6 || values.some((v) => !/^(x|\d{1,2})$/i.test(v) || (!/^x$/i.test(v) && Number(v) > 24))) return [];
    return values.flatMap((v, i) => /^x$/i.test(v) ? [] : [OPEN_MIDI[i] + Number(v)]);
  }
  function playMidis(ctx, destination, midis, duration, onEnded = () => {}) {
    if (!midis?.length || !(duration > 0)) return [];
    const now = ctx.currentTime, peak = 0.9 / Math.sqrt(midis.length);
    return midis.map((midi) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = "triangle";
      o.frequency.value = 440 * Math.pow(2, (midi - 69) / 12);
      g.gain.value = 0;
      o.connect(g);
      g.connect(destination);
      const attack = Math.min(0.015, duration * 0.25), release = Math.min(0.25, duration * 0.5);
      g.gain.setValueAtTime(0, now);
      g.gain.linearRampToValueAtTime(peak, now + attack);
      g.gain.setValueAtTime(peak, now + Math.max(attack, duration - release));
      g.gain.linearRampToValueAtTime(0.0001, now + duration);
      const voice = { o, g, stopped: false, released: false };
      o.onended = () => {
        voice.stopped = true;
        o.disconnect?.();
        g.disconnect?.();
        onEnded(voice);
      };
      o.start(now);
      o.stop(now + duration + 0.05);
      return voice;
    });
  }
  function silenceAudition() {
    const now = context.currentTime;
    auditionVoices.forEach(({ o, g, stopped }) => {
      if (stopped) return;
      g.gain.cancelScheduledValues(now);
      g.gain.setValueAtTime(0.0001, now);
      try { o.stop(now + 0.02); } catch (_) { /* already stopped */ }
    });
    auditionVoices = [];
  }
  async function playVoicing(voicing) {
    const midis = voicingMidis(voicing), token = ++request;
    if (!supported() || !midis.length) return false;
    try {
      if (!context || context.state === "closed") {
        context = new (root.AudioContext || root.webkitAudioContext)();
        master = context.createGain();
        master.gain.value = 0.15;
        master.connect(context.destination);
      }
      if (context.state === "suspended") await context.resume();
      if (token !== request) return false;
      silenceAudition();
      auditionVoices = playMidis(context, master, midis, 1.2, (voice) => {
        auditionVoices = auditionVoices.filter((v) => v !== voice);
      });
      return true;
    } catch (_) { return false; }
  }
  const api = { supported, voicingMidis, playMidis, playVoicing };
  root.VoicingAudio = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
