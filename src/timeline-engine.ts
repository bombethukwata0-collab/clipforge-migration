export type MotionEasing = 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out';
export type MotionKeyframe = { id: string; at: number; scale: number; x: number; y: number; opacity: number; rotation: number; easing: MotionEasing };
export type ClipMotion = { scale: number; x: number; y: number; opacity: number; rotation: number };
export type MotionClip = { startSeconds: number; endSeconds: number; zoomStart?: number; zoomEnd?: number; keyframes?: MotionKeyframe[] };
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));
const makeId = () => typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : 'kf-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
export function getMotionKeyframes(clip: MotionClip): MotionKeyframe[] {
  const valid = Array.isArray(clip.keyframes) ? clip.keyframes.filter(frame => frame && typeof frame.id === 'string' && Number.isFinite(frame.at)).map(frame => ({
    id: frame.id, at: clamp(frame.at, 0, 1), scale: clamp(frame.scale, 1, 3), x: clamp(frame.x, -0.5, 0.5),
    y: clamp(frame.y, -0.5, 0.5), opacity: clamp(frame.opacity, 0, 1), rotation: clamp(frame.rotation, -180, 180),
    easing: (['linear', 'ease-in', 'ease-out', 'ease-in-out'].includes(frame.easing) ? frame.easing : 'linear') as MotionEasing,
  })).sort((a, b) => a.at - b.at) : [];
  if (valid.length >= 2) return valid;
  return [
    { id: 'start-' + clip.startSeconds, at: 0, scale: clamp(clip.zoomStart ?? 1, 1, 3), x: 0, y: 0, opacity: 1, rotation: 0, easing: 'ease-in-out' },
    { id: 'end-' + clip.startSeconds, at: 1, scale: clamp(clip.zoomEnd ?? 1, 1, 3), x: 0, y: 0, opacity: 1, rotation: 0, easing: 'linear' },
  ];
}
function easeProgress(value: number, easing: MotionEasing) {
  const t = clamp(value, 0, 1);
  if (easing === 'ease-in') return t * t;
  if (easing === 'ease-out') return 1 - (1 - t) * (1 - t);
  if (easing === 'ease-in-out') return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
  return t;
}
export function getClipMotion(clip: MotionClip, timeSeconds: number): ClipMotion {
  const frames = getMotionKeyframes(clip);
  const progress = clamp((timeSeconds - clip.startSeconds) / Math.max(0.01, clip.endSeconds - clip.startSeconds), 0, 1);
  let left = frames[0];
  let right = frames[frames.length - 1];
  for (let index = 0; index < frames.length - 1; index += 1) {
    if (progress >= frames[index].at && progress <= frames[index + 1].at) { left = frames[index]; right = frames[index + 1]; break; }
  }
  const t = easeProgress((progress - left.at) / Math.max(0.0001, right.at - left.at), left.easing);
  return {
    scale: left.scale + (right.scale - left.scale) * t, x: left.x + (right.x - left.x) * t,
    y: left.y + (right.y - left.y) * t, opacity: left.opacity + (right.opacity - left.opacity) * t,
    rotation: left.rotation + (right.rotation - left.rotation) * t,
  };
}
export function createMotionKeyframe(clip: MotionClip, timeSeconds: number): MotionKeyframe {
  const at = clamp((timeSeconds - clip.startSeconds) / Math.max(0.01, clip.endSeconds - clip.startSeconds), 0, 1);
  return { id: makeId(), at, ...getClipMotion(clip, timeSeconds), easing: 'ease-in-out' };
}
