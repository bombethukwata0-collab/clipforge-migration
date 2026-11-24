import { api, auth } from './netlify-client';
import { useEffect, useMemo, useRef, useState } from 'react';
import './link-import.css';
import './captions.css';
import './workspace.css';
import { createMotionKeyframe, getClipMotion, getMotionKeyframes, type ClipMotion, type MotionKeyframe } from './timeline-engine';
import { estimateMotionTimeline, smoothSubjectPath, type MotionEstimate } from './motion-analysis';
import {
  Activity,
  ArrowDownToLine,
  AudioWaveform,
  Check,
  ChevronRight,
  CircleHelp,
  Clapperboard,
  BookOpen,
  Clock3,
  Film,
  FolderOpen,
  LoaderCircle,
  Plus,
  Play,
  Save,
  Scissors,
  Sparkles,
  Trash2,
  Undo2,
  Redo2,
  Upload,
  WandSparkles,
  X,
} from 'lucide-react';

type User = { userId: string; email?: string; name?: string };
type DeferredInstallPrompt = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform?: string }>;
};
type Clip = {
  startSeconds: number;
  endSeconds: number;
  reason?: string;
  score?: number;
  timestampSeconds?: number;
  momentType?: 'action' | 'reaction' | 'visual' | 'other';
  momentLabel?: string;
  storyPurpose?: string;
  eventPhase?: 'setup' | 'action' | 'outcome' | 'reaction' | 'standalone';
  sequenceEvidence?: string;
  eventConfidence?: number;
  actionLabel?: string;
  subjectTrack?: string;
  visualEvidenceConfidence?: number;
  motionSummary?: string;
  eventGroupLabel?: string;
  eventStartSeconds?: number;
  eventEndSeconds?: number;
  scriptBeatIndex?: number;
  scriptBeat?: string;
  matchConfidence?: number;
  volume?: number;
  zoomStart?: number;
  zoomEnd?: number;
  keyframes?: MotionKeyframe[];
};
type Caption = { id: string; startSeconds: number; endSeconds: number; text: string };
type EditSnapshot = { clips: Clip[]; captions: Caption[] };
type EditHistory = { scopeKey: string; current: EditSnapshot | null; past: EditSnapshot[]; future: EditSnapshot[]; suppressNext: boolean };
type EditingMode = 'manual' | 'automatic' | 'hybrid';
type EditorSection = 'highlights' | 'guided' | 'manual' | 'captions' | 'tools';
type MotionSample = MotionEstimate;
type CaptionStyle = { fontSize: string; color: string; background: 'dark' | 'none' };
type ProjectSettings = {
  editInstructions: string; editScript: string; editingMode: EditingMode;
  captionAnimation: 'none' | 'fade' | 'pop'; exportQuality: 'compact' | 'standard' | 'high';
  exportAspect: 'original' | '9:16' | '1:1' | '16:9'; exportResolution: '720' | '1080';
  crossfadeDuration: string; exportVolume: number; audioCleanup: number;
  exportFormat?: 'auto' | 'mp4' | 'webm'; sourceAudioEnabled?: boolean;
  clipLengthMode: 'ai' | 'fixed'; customClipLength: string;
  reframeEnabled: boolean; reframeX: number; reframeY: number;
};
type Project = { id: string; title: string; clips: Clip[]; captions?: Caption[]; captionStyle?: CaptionStyle; settings?: ProjectSettings; updatedAt: string };
type ProjectVersion = {
  id: string; name: string; savedAt: string; clips: Clip[]; captions: Caption[];
  captionFontSize: string; captionColor: string; captionBackground: 'dark' | 'none';
  captionAnimation: 'none' | 'fade' | 'pop';
  exportQuality: 'compact' | 'standard' | 'high';
  exportAspect: 'original' | '9:16' | '1:1' | '16:9';
  exportResolution: '720' | '1080'; crossfadeDuration: string; exportVolume: number;
  audioCleanup: number; editInstructions: string; editScript: string;
  exportFormat?: 'auto' | 'mp4' | 'webm'; sourceAudioEnabled?: boolean;
  editingMode?: EditingMode;
  clipLengthMode: 'ai' | 'fixed'; customClipLength: string;
  reframeEnabled: boolean; reframeX: number; reframeY: number;
};

function createCanvasCapture(canvas: HTMLCanvasElement) {
  const manualStream = canvas.captureStream(0);
  const manualTrack = manualStream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack | undefined;
  if (manualTrack && typeof manualTrack.requestFrame === 'function') {
    return {
      stream: manualStream,
      requestFrame: () => manualTrack.requestFrame(),
    };
  }
  manualStream.getTracks().forEach(track => track.stop());
  return {
    stream: canvas.captureStream(30),
    requestFrame: () => undefined,
  };
}

function getExportMimeCandidates(format: 'auto' | 'mp4' | 'webm' = 'auto') {
  const mp4 = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4;codecs=avc1.42E01E', 'video/mp4'];
  const webm = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
  return format === 'mp4' ? mp4 : format === 'webm' ? webm : [...mp4, ...webm];
}
function getSupportedExportMimeType(format: 'auto' | 'mp4' | 'webm' = 'auto') {
  if (typeof MediaRecorder === 'undefined') return '';
  return getExportMimeCandidates(format).find(type => MediaRecorder.isTypeSupported(type)) || '';
}
function createExportRecorder(stream: MediaStream, format: 'auto' | 'mp4' | 'webm', videoBitrate: number) {
  if (typeof MediaRecorder === 'undefined') throw new Error('This browser does not support in-browser video export.');
  let lastError: unknown;
  for (const mimeType of getExportMimeCandidates(format)) {
    if (!MediaRecorder.isTypeSupported(mimeType)) continue;
    try {
      const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: videoBitrate, audioBitsPerSecond: 192_000 });
      return { recorder, mimeType: recorder.mimeType || mimeType };
    } catch (error) { lastError = error; }
  }
  throw new Error(lastError instanceof Error
    ? 'The browser reported an export codec but could not start it. Choose Auto or another format, then try again.'
    : 'No compatible MP4 or WebM encoder is available in this browser.');
}

function getExportFileExtension(mimeType: string) {
  return mimeType.toLowerCase().startsWith('video/mp4') ? 'mp4' : 'webm';
}



function getExportDimensions(
  sourceWidth: number,
  sourceHeight: number,
  aspect: 'original' | '9:16' | '1:1' | '16:9',
  resolution: '720' | '1080'
) {
  if (aspect === 'original') {
    const scale = Math.min(1, (resolution === '1080' ? 1920 : 1280) / Math.max(sourceWidth, sourceHeight));
    return {
      width: Math.max(2, Math.round(sourceWidth * scale / 2) * 2),
      height: Math.max(2, Math.round(sourceHeight * scale / 2) * 2),
    };
  }
  const longEdge = resolution === '1080' ? 1920 : 1280;
  const shortEdge = Math.round(longEdge * (aspect === '9:16' || aspect === '16:9' ? 9 / 16 : 1));
  if (aspect === '9:16') return { width: shortEdge, height: longEdge };
  if (aspect === '16:9') return { width: longEdge, height: shortEdge };
  return { width: longEdge, height: longEdge };
}

function fitCaptionLines(
  context: CanvasRenderingContext2D,
  text: string,
  baseFontSize: number,
  fontFamily: string,
  maxWidth: number,
  maxLines = 3
) {
  let fontSize = baseFontSize;
  let lines: string[] = [];
  const layout = () => {
    context.font = '700 ' + fontSize + 'px ' + fontFamily;
    lines = [];
    let line = '';
    for (const word of text.split(/\s+/).filter(Boolean)) {
      const candidate = line ? line + ' ' + word : word;
      if (line && context.measureText(candidate).width > maxWidth) {
        lines.push(line);
        line = word;
      } else {
        line = candidate;
      }
    }
    if (line) lines.push(line);
  };
  layout();
  while (lines.length > maxLines && fontSize > Math.max(16, baseFontSize * 0.62)) {
    fontSize = Math.max(16, fontSize - 2);
    layout();
  }
  if (lines.length > maxLines) {
    lines = lines.slice(0, maxLines);
    let last = lines[maxLines - 1];
    while (last.length > 1 && context.measureText(last + '…').width > maxWidth) {
      last = last.slice(0, -1);
    }
    lines[maxLines - 1] = last + '…';
  }
  return { fontSize, lines };
}

function drawCoverFrame(
  context: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  width: number,
  height: number,
  focusX = 0.5,
  focusY = 0.5,
  motion: ClipMotion = { scale: 1, x: 0, y: 0, opacity: 1, rotation: 0 }
) {
  const sourceRatio = video.videoWidth / video.videoHeight;
  const targetRatio = width / height;
  let sx = 0;
  let sy = 0;
  let sw = video.videoWidth;
  let sh = video.videoHeight;
  const safeX = Math.max(0, Math.min(1, focusX));
  const safeY = Math.max(0, Math.min(1, focusY));
  if (sourceRatio > targetRatio) {
    sw = video.videoHeight * targetRatio;
    sx = Math.max(0, Math.min(video.videoWidth - sw, safeX * video.videoWidth - sw / 2));
  } else if (sourceRatio < targetRatio) {
    sh = video.videoWidth / targetRatio;
    sy = Math.max(0, Math.min(video.videoHeight - sh, safeY * video.videoHeight - sh / 2));
  }
  const safeScale = Math.max(1, Math.min(3, motion.scale));
  context.save();
  context.globalAlpha *= Math.max(0, Math.min(1, motion.opacity));
  context.translate(width / 2 + motion.x * width, height / 2 + motion.y * height);
  context.rotate(motion.rotation * Math.PI / 180);
  context.scale(safeScale, safeScale);
  context.drawImage(video, sx, sy, sw, sh, -width / 2, -height / 2, width, height);
  context.restore();
}

function encodeWavChunk(buffer: AudioBuffer, startSeconds: number, endSeconds: number) {
  const outputRate = 16000;
  const sourceStart = Math.floor(startSeconds * buffer.sampleRate);
  const sampleCount = Math.max(0, Math.floor((endSeconds - startSeconds) * outputRate));
  const wav = new ArrayBuffer(44 + sampleCount * 2);
  const view = new DataView(wav);
  const writeText = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i += 1) view.setUint8(offset + i, value.charCodeAt(i));
  };
  writeText(0, 'RIFF');
  view.setUint32(4, 36 + sampleCount * 2, true);
  writeText(8, 'WAVE');
  writeText(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, outputRate, true);
  view.setUint32(28, outputRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeText(36, 'data');
  view.setUint32(40, sampleCount * 2, true);
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, channel) => buffer.getChannelData(channel));
  const step = buffer.sampleRate / outputRate;
  for (let i = 0; i < sampleCount; i += 1) {
    const sourceIndex = Math.min(buffer.length - 1, sourceStart + Math.floor(i * step));
    let sample = 0;
    for (const channel of channels) sample += channel[sourceIndex] || 0;
    sample /= Math.max(1, channels.length);
    const clipped = Math.max(-1, Math.min(1, sample));
    view.setInt16(44 + i * 2, clipped < 0 ? clipped * 0x8000 : clipped * 0x7fff, true);
  }
  const bytes = new Uint8Array(wav);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

const fmt = (seconds: number) => {
  if (!Number.isFinite(seconds)) return '0:00';
  const safe = Math.max(0, Math.floor(seconds));
  return Math.floor(safe / 60) + ':' + String(safe % 60).padStart(2, '0');
};

function getScriptBeats(script: string) {
  const lines = script.replace(/\r/g, '').split('\n')
    .map(line => line
      .replace(/^\s*(?:(?:[-*•])|(?:\d{1,2}[.)]))\s*/, '')
      .replace(/^\s*(?:\[?\d{1,2}:\d{2}(?::\d{2})?\]?\s*[-–—:]\s*)/, '')
      .trim())
    .filter(Boolean);
  const sourceBeats = lines.length > 1
    ? lines
    : script.trim().split(/(?<=[.!?])\s+/).map(beat => beat.trim()).filter(Boolean);
  const bounded: string[] = [];
  for (const source of sourceBeats) {
    const sentences = source.match(/[^.!?]+[.!?]?/g) || [source];
    for (const sentence of sentences) {
      const words = sentence.trim().split(/\s+/).filter(Boolean);
      let chunk = '';
      for (const word of words) {
        const next = chunk ? chunk + ' ' + word : word;
        if (next.length > 350 && chunk) {
          bounded.push(chunk);
          chunk = word;
        } else {
          chunk = next;
        }
      }
      if (chunk) bounded.push(chunk);
    }
  }
  return bounded.slice(0, 12);
}

function getBriefChecklist(instructions: string) {
  const text = instructions.toLowerCase();
  return [
    { label: 'Goal', done: /goal|make|create|turn|edit|video about|purpose/.test(text) },
    { label: 'Platform', done: /tiktok|shorts|reels|youtube|instagram|vertical|landscape/.test(text) },
    { label: 'Style', done: /mood|tone|cinematic|energetic|calm|funny|dramatic|documentary/.test(text) },
    { label: 'Priorities', done: /prioriti|must.include|focus on|highlight|keep|feature/.test(text) },
    { label: 'Avoid', done: /avoid|exclude|must.not|don't|do not|no filler|remove/.test(text) },
  ];
}

function sortSuggestionsForStory(items: Clip[]) {
  return [...items].sort((a, b) => {
    const aBeat = Number.isInteger(a.scriptBeatIndex) ? a.scriptBeatIndex! : Number.MAX_SAFE_INTEGER;
    const bBeat = Number.isInteger(b.scriptBeatIndex) ? b.scriptBeatIndex! : Number.MAX_SAFE_INTEGER;
    return aBeat - bBeat || (a.timestampSeconds ?? a.startSeconds) - (b.timestampSeconds ?? a.startSeconds);
  });
}

type StoryRole = 'hook' | 'context' | 'action' | 'payoff' | 'reaction';

function getStoryRole(clip: Clip): StoryRole {
  if (clip.eventPhase === 'setup') return 'context';
  if (clip.eventPhase === 'action') return 'action';
  if (clip.eventPhase === 'outcome') return 'payoff';
  if (clip.eventPhase === 'reaction') return 'reaction';
  return 'hook';
}

function assembleStorySuggestions(items: Clip[], preserveScriptOrder = false) {
  const groups: Array<{ key: string; clips: Clip[] }> = [];
  for (const item of items) {
    const label = item.eventGroupLabel?.trim().toLowerCase();
    const eventStart = item.eventStartSeconds ?? item.startSeconds;
    const eventEnd = item.eventEndSeconds ?? item.endSeconds;
    const existing = label
      ? groups.find(group => group.key === label && group.clips.some(member => {
          if (item.scriptBeatIndex !== undefined && member.scriptBeatIndex !== undefined &&
              item.scriptBeatIndex !== member.scriptBeatIndex) return false;
          const itemSubject = item.subjectTrack?.trim().toLowerCase();
          const memberSubject = member.subjectTrack?.trim().toLowerCase();
          if (itemSubject && memberSubject && itemSubject !== memberSubject) return false;
          const memberStart = member.eventStartSeconds ?? member.startSeconds;
          const memberEnd = member.eventEndSeconds ?? member.endSeconds;
          return eventStart <= memberEnd + 8 && eventEnd >= memberStart - 8;
        }))
      : undefined;
    if (existing) existing.clips.push(item);
    else groups.push({ key: label || 'moment-' + groups.length, clips: [item] });
  }

  const assembled = groups.map(group => {
    const best = [...group.clips].sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0];
    const start = Math.min(...group.clips.map(item => item.eventStartSeconds ?? item.startSeconds));
    const end = Math.max(...group.clips.map(item => item.eventEndSeconds ?? item.endSeconds));
    const boundedStart = Math.max(0, Math.min(start, best.timestampSeconds ?? best.startSeconds));
    const boundedEnd = Math.max(boundedStart + 1, Math.max(end, best.timestampSeconds ?? best.endSeconds));
    const safeStart = boundedEnd - boundedStart > 45
      ? Math.max(0, Math.min(best.timestampSeconds ?? best.startSeconds, boundedEnd) - 22.5)
      : boundedStart;
    const safeEnd = Math.min(boundedEnd, safeStart + 45);
    const phases = (['setup', 'action', 'outcome', 'reaction'] as const)
      .filter(phase => group.clips.some(item => item.eventPhase === phase));
    const role = getStoryRole(best);
    const roleLabel: Record<StoryRole, string> = {
      hook: 'Hook',
      context: 'Context',
      action: 'Main action',
      payoff: 'Payoff',
      reaction: 'Reaction',
    };
    return {
      ...best,
      startSeconds: Number(safeStart.toFixed(2)),
      endSeconds: Number(Math.max(safeStart + 1, safeEnd).toFixed(2)),
      storyPurpose: roleLabel[role] + (phases.length > 1 ? ' · ' + phases.join(' → ') : ''),
      ...(group.clips.length > 1 ? { eventGroupLabel: best.eventGroupLabel || 'Related event' } : {}),
    };
  });

  if (preserveScriptOrder) return sortSuggestionsForStory(assembled);
  const roleOrder: Record<StoryRole, number> = { hook: 0, context: 1, action: 2, payoff: 3, reaction: 4 };
  return assembled.sort((a, b) =>
    roleOrder[getStoryRole(a)] - roleOrder[getStoryRole(b)] ||
    (b.score ?? 0) - (a.score ?? 0) ||
    (a.timestampSeconds ?? a.startSeconds) - (b.timestampSeconds ?? b.startSeconds)
  );
}

