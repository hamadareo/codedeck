/**
 * A short chime made with Web Audio (no sound files): rising for "finished",
 * two even notes for "needs approval". Quiet, and at most one per moment.
 */
export type ChimeKind = 'done' | 'approval';

const NOTES: Record<ChimeKind, number[]> = { done: [660, 880], approval: [880, 880] };
let ctx: AudioContext | null = null;
let last = 0;

export function playChime(kind: ChimeKind): void {
  const now = Date.now();
  if (now - last < 1500) return;
  last = now;
  try {
    ctx ??= new AudioContext();
    const t0 = ctx.currentTime;
    NOTES[kind].forEach((freq, i) => {
      const osc = ctx!.createOscillator();
      const gain = ctx!.createGain();
      const start = t0 + i * 0.16;
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.12, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.3);
      osc.connect(gain).connect(ctx!.destination);
      osc.start(start);
      osc.stop(start + 0.32);
    });
  } catch {
    // No audio device: the notification itself still shows.
  }
}
