let audio: AudioContext | null = null;

export function unlockAudio(): void {
  if (typeof window === "undefined") return;
  const Ctx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) return;
  if (!audio) audio = new Ctx();
  void audio.resume().catch(() => undefined);
}

export function playAlarm(): void {
  if (!audio) return;
  const start = audio.currentTime;
  tone(start, 740, 0.12);
  tone(start + 0.16, 620, 0.2);
}

export function playOk(): void {
  if (!audio) return;
  tone(audio.currentTime, 520, 0.1);
}

export function buzzAlert(): void {
  if (typeof navigator === "undefined" || !navigator.vibrate) return;
  navigator.vibrate([200, 90, 200, 90, 360]);
}

function tone(at: number, frequency: number, duration: number): void {
  if (!audio) return;
  const oscillator = audio.createOscillator();
  const gain = audio.createGain();
  oscillator.type = "sine";
  oscillator.frequency.value = frequency;
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(0.05, at + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + duration);
  oscillator.connect(gain);
  gain.connect(audio.destination);
  oscillator.start(at);
  oscillator.stop(at + duration + 0.02);
}