function App() {
  const [user, setUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authEmail, setAuthEmail] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [authMode, setAuthMode] = useState<'login' | 'signup' | 'forgot' | 'recovery'>('login');
  const [authNotice, setAuthNotice] = useState('');
  const [authBusy, setAuthBusy] = useState(false);
  const [recoveryPending, setRecoveryPending] = useState(false);
  const [installPrompt, setInstallPrompt] = useState<DeferredInstallPrompt | null>(null);
  const [appInstalled, setAppInstalled] = useState(false);
  const [updateRegistration, setUpdateRegistration] = useState<ServiceWorkerRegistration | null>(null);
  const [updateReady, setUpdateReady] = useState(false);
  const updateReloadRef = useRef(false);
  const [busy, setBusy] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [videoUrl, setVideoUrl] = useState('');
  const [videoLinkInput, setVideoLinkInput] = useState('');
  const [sourceLabel, setSourceLabel] = useState('');
  const [isRemoteSource, setIsRemoteSource] = useState(false);
  const [duration, setDuration] = useState(0);
  const [clips, setClips] = useState<Clip[]>([]);
  const [startInput, setStartInput] = useState('0');
  const [endInput, setEndInput] = useState('5');
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [deletingProjectId, setDeletingProjectId] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<Clip[]>([]);
  const [analysisProgress, setAnalysisProgress] = useState(0);
  const [analysisMessage, setAnalysisMessage] = useState('');
  const [editInstructions, setEditInstructions] = useState('');
  const [editScript, setEditScript] = useState('');
  const [editingMode, setEditingMode] = useState<EditingMode>('hybrid');
  const [voicePreviewing, setVoicePreviewing] = useState(false);
  const [clipLengthMode, setClipLengthMode] = useState<'ai' | 'fixed'>('ai');
  const [customClipLength, setCustomClipLength] = useState('15');
  const [exportQuality, setExportQuality] = useState<'compact' | 'standard' | 'high'>('standard');
  const [exportAspect, setExportAspect] = useState<'original' | '9:16' | '1:1' | '16:9'>('original');
  const [exportResolution, setExportResolution] = useState<'720' | '1080'>('1080');
  const [crossfadeDuration, setCrossfadeDuration] = useState('0.8');
  const [exportVolume, setExportVolume] = useState(100);
  const [captions, setCaptions] = useState<Caption[]>([]);
  const [transcribeProgress, setTranscribeProgress] = useState(0);
  const [captionFontSize, setCaptionFontSize] = useState('34');
  const [captionColor, setCaptionColor] = useState('#ffffff');
  const [captionBackground, setCaptionBackground] = useState<'dark' | 'none'>('dark');
  const [captionAnimation, setCaptionAnimation] = useState<'none' | 'fade' | 'pop'>('fade');
  const [reframeEnabled, setReframeEnabled] = useState(false);
  const [reframeX, setReframeX] = useState(0.5);
  const [reframeY, setReframeY] = useState(0.5);
  const [reframeStatus, setReframeStatus] = useState('');
  const [beatPoints, setBeatPoints] = useState<number[]>([]);
  const [beatStatus, setBeatStatus] = useState('');
  const [editingPreset, setEditingPreset] = useState<'tiktok' | 'youtube-shorts' | 'instagram-reels'>('tiktok');
  const [audioCleanup, setAudioCleanup] = useState(0);
  const [exportFormat, setExportFormat] = useState<'auto' | 'mp4' | 'webm'>('auto');
  const [sourceAudioEnabled, setSourceAudioEnabled] = useState(true);
  const [timelineScale, setTimelineScale] = useState(8);
  const [exportProgress, setExportProgress] = useState<{ label: string; percent: number } | null>(null);
  const timelineDragRef = useRef<{ kind: 'clip' | 'caption'; mode: 'move' | 'trim-start' | 'trim-end'; index: number; startX: number; laneWidth: number; start: number; end: number } | null>(null);
  const [brandLogoData, setBrandLogoData] = useState('');
  const [brandPrimaryColor, setBrandPrimaryColor] = useState('#a7f36b');
  const [brandSecondaryColor, setBrandSecondaryColor] = useState('#10150d');
  const [brandFontFamily, setBrandFontFamily] = useState('Arial, sans-serif');
  const [brandKitReady, setBrandKitReady] = useState(false);
  const [projectVersions, setProjectVersions] = useState<ProjectVersion[]>([]);
  const [versionName, setVersionName] = useState('');
  const [playbackTime, setPlaybackTime] = useState(0);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const [previewEnd, setPreviewEnd] = useState<number | null>(null);
  const [activeTab, setActiveTab] = useState<'editor' | 'projects' | 'help'>('editor');
  const [editingWorkspace, setEditingWorkspace] = useState<'manual' | 'ai'>('ai');
  const [editorSection, setEditorSection] = useState<EditorSection>('highlights');
  const [recoveryNotice, setRecoveryNotice] = useState(false);
  const [recoveryReady, setRecoveryReady] = useState(false);
  const [historyAvailability, setHistoryAvailability] = useState({ canUndo: false, canRedo: false });
  const [exportSettingsReady, setExportSettingsReady] = useState(false);
  const exportSettingsOwner = useRef<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const brandLogoInputRef = useRef<HTMLInputElement>(null);
  const brandLogoImage = useRef<HTMLImageElement | null>(null);
  const brandKitOwner = useRef<string | null>(null);
  const preserveEditPlanOnNextFile = useRef(false);
  const preserveEndInputOnNextMetadata = useRef(false);
  const editHistory = useRef<EditHistory>({ scopeKey: '', current: null, past: [], future: [], suppressNext: false });
  const syncHistoryAvailability = () => setHistoryAvailability({ canUndo: editHistory.current.past.length > 0, canRedo: editHistory.current.future.length > 0 });

  useEffect(() => {
    const snapshot: EditSnapshot = {
      clips: clips.map(clip => ({ ...clip })),
      captions: captions.map(caption => ({ ...caption })),
    };
    const scopeKey = activeProjectId ? 'project:' + activeProjectId : 'source:' + (file ? [file.name, file.size, file.lastModified].join(':') : sourceLabel);
    const history = editHistory.current;
    if (!history.current || history.scopeKey !== scopeKey) {
      history.scopeKey = scopeKey;
      history.current = snapshot;
      history.past = [];
      history.future = [];
      history.suppressNext = false;
      syncHistoryAvailability();
      return;
    }
    if (history.suppressNext) {
      history.suppressNext = false;
      history.current = snapshot;
      syncHistoryAvailability();
      return;
    }
    if (JSON.stringify(snapshot) !== JSON.stringify(history.current)) {
      history.past = [...history.past, history.current].slice(-50);
      history.future = [];
      history.current = snapshot;
      syncHistoryAvailability();
    }
  }, [clips, captions, activeProjectId, file, sourceLabel]);

  useEffect(() => {
    let active = true;
    let registration: ServiceWorkerRegistration | null = null;
    let updateOnFocus: (() => void) | null = null;
    const onBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as DeferredInstallPrompt);
    };
    const onAppInstalled = () => {
      setAppInstalled(true);
      setInstallPrompt(null);
    };
    const onControllerChange = () => {
      if (updateReloadRef.current) window.location.reload();
    };
    const onUpdateFound = () => {
      const installing = registration?.installing;
      if (!installing) return;
      installing.addEventListener('statechange', () => {
        if (active && installing.state === 'installed' && navigator.serviceWorker.controller) {
          setUpdateReady(true);
        }
      });
    };
    const standalone = window.matchMedia('(display-mode: standalone)').matches ||
      (navigator as Navigator & { standalone?: boolean }).standalone === true;
    if (standalone) setAppInstalled(true);
    window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt);
    window.addEventListener('appinstalled', onAppInstalled);
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.addEventListener('controllerchange', onControllerChange);
      navigator.serviceWorker.register('./sw.js').then(reg => {
        if (!active) return;
        registration = reg;
        setUpdateRegistration(reg);
        if (reg.waiting && navigator.serviceWorker.controller) setUpdateReady(true);
        reg.addEventListener('updatefound', onUpdateFound);
        updateOnFocus = () => { void reg.update().catch(() => undefined); };
        window.addEventListener('focus', updateOnFocus);
      }).catch(() => undefined);
    }
    return () => {
      active = false;
      window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt);
      window.removeEventListener('appinstalled', onAppInstalled);
      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange);
      }
      if (registration) registration.removeEventListener('updatefound', onUpdateFound);
      if (updateOnFocus) window.removeEventListener('focus', updateOnFocus);
    };
  }, []);

  useEffect(() => {
    let live = true;
    auth.handleCallback()
      .then(async callback => {
        if (!live) return;
        if (callback?.type === 'recovery') {
          setRecoveryPending(true);
          setAuthMode('recovery');
          setAuthNotice('Choose a new password to finish recovering your account.');
        }
        const current = await auth.getUser();
        if (!live) return;
        setUser(current);
        setAuthLoading(false);
        if (current && callback?.type !== 'recovery') {
          try {
            const response = await api.get('/api/projects');
            if (live) setProjects(response.data.projects || []);
          } catch {
            if (live) setErrorMessage('Could not load your saved projects. Please refresh and try again.');
          }
        }
      })
      .catch(() => {
        if (live) {
          setAuthLoading(false);
          setErrorMessage('Could not restore your sign-in session. Check that Clipforge authentication is enabled, then try again.');
        }
      });
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (!user) {
      setExportSettingsReady(false);
      exportSettingsOwner.current = null;
      return;
    }
    setExportSettingsReady(false);
    exportSettingsOwner.current = null;
    try {
      const raw = window.localStorage.getItem('clipforge:export-settings:' + user.userId);
      if (raw) {
        const settings = JSON.parse(raw) as Record<string, unknown>;
        if (['compact', 'standard', 'high'].includes(String(settings.exportQuality))) {
          setExportQuality(settings.exportQuality as 'compact' | 'standard' | 'high');
        }
        if (['original', '9:16', '1:1', '16:9'].includes(String(settings.exportAspect))) {
          setExportAspect(settings.exportAspect as 'original' | '9:16' | '1:1' | '16:9');
        }
        if (['720', '1080'].includes(String(settings.exportResolution))) {
          setExportResolution(settings.exportResolution as '720' | '1080');
        }
        if (['0.5', '0.8', '1.2', '1.5', '2'].includes(String(settings.crossfadeDuration))) {
          setCrossfadeDuration(String(settings.crossfadeDuration));
        }
        if (typeof settings.exportVolume === 'number' && Number.isFinite(settings.exportVolume)) {
          setExportVolume(Math.max(0, Math.min(150, Math.round(settings.exportVolume / 5) * 5)));
        }
        if (typeof settings.audioCleanup === 'number' && Number.isFinite(settings.audioCleanup)) {
          setAudioCleanup(Math.max(0, Math.min(100, Math.round(settings.audioCleanup / 5) * 5)));
        }
        if (['none', 'fade', 'pop'].includes(String(settings.captionAnimation))) {
          setCaptionAnimation(settings.captionAnimation as 'none' | 'fade' | 'pop');
        }
        if (['auto', 'mp4', 'webm'].includes(String(settings.exportFormat))) setExportFormat(settings.exportFormat as 'auto' | 'mp4' | 'webm');
        if (typeof settings.sourceAudioEnabled === 'boolean') setSourceAudioEnabled(settings.sourceAudioEnabled);
      }
    } catch {
      setErrorMessage('Export preferences could not be restored. Your current settings will still work.');
    }
    exportSettingsOwner.current = user.userId;
    setExportSettingsReady(true);
  }, [user]);

  useEffect(() => {
    if (!user || !exportSettingsReady || exportSettingsOwner.current !== user.userId) return;
    try {
      window.localStorage.setItem('clipforge:export-settings:' + user.userId, JSON.stringify({
        exportQuality,
        exportAspect,
        exportResolution,
        crossfadeDuration,
        exportVolume,
        audioCleanup,
        captionAnimation,
        exportFormat,
        sourceAudioEnabled,
      }));
    } catch {
      setErrorMessage('Export preferences could not be saved in this browser.');
    }
  }, [user, exportSettingsReady, exportQuality, exportAspect, exportResolution, crossfadeDuration, exportVolume, audioCleanup, captionAnimation, exportFormat, sourceAudioEnabled]);

  useEffect(() => {
    if (!user) {
      setRecoveryReady(false);
      return;
    }
    setRecoveryNotice(false);
    const storageKey = 'clipforge:draft:' + user.userId;
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (raw) {
        const draft = JSON.parse(raw) as {
          clips?: Clip[];
          captions?: Caption[];
          captionFontSize?: string;
          captionColor?: string;
          captionBackground?: 'dark' | 'none';
          sourceLabel?: string;
          activeProjectId?: string | null;
          startInput?: string;
          endInput?: string;
          editInstructions?: string;
          editScript?: string;
          editingMode?: EditingMode;
          audioCleanup?: number;
          reframeEnabled?: boolean;
          reframeX?: number;
          reframeY?: number;
        };
        const safeClips = Array.isArray(draft.clips)
          ? draft.clips.filter(clip =>
              clip && Number.isFinite(clip.startSeconds) &&
              Number.isFinite(clip.endSeconds) && clip.startSeconds >= 0 &&
              clip.endSeconds > clip.startSeconds
            ).slice(0, 20)
          : [];
        const safeCaptions = Array.isArray(draft.captions)
          ? draft.captions.filter(caption =>
              caption && typeof caption.id === 'string' &&
              Number.isFinite(caption.startSeconds) &&
              Number.isFinite(caption.endSeconds) &&
              caption.startSeconds >= 0 && caption.endSeconds > caption.startSeconds &&
              typeof caption.text === 'string'
            ).slice(0, 1000)
          : [];
        if (safeClips.length || safeCaptions.length) {
          setClips(safeClips);
          setCaptions(safeCaptions);
          setCaptionFontSize(['26', '34', '42'].includes(draft.captionFontSize || '') ? draft.captionFontSize! : '34');
          setCaptionColor(typeof draft.captionColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(draft.captionColor) ? draft.captionColor : '#ffffff');
          setCaptionBackground(draft.captionBackground === 'none' ? 'none' : 'dark');
          setSourceLabel(typeof draft.sourceLabel === 'string' ? draft.sourceLabel.slice(0, 180) : '');
          setActiveProjectId(typeof draft.activeProjectId === 'string' ? draft.activeProjectId : null);
          setStartInput(typeof draft.startInput === 'string' ? draft.startInput : '0');
          setEndInput(typeof draft.endInput === 'string' ? draft.endInput : '5');
          setEditInstructions(typeof draft.editInstructions === 'string' ? draft.editInstructions.slice(0, 1500) : '');
          setEditScript(typeof draft.editScript === 'string' ? draft.editScript.slice(0, 4000) : '');
          setEditingMode(['manual', 'automatic', 'hybrid'].includes(draft.editingMode || '') ? draft.editingMode! : 'hybrid');
          setAudioCleanup(typeof draft.audioCleanup === 'number' ? Math.max(0, Math.min(100, draft.audioCleanup)) : 0);
          setReframeEnabled(draft.reframeEnabled === true);
          setReframeX(typeof draft.reframeX === 'number' ? Math.max(0, Math.min(1, draft.reframeX)) : 0.5);
          setReframeY(typeof draft.reframeY === 'number' ? Math.max(0, Math.min(1, draft.reframeY)) : 0.5);
          preserveEditPlanOnNextFile.current = true;
          preserveEndInputOnNextMetadata.current = true;
          setRecoveryNotice(true);
        }
      }
    } catch {
      setErrorMessage('A local recovery draft could not be read. Your saved projects are still available.');
    }
    setRecoveryReady(true);
  }, [user]);

  useEffect(() => {
    if (!user || !recoveryReady) return;
    const storageKey = 'clipforge:draft:' + user.userId;
    if (!clips.length && !captions.length) {
      try { window.localStorage.removeItem(storageKey); } catch { /* Storage may be disabled. */ }
      return;
    }
    try {
      window.localStorage.setItem(storageKey, JSON.stringify({
        clips,
        captions,
        captionFontSize,
        captionColor,
        captionBackground,
        sourceLabel,
        activeProjectId,
        startInput,
        endInput,
        editInstructions,
        editScript,
        editingMode,
        audioCleanup,
        reframeEnabled,
        reframeX,
        reframeY,
        savedAt: new Date().toISOString(),
      }));
    } catch {
      setErrorMessage('Browser storage is full or unavailable. Save your edit plan to your account to keep a copy.');
    }
  }, [user, recoveryReady, clips, captions, captionFontSize, captionColor, captionBackground, sourceLabel, activeProjectId, startInput, endInput, editInstructions, editScript, editingMode, audioCleanup, reframeEnabled, reframeX, reframeY]);

  useEffect(() => {
    if (!user) {
      setBrandKitReady(false);
      brandKitOwner.current = null;
      return;
    }
    setBrandKitReady(false);
    brandKitOwner.current = null;
    setBrandLogoData('');
    setBrandPrimaryColor('#a7f36b');
    setBrandSecondaryColor('#10150d');
    setBrandFontFamily('Arial, sans-serif');
    try {
      const raw = window.localStorage.getItem('clipforge:brand-kit:' + user.userId);
      if (raw) {
        const kit = JSON.parse(raw) as Record<string, unknown>;
        if (typeof kit.logoDataUrl === 'string' && kit.logoDataUrl.startsWith('data:image/') && kit.logoDataUrl.length <= 750000) setBrandLogoData(kit.logoDataUrl);
        if (typeof kit.primaryColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(kit.primaryColor)) setBrandPrimaryColor(kit.primaryColor);
        if (typeof kit.secondaryColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(kit.secondaryColor)) setBrandSecondaryColor(kit.secondaryColor);
        if (['Arial, sans-serif', 'Trebuchet MS, sans-serif', 'Georgia, serif'].includes(String(kit.fontFamily))) setBrandFontFamily(String(kit.fontFamily));
        if (typeof kit.captionFontSize === 'string' && ['26', '34', '42'].includes(kit.captionFontSize)) setCaptionFontSize(kit.captionFontSize);
        if (typeof kit.captionColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(kit.captionColor)) setCaptionColor(kit.captionColor);
        if (kit.captionBackground === 'dark' || kit.captionBackground === 'none') setCaptionBackground(kit.captionBackground);
        if (kit.captionAnimation === 'none' || kit.captionAnimation === 'fade' || kit.captionAnimation === 'pop') setCaptionAnimation(kit.captionAnimation);
      }
    } catch {
      setErrorMessage('Your local brand kit could not be restored. You can still edit and export normally.');
    }
    brandKitOwner.current = user.userId;
    setBrandKitReady(true);
  }, [user]);

  useEffect(() => {
    if (!brandLogoData) {
      brandLogoImage.current = null;
      return;
    }
    const image = new window.Image();
    image.onload = () => { brandLogoImage.current = image; };
    image.onerror = () => { brandLogoImage.current = null; };
    image.src = brandLogoData;
    return () => { image.onload = null; image.onerror = null; };
  }, [brandLogoData]);

  useEffect(() => {
    if (!user || !activeProjectId) {
      setProjectVersions([]);
      return;
    }
    try {
      const raw = window.localStorage.getItem('clipforge:versions:' + user.userId + ':' + activeProjectId);
      const parsed = raw ? JSON.parse(raw) : [];
      setProjectVersions(Array.isArray(parsed) ? parsed.filter((item): item is ProjectVersion =>
        item && typeof item.id === 'string' && typeof item.name === 'string' &&
        typeof item.savedAt === 'string' && Array.isArray(item.clips) && Array.isArray(item.captions)
      ).slice(0, 20) : []);
    } catch {
      setProjectVersions([]);
      setErrorMessage('Local version history could not be read. Your saved edit plan is unchanged.');
    }
  }, [user, activeProjectId]);

  useEffect(() => {
    if (videoRef.current) videoRef.current.playbackRate = playbackSpeed;
  }, [playbackSpeed, videoUrl]);

  useEffect(() => {
    if (!file) return;
    const url = URL.createObjectURL(file);
    setVideoUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const projectTitle = file?.name || sourceLabel || 'Untitled edit';
  const clipCountLabel = useMemo(
    () => clips.length + (clips.length === 1 ? ' clip' : ' clips'),
    [clips.length]
  );
  const activeCaption = captions.find(
    caption => playbackTime >= caption.startSeconds && playbackTime <= caption.endSeconds
  );
  const activePreviewClip = clips.find(clip => playbackTime >= clip.startSeconds && playbackTime <= clip.endSeconds);
  const previewMotion = activePreviewClip ? getClipMotion(activePreviewClip, playbackTime) : { scale: 1, x: 0, y: 0, opacity: 1, rotation: 0 };

  const signIn = async () => {
    setErrorMessage('');
    setAuthNotice('');
    if (!authEmail.trim() || !authPassword) {
      setErrorMessage('Enter your email address and password.');
      return;
    }
    setAuthBusy(true);
    try {
      const current = await auth.signIn(authEmail.trim(), authPassword);
      setUser(current);
      setAuthPassword('');
      const response = await api.get('/api/projects');
      setProjects(response.data.projects || []);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Sign-in failed. Please try again.');
    } finally {
      setAuthBusy(false);
    }
  };

  const signUp = async () => {
    setErrorMessage('');
    setAuthNotice('');
    if (!authEmail.trim() || authPassword.length < 8) {
      setErrorMessage('Enter a valid email and a password with at least 8 characters.');
      return;
    }
    setAuthBusy(true);
    try {
      await auth.signUp(authEmail.trim(), authPassword);
      const current = await auth.getUser();
      if (current) {
        setUser(current);
        const response = await api.get('/api/projects');
        setProjects(response.data.projects || []);
      } else {
        setAuthMode('login');
        setAuthPassword('');
        setAuthNotice('Account created. Check your email for a confirmation link, then sign in.');
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Account creation failed. Please try again.');
    } finally {
      setAuthBusy(false);
    }
  };

  const sendRecoveryEmail = async () => {
    setErrorMessage('');
    setAuthNotice('');
    if (!authEmail.trim()) {
      setErrorMessage('Enter the email address linked to your account.');
      return;
    }
    setAuthBusy(true);
    try {
      await auth.requestPasswordRecovery(authEmail.trim());
      setAuthNotice('If an account exists for that email, a password recovery link will be sent.');
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Could not request password recovery.');
    } finally {
      setAuthBusy(false);
    }
  };

  const finishPasswordRecovery = async () => {
    setErrorMessage('');
    if (authPassword.length < 8) {
      setErrorMessage('Choose a password with at least 8 characters.');
      return;
    }
    setAuthBusy(true);
    try {
      await auth.updatePassword(authPassword);
      setAuthPassword('');
      setRecoveryPending(false);
      setAuthMode('login');
      setAuthNotice('Your password has been updated.');
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Could not update your password.');
    } finally {
      setAuthBusy(false);
    }
  };

  const signOut = async () => {
    try {
      await auth.signOut();
      setUser(null);
      setProjects([]);
      setActiveProjectId(null);
      setAuthMode('login');
      setAuthNotice('');
      setErrorMessage('');
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Could not sign out. Please try again.');
    }
  };

  const undoEdit = () => {
    const history = editHistory.current;
    if (!history.current || !history.past.length || busy) return;
    const previous = history.past[history.past.length - 1];
    history.past = history.past.slice(0, -1);
    history.future = [history.current, ...history.future].slice(0, 50);
    history.current = previous;
    history.suppressNext = true;
    setClips(previous.clips.map(clip => ({ ...clip })));
    setCaptions(previous.captions.map(caption => ({ ...caption })));
    syncHistoryAvailability();
  };

  const redoEdit = () => {
    const history = editHistory.current;
    if (!history.current || !history.future.length || busy) return;
    const next = history.future[0];
    history.future = history.future.slice(1);
    history.past = [...history.past, history.current].slice(-50);
    history.current = next;
    history.suppressNext = true;
    setClips(next.clips.map(clip => ({ ...clip })));
    setCaptions(next.captions.map(caption => ({ ...caption })));
    syncHistoryAvailability();
  };

  useEffect(() => {
    const onEditorShortcut = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const tagName = target?.tagName?.toLowerCase();
      if (target?.isContentEditable || ['input', 'textarea', 'select'].includes(tagName || '')) return;
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === 'z') {
        event.preventDefault();
        if (event.shiftKey) redoEdit();
        else undoEdit();
      } else if (key === 'y') {
        event.preventDefault();
        redoEdit();
      }
    };
    window.addEventListener('keydown', onEditorShortcut);
    return () => window.removeEventListener('keydown', onEditorShortcut);
  }, [busy, historyAvailability.canUndo, historyAvailability.canRedo]);

  const onChooseFile = (chosen?: File) => {
    if (!chosen) return;
    const knownVideoExtension = /\.(mp4|m4v|mov|webm|ogv|avi|mkv)$/i.test(chosen.name);
    if (!chosen.type.startsWith('video/') && !knownVideoExtension) {
      setErrorMessage('Choose a video file such as MP4, MOV or WebM.');
      return;
    }
    const restoringEditPlan = preserveEditPlanOnNextFile.current;
    preserveEditPlanOnNextFile.current = false;
    preserveEndInputOnNextMetadata.current = restoringEditPlan;
    setFile(chosen);
    setRecoveryNotice(false);
    setSourceLabel(chosen.name);
    setIsRemoteSource(false);
    setPlaybackTime(0);
    setPreviewEnd(null);
    if (!restoringEditPlan) {
      setActiveProjectId(null);
      setClips([]);
      setCaptions([]);
      setStartInput('0');
      setEndInput('5');
    }
    setSuggestions([]);
    setAnalysisProgress(0);
    setReframeEnabled(false);
    setReframeStatus('');
    setBeatPoints([]);
    setBeatStatus('');
    setTranscribeProgress(0);
    setDuration(0);
    setErrorMessage('');
    setActiveTab('editor');
  };

  const importVideoLink = () => {
    if (busy) return;
    const raw = videoLinkInput.trim();
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      setErrorMessage('Paste a valid direct video URL beginning with https:// or http://.');
      return;
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      setErrorMessage('Only secure web links (HTTPS) or HTTP video links are supported.');
      return;
    }
    if (!/\.(mp4|webm|mov|m4v)$/i.test(parsed.pathname)) {
      setErrorMessage('This looks like a webpage link, not a direct video file. Paste a direct .mp4, .webm, .mov or .m4v link. YouTube and TikTok page links are not supported in this beta.');
      return;
    }
    setFile(null);
    setRecoveryNotice(false);
    setActiveProjectId(null);
    setVideoUrl(parsed.toString());
    setSourceLabel(parsed.pathname.split('/').pop() || 'Linked video');
    setIsRemoteSource(true);
    setPlaybackTime(0);
    setPreviewEnd(null);
    setClips([]);
    setSuggestions([]);
    setAnalysisProgress(0);
    setReframeEnabled(false);
    setReframeStatus('');
    setBeatPoints([]);
    setBeatStatus('');
    setCaptions([]);
    setTranscribeProgress(0);
    setDuration(0);
    setStartInput('0');
    setEndInput('5');
    setErrorMessage('');
    setActiveTab('editor');
  };

  const addClip = (clip: Clip) => {
    if (clips.length >= 20) {
      setErrorMessage('An edit plan can contain up to 20 clips. Remove a clip before adding another.');
      return;
    }
    if (
      !Number.isFinite(clip.startSeconds) ||
      !Number.isFinite(clip.endSeconds) ||
      clip.startSeconds < 0 ||
      clip.endSeconds <= clip.startSeconds ||
      clip.endSeconds > duration
    ) {
      setErrorMessage('Choose a valid range inside the video duration.');
      return;
    }
    if (clips.some(existing =>
      Math.abs(existing.startSeconds - clip.startSeconds) < 0.25 &&
      Math.abs(existing.endSeconds - clip.endSeconds) < 0.25
    )) {
      setErrorMessage('That clip range is already in your timeline.');
      return;
    }
    setClips(current => [...current, clip]);
    setErrorMessage('');
  };

  const appendInstruction = (brief: string) => {
    setEditInstructions(current => [current.trim(), brief].filter(Boolean).join('\n\n').slice(0, 1500));
  };

  const buildTimelineFromSuggestions = () => {
    const ordered = assembleStorySuggestions(
      suggestions,
      editorSection === 'guided' && !!editScript.trim()
    );
    const combined = [...clips];
    let added = 0;
    for (const suggestion of ordered) {
      if (combined.length >= 20) break;
      const duplicate = combined.some(existing => Math.abs(existing.startSeconds - suggestion.startSeconds) < 0.25 && Math.abs(existing.endSeconds - suggestion.endSeconds) < 0.25);
      if (!duplicate) { combined.push(suggestion); added += 1; }
    }
    setClips(combined);
    setErrorMessage(added ? `Added ${added} assembled story moments in ${editorSection === 'guided' && editScript.trim() ? 'script' : 'hook-to-payoff'} order. Review the sequence and adjust it in the timeline.` : 'Those suggestions are already added, or the 20-clip limit has been reached.');
  };

  const applyScriptAsCaptions = (targetClips: Clip[] = clips, scriptText: string = editScript) => {
    const beats = getScriptBeats(scriptText);
    if (!beats.length || !targetClips.length) return 0;

    // Give each beat its strongest visual match. Unmatched beats are still
    // represented, distributed across the sequence for manual review.
    const beatClipAssignments = beats.map((_, beatIndex) => {
      const matches = targetClips
        .map((clip, index) => ({ clip, index }))
        .filter(item => item.clip.scriptBeatIndex === beatIndex)
        .sort((left, right) =>
          (right.clip.matchConfidence ?? 0) - (left.clip.matchConfidence ?? 0) ||
          (right.clip.score ?? 0) - (left.clip.score ?? 0)
        );
      if (matches.length) return matches[0].index;
      return Math.max(0, Math.min(
        targetClips.length - 1,
        Math.floor(((beatIndex + 0.5) * targetClips.length) / beats.length)
      ));
    });

    const beatsByClip = new Map<number, number[]>();
    beatClipAssignments.forEach((clipIndex, beatIndex) => {
      const assigned = beatsByClip.get(clipIndex) || [];
      assigned.push(beatIndex);
      beatsByClip.set(clipIndex, assigned);
    });

    const next: Caption[] = [];
    let idCounter = 0;
    beatsByClip.forEach((beatIndices, clipIndex) => {
      const clip = targetClips[clipIndex];
      const clipDuration = clip.endSeconds - clip.startSeconds;
      const totalWords = beatIndices.reduce(
        (sum, beatIndex) => sum + beats[beatIndex].split(/\s+/).filter(Boolean).length,
        0
      );
      let wordCursor = 0;

      beatIndices.forEach(beatIndex => {
        const words = beats[beatIndex].split(/\s+/).filter(Boolean);
        const phrases: string[] = [];
        let phrase = '';
        words.forEach(word => {
          phrase = phrase ? phrase + ' ' + word : word;
          if (phrase.split(/\s+/).length >= 7 || /[.!?][”’\"]?$/.test(word)) {
            phrases.push(phrase);
            phrase = '';
          }
        });
        if (phrase) phrases.push(phrase);

        phrases.forEach(text => {
          const count = text.split(/\s+/).filter(Boolean).length;
          const startFraction = wordCursor / Math.max(1, totalWords);
          const endFraction = (wordCursor + count) / Math.max(1, totalWords);
          const startSeconds = clip.startSeconds + startFraction * clipDuration;
          const endSeconds = clip.startSeconds + endFraction * clipDuration;
          if (endSeconds > startSeconds) next.push({
            id: 'script-' + Date.now() + '-' + idCounter++,
            startSeconds: Number(startSeconds.toFixed(2)),
            endSeconds: Number(endSeconds.toFixed(2)),
            text,
          });
          wordCursor += count;
        });
      });
    });

    setCaptions(next.sort((left, right) => left.startSeconds - right.startSeconds));
    const matchedBeats = new Set(targetClips
      .filter(clip => Number.isInteger(clip.scriptBeatIndex))
      .map(clip => clip.scriptBeatIndex)).size;
    setErrorMessage('Created ' + next.length + ' timed captions across ' + beats.length + ' script beats (' + matchedBeats + ' visually matched). Review timing and any unmatched beats before export.');
    return next.length;
  };

  const previewScriptVoice = () => {
    if (!('speechSynthesis' in window)) { setErrorMessage('This browser does not support spoken script preview.'); return; }
    if (voicePreviewing) { window.speechSynthesis.cancel(); setVoicePreviewing(false); return; }
    if (!editScript.trim()) return;
    const utterance = new SpeechSynthesisUtterance(editScript.trim());
    utterance.onend = () => setVoicePreviewing(false);
    utterance.onerror = () => setVoicePreviewing(false);
    setVoicePreviewing(true);
    window.speechSynthesis.speak(utterance);
  };

  const updateClipRange = (index: number, field: 'startSeconds' | 'endSeconds', rawValue: string) => {
    const value = Number(rawValue);
    const current = clips[index];
    if (!current || !Number.isFinite(value)) {
      setErrorMessage('Enter a valid clip time.');
      return;
    }
    const updated = { ...current, [field]: value };
    if (updated.startSeconds < 0 || updated.endSeconds <= updated.startSeconds || updated.endSeconds > duration) {
      setErrorMessage('Clip times must form a positive range inside the video duration.');
      return;
    }
    if (clips.some((clip, clipIndex) => clipIndex !== index &&
      Math.abs(clip.startSeconds - updated.startSeconds) < 0.25 &&
      Math.abs(clip.endSeconds - updated.endSeconds) < 0.25
    )) {
      setErrorMessage('That clip range already exists in your timeline.');
      return;
    }
    setClips(currentClips => currentClips
      .map((clip, clipIndex) => clipIndex === index ? updated : clip));
    setErrorMessage('');
  };

  const addManualClip = () => {
    addClip({ startSeconds: Number(startInput), endSeconds: Number(endInput) });
  };

  const splitClipAtPlayhead = (index: number) => {
    const clip = clips[index];
    const splitAt = playbackTime;
    if (!clip || splitAt <= clip.startSeconds + 0.25 || splitAt >= clip.endSeconds - 0.25) {
      setErrorMessage('Move the playhead at least 0.25 seconds inside the clip to split it.');
      return;
    }
    if (clips.length >= 20) {
      setErrorMessage('The timeline is limited to 20 clips. Remove a clip before splitting.');
      return;
    }
    const firstPart = { ...clip, endSeconds: Number(splitAt.toFixed(2)) };
    const secondPart = { ...clip, startSeconds: Number(splitAt.toFixed(2)) };
    setClips(current => current.flatMap((item, itemIndex) => itemIndex === index ? [firstPart, secondPart] : [item]));
    setErrorMessage('');
  };

  const addMotionKeyframe = (index: number) => {
    const clip = clips[index];
    if (!clip) return;
    const frame = createMotionKeyframe(clip, playbackTime);
    if (getMotionKeyframes(clip).some(item => Math.abs(item.at - frame.at) < 0.015)) {
      setErrorMessage('A keyframe already exists at this position. Adjust its controls below.');
      return;
    }
    setClips(current => current.map((item, clipIndex) => clipIndex !== index ? item : {
      ...item, keyframes: [...getMotionKeyframes(item), frame].sort((a, b) => a.at - b.at),
    }));
    setErrorMessage('Motion keyframe added at ' + Math.round(frame.at * 100) + '% of this clip.');
  };
  const updateMotionKeyframe = (clipIndex: number, id: string, field: keyof Omit<MotionKeyframe, 'id' | 'at'>, value: number | MotionKeyframe['easing']) => {
    setClips(current => current.map((item, index) => index !== clipIndex ? item : {
      ...item, keyframes: getMotionKeyframes(item).map(frame => frame.id === id ? { ...frame, [field]: value } : frame),
    }));
  };
  const removeMotionKeyframe = (clipIndex: number, id: string) => {
    const clip = clips[clipIndex];
    if (!clip || getMotionKeyframes(clip).length <= 2) {
      setErrorMessage('Keep at least two keyframes so the motion has a start and an end.');
      return;
    }
    setClips(current => current.map((item, index) => index !== clipIndex ? item : {
      ...item, keyframes: getMotionKeyframes(item).filter(frame => frame.id !== id),
    }));
  };
  const startTimelineDrag = (kind: 'clip' | 'caption', index: number, event: React.PointerEvent<HTMLElement>, mode: 'move' | 'trim-start' | 'trim-end' = 'move') => {
    if (busy || !duration) return;
    event.stopPropagation();
    const laneWidth = event.currentTarget.closest('.multitrack-track')?.getBoundingClientRect().width || 1;
    const item = kind === 'clip' ? clips[index] : captions[index];
    if (!item) return;
    timelineDragRef.current = { kind, mode, index, startX: event.clientX, laneWidth, start: item.startSeconds, end: item.endSeconds };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const finishTimelineDrag = (event: React.PointerEvent<HTMLElement>) => {
    const drag = timelineDragRef.current;
    if (!drag) return;
    const delta = (event.clientX - drag.startX) / drag.laneWidth * duration;
    timelineDragRef.current = null;
    if (Math.abs(delta) < 0.08) return;
    const minLength = 0.15;
    const nextStart = drag.mode === 'trim-start' ? Math.max(0, Math.min(drag.end - minLength, drag.start + delta)) : drag.mode === 'move' ? drag.start + Math.max(-drag.start, Math.min(duration - drag.end, delta)) : drag.start;
    const nextEnd = drag.mode === 'trim-end' ? Math.min(duration, Math.max(drag.start + minLength, drag.end + delta)) : drag.mode === 'move' ? drag.end + (nextStart - drag.start) : drag.end;
    if (drag.kind === 'clip') {
      setClips(current => current.map((clip, index) => index !== drag.index ? clip : {
        ...clip, startSeconds: Number(nextStart.toFixed(2)), endSeconds: Number(nextEnd.toFixed(2)),
      }));
    } else {
      setCaptions(current => current.map((caption, index) => index !== drag.index ? caption : {
        ...caption, startSeconds: Number(nextStart.toFixed(2)), endSeconds: Number(nextEnd.toFixed(2)),
      }));
    }
  };
  const seekTimeline = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!duration || busy) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const nextTime = Math.max(0, Math.min(duration, (event.clientX - rect.left) / rect.width * duration));
    setPlaybackTime(nextTime);
    if (videoRef.current) videoRef.current.currentTime = nextTime;
  };
  const moveClip = (index: number, direction: -1 | 1) => {
    const targetIndex = index + direction;
    if (targetIndex < 0 || targetIndex >= clips.length) return;
    setClips(current => {
      if (targetIndex >= current.length) return current;
      const reordered = [...current];
      [reordered[index], reordered[targetIndex]] = [reordered[targetIndex], reordered[index]];
      return reordered;
    });
    setErrorMessage('');
  };

  const previewClip = async (clip: Clip) => {
    const video = videoRef.current;
    if (!video || !videoUrl) {
      setErrorMessage('Choose a video before previewing a clip.');
      return;
    }
    if (!Number.isFinite(clip.startSeconds) || !Number.isFinite(clip.endSeconds) ||
      clip.startSeconds < 0 || clip.endSeconds <= clip.startSeconds || clip.endSeconds > duration) {
      setErrorMessage('This clip range is outside the loaded video. Check the source video and try again.');
      return;
    }
    try {
      setErrorMessage('');
      video.pause();
      if (Math.abs(video.currentTime - clip.startSeconds) > 0.05) {
        await new Promise<void>((resolve, reject) => {
          const timeout = window.setTimeout(() => {
            cleanup();
            reject(new Error('The video took too long to seek to this clip.'));
          }, 8000);
          const cleanup = () => {
            window.clearTimeout(timeout);
            video.removeEventListener('seeked', onSeeked);
            video.removeEventListener('error', onError);
          };
          const onSeeked = () => { cleanup(); resolve(); };
          const onError = () => { cleanup(); reject(new Error('The video could not seek to this clip.')); };
          video.addEventListener('seeked', onSeeked, { once: true });
          video.addEventListener('error', onError, { once: true });
          video.currentTime = clip.startSeconds;
        });
      }
      setPlaybackTime(clip.startSeconds);
      setPreviewEnd(clip.endSeconds);
      await video.play();
    } catch {
      setPreviewEnd(null);
      setErrorMessage('Clip preview could not start. Check that the video can seek to this point, then try again.');
    }
  };

  const extractFrames = async (sourceUrl: string, videoDuration: number, targetFrameCount = 20) => {
    const probe = document.createElement('video');
    probe.preload = 'auto';
    probe.muted = true;
    probe.crossOrigin = 'anonymous';
    try {
      const metadataReady = new Promise<void>((resolve, reject) => {
        const timeout = window.setTimeout(() => {
          cleanup();
          reject(new Error('The video took too long to load for AI analysis. Try a shorter video or a local MP4.'));
        }, 20000);
        const cleanup = () => {
          window.clearTimeout(timeout);
          probe.removeEventListener('loadedmetadata', onReady);
          probe.removeEventListener('error', onError);
        };
        const onReady = () => { cleanup(); resolve(); };
        const onError = () => { cleanup(); reject(new Error('Could not read this video.')); };
        probe.addEventListener('loadedmetadata', onReady, { once: true });
        probe.addEventListener('error', onError, { once: true });
      });
      probe.src = sourceUrl;
      await metadataReady;
      const canvas = document.createElement('canvas');
      const scale = Math.min(
        1,
        640 / Math.max(probe.videoWidth, probe.videoHeight)
      );
      canvas.width = Math.max(1, Math.round(probe.videoWidth * scale));
      canvas.height = Math.max(1, Math.round(probe.videoHeight * scale));
      const context = canvas.getContext('2d');
      if (!context)
        throw new Error('Frame capture is unavailable in this browser.');
      const signatureCanvas = document.createElement('canvas');
      const signatureScale = Math.min(
        1,
        80 / Math.max(probe.videoWidth, probe.videoHeight)
      );
      signatureCanvas.width = Math.max(1, Math.round(probe.videoWidth * signatureScale));
      signatureCanvas.height = Math.max(1, Math.round(probe.videoHeight * signatureScale));
      const signatureContext = signatureCanvas.getContext('2d', {
        willReadFrequently: true,
      });
      if (!signatureContext)
        throw new Error('Low-resolution frame analysis is unavailable in this browser.');

      const latestSampleTime = Math.max(
        0,
        videoDuration - Math.min(0.15, videoDuration * 0.01)
      );
      // Short and medium videos get denser local scouting; the hard cap keeps
      // browser work bounded on mobile and desktop alike.
      // Motion is estimated locally; semantic AI reviews a smaller selected keyframe set.
      const candidateCount = Math.min(480, Math.max(12, Math.ceil(videoDuration / 0.25)));
      const candidateTimes = Array.from({ length: candidateCount }, (_, index) => {
        const fraction = 0.02 + (0.96 * index) / Math.max(1, candidateCount - 1);
        return Math.min(latestSampleTime, Math.max(0, videoDuration * fraction));
      });
      const selectedCount = targetFrameCount <= 5
        ? Math.min(targetFrameCount, candidateCount)
        : Math.max(15, Math.floor(Math.min(targetFrameCount, candidateCount) / 5) * 5);
      const candidates: {
        timeSeconds: number;
        index: number;
        signature: Uint8Array;
        blob: Blob;
        motion?: MotionSample;
      }[] = [];

      const seekTo = async (timeSeconds: number) => {
        if (Math.abs(probe.currentTime - timeSeconds) <= 0.001) return;
        await new Promise<void>((resolve, reject) => {
          const timeout = window.setTimeout(() => {
            cleanup();
            reject(new Error('The video stalled while sampling frames for AI analysis.'));
          }, 10000);
          const cleanup = () => {
            window.clearTimeout(timeout);
            probe.removeEventListener('seeked', onSeeked);
            probe.removeEventListener('error', onError);
          };
          const onSeeked = () => { cleanup(); resolve(); };
          const onError = () => { cleanup(); reject(new Error('Could not sample a video frame.')); };
          probe.addEventListener('seeked', onSeeked, { once: true });
          probe.addEventListener('error', onError, { once: true });
          probe.currentTime = timeSeconds;
        });
      };

      const readSignature = () => {
        signatureContext.drawImage(
          probe,
          0,
          0,
          signatureCanvas.width,
          signatureCanvas.height
        );
        const pixels = signatureContext.getImageData(
          0,
          0,
          signatureCanvas.width,
          signatureCanvas.height
        ).data;
        const signature = new Uint8Array(signatureCanvas.width * signatureCanvas.height);
        for (let index = 0; index < signature.length; index += 1) {
          const pixelOffset = index * 4;
          signature[index] = Math.round(
            pixels[pixelOffset] * 0.299 +
            pixels[pixelOffset + 1] * 0.587 +
            pixels[pixelOffset + 2] * 0.114
          );
        }
        return signature;
      };

      for (let index = 0; index < candidateTimes.length; index += 1) {
        const timeSeconds = candidateTimes[index];
        if (index === 0 || (index + 1) % 12 === 0 || index === candidateTimes.length - 1) {
          setAnalysisProgress(Math.round(((index + 1) / candidateTimes.length) * 12));
          setAnalysisMessage('Mapping motion across the full timeline · checkpoint ' + (index + 1) + '/' + candidateTimes.length + '…');
        }
        await seekTo(timeSeconds);
        const signature = readSignature();
        context.drawImage(probe, 0, 0, canvas.width, canvas.height);
        const blob = await new Promise<Blob>((resolve, reject) =>
          canvas.toBlob(
            value =>
              value
                ? resolve(value)
                : reject(new Error('Frame compression failed.')),
            'image/jpeg',
            0.52
          )
        );
        candidates.push({
          timeSeconds,
          index,
          signature,
          blob,
        });
      }

      // Per-frame contrast normalization makes diversity scoring less sensitive
      // to exposure flicker, while a compact edge descriptor preserves structure.
      const visualDescriptors = candidates.map(candidate => {
        const signature = candidate.signature;
        const mean = signature.reduce((sum, value) => sum + value, 0) / Math.max(1, signature.length);
        let variance = 0;
        for (const value of signature) variance += (value - mean) ** 2;
        const deviation = Math.max(12, Math.sqrt(variance / Math.max(1, signature.length)));
        const contrast = new Uint8Array(signature.length);
        const edges = new Uint8Array(signature.length);
        for (let index = 0; index < signature.length; index += 1) {
          contrast[index] = Math.round(Math.max(0, Math.min(255,
            ((signature[index] - mean) / deviation + 3) / 6 * 255
          )));
          const x = index % signatureCanvas.width;
          const right = x + 1 < signatureCanvas.width ? signature[index + 1] : signature[index];
          const below = index + signatureCanvas.width < signature.length
            ? signature[index + signatureCanvas.width]
            : signature[index];
          const gradient = Math.hypot(right - signature[index], below - signature[index]) / deviation;
          edges[index] = Math.round(Math.max(0, Math.min(255, gradient / 2.8 * 255)));
        }
        return { contrast, edges };
      });
      const visualDistance = (
        left: { contrast: Uint8Array; edges: Uint8Array },
        right: { contrast: Uint8Array; edges: Uint8Array }
      ) => {
        let contrastTotal = 0;
        let edgeTotal = 0;
        for (let index = 0; index < left.contrast.length; index += 1) {
          contrastTotal += Math.abs(left.contrast[index] - right.contrast[index]);
          edgeTotal += Math.abs(left.edges[index] - right.edges[index]);
        }
        const count = Math.max(1, left.contrast.length);
        return (contrastTotal / count) * 0.72 + (edgeTotal / count) * 0.28;
      };

      // Dense block flow separates robust global camera translation from coherent residual regions.
      const motionTimeline = estimateMotionTimeline(
        candidates.map(candidate => ({ timeSeconds: candidate.timeSeconds, signature: candidate.signature })),
        signatureCanvas.width,
        signatureCanvas.height
      );
      candidates.forEach((candidate, index) => { candidate.motion = motionTimeline[index]; });

      // Estimate local visual change from adjacent samples. This is a motion/scene-change
      // proxy, not proof of a specific action; combine it with novelty and timeline spread.
      const localChange = candidates.map((candidate, index) => {
        const descriptor = visualDescriptors[index];
        const before = index > 0
          ? visualDistance(descriptor, visualDescriptors[index - 1])
          : 0;
        const after = index < candidates.length - 1
          ? visualDistance(descriptor, visualDescriptors[index + 1])
          : 0;
        return Math.max(before, after);
      });

      // Preserve the opening and ending, then reserve slots for strong scene boundaries.
      const sceneCutSeeds = candidates
        .filter(candidate => candidate.motion?.sceneCut)
        .sort((left, right) => localChange[right.index] - localChange[left.index])
        .slice(0, Math.max(0, Math.floor(selectedCount * 0.2) - 1))
        .map(candidate => candidate.index);
      const selectedIndices = Array.from(new Set([0, ...sceneCutSeeds, candidateTimes.length - 1]));
      while (selectedIndices.length < Math.min(selectedCount, candidates.length)) {
        let bestIndex = -1;
        let bestScore = -Infinity;
        for (const candidate of candidates) {
          if (selectedIndices.includes(candidate.index)) continue;
          let nearestVisualDistance = Infinity;
          let nearestTemporalDistance = Infinity;
          for (const selectedIndex of selectedIndices) {
            const selected = candidates[selectedIndex];
            nearestVisualDistance = Math.min(
              nearestVisualDistance,
              visualDistance(visualDescriptors[candidate.index], visualDescriptors[selectedIndex])
            );
            nearestTemporalDistance = Math.min(
              nearestTemporalDistance,
              (Math.abs(candidate.index - selectedIndex) /
                (candidateTimes.length - 1)) * 255
            );
          }
          const motion = candidate.motion;
          const motionMagnitude = Math.max(0, Math.min(1, (motion?.magnitude ?? 0) / 0.55));
          const subjectMotion = Math.max(0, Math.min(1, motion?.subjectMotionRatio ?? 0));
          const flowReliability = 0.45 + 0.55 * Math.max(0, Math.min(1, motion?.flowConfidence ?? 0));
          const motionInterest = (motionMagnitude * 0.6 + subjectMotion * 0.4) * flowReliability;
          const sceneBoundaryBonus = motion?.sceneCut ? 60 : 0;
          const score =
            nearestVisualDistance * 0.30 +
            nearestTemporalDistance * 0.22 +
            localChange[candidate.index] * 0.26 +
            motionInterest * 255 * 0.22 +
            sceneBoundaryBonus;
          if (score > bestScore) {
            bestScore = score;
            bestIndex = candidate.index;
          }
        }
        if (bestIndex < 0) break;
        selectedIndices.push(bestIndex);
      }

      selectedIndices.sort((left, right) => left - right);
      const frames: { timeSeconds: number; data: string; mimeType: string }[] = [];
      for (const selectedIndex of selectedIndices) {
        const candidate = candidates[selectedIndex];
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () =>
            reject(new Error('Could not prepare a video frame.'));
          reader.readAsDataURL(candidate.blob);
        });
        frames.push({
          timeSeconds: candidate.timeSeconds,
          data: dataUrl.split(',')[1],
          mimeType: 'image/jpeg',
        });
      }
      return { frames, motionTimeline };
    } finally {
      probe.pause();
      probe.removeAttribute('src');
      probe.load();
    }
  };

  const analyzeVideo = async (autoBuild = false, forceScriptBuild = false) => {
    if (!videoUrl || !duration) return;
    setBusy(autoBuild ? 'create' : 'analyze');
    setErrorMessage('');
    setSuggestions([]);
    setAnalysisProgress(0);
    setAnalysisMessage('Scanning up to 480 checkpoints with multi-scale flow, camera-model compensation and persistent motion-region association…');
    let merged: Clip[] = [];
    let completedBatches = 0;
    let totalBatches = 0;
    try {
      // Keep short clips economical, but give longer edits more semantic checkpoints
      // so the AI has a better chance of seeing separate story phases between batches.
      const analysisFrameBudget = Math.min(30, 20 + Math.min(10, Math.floor(Math.max(0, duration - 90) / 30) * 5));
      const { frames, motionTimeline } = await extractFrames(videoUrl, duration, analysisFrameBudget);
      const transcriptForAnalysis = captions.length <= 200
        ? captions
        : Array.from({ length: 200 }, (_, index) => captions[Math.round(index * (captions.length - 1) / 199)]);
      const scriptForAnalysis = forceScriptBuild && editorSection === 'guided' ? editScript : '';
      const instructionsForAnalysis = editorSection === 'guided' ? editInstructions : '';
      const scriptBeats = getScriptBeats(scriptForAnalysis);
      totalBatches = Math.ceil(frames.length / 5);
      setAnalysisProgress(15);
      setAnalysisProgress(15);
      setAnalysisMessage('Full-timeline scan complete · reviewing ' + frames.length + ' selected keyframes in ' + totalBatches + ' chronological AI batches…');
      for (let start = 0; start < frames.length; start += 5) {
        const batchFrames = frames.slice(start, start + 5);
        const response = await api.post('/api/analyze', {
          duration,
          frames: batchFrames,
          timelineMotion: motionTimeline,
          transcript: transcriptForAnalysis.map(caption => ({
            startSeconds: caption.startSeconds,
            endSeconds: caption.endSeconds,
            text: caption.text,
          })),
          scriptBeats,
          editingMode: editorSection === 'guided' ? editingMode : 'hybrid',
          editInstructions: instructionsForAnalysis,
          editScript: scriptForAnalysis,
          clipLengthMode,
          customClipLength: Number(customClipLength),
        });
        const incoming = (response.data.highlights || []) as Clip[];
        for (const candidate of incoming) {
          const duplicateIndex = merged.findIndex(existing => {
            const samePhase = (existing.eventPhase || 'standalone') === (candidate.eventPhase || 'standalone');
            if (!samePhase) return false;

            const sameSubject = !existing.subjectTrack || !candidate.subjectTrack ||
              existing.subjectTrack.trim().toLowerCase() === candidate.subjectTrack.trim().toLowerCase();
            if (!sameSubject) return false;

            const sameAction = !existing.actionLabel || !candidate.actionLabel ||
              existing.actionLabel.trim().toLowerCase() === candidate.actionLabel.trim().toLowerCase();
            if (!sameAction) return false;

            if (existing.scriptBeatIndex !== undefined && candidate.scriptBeatIndex !== undefined &&
                existing.scriptBeatIndex !== candidate.scriptBeatIndex) return false;

            const overlap = Math.max(0,
              Math.min(existing.endSeconds, candidate.endSeconds) -
              Math.max(existing.startSeconds, candidate.startSeconds)
            );
            const overlapRatio = overlap / Math.max(0.25, Math.min(
              existing.endSeconds - existing.startSeconds,
              candidate.endSeconds - candidate.startSeconds
            ));
            const nearbyAnchor = Math.abs(
              (existing.timestampSeconds ?? existing.startSeconds) -
              (candidate.timestampSeconds ?? candidate.startSeconds)
            ) < 3.5;
            const sameEvent = !!existing.eventGroupLabel && !!candidate.eventGroupLabel &&
              existing.eventGroupLabel.trim().toLowerCase() === candidate.eventGroupLabel.trim().toLowerCase();
            return overlapRatio > 0.62 || (nearbyAnchor && overlapRatio > 0.15) ||
              (sameEvent && overlapRatio > 0.78);
          });
          if (duplicateIndex < 0) merged.push(candidate);
          else {
            const rank = (item: Clip) =>
              (item.score || 0) * 0.72 +
              (item.visualEvidenceConfidence ?? 0) * 0.18 +
              (item.eventConfidence ?? 50) * 0.10;
            if (rank(candidate) > rank(merged[duplicateIndex])) merged[duplicateIndex] = candidate;
          }
        }
        merged = sortSuggestionsForStory(merged);
        setSuggestions([...merged]);
        completedBatches += 1;
        setAnalysisProgress(15 + Math.round((completedBatches / totalBatches) * 85));
        const matchedBeatCount = new Set(merged
          .filter(item => Number.isInteger(item.scriptBeatIndex))
          .map(item => item.scriptBeatIndex)).size;
        setAnalysisMessage('Analysed batch ' + completedBatches + ' of ' + totalBatches + ' · ' + merged.length + ' unique moments found' +
          (scriptBeats.length ? ' · ' + matchedBeatCount + '/' + scriptBeats.length + ' script beats matched' : ''));
        for (let index = start; index < start + batchFrames.length; index += 1) frames[index].data = '';
      }
      merged = sortSuggestionsForStory(merged);
      setSuggestions(merged);
      setAnalysisProgress(100);
      const matchedBeatCount = new Set(merged
        .filter(item => Number.isInteger(item.scriptBeatIndex))
        .map(item => item.scriptBeatIndex)).size;
      setAnalysisMessage('Analysis complete · ' + merged.length + ' distinct suggestions' +
        (scriptBeats.length ? ' · ' + matchedBeatCount + '/' + scriptBeats.length + ' script beats matched' : ''));
      if (!merged.length) {
        setErrorMessage('The AI did not find clear suggestions in the sampled frames. Try manual selection or add more spoken context.');
      } else if (autoBuild && (editingMode === 'automatic' || forceScriptBuild)) {
        const assembled = assembleStorySuggestions(merged, forceScriptBuild && !!scriptBeats.length);
        const combined = [...clips];
        let added = 0;
        for (const suggestion of assembled) {
          if (combined.length >= 20) break;
          const duplicate = combined.some(existing =>
            Math.abs(existing.startSeconds - suggestion.startSeconds) < 0.25 &&
            Math.abs(existing.endSeconds - suggestion.endSeconds) < 0.25
          );
          if (!duplicate) { combined.push(suggestion); added += 1; }
        }
        const finalTimeline = combined;
        setClips(finalTimeline);
        const captionCount = scriptForAnalysis.trim() ? applyScriptAsCaptions(finalTimeline, scriptForAnalysis) : 0;
        const matchedBeatCount = new Set(finalTimeline
          .filter(item => Number.isInteger(item.scriptBeatIndex))
          .map(item => item.scriptBeatIndex)).size;
        setErrorMessage('Created a reviewable ' + (forceScriptBuild ? 'script-ordered ' : 'hook-to-payoff ') + 'timeline with ' + finalTimeline.length + ' assembled moments (' + added + ' new). ' +
          (captionCount ? captionCount + ' beat-aligned script captions are ready. ' : '') +
          (scriptBeats.length ? matchedBeatCount + '/' + scriptBeats.length + ' beats have visual matches. ' : '') +
          (finalTimeline.length < 2 ? 'Add another clip before exporting a full sequence.' : 'Review the order, ranges and captions, then export your sequence.'));
      }
    } catch (err) {
      setSuggestions([...merged]);
      const detail = err instanceof Error ? err.message : 'AI analysis failed. Please try again.';
      setErrorMessage(detail + (completedBatches ? ' Partial results from ' + completedBatches + ' of ' + totalBatches + ' batches were kept.' : ''));
    } finally {
      setBusy('');
    }
  };

  const suggestSmartReframe = async () => {
    if (!videoUrl || !duration) return;
    setBusy('reframe');
    setReframeStatus('Scanning the full motion trace and sampling visual subject anchors…');
    try {
      const { frames, motionTimeline } = await extractFrames(videoUrl, duration, 12);
      setReframeStatus('Identifying visible subjects across chronological samples and matching them to predicted motion paths…');
      const response = await api.post('/api/reframe', { frames });
      const rawDetections = Array.isArray(response.data.detections) ? response.data.detections as Array<{
        centerX: number; centerY: number; width: number; height: number; confidence: number;
        timeSeconds: number; frameIndex: number; trackId: string; subject?: string;
      }> : [];
      const detections = rawDetections.filter(item =>
        typeof item.trackId === 'string' && item.trackId.length > 0 &&
        Number.isInteger(item.frameIndex) && item.frameIndex >= 0 && item.frameIndex < frames.length &&
        Number.isFinite(item.centerX) && Number.isFinite(item.centerY) &&
        Number.isFinite(item.width) && Number.isFinite(item.height) &&
        Number.isFinite(item.confidence) && item.confidence >= 0.38 &&
        Number.isFinite(item.timeSeconds) && item.timeSeconds >= 0 &&
        item.centerX >= 0 && item.centerX <= 1 && item.centerY >= 0 && item.centerY <= 1 &&
        item.width > 0 && item.width <= 1 && item.height > 0 && item.height <= 1
      );
      const identityGroups = new Map<string, typeof detections>();
      for (const detection of detections) {
        const group = identityGroups.get(detection.trackId) || [];
        group.push(detection);
        identityGroups.set(detection.trackId, group);
      }
      const identityScore = (group: typeof detections) => {
        const averageConfidence = group.reduce((sum, item) => sum + item.confidence, 0) / group.length;
        const representedFrames = new Set(group.map(item => item.frameIndex)).size;
        const persistence = Math.min(1, representedFrames / Math.max(3, frames.length * 0.45));
        const firstSeen = Math.min(...group.map(item => item.timeSeconds));
        const lastSeen = Math.max(...group.map(item => item.timeSeconds));
        const temporalCoverage = duration > 0 ? Math.max(0, Math.min(1, (lastSeen - firstSeen) / duration)) : 0;
        return persistence * 0.55 + temporalCoverage * 0.2 + averageConfidence * 0.25;
      };
      const selectedIdentity = [...identityGroups.entries()]
        .sort((left, right) => identityScore(right[1]) - identityScore(left[1]))[0];
      const semanticAnchors = (selectedIdentity?.[1] || [])
        .sort((a, b) => a.timeSeconds - b.timeSeconds)
        .map(item => ({
          centerX: item.centerX, centerY: item.centerY,
          confidence: item.confidence, timeSeconds: item.timeSeconds,
          source: 'visual', trackId: item.trackId, width: item.width, height: item.height,
        }));
      const motionPoints = motionTimeline.filter(item =>
        !item.sceneCut && !item.trackingGap && item.trackId !== null && item.trackAge >= 2 &&
        item.trackStability >= 0.24 && item.confidence >= 0.22 && item.trackUncertainty <= 0.3
      ).flatMap(item => {
        const confidence = item.predictionConfidence ?? item.trackStability * item.flowConfidence;
        const actual = {
          centerX: item.trackX, centerY: item.trackY,
          confidence: item.trackStability * item.flowConfidence,
          timeSeconds: item.timeSeconds, source: 'motion', motionTrackId: item.trackId,
        };
        const predicted = confidence >= 0.3 ? [{
          centerX: item.predictedTrackX ?? item.trackX,
          centerY: item.predictedTrackY ?? item.trackY,
          confidence: confidence * 0.68,
          timeSeconds: item.timeSeconds + (item.predictionHorizonSeconds || 0.75),
          source: 'prediction', motionTrackId: item.trackId,
        }] : [];
        return [actual, ...predicted];
      });
      const temporalTolerance = Math.min(2.5, Math.max(0.75, duration / Math.max(1, frames.length) * 0.35));
      const fusedPoints = semanticAnchors.length
        ? motionPoints.flatMap(point => {
            let nearest: typeof semanticAnchors[number] | null = null;
            for (const anchor of semanticAnchors) {
              if (!nearest || Math.abs(anchor.timeSeconds - point.timeSeconds) < Math.abs(nearest.timeSeconds - point.timeSeconds)) nearest = anchor;
            }
            if (!nearest || Math.abs(nearest.timeSeconds - point.timeSeconds) > temporalTolerance ||
              Math.hypot(point.centerX - nearest.centerX, point.centerY - nearest.centerY) > 0.22) return [];
            const visualWeight = Math.max(0.32, Math.min(0.78, nearest.confidence * 0.76));
            return [{
              ...point,
              centerX: point.centerX * (1 - visualWeight) + nearest.centerX * visualWeight,
              centerY: point.centerY * (1 - visualWeight) + nearest.centerY * visualWeight,
              confidence: Math.max(point.confidence, nearest.confidence * 0.82),
            }];
          })
        : motionPoints;
      const deduplicated = [...semanticAnchors, ...fusedPoints].sort((a, b) => a.timeSeconds - b.timeSeconds)
        .filter((point, index, all) => index === 0 || point.timeSeconds - all[index - 1].timeSeconds > 0.12);
      const usable = smoothSubjectPath(deduplicated);
      if (!usable.length) throw new Error('No stable subject path was found. Keep the centred crop or adjust it manually.');
      const weightedMedian = (values: Array<{ value: number; weight: number }>) => {
        const sorted = [...values].sort((a, b) => a.value - b.value);
        const total = sorted.reduce((sum, item) => sum + item.weight, 0);
        let accumulated = 0;
        for (const item of sorted) {
          accumulated += item.weight;
          if (accumulated >= total / 2) return item.value;
        }
        return sorted[sorted.length - 1]?.value ?? 0.5;
      };
      const focusX = Math.max(0.05, Math.min(0.95, weightedMedian(usable.map(item => ({ value: item.centerX, weight: Math.max(0.05, item.confidence) })))));
      const focusY = Math.max(0.05, Math.min(0.95, weightedMedian(usable.map(item => ({ value: item.centerY, weight: Math.max(0.05, item.confidence) })))));
      setReframeX(focusX);
      setReframeY(focusY);
      const trackedClips = clips.map(clip => {
        const points = usable.filter(item => item.timeSeconds >= clip.startSeconds && item.timeSeconds <= clip.endSeconds);
        if (points.length < 2) return clip;
        const keyframes = points.map(point => {
          const frame = createMotionKeyframe(clip, point.timeSeconds);
          return {
            ...frame,
            scale: 1.12,
            x: Math.max(-0.22, Math.min(0.22, (focusX - point.centerX) * 0.6)),
            y: Math.max(-0.22, Math.min(0.22, (focusY - point.centerY) * 0.6)),
          };
        });
        return { ...clip, keyframes };
      });
      setClips(trackedClips);
      setReframeEnabled(true);
      const trackedCount = trackedClips.filter((clip, index) => clip !== clips[index]).length;
      setReframeStatus('Tracked ' + (selectedIdentity?.[0] || 'the strongest visible subject') + ' using ' + semanticAnchors.length + ' identity-linked visual detections, ' + fusedPoints.length + ' spatially and temporally matched motion/prediction samples and confidence-aware smoothing. Sparse sampling gaps and scene cuts are not bridged. Added editable predictive tracking keyframes to ' + trackedCount + ' clip(s). Region tracking is still approximate; review the crop before export.');
    } catch (err) {
      setReframeStatus(err instanceof Error ? err.message : 'Smart reframing is unavailable for this source.');
    } finally {
      setBusy('');
    }
  };

  const saveProject = async () => {
    if (!clips.length) {
      setErrorMessage('Add at least one clip before saving an edit plan.');
      return;
    }
    setBusy('save');
    setErrorMessage('');
    try {
      const payload = {
        title: projectTitle,
        clips,
        captions: captions.filter(caption => caption.text.trim().length > 0),
        captionStyle: {
          fontSize: captionFontSize,
          color: captionColor,
          background: captionBackground,
        },
        settings: {
          editInstructions, editScript, editingMode, captionAnimation,
          exportQuality, exportAspect, exportResolution, crossfadeDuration,
          exportVolume, audioCleanup, clipLengthMode, customClipLength,
          reframeEnabled, reframeX, reframeY, exportFormat, sourceAudioEnabled,
        },
      };
      const response = activeProjectId
        ? await api.put('/api/projects/' + encodeURIComponent(activeProjectId), payload)
        : await api.post('/api/projects', payload);
      const saved = response.data.project as Project;
      setActiveProjectId(saved.id);
      setProjects(current => [
        saved,
        ...current.filter(item => item.id !== saved.id),
      ].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
      setErrorMessage('Edit plan saved successfully.');
    } catch (err) {
      setErrorMessage(
        err instanceof Error ? err.message : 'Could not save your project.'
      );
    } finally {
      setBusy('');
    }
  };

  const loadProject = (project: Project) => {
    setActiveProjectId(project.id);
    preserveEditPlanOnNextFile.current = true;
    preserveEndInputOnNextMetadata.current = true;
    setFile(null);
    setVideoUrl('');
    setSourceLabel(project.title || 'Untitled edit');
    setIsRemoteSource(false);
    setDuration(0);
    setPlaybackTime(0);
    setClips(project.clips || []);
    setCaptions(project.captions || []);
    if (project.captionStyle) {
      setCaptionFontSize(project.captionStyle.fontSize || '34');
      setCaptionColor(project.captionStyle.color || '#ffffff');
      setCaptionBackground(project.captionStyle.background || 'dark');
    }
    const settings = project.settings;
    if (settings) {
      setEditInstructions(settings.editInstructions || '');
      setEditScript(settings.editScript || '');
      setEditingMode(settings.editingMode || 'hybrid');
      setCaptionAnimation(settings.captionAnimation || 'none');
      setExportQuality(settings.exportQuality || 'standard');
      setExportAspect(settings.exportAspect || 'original');
      setExportResolution(settings.exportResolution || '1080');
      setExportFormat(settings.exportFormat || 'auto');
      setSourceAudioEnabled(settings.sourceAudioEnabled !== false);
      setCrossfadeDuration(settings.crossfadeDuration || '0.5');
      setExportVolume(Number.isFinite(settings.exportVolume) ? settings.exportVolume : 100);
      setAudioCleanup(Number.isFinite(settings.audioCleanup) ? settings.audioCleanup : 0);
      setClipLengthMode(settings.clipLengthMode || 'ai');
      setCustomClipLength(settings.customClipLength || '15');
      setReframeEnabled(settings.reframeEnabled === true);
      setReframeX(Number.isFinite(settings.reframeX) ? settings.reframeX : 0.5);
      setReframeY(Number.isFinite(settings.reframeY) ? settings.reframeY : 0.5);
    }
    setSuggestions([]);
    setActiveTab('editor');
    setErrorMessage(
      'Edit plan loaded. Re-select the original video file to preview and export these clips.'
    );
  };

  const startNewEdit = () => {
    setActiveProjectId(null);
    preserveEditPlanOnNextFile.current = false;
    preserveEndInputOnNextMetadata.current = false;
    setFile(null);
    setVideoUrl('');
    setSourceLabel('');
    setIsRemoteSource(false);
    setDuration(0);
    setPlaybackTime(0);
    setClips([]);
    setCaptions([]);
    setSuggestions([]);
    setTranscribeProgress(0);
    setStartInput('0');
    setEndInput('5');
    setErrorMessage('');
    setActiveTab('editor');
  };

  const deleteProject = async (id: string) => {
    if (deletingProjectId) return;
    if (!window.confirm('Delete this saved edit plan? This cannot be undone.')) return;
    setDeletingProjectId(id);
    try {
      await api.delete('/api/projects/' + encodeURIComponent(id));
      setProjects(current => current.filter(project => project.id !== id));
      if (activeProjectId === id) setActiveProjectId(null);
      setErrorMessage('Edit plan deleted.');
    } catch {
      setErrorMessage('Could not delete that project. Please try again.');
    } finally {
      setDeletingProjectId(null);
    }
  };

  const transcribeVideo = async () => {
    if (!file || isRemoteSource) {
      setErrorMessage('Choose a video file from your device to generate captions. Direct links are not supported for transcription yet.');
      return;
    }
    if (duration > 1200) {
      setErrorMessage('Automatic captions currently support videos up to 20 minutes long.');
      return;
    }
    setBusy('transcribe');
    setErrorMessage('');
    setCaptions([]);
    setTranscribeProgress(0);
    let audioContext: AudioContext | null = null;
    try {
      audioContext = new AudioContext();
      const decoded = await audioContext.decodeAudioData(await file.arrayBuffer());
      if (!decoded.numberOfChannels || decoded.length === 0) {
        throw new Error('No usable audio track was found in this video.');
      }
      if (decoded.duration > 1200) {
        throw new Error('Automatic captions currently support videos up to 20 minutes long.');
      }
      const chunkSeconds = 45;
      const generated: Caption[] = [];
      const chunkCount = Math.ceil(decoded.duration / chunkSeconds);
      let captionLimitReached = false;
      for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
        const startSeconds = chunkIndex * chunkSeconds;
        const endSeconds = Math.min(decoded.duration, startSeconds + chunkSeconds);
        const audioData = encodeWavChunk(decoded, startSeconds, endSeconds);
        const response = await api.post('/api/transcribe', {
          audioData,
          startSeconds,
        });
        const segments = Array.isArray(response.data.segments) ? response.data.segments : [];
        for (let index = 0; index < segments.length; index += 1) {
          if (generated.length >= 1000) {
            captionLimitReached = true;
            break;          }
          const segment = segments[index] as { startSeconds: number; endSeconds: number; text: string };
          const localStart = Math.max(0, Math.min(endSeconds - startSeconds, Number(segment.startSeconds)));
          const localEnd = Math.max(localStart, Math.min(endSeconds - startSeconds, Number(segment.endSeconds)));
          const text = String(segment.text || '').trim().slice(0, 220);
          if (text && localEnd > localStart) {
            generated.push({
              id: chunkIndex + '-' + index + '-' + Math.round(localStart * 100),
              startSeconds: Number((startSeconds + localStart).toFixed(2)),
              endSeconds: Number((startSeconds + localEnd).toFixed(2)),
              text,
            });
          }
        }
        generated.sort((a, b) => a.startSeconds - b.startSeconds);
        setCaptions([...generated]);
        setTranscribeProgress(Math.round(((chunkIndex + 1) / chunkCount) * 100));
        if (captionLimitReached) break;
      }
      if (captionLimitReached) {
        setErrorMessage('The 1,000-caption limit was reached. Your first 1,000 captions are ready to edit and save.');
      }
      if (!generated.length) {
        setErrorMessage('No clear speech was detected. You can still add clips manually or try a video with clearer audio.');
      }
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Caption transcription failed. Please try again.');
    } finally {
      if (audioContext && audioContext.state !== 'closed') await audioContext.close().catch(() => undefined);
      setBusy('');
    }
  };

  const analyzeBeats = async () => {
    if (!file || isRemoteSource) {
      setBeatStatus('Beat detection currently needs a local video file with audio.');
      return;
    }
    if (duration > 300 || file.size > 50 * 1024 * 1024) {
      setBeatStatus('For browser memory safety, beat detection supports local videos up to 5 minutes and 50 MB.');
      return;
    }
    setBusy('beats');
    setBeatStatus('Decoding local audio and detecting likely rhythmic onsets…');
    setBeatPoints([]);
    let audioContext: AudioContext | null = null;
    try {
      audioContext = new AudioContext();
      const decoded = await audioContext.decodeAudioData(await file.arrayBuffer());
      if (!decoded.length || !decoded.numberOfChannels) throw new Error('No usable audio track was found.');
      const hop = Math.max(1, Math.floor(decoded.sampleRate * 0.05));
      const windowCount = Math.floor(decoded.length / hop);
      const envelope = new Float32Array(windowCount);
      const transientEnvelope = new Float32Array(windowCount);
      const channels = Array.from({ length: decoded.numberOfChannels }, (_, channel) => decoded.getChannelData(channel));
      let previousMono = 0;
      for (let windowIndex = 0; windowIndex < windowCount; windowIndex += 1) {
        const start = windowIndex * hop;
        const end = Math.min(decoded.length, start + hop);
        let energy = 0;
        let transientEnergy = 0;
        let count = 0;
        for (let sample = start; sample < end; sample += 4) {
          let mono = 0;
          for (const channel of channels) mono += channel[sample] || 0;
          mono /= channels.length;
          energy += mono * mono;
          transientEnergy += Math.abs(mono - previousMono);
          previousMono = mono;
          count += 1;
        }
        envelope[windowIndex] = Math.sqrt(energy / Math.max(1, count));
        transientEnvelope[windowIndex] = transientEnergy / Math.max(1, count);
      }
      const flux = new Float32Array(windowCount);
      let sum = 0;
      let squareSum = 0;
      for (let index = 1; index < windowCount; index += 1) {
        const energyRise = Math.max(0, envelope[index] - envelope[index - 1]);
        const transientRise = Math.max(0, transientEnvelope[index] - transientEnvelope[index - 1]);
        // Combine loudness change with broadband transients to catch quieter percussion.
        flux[index] = energyRise * 0.55 + transientRise * 0.45;
        sum += flux[index];
        squareSum += flux[index] * flux[index];
      }
      const mean = sum / Math.max(1, windowCount - 1);
      const deviation = Math.sqrt(Math.max(0, squareSum / Math.max(1, windowCount - 1) - mean * mean));
      const threshold = mean + deviation * 0.65;
      const candidates: Array<{ time: number; strength: number }> = [];
      for (let index = 2; index < windowCount - 2; index += 1) {
        if (flux[index] >= threshold && flux[index] >= flux[index - 1] && flux[index] > flux[index + 1]) candidates.push({ time: index * 0.05, strength: flux[index] });
      }
      candidates.sort((a, b) => b.strength - a.strength);
      const chosen: number[] = [];
      for (const candidate of candidates) {
        if (chosen.every(time => Math.abs(time - candidate.time) >= 0.32)) chosen.push(candidate.time);
        if (chosen.length >= 80) break;
      }
      const points = chosen.sort((a, b) => a - b).filter(time => time < decoded.duration - 0.4);
      setBeatPoints(points);
      setBeatStatus(points.length
        ? 'Found ' + points.length + ' likely rhythmic onsets. These are suggestions, not a guaranteed musical beat grid.'
        : 'No reliable rhythmic onsets were detected. Try a clearer music section or keep using manual cuts.');
    } catch (err) {
      setBeatStatus(err instanceof Error ? err.message : 'Audio decoding or beat detection failed. You can continue editing manually.');
    } finally {
      if (audioContext && audioContext.state !== 'closed') await audioContext.close().catch(() => undefined);
      setBusy('');
    }
  };

  const applyBeatCuts = () => {
    if (!clips.length) {
      setErrorMessage('Add at least one timeline clip before applying beat cuts.');
      return;
    }
    if (!beatPoints.length) return;
    const next: Clip[] = [];
    clips.forEach((clip, clipIndex) => {
      const cuts = beatPoints.filter(time => time > clip.startSeconds + 0.35 && time < clip.endSeconds - 0.35);
      const segments = cuts.length
        ? [clip.startSeconds, ...cuts, clip.endSeconds].slice(1).map((end, index) => ({
            ...clip,
            startSeconds: Number(([clip.startSeconds, ...cuts][index]).toFixed(2)),
            endSeconds: Number(end.toFixed(2)),
            reason: clip.reason || 'Beat-synced segment',
          }))
        : [clip];
      const remainingOriginals = clips.length - clipIndex - 1;
      if (next.length + segments.length + remainingOriginals > 20) next.push(clip);
      else next.push(...segments);
    });
    setClips(next);
    setErrorMessage('Applied detected onset cuts where the existing clip ranges allowed. Review the new segments before export.');
  };

  const applyEditingPreset = () => {
    const presets = {
      tiktok: { name: 'TikTok', aspect: '9:16' as const, resolution: '1080' as const, quality: 'standard' as const, crossfade: '0.5', fontSize: '42', color: '#ffe36e', background: 'dark' as const, animation: 'pop' as const, clipLength: '15', guidance: 'Use fast-paced vertical storytelling with a strong opening hook, short supporting moments, bold captions and quick transitions. Keep the most compelling moment near the start.' },
      'youtube-shorts': { name: 'YouTube Shorts', aspect: '9:16' as const, resolution: '1080' as const, quality: 'standard' as const, crossfade: '0.8', fontSize: '34', color: '#ffffff', background: 'dark' as const, animation: 'fade' as const, clipLength: '20', guidance: 'Use a clear hook, balanced pacing and a simple narrative arc. Keep captions readable and let important moments breathe.' },
      'instagram-reels': { name: 'Instagram Reels', aspect: '9:16' as const, resolution: '1080' as const, quality: 'standard' as const, crossfade: '0.5', fontSize: '34', color: '#ffffff', background: 'dark' as const, animation: 'fade' as const, clipLength: '15', guidance: 'Create a polished vertical edit with a quick opening, visually clear moments and concise captions. Use smooth transitions without slowing the story.' },
    };
    const preset = presets[editingPreset];
    setExportAspect(preset.aspect);
    setExportResolution(preset.resolution);
    setExportQuality(preset.quality);
    setCrossfadeDuration(preset.crossfade);
    setCaptionFontSize(preset.fontSize);
    setCaptionColor(preset.color);
    setCaptionBackground(preset.background);
    setCaptionAnimation(preset.animation);
    setClipLengthMode('fixed');
    setCustomClipLength(preset.clipLength);
    setEditInstructions(current => current.trim() ? current + '\n\nPreset guidance: ' + preset.guidance : preset.guidance);
    setErrorMessage(preset.name + ' preset applied. Review the settings and customise anything before exporting.');
  };

  const handleBrandLogoChange = (chosen?: File) => {
    if (!chosen) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(chosen.type) || chosen.size > 500000) {
      setErrorMessage('Choose a PNG, JPEG or WebP logo smaller than 500 KB. It stays in this browser.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const value = String(reader.result || '');
      if (!value.startsWith('data:image/')) {
        setErrorMessage('The logo could not be read. Try another image file.');
        return;
      }
      setBrandLogoData(value);
      setErrorMessage('Logo added to your local brand kit. Save the kit to keep it for this account in this browser.');
    };
    reader.onerror = () => setErrorMessage('The logo file could not be read.');
    reader.readAsDataURL(chosen);
  };

  const saveBrandKit = () => {
    if (!user || !brandKitReady || brandKitOwner.current !== user.userId) {
      setErrorMessage('Your brand kit is still loading. Try again in a moment.');
      return;
    }
    try {
      window.localStorage.setItem('clipforge:brand-kit:' + user.userId, JSON.stringify({
        logoDataUrl: brandLogoData,
        primaryColor: brandPrimaryColor,
        secondaryColor: brandSecondaryColor,
        fontFamily: brandFontFamily,
        captionFontSize,
        captionColor,
        captionBackground,
        captionAnimation,
      }));
      setErrorMessage('Brand kit saved locally for this signed-in account. It is not cloud-synced.');
    } catch {
      setErrorMessage('The brand kit could not be saved. Try a smaller logo or remove unused browser data.');
    }
  };

  const applyBrandStyleToCaptions = () => {
    setCaptionColor(brandPrimaryColor);
    setCaptionBackground('dark');
    setErrorMessage('Brand colour applied to captions. The selected font and logo will also be used in exports.');
  };

  const saveProjectVersion = () => {
    if (!user || !activeProjectId) {
      setErrorMessage('Save the edit plan to your project library before creating a named version.');
      return;
    }
    const snapshot: ProjectVersion = {
      id: Date.now().toString() + '-' + Math.random().toString(36).slice(2, 7),
      name: versionName.trim().slice(0, 80) || 'Version ' + (projectVersions.length + 1),
      savedAt: new Date().toISOString(),
      clips: [...clips],
      captions: [...captions],
      captionFontSize,
      captionColor,
      captionBackground,
      captionAnimation,
      exportQuality,
      exportAspect,
      exportResolution,
      crossfadeDuration,
      exportVolume,
      audioCleanup,
      exportFormat,
      sourceAudioEnabled,
      editInstructions,
      editScript,
      editingMode,
      clipLengthMode,
      customClipLength,
      reframeEnabled,
      reframeX,
      reframeY,
    };
    const next = [snapshot, ...projectVersions].slice(0, 20);
    try {
      window.localStorage.setItem('clipforge:versions:' + user.userId + ':' + activeProjectId, JSON.stringify(next));
      setProjectVersions(next);
      setVersionName('');
      setErrorMessage('Saved ' + snapshot.name + ' to this browser’s local version history.');
    } catch {
      setErrorMessage('Version history could not be saved in this browser. Your current edit remains intact.');
    }
  };

  const restoreProjectVersion = (version: ProjectVersion) => {
    if (!window.confirm('Restore "' + version.name + '"? This replaces the current unsaved edit state.')) return;
    if (!Array.isArray(version.clips) || !Array.isArray(version.captions)) {
      setErrorMessage('That local version is incomplete and cannot be restored.');
      return;
    }
    setClips(version.clips);
    setCaptions(version.captions);
    setCaptionFontSize(version.captionFontSize);
    setCaptionColor(version.captionColor);
    setCaptionBackground(version.captionBackground);
    setCaptionAnimation(version.captionAnimation);
    setExportQuality(version.exportQuality);
    setExportAspect(version.exportAspect);
    setExportResolution(version.exportResolution);
    setCrossfadeDuration(version.crossfadeDuration);
    setExportVolume(version.exportVolume);
    setAudioCleanup(version.audioCleanup);
    setExportFormat(version.exportFormat || 'auto');
    setSourceAudioEnabled(version.sourceAudioEnabled !== false);
    setEditInstructions(version.editInstructions);
    setEditScript(version.editScript);
    setEditingMode(version.editingMode || 'hybrid');
    setClipLengthMode(version.clipLengthMode);
    setCustomClipLength(version.customClipLength);
    setReframeEnabled(version.reframeEnabled);
    setReframeX(version.reframeX);
    setReframeY(version.reframeY);
    setErrorMessage('Restored ' + version.name + '. Re-select the original video if the source is not currently loaded.');
  };

  const drawBrandLogo = (context: CanvasRenderingContext2D, width: number, height: number) => {
    const logo = brandLogoImage.current;
    if (!logo || !logo.complete || !logo.naturalWidth || !logo.naturalHeight) return;
    const maxWidth = width * 0.16;
    const maxHeight = height * 0.12;
    const scale = Math.min(maxWidth / logo.naturalWidth, maxHeight / logo.naturalHeight);
    const logoWidth = logo.naturalWidth * scale;
    const logoHeight = logo.naturalHeight * scale;
    const x = width - logoWidth - width * 0.04;
    const y = height * 0.04;
    context.save();
    context.fillStyle = brandSecondaryColor;
    context.globalAlpha = 0.72;
    context.fillRect(x - 6, y - 6, logoWidth + 12, logoHeight + 12);
    context.globalAlpha = 0.96;
    context.drawImage(logo, x, y, logoWidth, logoHeight);
    context.restore();
  };

  const exportClip = async (clip: Clip, index: number) => {
    const video = videoRef.current;
    if (!video || !videoUrl) {
      setErrorMessage('Choose the original video before exporting.');
      return;
    }
    if (!('captureStream' in video) || !('MediaRecorder' in window)) {
      setErrorMessage('This browser does not support in-browser video export. Try the latest Chrome.');
      return;
    }
    if (!Number.isFinite(clip.startSeconds) || !Number.isFinite(clip.endSeconds) || clip.startSeconds < 0 || clip.endSeconds <= clip.startSeconds || clip.endSeconds > duration) {
      setErrorMessage('This clip has an invalid time range. Edit its in and out points before exporting.');
      return;
    }
    if (!video.videoWidth || !video.videoHeight) {
      setErrorMessage('The video is not ready to export yet. Wait for it to finish loading, then try again.');
      return;
    }
    const mimeType = getSupportedExportMimeType(exportFormat);
    if (!mimeType) {
      setErrorMessage('The selected export format is not supported by this browser. Choose Auto or another available format.');
      return;
    }
    setBusy('export-' + index);
    setExportProgress({ label: 'Preparing clip export…', percent: 0 });
    setErrorMessage('');
    const originalPlaybackRate = video.playbackRate;
    video.playbackRate = 1;
    let streams: MediaStream[] = [];
    let frameRequest = 0;
    let stopListener: (() => void) | null = null;
    let activeRecorder: MediaRecorder | null = null;
    let exportAudioContext: AudioContext | null = null;
    let denoiser: { stream: MediaStream; destroy: () => void } | null = null;
    let exportTimeout = 0;
    try {
      const sourceStream = video.captureStream();
      const canvas = document.createElement('canvas');
      const dimensions = getExportDimensions(video.videoWidth, video.videoHeight, exportAspect, exportResolution);
      canvas.width = dimensions.width;
      canvas.height = dimensions.height;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Caption rendering is unavailable in this browser.');
      const { stream: canvasStream, requestFrame: requestCanvasFrame } = createCanvasCapture(canvas);
      const outputAudioTracks: MediaStreamTrack[] = [];
      if (sourceAudioEnabled && sourceStream.getAudioTracks().length > 0) {
        exportAudioContext = new AudioContext({ sampleRate: 48000 });
        const sourceAudioStream = new MediaStream(sourceStream.getAudioTracks());
        let audioInputStream = sourceAudioStream;
        if (audioCleanup > 0) {
          if (!exportAudioContext.audioWorklet) {
            throw new Error('AI noise reduction needs AudioWorklet support. Set noise reduction to 0 to export without it.');
          }
          const { denoiseStream } = await import('@lofcz/deepfilternet-web');
          denoiser = await denoiseStream(sourceAudioStream, {
            context: exportAudioContext,
            attenuationLimit: Math.round(10 + audioCleanup * 0.4),
          });
          audioInputStream = denoiser.stream;
          streams.push(denoiser.stream);
        }
        const audioSource = exportAudioContext.createMediaStreamSource(audioInputStream);
        const volumeNode = exportAudioContext.createGain();
        const audioDestination = exportAudioContext.createMediaStreamDestination();
        volumeNode.gain.value = (exportVolume / 100) * (Math.max(0, Math.min(150, clip.volume ?? 100)) / 100);
        audioSource.connect(volumeNode);
        volumeNode.connect(audioDestination);
        await exportAudioContext.resume();
        outputAudioTracks.push(...audioDestination.stream.getAudioTracks());
        streams.push(audioDestination.stream);
      }
      const stream = new MediaStream([
        ...canvasStream.getVideoTracks(),
        ...outputAudioTracks,
      ]);
      streams = [...streams, sourceStream, canvasStream, stream];
      const videoBitrate = exportQuality === 'high' ? 8_000_000 : exportQuality === 'compact' ? 1_500_000 : 4_000_000;
      const createdRecorder = createExportRecorder(stream, exportFormat, videoBitrate);
      const recorder = createdRecorder.recorder;
      const actualMimeType = createdRecorder.mimeType;
      activeRecorder = recorder;
      const drawFrame = () => {
        drawCoverFrame(context, video, canvas.width, canvas.height, reframeEnabled ? reframeX : 0.5, reframeEnabled ? reframeY : 0.5, getClipMotion(clip, video.currentTime));
        drawBrandLogo(context, canvas.width, canvas.height);
        const active = captions.find(item => video.currentTime >= item.startSeconds && video.currentTime <= item.endSeconds);
        if (active) {
          const animationProgress = captionAnimation === 'none'
            ? 1
            : Math.max(0, Math.min(1, (video.currentTime - active.startSeconds) / 0.32));
          context.save();
          if (captionAnimation === 'fade') context.globalAlpha *= animationProgress;
          if (captionAnimation === 'pop') {
            const scale = 0.84 + 0.16 * animationProgress;
            context.translate(canvas.width / 2, canvas.height / 2);
            context.scale(scale, scale);
            context.translate(-canvas.width / 2, -canvas.height / 2);
          }
          const baseFontSize = Number(captionFontSize) * (canvas.width / 1280);
          const maxTextWidth = canvas.width * 0.86;
          const captionLayout = fitCaptionLines(context, active.text, baseFontSize, brandFontFamily, maxTextWidth, 3);
          const fontSize = captionLayout.fontSize;
          const visibleLines = captionLayout.lines;
          context.textAlign = 'center';
          context.textBaseline = 'middle';
          const lineHeight = fontSize * 1.22;
          const boxHeight = visibleLines.length * lineHeight + fontSize * 0.65;
          const boxWidth = Math.min(maxTextWidth + fontSize, Math.max(...visibleLines.map(value => context.measureText(value).width)) + fontSize);
          const x = (canvas.width - boxWidth) / 2;
          const captionSafeBottom = exportAspect === '9:16' ? 0.16 : exportAspect === '1:1' ? 0.10 : 0.07;
          const y = canvas.height - boxHeight - canvas.height * captionSafeBottom;
          if (captionBackground === 'dark') {
            context.fillStyle = 'rgba(0, 0, 0, 0.76)';
            context.fillRect(x, y, boxWidth, boxHeight);
          }
          context.lineJoin = 'round';
          context.lineWidth = Math.max(2, fontSize * 0.09);
          context.strokeStyle = 'rgba(0, 0, 0, 0.84)';
          context.fillStyle = captionColor;
          visibleLines.forEach((value, lineIndex) => {
            const textY = y + fontSize * 0.42 + lineHeight * (lineIndex + 0.5);
            context.strokeText(value, canvas.width / 2, textY, maxTextWidth);
            context.fillText(value, canvas.width / 2, textY, maxTextWidth);
          });
          context.restore();
        }
        requestCanvasFrame();
        if (recorder.state !== 'inactive' && video.currentTime < clip.endSeconds) {
          frameRequest = requestAnimationFrame(drawFrame);
        }
      };
      const chunks: BlobPart[] = [];
      recorder.ondataavailable = event => {
        if (event.data.size) chunks.push(event.data);
      };
      const finished = new Promise<Blob>((resolve, reject) => {
        recorder.onstop = () => resolve(new Blob(chunks, { type: actualMimeType.split(';')[0] }));
        recorder.onerror = () => reject(new Error('The browser could not finish this export.'));
      });
      video.pause();
      if (Math.abs(video.currentTime - clip.startSeconds) >= 0.05) {
        await new Promise<void>((resolve, reject) => {
          const timeout = window.setTimeout(() => { cleanup(); reject(new Error('The video took too long to seek to the clip start.')); }, 15000);
          const cleanup = () => {
            window.clearTimeout(timeout);
            video.removeEventListener('seeked', onSeeked);
            video.removeEventListener('error', onError);
          };
          const onSeeked = () => { cleanup(); resolve(); };
          const onError = () => { cleanup(); reject(new Error('Could not seek to the clip start.')); };
          video.addEventListener('seeked', onSeeked, { once: true });
          video.addEventListener('error', onError, { once: true });
          video.currentTime = clip.startSeconds;
        });
      }
      recorder.start(250);
      const stopAtEnd = () => {
        const progress = Math.max(0, Math.min(100, (video.currentTime - clip.startSeconds) / (clip.endSeconds - clip.startSeconds) * 100));
        setExportProgress({ label: 'Rendering clip…', percent: progress });
        if (video.currentTime >= clip.endSeconds) {
          video.pause();
          video.removeEventListener('timeupdate', stopAtEnd);
          cancelAnimationFrame(frameRequest);
          if (recorder.state !== 'inactive') recorder.stop();
        }
      };
      stopListener = stopAtEnd;
      video.addEventListener('timeupdate', stopAtEnd);
      await video.play();
      drawFrame();
      stopAtEnd();
      const timeoutMs = Math.max(30000, (clip.endSeconds - clip.startSeconds) * 5000);
      const timeoutPromise = new Promise<never>((_, reject) => {
        exportTimeout = window.setTimeout(() => reject(new Error('Clip export timed out. Try a shorter clip or lower export quality.')), timeoutMs);
      });
      const blob = await Promise.race([finished, timeoutPromise]);
      if (!blob.size) throw new Error('The exported clip was empty. Please try again.');
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'clipforge-' + (index + 1) + '.' + getExportFileExtension(blob.type || actualMimeType);
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1500);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Export failed. Please try again.');
    } finally {
      if (exportTimeout) window.clearTimeout(exportTimeout);
      if (frameRequest) cancelAnimationFrame(frameRequest);
      if (stopListener && video) video.removeEventListener('timeupdate', stopListener);
      if (video) {
        video.pause();
        video.playbackRate = originalPlaybackRate;
      }
      if (activeRecorder && activeRecorder.state !== 'inactive') activeRecorder.stop();
      denoiser?.destroy();
      streams.forEach(stream => stream.getTracks().forEach(track => track.stop()));
      if (exportAudioContext && exportAudioContext.state !== 'closed') {
        await exportAudioContext.close().catch(() => undefined);
      }
      setBusy('');
      setExportProgress(null);
    }
  };


  const exportSequence = async () => {
    const orderedClips = [...clips];
    if (orderedClips.length < 2) {
      setErrorMessage('Add at least two clips before exporting a sequence.');
      return;
    }
    if (!videoUrl || !('MediaRecorder' in window)) {
      setErrorMessage('Choose a video and use a recent Chrome browser to export a sequence.');
      return;
    }
    if (orderedClips.some(clip => !Number.isFinite(clip.startSeconds) || !Number.isFinite(clip.endSeconds) || clip.startSeconds < 0 || clip.endSeconds <= clip.startSeconds || clip.endSeconds > duration)) {
      setErrorMessage('One or more clips have invalid time ranges. Correct them before exporting the sequence.');
      return;
    }
    const mimeType = getSupportedExportMimeType(exportFormat);
    if (!mimeType) {
      setErrorMessage('The selected export format is not supported by this browser. Choose Auto or another available format.');
      return;
    }

    setBusy('sequence');
    setExportProgress({ label: 'Preparing sequence export…', percent: 0 });
    setErrorMessage('');
    const mediaVideos: HTMLVideoElement[] = [];
    const mediaStreams: MediaStream[] = [];
    let audioContext: AudioContext | null = null;
    let sequenceDenoiser: { stream: MediaStream; destroy: () => void } | null = null;
    let animationFrame = 0;
    let recorder: MediaRecorder | null = null;
    let recorderFinishTimeout = 0;

    try {
      const preview = videoRef.current;
      const widthSource = preview?.videoWidth || 1280;
      const heightSource = preview?.videoHeight || 720;
      const dimensions = getExportDimensions(widthSource, heightSource, exportAspect, exportResolution);
      const canvas = document.createElement('canvas');
      canvas.width = dimensions.width;
      canvas.height = dimensions.height;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Sequence rendering is unavailable in this browser.');

      const makeVideo = () => {
        const element = document.createElement('video');
        element.crossOrigin = 'anonymous';
        element.preload = 'auto';
        element.playsInline = true;
        element.muted = false;
        mediaVideos.push(element);
        return element;
      };
      const firstVideo = makeVideo();
      const secondVideo = makeVideo();
      await Promise.all(mediaVideos.map(element => new Promise<void>((resolve, reject) => {
        const timeout = window.setTimeout(() => { cleanup(); reject(new Error('The source video took too long to load for sequence export.')); }, 20000);
        const cleanup = () => {
          window.clearTimeout(timeout);
          element.removeEventListener('loadedmetadata', onReady);
          element.removeEventListener('error', onError);
        };
        const onReady = () => { cleanup(); resolve(); };
        const onError = () => { cleanup(); reject(new Error('The source video could not be loaded for sequence export.')); };
        element.addEventListener('loadedmetadata', onReady, { once: true });
        element.addEventListener('error', onError, { once: true });
        element.src = videoUrl;
        element.load();
      })));

      const seekTo = async (element: HTMLVideoElement, seconds: number) => {
        if (Math.abs(element.currentTime - seconds) < 0.04) return;
        await new Promise<void>((resolve, reject) => {
          const timeout = window.setTimeout(() => { cleanup(); reject(new Error('The video took too long to seek to a clip boundary.')); }, 15000);
          const cleanup = () => {
            window.clearTimeout(timeout);
            element.removeEventListener('seeked', onSeeked);
            element.removeEventListener('error', onError);
          };
          const onSeeked = () => { cleanup(); resolve(); };
          const onError = () => { cleanup(); reject(new Error('Could not seek to a clip boundary.')); };
          element.addEventListener('seeked', onSeeked, { once: true });
          element.addEventListener('error', onError, { once: true });
          element.currentTime = seconds;
        });
      };
      const nextFrame = () => new Promise<void>(resolve => {
        requestAnimationFrame(() => resolve());
      });
      const waitUntil = async (condition: () => boolean, timeoutMs = 180000) => {
        const deadline = performance.now() + timeoutMs;
        while (!condition()) {
          if (performance.now() >= deadline) {
            throw new Error('Sequence playback stalled before the next clip boundary. Try a shorter clip or reload the video.');
          }
          await nextFrame();
        }
      };

      audioContext = new AudioContext({ sampleRate: 48000 });
      const destination = audioContext.createMediaStreamDestination();
      const audioNodes = mediaVideos.map(element => {
        const source = audioContext!.createMediaElementSource(element);
        const gain = audioContext!.createGain();
        gain.gain.value = 0;
        source.connect(gain);
        gain.connect(destination);
        return { source, gain };
      });
      await audioContext.resume();
      let audioOutputStream = destination.stream;
      if (audioCleanup > 0) {
        if (!audioContext.audioWorklet) {
          throw new Error('AI noise reduction needs AudioWorklet support. Set noise reduction to 0 to export without it.');
        }
        const { denoiseStream } = await import('@lofcz/deepfilternet-web');
        sequenceDenoiser = await denoiseStream(destination.stream, {
          context: audioContext,
          attenuationLimit: Math.round(10 + audioCleanup * 0.4),
        });
        audioOutputStream = sequenceDenoiser.stream;
        mediaStreams.push(sequenceDenoiser.stream);
      }

      const drawLayer = (element: HTMLVideoElement, opacity: number) => {
        if (opacity <= 0) return;
        context.globalAlpha = opacity;
        const activeClip = orderedClips.find(clip => element.currentTime >= clip.startSeconds && element.currentTime <= clip.endSeconds);
        drawCoverFrame(context, element, canvas.width, canvas.height, reframeEnabled ? reframeX : 0.5, reframeEnabled ? reframeY : 0.5, activeClip ? getClipMotion(activeClip, element.currentTime) : { scale: 1, x: 0, y: 0, opacity: 1, rotation: 0 });
        drawBrandLogo(context, canvas.width, canvas.height);
        const active = captions.find(item =>
          element.currentTime >= item.startSeconds &&
          element.currentTime <= item.endSeconds
        );
        if (active) {
          const animationProgress = captionAnimation === 'none'
            ? 1
            : Math.max(0, Math.min(1, (element.currentTime - active.startSeconds) / 0.32));
          context.save();
          if (captionAnimation === 'fade') context.globalAlpha *= animationProgress;
          if (captionAnimation === 'pop') {
            const scale = 0.84 + 0.16 * animationProgress;
            context.translate(canvas.width / 2, canvas.height / 2);
            context.scale(scale, scale);
            context.translate(-canvas.width / 2, -canvas.height / 2);
          }
          const baseFontSize = Number(captionFontSize) * (canvas.width / 1280);
          const maxTextWidth = canvas.width * 0.86;
          const captionLayout = fitCaptionLines(context, active.text, baseFontSize, brandFontFamily, maxTextWidth, 3);
          const fontSize = captionLayout.fontSize;
          const visibleLines = captionLayout.lines;
          context.textAlign = 'center';
          context.textBaseline = 'middle';
          const lineHeight = fontSize * 1.22;
          const boxHeight = visibleLines.length * lineHeight + fontSize * 0.65;
          const boxWidth = Math.min(
            maxTextWidth + fontSize,
            Math.max(...visibleLines.map(value => context.measureText(value).width)) + fontSize
          );
          const x = (canvas.width - boxWidth) / 2;
          const captionSafeBottom = exportAspect === '9:16' ? 0.16 : exportAspect === '1:1' ? 0.10 : 0.07;
          const y = canvas.height - boxHeight - canvas.height * captionSafeBottom;
          if (captionBackground === 'dark') {
            context.fillStyle = 'rgba(0, 0, 0, 0.76)';
            context.fillRect(x, y, boxWidth, boxHeight);
          }
          context.lineJoin = 'round';
          context.lineWidth = Math.max(2, fontSize * 0.09);
          context.strokeStyle = 'rgba(0, 0, 0, 0.84)';
          context.fillStyle = captionColor;
          visibleLines.forEach((value, lineIndex) => {
            const textY = y + fontSize * 0.42 + lineHeight * (lineIndex + 0.5);
            context.strokeText(value, canvas.width / 2, textY, maxTextWidth);
            context.fillText(value, canvas.width / 2, textY, maxTextWidth);
          });
          context.restore();
        }
        context.globalAlpha = 1;
      };

      let visibleVideo = firstVideo;
      let visibleIndex = 0;
      let completedOutputSeconds = 0;
      let progressClip = orderedClips[0];
      let lastProgressUpdate = 0;
      const totalOutputSeconds = orderedClips.reduce((sum, clip) => sum + clip.endSeconds - clip.startSeconds, 0) - orderedClips.slice(0, -1).reduce((sum, clip, index) => sum + Math.min(Number(crossfadeDuration), (clip.endSeconds - clip.startSeconds) / 2, (orderedClips[index + 1].endSeconds - orderedClips[index + 1].startSeconds) / 2), 0);
      const { stream: canvasStream, requestFrame: requestCanvasFrame } = createCanvasCapture(canvas);
      const outputStream = new MediaStream([
        ...canvasStream.getVideoTracks(),
        ...audioOutputStream.getAudioTracks(),
      ]);
      mediaStreams.push(canvasStream, destination.stream, outputStream);

      const videoBitrate = exportQuality === 'high'
        ? 8_000_000
        : exportQuality === 'compact' ? 1_500_000 : 4_000_000;
      const createdRecorder = createExportRecorder(outputStream, exportFormat, videoBitrate);
      recorder = createdRecorder.recorder;
      const actualMimeType = createdRecorder.mimeType;
      const chunks: BlobPart[] = [];
      recorder.ondataavailable = event => {
        if (event.data.size) chunks.push(event.data);
      };
      const finished = new Promise<Blob>((resolve, reject) => {
        recorder!.onstop = () => resolve(new Blob(chunks, { type: actualMimeType.split(';')[0] }));
        recorder!.onerror = () => reject(new Error('The browser could not finish the sequence export.'));
      });

      // Keep visual opacity separate from the audio gain: muting audio must
      // never mute the picture, and the two crossfades must remain independent.
      let firstOpacity = 1;
      let secondOpacity = 0;
      const render = () => {
        context.clearRect(0, 0, canvas.width, canvas.height);
        drawLayer(firstVideo, firstOpacity);
        drawLayer(secondVideo, secondOpacity);
        requestCanvasFrame();
        const now = performance.now();
        if (now - lastProgressUpdate > 300) {
          const elapsed = completedOutputSeconds + Math.max(0, visibleVideo.currentTime - progressClip.startSeconds);
          setExportProgress({ label: 'Rendering sequence…', percent: Math.max(0, Math.min(99, elapsed / Math.max(0.1, totalOutputSeconds) * 100)) });
          lastProgressUpdate = now;
        }
        animationFrame = requestAnimationFrame(render);
      };

      await seekTo(visibleVideo, orderedClips[0].startSeconds);
      const masterGain = sourceAudioEnabled ? exportVolume / 100 : 0;
      audioNodes[0].gain.gain.value = masterGain * (Math.max(0, Math.min(150, orderedClips[0].volume ?? 100)) / 100);
      recorder.start(250);
      render();
      await visibleVideo.play();

      for (let index = 0; index < orderedClips.length - 1; index += 1) {
        const currentClip = orderedClips[index];
        const nextClip = orderedClips[index + 1];
        const currentDuration = currentClip.endSeconds - currentClip.startSeconds;
        const nextDuration = nextClip.endSeconds - nextClip.startSeconds;
        const fadeDuration = Math.min(
          Number(crossfadeDuration),
          currentDuration / 2,
          nextDuration / 2
        );
        const fadeStart = currentClip.endSeconds - fadeDuration;

        await waitUntil(
          () => visibleVideo.currentTime >= fadeStart,
          15000 + Math.max(0, fadeStart - visibleVideo.currentTime) * 3000
        );
        const nextVideo = visibleIndex === 0 ? secondVideo : firstVideo;
        const nextNode = audioNodes[visibleIndex === 0 ? 1 : 0];
        const currentNode = audioNodes[visibleIndex];
        await seekTo(nextVideo, nextClip.startSeconds);
        nextNode.gain.gain.value = 0;
        await nextVideo.play();

        const fadeEnd = nextClip.startSeconds + fadeDuration;
        const fadeDeadline = performance.now() + Math.max(15000, fadeDuration * 5000);
        while (visibleVideo.currentTime < currentClip.endSeconds && nextVideo.currentTime < fadeEnd) {
          if (performance.now() >= fadeDeadline) {
            throw new Error('Sequence crossfade stalled. Try a shorter clip or reload the video.');
          }
          const progress = Math.max(0, Math.min(1, (nextVideo.currentTime - nextClip.startSeconds) / fadeDuration));
          currentNode.gain.gain.value = (1 - progress) * masterGain * (Math.max(0, Math.min(150, currentClip.volume ?? 100)) / 100);
          nextNode.gain.gain.value = progress * masterGain * (Math.max(0, Math.min(150, nextClip.volume ?? 100)) / 100);
          if (visibleIndex === 0) {
            firstOpacity = 1 - progress;
            secondOpacity = progress;
          } else {
            secondOpacity = 1 - progress;
            firstOpacity = progress;
          }
          await nextFrame();
        }

        visibleVideo.pause();
        currentNode.gain.gain.value = 0;
        nextNode.gain.gain.value = masterGain * (Math.max(0, Math.min(150, nextClip.volume ?? 100)) / 100);
        if (visibleIndex === 0) {
          firstOpacity = 0;
          secondOpacity = 1;
        } else {
          secondOpacity = 0;
          firstOpacity = 1;
        }
        completedOutputSeconds += currentDuration - fadeDuration;
        progressClip = nextClip;
        visibleVideo = nextVideo;
        visibleIndex = visibleIndex === 0 ? 1 : 0;
      }

      const finalClip = orderedClips[orderedClips.length - 1];
      await waitUntil(
        () => visibleVideo.currentTime >= finalClip.endSeconds,
        15000 + Math.max(0, finalClip.endSeconds - visibleVideo.currentTime) * 3000
      );
      visibleVideo.pause();
      if (recorder.state !== 'inactive') recorder.stop();
      const finishTimeout = new Promise<never>((_, reject) => {
        recorderFinishTimeout = window.setTimeout(
          () => reject(new Error('The browser did not finish finalizing the sequence. Try exporting again or use a shorter sequence.')),
          30000
        );
      });
      const blob = await Promise.race([finished, finishTimeout]);
      if (!blob.size) throw new Error('The sequence export was empty. Please try again.');

      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'clipforge-sequence.' + getExportFileExtension(blob.type || actualMimeType);
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1500);
    } catch (err) {
      if (recorder && recorder.state !== 'inactive') recorder.stop();
      setErrorMessage(err instanceof Error ? err.message : 'Sequence export failed. Please try again.');
    } finally {
      if (recorderFinishTimeout) window.clearTimeout(recorderFinishTimeout);
      if (animationFrame) cancelAnimationFrame(animationFrame);
      mediaVideos.forEach(element => {
        element.pause();
        element.removeAttribute('src');
        element.load();
      });
      mediaStreams.forEach(stream => stream.getTracks().forEach(track => track.stop()));
      sequenceDenoiser?.destroy();
      if (audioContext && audioContext.state !== 'closed') {
        await audioContext.close().catch(() => undefined);
      }
      setBusy('');
      setExportProgress(null);
    }
  };

  const installApp = async () => {
    if (!installPrompt) return;
    try {
      await installPrompt.prompt();
      const choice = await installPrompt.userChoice;
      if (choice.outcome === 'accepted') setAppInstalled(true);
    } catch {
      setErrorMessage('The browser could not start installation. Use its browser menu to add CLIPFORGE to your home screen.');
    } finally {
      setInstallPrompt(null);
    }
  };

  const applyAppUpdate = () => {
    if (!updateRegistration?.waiting) return;
    const confirmed = window.confirm('Updating will reload CLIPFORGE. Finish any exports and save your edit plan first. Continue?');
    if (!confirmed) return;
    updateReloadRef.current = true;
    updateRegistration.waiting.postMessage({ type: 'SKIP_WAITING' });
  };

  if (authLoading) {
    return (
      <div className="auth-screen">
        <div className="brand-mark">
          <Clapperboard size={22} />
        </div>
        <LoaderCircle className="spin" />
        <p>Opening your studio…</p>
      </div>
    );
  }

  if (!user || recoveryPending) {
    const isRecovery = authMode === 'recovery' && recoveryPending;
    const isSignup = authMode === 'signup';
    const isForgot = authMode === 'forgot';
    return (
      <div className="auth-screen">
        <div className="auth-glow" />
        <div className="brand-lockup">
          <div className="brand-mark">
            <Clapperboard size={23} />
          </div>
          <span>CLIPFORGE</span>
          <b>AI</b>
        </div>
        <div className="auth-card">
          <div className="eyebrow">
            <Sparkles size={14} /> YOUR CREATOR WORKSPACE
          </div>
          <h1>
            {isRecovery ? 'Choose a new' : isSignup ? 'Create your' : isForgot ? 'Reset your' : 'Turn raw footage'}
            <br />
            <span>{isRecovery ? 'password.' : isSignup ? 'creator account.' : isForgot ? 'password.' : 'into the good part.'}</span>
          </h1>
          <p>
            {isRecovery
              ? 'Set a new password to get back into your creator workspace.'
              : isSignup
                ? 'Create an account to save your edit plans and access your workspace.'
                : isForgot
                  ? 'We will send a password recovery link if an account matches that email.'
                  : 'Build clean clips, get AI-assisted moment suggestions, and keep your edit plans in one place.'}
          </p>
          {!isRecovery && (
            <label className="auth-field">
              <span>Email address</span>
              <input
                className="auth-input"
                type="email"
                autoComplete="email"
                value={authEmail}
                onChange={event => setAuthEmail(event.target.value)}
                placeholder="you@example.com"
              />
            </label>
          )}
          {!isForgot && (
            <label className="auth-field">
              <span>{isRecovery ? 'New password' : 'Password'}</span>
              <input
                className="auth-input"
                type="password"
                autoComplete={isSignup || isRecovery ? 'new-password' : 'current-password'}
                value={authPassword}
                onChange={event => setAuthPassword(event.target.value)}
                placeholder={isRecovery || isSignup ? 'At least 8 characters' : 'Your password'}
              />
            </label>
          )}
          {isRecovery ? (
            <button className="primary-button full" onClick={finishPasswordRecovery} disabled={authBusy}>
              Update password <ChevronRight size={17} />
            </button>
          ) : isForgot ? (
            <button className="primary-button full" onClick={sendRecoveryEmail} disabled={authBusy}>
              Send recovery link <ChevronRight size={17} />
            </button>
          ) : isSignup ? (
            <button className="primary-button full" onClick={signUp} disabled={authBusy}>
              {authBusy ? 'Creating account…' : 'Create account'} <ChevronRight size={17} />
            </button>
          ) : (
            <button className="primary-button full" onClick={signIn} disabled={authBusy}>
              {authBusy ? 'Signing in…' : 'Sign in to your studio'} <ChevronRight size={17} />
            </button>
          )}
          {!isRecovery && (
            <div className="auth-links">
              {isForgot ? (
                <button type="button" onClick={() => { setAuthMode('login'); setErrorMessage(''); setAuthNotice(''); }}>Back to sign in</button>
              ) : isSignup ? (
                <button type="button" onClick={() => { setAuthMode('login'); setErrorMessage(''); setAuthNotice(''); }}>Already have an account? Sign in</button>
              ) : (
                <>
                  <button type="button" onClick={() => { setAuthMode('signup'); setErrorMessage(''); setAuthNotice(''); }}>Create an account</button>
                  <button type="button" onClick={() => { setAuthMode('forgot'); setErrorMessage(''); setAuthNotice(''); }}>Forgot password?</button>
                </>
              )}
            </div>
          )}
          {authNotice && <div className="auth-notice">{authNotice}</div>}
          {errorMessage && <div className="alert">{errorMessage}</div>}
          {!isRecovery && (
            <div className="privacy-note">
              <Check size={14} /> Your video stays in your browser. Sampled frames and, when requested, compressed audio chunks are sent for AI processing.
            </div>
          )}
        </div>
        <div className="auth-footer">BUILT FOR THE MOMENTS WORTH KEEPING</div>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand-lockup">
          <div className="brand-mark">
            <Clapperboard size={20} />
          </div>
          <span>CLIPFORGE</span>
          <b>AI</b>
        </div>
        <div className="workspace-label">WORKSPACE</div>
        <button
          className={activeTab === 'editor' ? 'nav-item active' : 'nav-item'}
          onClick={() => setActiveTab('editor')}
        >
          <Scissors size={17} /> Editor
        </button>
        <button
          className={activeTab === 'projects' ? 'nav-item active' : 'nav-item'}
          onClick={() => setActiveTab('projects')}
        >
          <FolderOpen size={17} /> My projects{' '}
          <span className="nav-count">{projects.length}</span>
        </button>
        <button
          className={activeTab === 'help' ? 'nav-item active' : 'nav-item'}
          onClick={() => setActiveTab('help')}
        >
          <BookOpen size={17} /> Help & Tutorials
        </button>
        <div className="sidebar-bottom">
          <div className="storage-card">
            <div className="storage-icon">
              <AudioWaveform size={17} />
            </div>
            <strong>Local-first editing</strong>
            <p>
              Videos are processed on your device. Your saved projects contain
              edit plans, not video files.
            </p>
          </div>
          <button className="account-button" type="button" onClick={signOut} aria-label="Sign out of Clipforge" title="Sign out">
            <div className="avatar">
              {(user.name || user.email || 'C').slice(0, 1).toUpperCase()}
            </div>
            <span>
              <strong>{user.name || 'Creator account'}</strong>
              <small>Sign out</small>
            </span>
          </button>
        </div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <div className="breadcrumb">
            Workspace <ChevronRight size={14} />{' '}
            <strong>
              {activeTab === 'editor' ? 'Video editor' : activeTab === 'projects' ? 'My projects' : 'Help & Tutorials'}
            </strong>
          </div>
          <div className="topbar-right">
            {!appInstalled && installPrompt && (
              <button type="button" className="pwa-action-button" onClick={installApp}>Install app</button>
            )}
            {updateReady && (
              <button type="button" className="pwa-action-button update" onClick={applyAppUpdate} disabled={!!busy} title="Finish exports and save your edit plan before updating">Update now</button>
            )}
            <span className="status-dot" /> PRIVATE WORKSPACE{' '}
            <span className="version-pill">BETA</span>
          </div>
        </header>

        {activeTab === 'editor' ? (
          <div className="page">
            <section className="page-heading">
              <div>
                <div className="eyebrow">
                  <WandSparkles size={14} /> {editingWorkspace === 'ai' ? 'AI EDITING STUDIO' : 'MANUAL EDITING STUDIO'}
                </div>
                <h1>
                  Make every second <span>count.</span>
                </h1>
                <p>
                  {editingWorkspace === 'ai' ? 'Let AI find the strongest moments, guide the story, then fine-tune every detail.' : 'Take direct control of your clips, timeline, subtitles, sound and final export.'}
                </p>
              </div>
              <div className="heading-chip">
                <Activity size={16} /> LOCAL PROCESSING
              </div>
            </section>

            {!clips.length && !recoveryNotice && (
              <section className="panel" aria-label="Quick start guide" style={{ marginBottom: 18, padding: 16 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}><Sparkles size={18} /><div><strong>Your first edit — follow these steps</strong><p style={{ margin: '3px 0 0', color: 'var(--muted)' }}>You only need a video and the Highlights workspace to get started.</p></div></div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10 }}>
                  <div style={{ border: '1px solid var(--line)', borderRadius: 12, padding: 12, display: 'grid', gap: 8 }}><strong>1. Choose a video</strong><p style={{ margin: 0, color: 'var(--muted)' }}>{videoUrl ? 'Video ready ✓' : 'Pick a video file from your device.'}</p><button type="button" className="secondary-button" onClick={() => fileInputRef.current?.click()} disabled={!!busy}>Choose video</button></div>
                  <div style={{ border: '1px solid var(--line)', borderRadius: 12, padding: 12, display: 'grid', gap: 8 }}><strong>2. Find highlights</strong><p style={{ margin: 0, color: 'var(--muted)' }}>{suggestions.length ? suggestions.length + ' moments found ✓' : 'Open Highlights and tap Find highlights.'}</p><button type="button" className="secondary-button" onClick={() => setEditorSection('highlights')} disabled={!videoUrl || !!busy}>Open Highlights</button></div>
                  <div style={{ border: '1px solid var(--line)', borderRadius: 12, padding: 12, display: 'grid', gap: 8 }}><strong>3. Build your edit</strong><p style={{ margin: 0, color: 'var(--muted)' }}>Add the suggested moments to your timeline.</p><button type="button" className="secondary-button" onClick={buildTimelineFromSuggestions} disabled={!suggestions.length || !!busy || clips.length >= 20}>Build my edit</button></div>
                </div>
              </section>
            )}
            {errorMessage && (
              <div className="alert">
                <CircleHelp size={16} /> {errorMessage}
                <button onClick={() => setErrorMessage('')}>
                  <X size={15} />
                </button>
              </div>
            )}

<section className="workspace-choice" aria-label="Choose editing workspace">
  <button type="button" className={editingWorkspace === 'manual' ? 'workspace-choice-card selected' : 'workspace-choice-card'} onClick={() => { setEditingWorkspace('manual'); setEditorSection('manual'); }} aria-pressed={editingWorkspace === 'manual'}>
    <span className="workspace-choice-icon"><Scissors size={19} /></span>
    <span className="workspace-choice-copy"><strong>Manual Editing</strong><small>Full hands-on control over every edit</small></span>
    <span className="workspace-choice-check">{editingWorkspace === 'manual' ? 'ACTIVE' : 'OPEN'}</span>
  </button>
  <button type="button" className={editingWorkspace === 'ai' ? 'workspace-choice-card selected ai-selected' : 'workspace-choice-card'} onClick={() => { setEditingWorkspace('ai'); setEditorSection('highlights'); }} aria-pressed={editingWorkspace === 'ai'}>
    <span className="workspace-choice-icon"><WandSparkles size={19} /></span>
    <span className="workspace-choice-copy"><strong>AI Editing</strong><small>Generate a first cut, then refine it yourself</small></span>
    <span className="workspace-choice-check">{editingWorkspace === 'ai' ? 'ACTIVE' : 'OPEN'}</span>
  </button>
</section>
<div className="editor-mode-switcher">
  <div className="editor-tool-groups">
    <div className="editor-tool-group"><span>CREATE</span><div className="editor-mode-tabs">
      <button type="button" className={editorSection === 'highlights' ? 'editor-mode-tab active' : 'editor-mode-tab'} onClick={() => setEditorSection('highlights')}>✨ Highlights</button>
      <button type="button" className={editorSection === 'guided' ? 'editor-mode-tab active' : 'editor-mode-tab'} onClick={() => setEditorSection('guided')}>AI brief + script</button>
    </div></div>
    <div className="editor-tool-group"><span>EDIT</span><div className="editor-mode-tabs">
      <button type="button" className={editorSection === 'manual' ? 'editor-mode-tab active' : 'editor-mode-tab'} onClick={() => setEditorSection('manual')}>Edit clips</button>
      <button type="button" className={editorSection === 'captions' ? 'editor-mode-tab active' : 'editor-mode-tab'} onClick={() => setEditorSection('captions')}>Subtitles</button>
    </div></div>
    <div className="editor-tool-group"><span>FINISH</span><div className="editor-mode-tabs">
      <button type="button" className={editorSection === 'tools' ? 'editor-mode-tab active' : 'editor-mode-tab'} onClick={() => setEditorSection('tools')}>Export + audio</button>
    </div></div>
  </div>
  <div className="editor-section-intro"><strong>{editorSection === 'highlights' ? 'Find highlights' : editorSection === 'guided' ? 'Guide the AI' : editorSection === 'manual' ? 'Edit clips' : editorSection === 'captions' ? 'Subtitles' : 'Export and audio'}</strong><p>{editorSection === 'highlights' ? 'Find promising moments automatically.' : editorSection === 'guided' ? 'Give the AI your instructions and script.' : editorSection === 'manual' ? 'Trim clips, change their order and preview them.' : editorSection === 'captions' ? 'Create and correct subtitles.' : 'Fine-tune background noise, audio levels, video quality and export format.'}</p><button className="secondary-button" type="button" onClick={() => setActiveTab('help')}>How to use</button></div>
</div>
            <div className={'editor-grid' + (['highlights', 'guided'].includes(editorSection) ? '' : ' editor-grid-single')}>
              <section className="panel video-panel">
                {recoveryNotice && !videoUrl && (
                  <div className="recovery-banner" role="status">
                    <strong>Unsaved edit recovered</strong>
                    <span>Your clip ranges and captions are back. Choose the original video again to preview and export them.</span>
                  </div>
                )}
                <div className="panel-heading">
                  <div>
                    <span className="step-number">01</span>
                    <div>
                      <h2>Source video</h2>
                      <p>Choose a file or paste a direct video link</p>
                    </div>
                  </div>
                  <span className="panel-tag">INPUT</span>
                </div>
                {!videoUrl ? (
                  <button
                    className="dropzone"
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <div className="upload-icon">
                      <Upload size={23} />
                    </div>
                    <strong>Drop your video here</strong>
                    <span>or tap to browse your files</span>
                    <small>MP4 · MOV · WebM · processed locally</small>
                  </button>
                ) : (
                  <div className="video-wrap">
                    <video
                      ref={videoRef}
                      src={videoUrl}
                      crossOrigin={isRemoteSource ? 'anonymous' : undefined}
                      controls
                      playsInline
                      style={{ transform: 'translate(' + (previewMotion.x * 100) + '%, ' + (previewMotion.y * 100) + '%) scale(' + previewMotion.scale + ') rotate(' + previewMotion.rotation + 'deg)', transformOrigin: (reframeX * 100) + '% ' + (reframeY * 100) + '%', opacity: previewMotion.opacity }}
                      onError={() => setErrorMessage('The video link could not be loaded. Check that it is a direct video file and that its host allows browser playback (CORS).')}
                      onTimeUpdate={event => {
                        const currentTime = event.currentTarget.currentTime;
                        setPlaybackTime(currentTime);
                        if (previewEnd !== null && currentTime >= previewEnd) {
                          event.currentTarget.pause();
                          setPlaybackTime(previewEnd);
                          setPreviewEnd(null);
                        }
                      }}
                      onLoadedMetadata={event => {
                        const value = event.currentTarget.duration;
                        if (!Number.isFinite(value) || value <= 0) {
                          setDuration(0);
                          setPreviewEnd(null);
                          setErrorMessage('This video does not report a usable duration. Try a different video file or direct video link.');
                          return;
                        }
                        setPreviewEnd(null);
                        setPlaybackTime(0);
                        setDuration(value);
                        if (clips.some(clip => clip.endSeconds > value)) {
                          setErrorMessage('The selected video is shorter than one or more saved clip ranges. Choose the original source video to restore the edit plan correctly.');
                        }
                        if (preserveEndInputOnNextMetadata.current) {
                          preserveEndInputOnNextMetadata.current = false;
                        } else {
                          setEndInput(String(Math.min(5, Math.floor(value))));
                        }
                      }}
                    />
                    <div
                      className={'export-crop-guide crop-' + (exportAspect === 'original' ? 'original' : exportAspect.replace(':', '-'))}
                      aria-hidden="true"
                    >
                      <span />
                      <small>{exportAspect === 'original' ? 'Original frame' : exportAspect + ' export crop · safe area'}</small>
                    </div>
                    {activeCaption && (
                      <div
                        key={activeCaption.id}
                        className={'caption-preview-overlay caption-animation-' + captionAnimation}
                        style={{
                          color: captionColor,
                          fontSize: captionFontSize + 'px',
                          fontFamily: brandFontFamily,
                          background: captionBackground === 'dark' ? 'rgba(0, 0, 0, 0.76)' : 'transparent',
                          bottom: exportAspect === '9:16' ? '16%' : exportAspect === '1:1' ? '10%' : '65px',
                        }}
                      >
                        {activeCaption.text}
                      </div>
                    )}
                    <div className="video-meta">
                      <span>
                        <Film size={14} /> {sourceLabel || file?.name || 'Video source'}
                      </span>
                      <span>
                        <Clock3 size={14} /> {fmt(duration)}
                      </span>
                      <label className="playback-speed-control">
                        PREVIEW SPEED
                        <select
                          value={String(playbackSpeed)}
                          onChange={event => setPlaybackSpeed(Number(event.target.value))}
                          disabled={!!busy}
                          aria-label="Preview playback speed"
                        >
                          <option value="0.5">0.5×</option>
                          <option value="0.75">0.75×</option>
                          <option value="1">1×</option>
                          <option value="1.25">1.25×</option>
                          <option value="1.5">1.5×</option>
                          <option value="2">2×</option>
                        </select>
                      </label>
                      <button
                        onClick={() => {
                          preserveEditPlanOnNextFile.current = false;
                          preserveEndInputOnNextMetadata.current = false;
                          setFile(null);
                          setVideoUrl('');
                          setSourceLabel('');
                          setIsRemoteSource(false);
                          setDuration(0);
                          setClips([]);
                          setSuggestions([]);
                          setCaptions([]);
                          setTranscribeProgress(0);
                        }}
                      >
                        <X size={14} /> Remove
                      </button>
                    </div>
                  </div>
                )}
                <div className="link-import">
                  <div className="link-import-label">OR IMPORT FROM A DIRECT VIDEO LINK</div>
                  <div className="link-import-row">
                    <input
                      type="url"
                      value={videoLinkInput}
                      onChange={event => setVideoLinkInput(event.target.value)}
                      onKeyDown={event => {
                        if (event.key === 'Enter') importVideoLink();
                      }}
                      placeholder="https://example.com/video.mp4"
                      aria-label="Direct video URL"
                    />
                    <button className="secondary-button" onClick={importVideoLink} disabled={!videoLinkInput.trim() || !!busy}>
                      <Plus size={15} /> Use link
                    </button>
                  </div>
                  <small>Direct .mp4, .webm, .mov or .m4v file links only. The video host must allow browser access.</small>
                </div>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="video/*"
                  hidden
                  onChange={event => {
                    onChooseFile(event.target.files?.[0]);
                    event.currentTarget.value = '';
                  }}
                />
                {videoUrl && (
                  <button
                    className="secondary-button replace-button"
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <Upload size={15} /> Replace video
                  </button>
                )}
                <div className="privacy-inline">
                  <Check size={14} /> {isRemoteSource ? 'The linked video streams from its original host. Sampled frames are sent for AI analysis when requested.' : 'Your selected video file stays on your device. Sampled frames are sent for AI analysis when requested.'}
                </div>
              </section>

              <section className="panel ai-panel" style={{ display: ['highlights', 'guided'].includes(editorSection) ? 'block' : 'none' }}>
                <div className="panel-heading">
                  <div>
                    <span className="step-number">02</span>
                    <div>
                      <h2>{editorSection === 'guided' ? 'AI brief + script' : 'Find highlights'}</h2>
                      <p>{editorSection === 'guided' ? 'Set your editing rules and story direction together' : 'Find promising moments without a brief'}</p>
                    </div>
                  </div>
                  <span className="ai-tag">
                    <Sparkles size={12} /> AI
                  </span>
                </div>
                <div className="ai-intro">
                  <div className="ai-orb">
                    <WandSparkles size={21} />
                  </div>
                  <div>
                    <strong>Track movement. Model camera motion. Maintain a subject path.</strong>
                    <p>
                      CLIPFORGE scans up to 480 checkpoints using coarse-to-fine block flow, robust translation/zoom/rotation camera compensation, coherent residual-region clustering, temporal track association, short occlusion recovery and confidence-aware smoothing. The full trace accompanies selected visual keyframes. It follows a moving image region, not guaranteed real-world identity or semantic understanding of every decoded frame.
                    </p>
                  </div>
                </div>
                <div className="story-direction-fields">
                  {editorSection === 'guided' && (<>
                  <label htmlFor="editing-mode">HOW SHOULD AI WORK?</label>
                  <select id="editing-mode" value={editingMode} onChange={event => setEditingMode(event.target.value as EditingMode)} disabled={!!busy}>
                    <option value="manual">Manual AI — follow my exact directions</option>
                    <option value="automatic">Automatic AI — create a first draft for me</option>
                    <option value="hybrid">Hybrid AI — suggest moments, I decide</option>
                  </select>
                  <small>{editingMode === 'manual' ? 'Your instructions take priority. AI finds footage that fits; you choose what enters the timeline.' : editingMode === 'automatic' ? 'AI uses its own editorial judgement to select moments and assemble a first-draft timeline. Your instructions guide its choices.' : 'AI finds and ranks moments, then waits for your approval. Add, remove and arrange clips yourself.'}</small>
                  </>)}
                  {editorSection === 'guided' && (<>
                  <label htmlFor="edit-instructions">YOUR EDITING INSTRUCTIONS</label>
                  <small>Give the AI a clear brief: the goal, platform, mood, pacing, moments to prioritise, and anything it must avoid. These directions guide selection; they do not override what the sampled footage can actually prove.</small>
                  <div className="instruction-template-row">
                    <button type="button" className="secondary-button" onClick={() => appendInstruction('Goal: Create an engaging gaming or sports highlight edit. Open with the strongest clearly supported moment, favour decisive action and genuine reactions, keep the pacing energetic, and avoid repetitive or visually unclear sections.')} disabled={!!busy}>Highlights brief</button>
                    <button type="button" className="secondary-button" onClick={() => appendInstruction('Goal: Make a clear tutorial or explainer. Preserve the order of the steps, prioritise footage that demonstrates each point, leave enough context to understand the action, and avoid unrelated filler.')} disabled={!!busy}>Tutorial brief</button>
                    <button type="button" className="secondary-button" onClick={() => appendInstruction('Goal: Build a story-led edit. Follow the supplied script from opening to conclusion, prioritise footage that visibly supports each beat, maintain continuity, and do not invent scenes when no matching frame is available.')} disabled={!!busy}>Story brief</button>
                    <button type="button" className="secondary-button" onClick={() => appendInstruction('Editing rule: Remove dead time and repeated shots. Keep the strongest clear moments, but preserve enough lead-in and follow-through to understand each action.')} disabled={!!busy}>No filler</button>
                    <button type="button" className="secondary-button" onClick={() => appendInstruction('Editing rule: Preserve important spoken dialogue and reactions. Avoid cutting over key words, and use visual-only sections as transitions rather than replacing essential speech.')} disabled={!!busy}>Keep dialogue</button>
                    <button type="button" className="secondary-button" onClick={() => appendInstruction('Platform: TikTok / vertical short-form. Open with a clear visual hook in the first 1–2 seconds, keep the strongest payoff early, use tight but understandable pacing, and avoid a slow intro.')} disabled={!!busy}>TikTok hook</button>
                    <button type="button" className="secondary-button" onClick={() => appendInstruction('Style: cinematic story edit. Establish the context, build anticipation, vary wide and close visual moments where available, preserve continuity, and finish on the clearest payoff.')} disabled={!!busy}>Cinematic story</button>
                    <button type="button" className="secondary-button" onClick={() => appendInstruction('Style: sports analysis. Prioritise the build-up, player positioning, decision, action and outcome when the sampled footage supports them. Keep enough lead-in and follow-through to understand the play; do not infer unseen events.')} disabled={!!busy}>Sports breakdown</button>
                  </div>
                  <textarea
                    id="edit-instructions"
                    value={editInstructions}
                    onChange={event => setEditInstructions(event.target.value.slice(0, 1500))}
                    placeholder="Example: Make a fast-paced 30-second TikTok edit. Prioritise funny reactions, keep the strongest moment near the beginning, avoid slow sections, and use energetic pacing."
                    rows={3}
                    maxLength={1500}
                    disabled={!!busy}
                  />
                  <small>Describe the platform, mood, pacing, important moments and anything to avoid.</small>
                  <div className="brief-quality-check">
                    <span>BRIEF CHECK · {getBriefChecklist(editInstructions).filter(item => item.done).length}/5</span>
                    {getBriefChecklist(editInstructions).map(item => <small key={item.label} className={item.done ? 'brief-check-done' : ''}>{item.done ? '✓' : '○'} {item.label}</small>)}
                  </div>
                  </>)}
                  {editorSection === 'guided' && (<>
                  <label htmlFor="edit-script">VIDEO SCRIPT / VOICEOVER SCRIPT</label>
                  <textarea
                    id="edit-script"
                    value={editScript}
                    onChange={event => setEditScript(event.target.value.slice(0, 4000))}
                    placeholder="Paste the words or story the finished video should follow. The AI will use this to look for matching footage."
                    rows={5}
                    maxLength={4000}
                    disabled={!!busy}
                  />
                  <small>{editScript.length}/4000 characters · {getScriptBeats(editScript).length}/12 detected story beats. Numbered lines, bullet points, timecoded lines and separate lines are supported; otherwise sentences are used. The script guides scene selection and can become timed captions.</small>
                  {getScriptBeats(editScript).length > 0 && <small className="script-coach-note">Tip: give each beat one clear idea or visual target. Add a hook, development and payoff as separate beats; the AI will leave unsupported beats unmatched instead of inventing footage.</small>}
                  {editScript.trim() && (
                    <div className="script-beat-preview" aria-live="polite">
                      <div className="script-beat-heading">SCRIPT BEATS <span>{getScriptBeats(editScript).length} detected</span></div>
                      {getScriptBeats(editScript).map((beat, index) => (
                        <div className="script-beat-item" key={index}>
                          <span>{String(index + 1).padStart(2, '0')}</span>
                          <p>{beat}</p>
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="script-action-row">
                    <button type="button" className="secondary-button" onClick={previewScriptVoice} disabled={!editScript.trim() || !!busy}>{voicePreviewing ? 'Stop voice preview' : 'Preview spoken script'}</button>
                    <button type="button" className="secondary-button" onClick={applyScriptAsCaptions} disabled={!editScript.trim() || !clips.length || !!busy}>Create timed captions</button>
                    <button type="button" className="primary-button" onClick={() => analyzeVideo(editingMode === 'automatic' || !!editScript.trim(), !!editScript.trim())} disabled={!videoUrl || (!editInstructions.trim() && !editScript.trim()) || !!busy}>{busy === 'create' || busy === 'analyze' ? 'Working…' : editScript.trim() ? 'Create edit from brief + script' : 'Find moments from my brief'}</button>
                  </div>
                  <small>AI uses both fields together when supplied. Script beats guide story order and timed captions; editing instructions guide style, priorities and exclusions. Spoken preview uses your device's built-in voice and is not included in exported audio.</small>
                  </>)}
                </div>
                <div className="clip-length-settings">
                  <label htmlFor="clip-length-mode">CLIP LENGTH</label>
                  <select
                    id="clip-length-mode"
                    value={clipLengthMode}
                    onChange={event => setClipLengthMode(event.target.value as 'ai' | 'fixed')}
                  >
                    <option value="ai">Let AI choose each length</option>
                    <option value="fixed">Use my preferred length</option>
                  </select>
                  {clipLengthMode === 'fixed' && (
                    <select
                      aria-label="Preferred clip length in seconds"
                      value={customClipLength}
                      onChange={event => setCustomClipLength(event.target.value)}
                    >
                      <option value="10">10 seconds</option>
                      <option value="15">15 seconds</option>
                      <option value="20">20 seconds</option>
                      <option value="30">30 seconds</option>
                      <option value="45">45 seconds</option>
                      <option value="60">60 seconds</option>
                    </select>
                  )}
                  <small>{clipLengthMode === 'ai' ? 'AI estimates a different start and end for each suggested moment.' : `AI suggestions will use approximately ${customClipLength}-second clips, shortened if they reach the end of your video.`}</small>
                </div>
                {editorSection !== 'guided' && (<div className="analysis-actions">
                  <button className="primary-button" type="button" onClick={() => analyzeVideo(editorSection === 'guided' && editingMode === 'automatic')} disabled={!videoUrl || !!busy || (editorSection === 'guided' && editingMode === 'manual' && !editInstructions.trim())}>
                    {busy === 'create' || busy === 'analyze' ? <LoaderCircle className="spin" size={16} /> : <WandSparkles size={16} />}
                    {busy === 'create' || busy === 'analyze' ? 'Working…' : editorSection === 'guided' && editingMode === 'automatic' ? 'Create first draft' : editorSection === 'guided' ? 'Find moments from my brief' : 'Find highlights'}
                  </button>
                </div>)}
                {(busy === 'analyze' || busy === 'create') && (
                  <div className="analysis-progress" role="status" style={{ marginTop: 12 }}>
                    <progress value={analysisProgress} max={100} style={{ width: '100%' }} />
                    <small>{analysisMessage || 'Preparing analysis…'} · {analysisProgress}%</small>
                  </div>
                )}
                <div className="ai-footnote">
                  <CircleHelp size={13} /> {captions.length
                    ? 'Suggestions combine a full-timeline visual-change scan, selected keyframes, timed captions and ordered script beats. AI still interprets keyframes rather than every decoded frame.'
                    : 'Suggestions use a full-timeline visual-change scan and selected keyframes. Generate captions to add spoken-word context; AI does not yet interpret every decoded frame.'}
                </div>
                {suggestions.length > 0 && (
                  <div>
                    <button className="secondary-button full build-timeline-button" type="button" onClick={buildTimelineFromSuggestions} disabled={!!busy || clips.length >= 20}>Add all suggestions in {editorSection === 'guided' && editScript.trim() ? 'script' : 'source'} order</button>
                    <button className="secondary-button full" type="button" onClick={() => setEditorSection('manual')} style={{ marginBottom: 8 }}>Review and edit timeline <ChevronRight size={14} /></button>
                    <div className="suggestion-list">
                    <div className="suggestion-title">
                      SUGGESTED MOMENTS <span>{suggestions.length}</span>
                    </div>
                    {editorSection === 'guided' && editScript.trim() && (
                      <div className="script-coverage">
                        <div className="suggestion-title">
                          SCRIPT COVERAGE
                          <span>{new Set(suggestions.filter(item => Number.isInteger(item.scriptBeatIndex)).map(item => item.scriptBeatIndex)).size}/{getScriptBeats(editScript).length} matched</span>
                        </div>
                        {getScriptBeats(editScript).map((beat, beatIndex) => {
                          const matches = suggestions.filter(item => item.scriptBeatIndex === beatIndex);
                          const confidence = matches.reduce((best, item) => Math.max(best, item.matchConfidence ?? 0), 0);
                          return (
                            <div className="script-coverage-row" key={beatIndex}>
                              <span>{String(beatIndex + 1).padStart(2, '0')}</span>
                              <p>{beat}</p>
                              <small className={matches.length ? 'is-matched' : ''}>
                                {matches.length ? 'Visual match · ' + confidence + '% confidence' : 'No clear sampled match · review manually'}
                              </small>
                            </div>
                          );
                        })}
                      </div>
                    )}
                    {suggestions.length > 0 && (
                      <div className="story-assembly-panel">
                        <strong>STORY ASSEMBLY</strong>
                        <p>{assembleStorySuggestions(suggestions, editorSection === 'guided' && !!editScript.trim()).length} story units from {suggestions.length} detected moments. Related setup, action, outcome and reaction evidence is grouped where the event labels and time windows support it.</p>
                        <button type="button" className="secondary-button" onClick={buildTimelineFromSuggestions}>Build story sequence</button>
                        <small>{editorSection === 'guided' && editScript.trim() ? 'Your script beat order takes priority.' : 'Default order: strongest hook → context → action → payoff → reaction. You can still rearrange everything.'}</small>
                      </div>
                    )}
                    {suggestions.map((suggestion, index) => (
                      <div className="suggestion" key={index}>
                        <div className="suggestion-time">
                          {fmt(suggestion.startSeconds)}–
                          {fmt(suggestion.endSeconds)}
                        </div>
                        <div className="suggestion-copy">
                          <strong>
                            {suggestion.reason || 'Potential highlight'}
                          </strong>
                          {suggestion.momentLabel && <small className="story-purpose">MOMENT · {suggestion.momentLabel}</small>}
                          {suggestion.storyPurpose && <small className="story-purpose">EDITORIAL ROLE · {suggestion.storyPurpose}</small>}
                          {suggestion.eventPhase && <small className="story-purpose">SEQUENCE PHASE · {suggestion.eventPhase.toUpperCase()}</small>}
                          {suggestion.sequenceEvidence && <small>{suggestion.sequenceEvidence}</small>}
                          {suggestion.actionLabel && <small className="story-purpose">RECOGNISED ACTION · {suggestion.actionLabel}</small>}
                          {suggestion.subjectTrack && <small>SUBJECT TRACK · {suggestion.subjectTrack}</small>}
                          {suggestion.motionSummary && <small>MOTION · {suggestion.motionSummary}</small>}
                          {suggestion.eventGroupLabel && <small className="story-purpose">EVENT ARC · {suggestion.eventGroupLabel}</small>}
                          {suggestion.eventStartSeconds !== undefined && suggestion.eventEndSeconds !== undefined && <small>ESTIMATED EVENT WINDOW · {fmt(suggestion.eventStartSeconds)}–{fmt(suggestion.eventEndSeconds)}</small>}
                          {suggestion.eventConfidence !== undefined && <small>SEQUENCE CONFIDENCE · {suggestion.eventConfidence}%</small>}
                          <small>
                            {(suggestion.momentType || 'visual').toUpperCase()} · AI evidence score {suggestion.score ?? 0}/100
                            {suggestion.scriptBeatIndex !== undefined ? ` · Script beat ${suggestion.scriptBeatIndex + 1} (${suggestion.matchConfidence ?? 0}% match)` : ''}
                            {suggestion.visualEvidenceConfidence !== undefined ? ` · Visual evidence ${suggestion.visualEvidenceConfidence}%` : ''}
                            {suggestion.timestampSeconds !== undefined ? ` · Around ${fmt(suggestion.timestampSeconds)}` : ''}
                          </small>
                        </div>
                        <button                          title="Add this clip"
                          onClick={() => addClip(suggestion)}
                        >
                          <Plus size={16} />
                        </button>
                      </div>
                    ))}
                    </div>
                  </div>
                )}
              </section>
            </div>

            <section className="panel caption-panel" style={{ display: editorSection === 'captions' ? 'block' : 'none' }}>
              <div className="panel-heading">
                <div>
                  <span className="step-number">03</span>
                  <div>
                    <h2>Automatic captions</h2>
                    <p>Transcribe speech, refine the words, and style subtitles</p>
                  </div>
                </div>
                <span className="panel-tag">{captions.length} CAPTIONS</span>
              </div>
              <div className="caption-toolbar">
                <button
                  className="primary-button"
                  onClick={transcribeVideo}
                  disabled={!file || isRemoteSource || !!busy}
                >
                  {busy === 'transcribe' ? (
                    <><LoaderCircle className="spin" size={16} /> Transcribing {transcribeProgress}%</>
                  ) : (
                    <><AudioWaveform size={16} /> Generate captions</>
                  )}
                </button>
                <button
                  className="secondary-button"
                  onClick={() => { setCaptions([]); setTranscribeProgress(0); }}
                  disabled={!captions.length || !!busy}
                >
                  <Trash2 size={15} /> Clear captions
                </button>
              </div>
              <div className="caption-settings">
                <label>
                  TEXT SIZE
                  <select value={captionFontSize} onChange={event => setCaptionFontSize(event.target.value)}>
                    <option value="26">Small</option>
                    <option value="34">Medium</option>
                    <option value="42">Large</option>
                  </select>
                </label>
                <label>
                  TEXT COLOUR
                  <input type="color" value={captionColor} onChange={event => setCaptionColor(event.target.value)} />
                </label>
                <label>
                  BACKGROUND
                  <select value={captionBackground} onChange={event => setCaptionBackground(event.target.value as 'dark' | 'none')}>
                    <option value="dark">Dark box</option>
                    <option value="none">No box</option>
                  </select>
                </label>
                <label>
                  ANIMATION
                  <select value={captionAnimation} onChange={event => setCaptionAnimation(event.target.value as 'none' | 'fade' | 'pop')}>
                    <option value="none">None</option>
                    <option value="fade">Fade in</option>
                    <option value="pop">Pop in</option>
                  </select>
                </label>
              </div>
              <div className="caption-privacy">
                <CircleHelp size={14} />
                Uploaded videos only, up to 20 minutes. The video stays on your device; compressed audio chunks are sent to AI for transcription. Captions and their style are saved with your edit plan. Direct video links cannot be transcribed in this beta.
              </div>
              {captions.length > 0 ? (
                <div className="caption-list">
                  {captions.map(caption => (
                    <div className="caption-row" key={caption.id}>
                      <div className="caption-time-edit">
                        <input
                          type="number"
                          min="0"
                          max={duration || 7200}
                          step="0.1"
                          value={caption.startSeconds}
                          aria-label={'Caption start time at ' + fmt(caption.startSeconds)}
                          onChange={event => {
                            const value = Number(event.target.value);
                            if (!Number.isFinite(value)) return;
                            setCaptions(current => current.map(item => item.id === caption.id ? { ...item, startSeconds: Math.max(0, Math.min(value, item.endSeconds - 0.05)) } : item).sort((a, b) => a.startSeconds - b.startSeconds));
                          }}
                        />
                        <span>–</span>
                        <input
                          type="number"
                          min={caption.startSeconds + 0.05}
                          max={duration || 7200}
                          step="0.1"
                          value={caption.endSeconds}
                          aria-label={'Caption end time at ' + fmt(caption.startSeconds)}
                          onChange={event => {
                            const value = Number(event.target.value);
                            if (!Number.isFinite(value)) return;
                            setCaptions(current => current.map(item => item.id === caption.id ? { ...item, endSeconds: Math.max(item.startSeconds + 0.05, Math.min(value, duration || 7200)) } : item).sort((a, b) => a.startSeconds - b.startSeconds));
                          }}
                        />
                      </div>
                      <input
                        className="caption-text-input"
                        value={caption.text}
                        aria-label={'Edit caption text at ' + fmt(caption.startSeconds)}
                        onChange={event => setCaptions(current => current.map(item => item.id === caption.id ? { ...item, text: event.target.value.slice(0, 220) } : item))}
                      />
                      <button
                        className="icon-button remove-button caption-remove-button"
                        type="button"
                        title="Remove caption"
                        aria-label={'Remove caption at ' + fmt(caption.startSeconds)}
                        onClick={() => setCaptions(current => current.filter(item => item.id !== caption.id))}
                      >
                        <Trash2 size={15} />
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="caption-empty">
                  <AudioWaveform size={20} />
                  <span>Generate captions to see editable, time-synchronised subtitles here.</span>
                </div>
              )}
            </section>

            <section className="panel timeline-panel" style={{ display: ['manual', 'tools'].includes(editorSection) ? 'block' : 'none' }}>
              <div className="panel-heading">
                <div>
                  <span className="step-number">03</span>
                  <div>
                                    <h2>{editorSection === 'manual' ? 'Manual clip timeline' : 'Export & creative tools'}</h2>
                <p>{editorSection === 'manual' ? 'Set exact ranges, preview, split, reorder and adjust each clip.' : 'Control output quality, framing, audio, branding and saved versions.'}</p>
                  </div>
                </div>
                <div className="timeline-history-controls">
                  <button className="secondary-button" type="button" onClick={undoEdit} disabled={!historyAvailability.canUndo || !!busy} title="Undo the last timeline or caption edit" aria-label="Undo last edit"><Undo2 size={15} /> Undo</button>
                  <button className="secondary-button" type="button" onClick={redoEdit} disabled={!historyAvailability.canRedo || !!busy} title="Redo the last undone edit" aria-label="Redo edit"><Redo2 size={15} /> Redo</button>
                  <span className="panel-tag">{clipCountLabel.toUpperCase()}</span>
                </div>
              </div>
              <div style={{ display: editorSection === 'manual' ? 'block' : 'none' }}>
              <div className="manual-edit-guide"><strong>How to make a clip</strong><span>Pause at the start, tap <b>Use playhead</b> under START. Move to the end, tap <b>Use playhead</b> under END, then press <b>Add clip</b>.</span></div>
              <div className="range-builder">
                <label>
                  START (SECONDS)
                  <input
                    type="number"
                    min="0"
                    max={duration || 7200}
                    step="0.1"
                    value={startInput}
                    onChange={event => setStartInput(event.target.value)}
                  />
                  <button
                    className="playhead-button"
                    type="button"
                    onClick={() => setStartInput(playbackTime.toFixed(1))}
                    disabled={!videoUrl || !!busy}
                  >
                    Use playhead
                  </button>
                </label>
                <div className="range-arrow">
                  <ChevronRight size={17} />
                </div>
                <label>
                  END (SECONDS)
                  <input
                    type="number"
                    min="0.1"
                    max={duration || 7200}
                    step="0.1"
                    value={endInput}
                    onChange={event => setEndInput(event.target.value)}
                  />
                  <button
                    className="playhead-button"
                    type="button"
                    onClick={() => setEndInput(playbackTime.toFixed(1))}
                    disabled={!videoUrl || !!busy}
                  >
                    Use playhead
                  </button>
                </label>
                <button
                  className="secondary-button add-clip-button"
                  onClick={addManualClip}
                  disabled={!videoUrl || !!busy || clips.length >= 20}
                >
                  <Plus size={16} /> Add clip
                </button>
              </div>
              {clips.length === 0 ? (
                <div className="empty-timeline">
                  <AudioWaveform size={22} />
                  <span>
                    No clips yet. Add a range manually or use an AI suggestion.
                  </span>
                </div>
              ) : (
                <div className="clip-list">
                  <p className="timeline-order-hint">Sequence order follows this list. Use the arrows to rearrange clips before exporting.</p>
                  <div className="multitrack-overview" aria-label="Editable multi-track timeline">
                    <div className="timeline-tools"><span>DRAG CLIPS TO SLIP-EDIT · TAP THE RULER TO SEEK</span><label>ZOOM <input type="range" min="4" max="24" step="1" value={timelineScale} onChange={event => setTimelineScale(Number(event.target.value))} disabled={!!busy} /></label></div>
                    <div className="multitrack-scroll"><div className="multitrack-content" style={{ width: Math.max(720, duration * timelineScale) + 'px' }}>
                      <div className="timeline-ruler" onClick={seekTimeline}>{Array.from({ length: Math.ceil(duration / 10) + 1 }, (_, index) => index * 10).filter(time => time <= duration).map(time => <span key={time} style={{ left: (duration ? time / duration * 100 : 0) + '%' }}>{fmt(time)}</span>)}{beatPoints.map((time, index) => <i key={'beat-' + index} title={'Detected audio onset at ' + fmt(time)} style={{ position: 'absolute', left: (duration ? time / duration * 100 : 0) + '%', top: 0, bottom: 0, width: 2, background: '#e7b65a', opacity: 0.85, pointerEvents: 'none' }} />)}<i style={{ left: (duration ? playbackTime / duration * 100 : 0) + '%' }} /></div>
                      <div className="multitrack-lane"><strong>V1 · VIDEO</strong><div className="multitrack-track video-track" onClick={seekTimeline}>{clips.map((clip, index) => <button type="button" key={index} className="timeline-clip-block" title={'Drag to shift clip ' + (index + 1) + ' source range'} style={{ left: (duration ? clip.startSeconds / duration * 100 : 0) + '%', width: (duration ? Math.max(0.7, (clip.endSeconds - clip.startSeconds) / duration * 100) : 1) + '%', background: index % 2 ? '#347fbd' : '#258fbd' }} onPointerDown={event => startTimelineDrag('clip', index, event)} onPointerUp={finishTimelineDrag} onPointerCancel={() => { timelineDragRef.current = null; }} onClick={event => { event.stopPropagation(); setPlaybackTime(clip.startSeconds); if (videoRef.current) videoRef.current.currentTime = clip.startSeconds; }}>{index + 1}{getMotionKeyframes(clip).map(frame => <i key={frame.id} className="timeline-keyframe-marker" style={{ left: frame.at * 100 + '%' }} title={'Motion keyframe at ' + Math.round(frame.at * 100) + '%'} />)}<span className="timeline-trim-handle trim-start" title="Trim clip start" onPointerDown={event => startTimelineDrag('clip', index, event, 'trim-start')} onPointerUp={finishTimelineDrag} /><span className="timeline-trim-handle trim-end" title="Trim clip end" onPointerDown={event => startTimelineDrag('clip', index, event, 'trim-end')} onPointerUp={finishTimelineDrag} /></button>)}<i className="timeline-playhead" style={{ left: (duration ? playbackTime / duration * 100 : 0) + '%' }} /></div></div>
                      <div className="multitrack-lane"><strong>T1 · SUBTITLES</strong><div className="multitrack-track caption-track" onClick={seekTimeline}>{captions.map((caption, index) => <button type="button" key={caption.id} className="timeline-caption-block" title={'Drag to move subtitle: ' + caption.text} style={{ left: (duration ? caption.startSeconds / duration * 100 : 0) + '%', width: (duration ? Math.max(0.7, (caption.endSeconds - caption.startSeconds) / duration * 100) : 1) + '%' }} onPointerDown={event => startTimelineDrag('caption', index, event)} onPointerUp={finishTimelineDrag} onPointerCancel={() => { timelineDragRef.current = null; }} onClick={event => { event.stopPropagation(); setPlaybackTime(caption.startSeconds); if (videoRef.current) videoRef.current.currentTime = caption.startSeconds; }}>{caption.text.slice(0, 18)}<span className="timeline-trim-handle trim-start" title="Trim subtitle start" onPointerDown={event => startTimelineDrag('caption', index, event, 'trim-start')} onPointerUp={finishTimelineDrag} /><span className="timeline-trim-handle trim-end" title="Trim subtitle end" onPointerDown={event => startTimelineDrag('caption', index, event, 'trim-end')} onPointerUp={finishTimelineDrag} /></button>)}<i className="timeline-playhead" style={{ left: (duration ? playbackTime / duration * 100 : 0) + '%' }} /></div></div>
                      <div className="multitrack-lane"><strong>A1 · SOURCE AUDIO</strong><div className="multitrack-track audio-track" onClick={seekTimeline}><span className={sourceAudioEnabled ? '' : 'muted'} /><i className="timeline-playhead" style={{ left: (duration ? playbackTime / duration * 100 : 0) + '%' }} /></div></div>
                    </div></div>
                    <label className="source-audio-toggle"><input type="checkbox" checked={sourceAudioEnabled} onChange={event => setSourceAudioEnabled(event.target.checked)} disabled={!!busy} /> Enable source audio track</label>
                  </div>
                  {clips.map((clip, index) => (
                    <div className="clip-row" key={index}>
                      <div className="clip-index">
                        {String(index + 1).padStart(2, '0')}
                      </div>
                      <div className="clip-visual">
                        <div className="clip-bar">
                          <span
                            style={{
                              left:
                                (duration
                                  ? (clip.startSeconds / duration) * 100
                                  : 0) + '%',
                              width:
                                (duration
                                  ? ((clip.endSeconds - clip.startSeconds) /
                                      duration) *
                                    100
                                  : 0) + '%',
                            }}
                          />
                        </div>
                        <div className="clip-caption">
                          <strong>
                            {fmt(clip.startSeconds)} – {fmt(clip.endSeconds)}
                          </strong>
                          <small>
                            {clip.reason || 'Manual selection'} ·{' '}
                            {(clip.endSeconds - clip.startSeconds).toFixed(1)}{' '}
                            sec
                          </small>
                        </div>
                        <div className="clip-range-editor">
                          <label>
                            IN
                            <input
                              type="number"
                              min="0"
                              max={duration || undefined}
                              step="0.1"
                              defaultValue={clip.startSeconds.toFixed(1)}
                              aria-label={'Clip ' + (index + 1) + ' in point in seconds'}
                              disabled={!!busy}
                              onBlur={event => updateClipRange(index, 'startSeconds', event.currentTarget.value)}
                            />
                          </label>
                          <label>
                            OUT
                            <input
                              type="number"
                              min="0.1"
                              max={duration || undefined}
                              step="0.1"
                              defaultValue={clip.endSeconds.toFixed(1)}
                              aria-label={'Clip ' + (index + 1) + ' out point in seconds'}
                              disabled={!!busy}
                              onBlur={event => updateClipRange(index, 'endSeconds', event.currentTarget.value)}
                            />
                          </label>
                        </div>
                        <div className="clip-keyframes">
                          <div className="keyframe-heading"><strong>MOTION KEYFRAMES</strong><button type="button" className="clip-split-button" onClick={() => addMotionKeyframe(index)} disabled={!!busy}>+ At playhead</button></div>
                          <div className="keyframe-points">{getMotionKeyframes(clip).map(frame => <div className="keyframe-editor" key={frame.id}>
                            <strong>{Math.round(frame.at * 100)}% · {frame.scale.toFixed(2)}×</strong>
                            <label>Scale <input type="range" min="100" max="300" step="5" value={Math.round(frame.scale * 100)} onChange={event => updateMotionKeyframe(index, frame.id, 'scale', Number(event.target.value) / 100)} disabled={!!busy} /></label>
                            <label>Horizontal <input type="range" min="-50" max="50" step="1" value={Math.round(frame.x * 100)} onChange={event => updateMotionKeyframe(index, frame.id, 'x', Number(event.target.value) / 100)} disabled={!!busy} /></label>
                            <label>Vertical <input type="range" min="-50" max="50" step="1" value={Math.round(frame.y * 100)} onChange={event => updateMotionKeyframe(index, frame.id, 'y', Number(event.target.value) / 100)} disabled={!!busy} /></label>
                            <label>Opacity <input type="range" min="0" max="100" step="5" value={Math.round(frame.opacity * 100)} onChange={event => updateMotionKeyframe(index, frame.id, 'opacity', Number(event.target.value) / 100)} disabled={!!busy} /></label>
                            <label>Rotation <input type="range" min="-180" max="180" step="5" value={Math.round(frame.rotation)} onChange={event => updateMotionKeyframe(index, frame.id, 'rotation', Number(event.target.value))} disabled={!!busy} /></label>
                            <label>Easing <select value={frame.easing} onChange={event => updateMotionKeyframe(index, frame.id, 'easing', event.target.value as MotionKeyframe['easing'])} disabled={!!busy}><option value="linear">Linear</option><option value="ease-in">Ease in</option><option value="ease-out">Ease out</option><option value="ease-in-out">Ease in/out</option></select></label>
                            <button type="button" className="clip-order-button" onClick={() => removeMotionKeyframe(index, frame.id)} disabled={!!busy || getMotionKeyframes(clip).length <= 2} aria-label={'Remove keyframe at ' + Math.round(frame.at * 100) + ' percent'}>×</button>
                          </div>)}</div>
                        </div>
                        <label className="clip-volume-control">
                          <span>CLIP AUDIO · {Math.round(clip.volume ?? 100)}%</span>
                          <input
                            type="range"
                            min="0"
                            max="150"
                            step="5"
                            value={Math.max(0, Math.min(150, clip.volume ?? 100))}
                            aria-label={'Clip ' + (index + 1) + ' audio level'}
                            disabled={!!busy}
                            onChange={event => {
                              const volume = Number(event.target.value);
                              setClips(current => current.map((item, clipIndex) =>
                                clipIndex === index ? { ...item, volume } : item
                              ));
                            }}
                          />
                        </label>
                      </div>
                      <div className="clip-edit-actions">
                        <button
                          className="clip-order-button"
                          type="button"
                          title="Move clip earlier in sequence"
                          aria-label={'Move clip ' + (index + 1) + ' earlier in sequence'}
                          disabled={index === 0 || !!busy}
                          onClick={() => moveClip(index, -1)}
                        >↑</button>
                        <button
                          className="clip-order-button"
                          type="button"
                          title="Move clip later in sequence"
                          aria-label={'Move clip ' + (index + 1) + ' later in sequence'}
                          disabled={index === clips.length - 1 || !!busy}
                          onClick={() => moveClip(index, 1)}
                        >↓</button>
                        <button
                          className="clip-split-button"
                          type="button"
                          title="Split this clip at the current playhead position"
                          disabled={!videoUrl || !!busy || clips.length >= 20}
                          onClick={() => splitClipAtPlayhead(index)}
                        ><Scissors size={13} /> Split</button>
                      </div>
                      <button
                        className="icon-button preview-button"
                        disabled={!videoUrl || !!busy}
                        title="Preview this clip"
                        onClick={() => previewClip(clip)}
                      >
                        <Play size={15} />
                        <span>Preview</span>
                      </button>
                      <button
                        className="icon-button export-button"
                        disabled={!videoUrl || !!busy}
                        onClick={() => exportClip(clip, index)}
                      >
                        {busy === 'export-' + index ? (
                          <LoaderCircle className="spin" size={16} />
                        ) : (
                          <ArrowDownToLine size={17} />
                        )}
                        <span>Export</span>
                      </button>
                      <button
                        className="icon-button remove-button"
                        title="Remove clip"
                        onClick={() =>
                          setClips(current =>
                            current.filter((_, i) => i !== index)
                          )
                        }
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              </div>
              <div style={{ display: editorSection === 'tools' ? 'grid' : 'none', gap: 14 }}>
              <section className="panel" style={{ marginTop: 18 }}>
                <div className="panel-heading"><div><span className="step-number">04</span><div><h2>Smart vertical framing</h2><p>Find a stable subject position for portrait exports</p></div></div><span className="panel-tag">MOTION + VISUAL TRACKING</span></div>
                <div style={{ display: 'flex', gap: 18, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                  {videoUrl && <div style={{ width: 116, aspectRatio: '9 / 16', overflow: 'hidden', borderRadius: 12, border: '1px solid var(--line)', background: '#05070a' }}>
                    <video src={videoUrl} muted loop autoPlay playsInline style={{ width: '100%', height: '100%', objectFit: 'cover', objectPosition: (reframeX * 100) + '% ' + (reframeY * 100) + '%' }} />
                  </div>}
                  <div style={{ flex: '1 1 240px' }}>
                    <button className="secondary-button" type="button" onClick={suggestSmartReframe} disabled={!videoUrl || !!busy}>{busy === 'reframe' ? <LoaderCircle className="spin" size={15} /> : <WandSparkles size={15} />} Suggest subject crop</button>
                    <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 12 }}><input type="checkbox" checked={reframeEnabled} onChange={event => setReframeEnabled(event.target.checked)} disabled={!!busy} />Apply this crop to exports</label>
                    <label style={{ display: 'block', marginTop: 12 }}>Horizontal focus · {Math.round(reframeX * 100)}%<input type="range" min="0" max="100" value={Math.round(reframeX * 100)} onChange={event => { setReframeX(Number(event.target.value) / 100); setReframeEnabled(true); }} disabled={!videoUrl || !!busy} style={{ width: '100%' }} /></label>
                    <label style={{ display: 'block', marginTop: 8 }}>Vertical focus · {Math.round(reframeY * 100)}%<input type="range" min="0" max="100" value={Math.round(reframeY * 100)} onChange={event => { setReframeY(Number(event.target.value) / 100); setReframeEnabled(true); }} disabled={!videoUrl || !!busy} style={{ width: '100%' }} /></label>
                    <small>{reframeStatus || 'Combines timestamped visual detections with persistent motion-region tracking, confidence filtering and scene-cut resets. Motion regions are not guaranteed person identity; review the crop before export.'}</small>
                  </div>
                </div>
              </section>

              <section className="panel" style={{ marginTop: 18 }}>
                <div className="panel-heading"><div><span className="step-number">05</span><div><h2>Beat sync</h2><p>Detect likely audio onsets and use them as cut suggestions</p></div></div><span className="panel-tag">ON-DEVICE AUDIO</span></div>
                <button className="secondary-button" type="button" onClick={analyzeBeats} disabled={!file || isRemoteSource || !!busy}>{busy === 'beats' ? <LoaderCircle className="spin" size={15} /> : <AudioWaveform size={15} />} Detect beat / onset points</button>
                <small style={{ display: 'block', marginTop: 8 }}>{beatStatus || 'Local browser audio analysis only. Supports local files up to 5 minutes and 50 MB; detected points are approximate rhythmic onsets, not guaranteed beats.'}</small>
                {beatPoints.length > 0 && <>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
                    {beatPoints.slice(0, 12).map((time, index) => <button key={index} className="clip-order-button" type="button" onClick={() => previewClip({ startSeconds: time, endSeconds: Math.min(duration, time + 1) })}>{fmt(time)}</button>)}
                    {beatPoints.length > 12 && <small>+{beatPoints.length - 12} more</small>}
                  </div>
                  <button className="secondary-button" type="button" onClick={applyBeatCuts} disabled={!clips.length || !!busy} style={{ marginTop: 12 }}>Apply onset cuts to timeline</button>
                </>}
              </section>

              <section className="panel" style={{ marginTop: 18 }}>
                <div className="panel-heading"><div><span className="step-number">06</span><div><h2>Editing presets</h2><p>Choose a starting point; nothing changes until you apply it</p></div></div><span className="panel-tag">CUSTOMISABLE</span></div>
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'end' }}>
                  <label style={{ flex: '1 1 220px' }}>PRESET
                    <select value={editingPreset} onChange={event => setEditingPreset(event.target.value as 'tiktok' | 'youtube-shorts' | 'instagram-reels')} disabled={!!busy} style={{ display: 'block', width: '100%' }}>
                      <option value="tiktok">TikTok · fast hook</option><option value="youtube-shorts">YouTube Shorts · balanced story</option><option value="instagram-reels">Instagram Reels · polished vertical</option>
                    </select>
                  </label>
                  <button className="secondary-button" type="button" onClick={applyEditingPreset} disabled={!!busy}>Apply preset</button>
                </div>
                <small style={{ display: 'block', marginTop: 8 }}>Applying a preset updates aspect, resolution, quality, caption style, pacing guidance and transition defaults. You can customise every setting afterwards.</small>
              </section>

              <section className="panel" style={{ marginTop: 18 }}>
                <div className="panel-heading"><div><span className="step-number">07</span><div><h2>Brand kit</h2><p>Reuse your logo, colours and caption styling in exports</p></div></div><span className="panel-tag">LOCAL ONLY</span></div>
                <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                  <button className="secondary-button" type="button" onClick={() => brandLogoInputRef.current?.click()} disabled={!!busy}><Upload size={14} /> {brandLogoData ? 'Replace logo' : 'Add logo'}</button>
                  {brandLogoData && <button className="secondary-button" type="button" onClick={() => setBrandLogoData('')} disabled={!!busy}>Remove logo</button>}
                  <input ref={brandLogoInputRef} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={event => { handleBrandLogoChange(event.target.files?.[0]); event.currentTarget.value = ''; }} />
                  <label>Primary colour <input type="color" value={brandPrimaryColor} onChange={event => setBrandPrimaryColor(event.target.value)} /></label>
                  <label>Secondary colour <input type="color" value={brandSecondaryColor} onChange={event => setBrandSecondaryColor(event.target.value)} /></label>
                  <label>Caption font <select value={brandFontFamily} onChange={event => setBrandFontFamily(event.target.value)} disabled={!!busy}><option value="Arial, sans-serif">Arial</option><option value="Trebuchet MS, sans-serif">Trebuchet</option><option value="Georgia, serif">Georgia</option></select></label>
                </div>
                <div style={{ display: 'flex', gap: 10, marginTop: 12, flexWrap: 'wrap' }}>
                  <button className="secondary-button" type="button" onClick={applyBrandStyleToCaptions} disabled={!!busy}>Apply brand colour to captions</button>
                  <button className="primary-button" type="button" onClick={saveBrandKit} disabled={!brandKitReady || !!busy}><Save size={14} /> Save brand kit</button>
                </div>
                <small style={{ display: 'block', marginTop: 8 }}>The logo is limited to 500 KB and stays in this browser. It is not uploaded to a third party; the logo is embedded only when you export.</small>
              </section>

              <section className="panel" style={{ marginTop: 18 }}>
                <div className="panel-heading"><div><span className="step-number">08</span><div><h2>Project version history</h2><p>Save and restore named edit-state snapshots</p></div></div><span className="panel-tag">THIS BROWSER</span></div>
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                  <input value={versionName} onChange={event => setVersionName(event.target.value.slice(0, 80))} placeholder="Version name (optional)" aria-label="Project version name" disabled={!!busy} style={{ flex: '1 1 220px' }} />
                  <button className="secondary-button" type="button" onClick={saveProjectVersion} disabled={!activeProjectId || !clips.length || !!busy}>Save version</button>
                </div>
                {!activeProjectId && <small style={{ display: 'block', marginTop: 8 }}>Save the edit plan to My projects first. Versions are stored locally in this browser and are not cloud-synced.</small>}
                {projectVersions.length > 0 ? <div style={{ display: 'grid', gap: 10, marginTop: 14 }}>
                  {projectVersions.map(version => <div key={version.id} style={{ borderTop: '1px solid var(--line)', paddingTop: 10, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                    <div style={{ flex: '1 1 220px' }}><strong>{version.name}</strong><small style={{ display: 'block' }}>{new Date(version.savedAt).toLocaleString()} · {version.clips.length} clips · {version.captions.length} captions · {version.exportAspect} · {version.exportResolution}p</small></div>
                    <button className="secondary-button" type="button" onClick={() => restoreProjectVersion(version)} disabled={!!busy}>Restore</button>
                  </div>)}
                </div> : <small style={{ display: 'block', marginTop: 10 }}>No local versions saved for this edit plan yet.</small>}
              </section>

              <div className="sequence-export-panel">
                <div className="sequence-export-copy">
                  <strong>Export full sequence</strong>
                  <span>Join clips in the order shown above, with smooth picture and audio crossfades. AI noise reduction is applied locally during export when enabled.</span>
                </div>
                <label>
                  CROSSFADE
                  <select
                    value={crossfadeDuration}
                    onChange={event => setCrossfadeDuration(event.target.value)}
                    disabled={!!busy}
                  >
                    <option value="0.5">0.5 seconds</option>
                    <option value="0.8">0.8 seconds</option>
                    <option value="1.2">1.2 seconds</option>
                    <option value="1.5">1.5 seconds</option>
                    <option value="2">2 seconds</option>
                  </select>
                </label>
                <button
                  className="primary-button sequence-export-button"
                  onClick={exportSequence}
                  disabled={clips.length < 2 || !!busy || !videoUrl}
                >
                  {busy === 'sequence' ? <LoaderCircle className="spin" size={16} /> : <Film size={16} />}
                  {busy === 'sequence' ? 'Exporting sequence…' : 'Export sequence'}
                </button>
              </div>
              {exportProgress && <div className="export-progress-panel"><div><strong>{exportProgress.label}</strong><span>{Math.round(exportProgress.percent)}%</span></div><div className="export-progress-track"><i style={{ width: Math.max(0, Math.min(100, exportProgress.percent)) + '%' }} /></div></div>}
              <div className="timeline-footer">
                <div className="export-settings">
                  <span>
                    <Check size={14} /> Available encoder: {getSupportedExportMimeType(exportFormat) ? getExportFileExtension(getSupportedExportMimeType(exportFormat)).toUpperCase() : 'Unavailable'}
                  </span>
                  <label>
                    ASPECT
                    <select
                      value={exportAspect}
                      onChange={event => setExportAspect(event.target.value as 'original' | '9:16' | '1:1' | '16:9')}
                      disabled={!!busy}
                    >
                      <option value="original">Original</option>
                      <option value="9:16">9:16 · TikTok / Reels</option>
                      <option value="1:1">1:1 · Square</option>
                      <option value="16:9">16:9 · YouTube</option>
                    </select>
                  </label>
                  <label>
                    RESOLUTION
                    <select
                      value={exportResolution}
                      onChange={event => setExportResolution(event.target.value as '720' | '1080')}
                      disabled={!!busy}
                    >
                      <option value="720">720p · Faster</option>
                      <option value="1080">1080p · Sharper</option>
                    </select>
                  </label>
                  <label className="audio-level-setting">
                    AI NOISE REDUCTION · {audioCleanup}%
                    <input type="range" min="0" max="100" step="5" value={audioCleanup} onChange={event => setAudioCleanup(Number(event.target.value))} disabled={!!busy} aria-label="AI background noise reduction strength" />
                    <span>0% off · higher values suppress more background noise. Best for speech; music and game sounds may soften.</span>
                  </label>
                  <label className="audio-level-setting">
                    AUDIO LEVEL · {exportVolume}%
                    <input
                      type="range"
                      min="0"
                      max="150"
                      step="5"
                      value={exportVolume}
                      onChange={event => setExportVolume(Number(event.target.value))}
                      disabled={!!busy}
                      aria-label="Export audio level"
                    />
                    <span>0% mute · 100% original · 150% boost</span>
                  </label>
                  <label>
                    FORMAT
                    <select value={exportFormat} onChange={event => setExportFormat(event.target.value as 'auto' | 'mp4' | 'webm')} disabled={!!busy}>
                      <option value="auto">Auto · MP4 first</option>
                      <option value="mp4" disabled={!getSupportedExportMimeType('mp4')}>MP4 only</option>
                      <option value="webm" disabled={!getSupportedExportMimeType('webm')}>WebM only</option>
                    </select>
                  </label>
                  <label>
                    QUALITY
                    <select
                      value={exportQuality}
                      onChange={event => setExportQuality(event.target.value as 'compact' | 'standard' | 'high')}
                      disabled={!!busy}
                    >
                      <option value="compact">Compact · smaller file</option>
                      <option value="standard">Standard · balanced</option>
                      <option value="high">High · sharper video</option>
                    </select>
                  </label>
                </div>
                <button
                  className="primary-button save-button"
                  onClick={saveProject}
                  disabled={!clips.length || !!busy}
                >
                  {busy === 'save' ? (
                    <LoaderCircle className="spin" size={16} />
                  ) : (
                    <Save size={16} />
                  )}{' '}
                  {activeProjectId ? 'Update edit plan' : 'Save edit plan'}
                </button>
              </div>
              </div>
            </section>

            <div className="bottom-note" style={{ display: editorSection === 'tools' ? 'flex' : 'none' }}>
              <span>
                <CircleHelp size={15} />
              </span>
              <p>
                <strong>Export note:</strong> Auto mode tries supported MP4 encoders first, then WebM. You can force either format when the browser reports support. The downloaded extension follows the recorder's actual MIME type.
                Captions are burned into the picture with the selected entrance animation. AI noise reduction runs on your device during export and does not change the source video. It is speech-focused and may soften music or game audio. Both export types include master audio level controls and sequence crossfades. Motion analysis uses dense sampled block-flow estimates; semantic action recognition still reasons over selected keyframes rather than every decoded frame.
              </p>
            </div>
          </div>
        ) : activeTab === 'projects' ? (
          <div className="page projects-page">            <section className="page-heading">
              <div>
                <div className="eyebrow">
                  <FolderOpen size={14} /> YOUR LIBRARY
                </div>
                <h1>
                  Saved <span>edit plans.</span>
                </h1>
                <p>
                  Your clip ranges, captions and subtitle styles, ready to reopen when you have the
                  original source video.
                </p>
              </div>
              <button
                className="primary-button"
                onClick={startNewEdit}
              >
                <Plus size={16} /> New edit
              </button>
            </section>
            {projects.length === 0 ? (
              <div className="empty-projects">
                <div className="empty-project-icon">
                  <FolderOpen size={25} />
                </div>
                <h2>No saved projects yet</h2>
                <p>
                  Save an edit plan from the editor and it will show up here.
                </p>
                <button
                  className="secondary-button"
                  onClick={() => setActiveTab('editor')}
                >
                  Open editor <ChevronRight size={15} />
                </button>
              </div>
            ) : (
              <div className="project-grid">
                {projects.map(project => (
                  <article className="project-card" key={project.id}>
                    <div className="project-card-top">
                      <div className="project-icon">
                        <Film size={18} />
                      </div>
                      <button
                  className="icon-button remove-button project-delete-button"
                  title="Delete project"
                  aria-label={'Delete edit plan ' + project.title}
                  disabled={!!deletingProjectId}
                  onClick={() => deleteProject(project.id)}
                >
                        <Trash2 size={16} />
                      </button>
                    </div>
                    <h3>{project.title}</h3>
                    <p>
                      {project.clips.length} clip
                      {project.clips.length === 1 ? '' : 's'} · {project.captions?.length || 0} captions · Updated{' '}
                      {new Date(project.updatedAt).toLocaleDateString()}
                    </p>
                    <div className="project-ranges">
                      {project.clips.slice(0, 3).map((clip, index) => (
                        <span key={index}>
                          {fmt(clip.startSeconds)}–{fmt(clip.endSeconds)}
                        </span>
                      ))}
                      {project.clips.length > 3 && (
                        <span>+{project.clips.length - 3} more</span>
                      )}
                    </div>
                    <button
                      className="secondary-button full"
                      onClick={() => loadProject(project)}
                    >
                      Open edit plan <ChevronRight size={15} />
                    </button>
                  </article>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="page help-page">
            <section className="page-heading">
              <div>
                <div className="eyebrow"><BookOpen size={14} /> START HERE</div>
                <h1>Learn your <span>studio.</span></h1>
                <p>A simple walkthrough of CLIPFORGE, from choosing a video to saving your edit.</p>
              </div>
              <button className="primary-button" onClick={() => { setEditorSection('highlights'); setActiveTab('editor'); }}><Scissors size={16} /> Open editor</button>
            </section>
            <div className="help-welcome">
              <div className="help-welcome-icon"><Sparkles size={22} /></div>
              <div><strong>New to CLIPFORGE? Follow these steps in order.</strong><p>You do not need to understand every setting. Start with one short video and practise the basic workflow.</p></div>
            </div>
            <div className="help-steps">
              <article className="help-step"><span className="help-step-number">01</span><div><h2>Add your video</h2><p>Open <b>Editor</b> and tap <b>Choose video</b>. Pick a video file from your phone or computer. You can also paste a direct video-file link and tap <b>Use link</b>.</p><small>YouTube and TikTok page links are not supported. A direct MP4, WebM, MOV or M4V file link may work if the host allows it.</small></div></article>
              <article className="help-step"><span className="help-step-number">02</span><div><h2>Find the best moments</h2><p>Tap <b>Highlights</b>, then tap <b>Find highlights</b>. Wait for the suggestions. Preview each one, tap its <b>+</b> button to keep it, or choose <b>Add all suggestions</b>.</p><small>AI checks selected points in the video, not every frame. Always preview clips before exporting.</small></div></article>
              <article className="help-step"><span className="help-step-number">03</span><div><h2>Give the AI directions (optional)</h2><p>Tap <b>AI brief + script</b> if you want a particular style or story. Add instructions, paste a script if you have one, then tap <b>Create edit from brief + script</b>. You can skip this and use Highlights on its own.</p><small>The AI can only choose moments that are actually visible in your video. It cannot create missing scenes.</small></div></article>
              <article className="help-step"><span className="help-step-number">04</span><div><h2>Edit clips and subtitles</h2><p>Tap <b>Edit clips</b> to trim, split, preview or reorder clips. Tap <b>Subtitles</b> to create captions, correct the words and change their appearance. Use Undo if you make a change you do not like.</p><small>Automatic subtitles need an uploaded video file that is 20 minutes or shorter. Direct video links cannot be transcribed in this beta.</small></div></article>
              <article className="help-step"><span className="help-step-number">05</span><div><h2>Export and save</h2><p>Tap <b>Export + more</b>. Choose your video shape, quality and sound level. Use <b>AI Noise Reduction</b> to reduce background noise in speech, then export one clip or the full sequence. Tap <b>Save edit plan</b> to keep your edit settings.</p><small>Noise reduction runs on your device and is speech-focused; strong settings may soften music or game sounds. MP4 is used when your browser supports it; otherwise exports use WebM. A saved edit plan does not include the original video, so choose that video again when reopening it.</small></div></article>

            </div>
            <section className="help-mode-grid">
              <article><strong>Highlights</strong><p>Quick AI shortlist. No brief or script.</p></article>
              <article><strong>AI brief + script</strong><p>Custom editing rules and ordered story beats in one combined analysis.</p></article>
              <article><strong>Edit clips</strong><p>Trim, split, preview and reorder clips.</p></article>
              <article><strong>Subtitles</strong><p>Create and style your captions.</p></article>
              <article><strong>Export + more</strong><p>Choose video shape, sound, branding and save your edit.</p></article>
            </section>
            <section className="help-info-grid">
              <div className="help-info-card"><h3><Check size={16} /> Privacy basics</h3><p>Your video file stays on your device in this beta. When you request AI suggestions, compressed still frames are sent to the AI service for analysis. Do not submit private footage unless you are comfortable with that.</p></div>
              <div className="help-info-card"><h3><CircleHelp size={16} /> If something goes wrong</h3><p>If a video will not load, try a shorter MP4 or a different browser. If export is unsupported, update to a recent Chrome browser. If AI suggestions fail, you can still add clips manually.</p></div>
            </section>
            <div className="help-bottom"><div><strong>Ready to make your first clip?</strong><p>Start with Highlights. You can explore the other tools once your first edit is ready.</p></div><button className="primary-button" onClick={() => { setEditorSection('highlights'); setActiveTab('editor'); }}>Open Highlights <ChevronRight size={16} /></button></div>
          </div>
        )}
      </main>
    </div>
  );
}

export default App;
