import { ai, db, error, json, requireAuth, router } from '@appdeploy/sdk';

type Clip = {
  startSeconds: number;
  endSeconds: number;
  reason?: string;
  score?: number;
};

type Caption = {
  id: string;
  startSeconds: number;
  endSeconds: number;
  text: string;
};

type CaptionStyle = {
  fontSize: string;
  color: string;
  background: 'dark' | 'none';
};
type ProjectSettings = {
  editInstructions: string; editScript: string; editingMode: 'manual' | 'automatic' | 'hybrid';
  captionAnimation: 'none' | 'fade' | 'pop'; exportQuality: 'compact' | 'standard' | 'high';
  exportAspect: 'original' | '9:16' | '1:1' | '16:9'; exportResolution: '720' | '1080';
  crossfadeDuration: string; exportVolume: number; audioCleanup: number;
  clipLengthMode: 'ai' | 'fixed'; customClipLength: string;
  reframeEnabled: boolean; reframeX: number; reframeY: number;
};

type ProjectRecord = {
  ownerId: string;
  title: string;
  clips: Clip[];
  captions?: Caption[];
  captionStyle?: CaptionStyle;
  settings?: ProjectSettings;
  createdAt: string;
  updatedAt: string;
};

type FrameInput = {
  timeSeconds: number;
  data: string;
  mimeType: string;
};

type EventPhase = 'setup' | 'action' | 'outcome' | 'reaction' | 'standalone';
type MotionSample = {
  timeSeconds: number; trackingGap?: boolean; magnitude: number;
  direction: 'left' | 'right' | 'up' | 'down' | 'mixed' | 'still';
  changedRegionRatio: number; trackX: number; trackY: number; confidence: number;
  cameraMotionX?: number; cameraMotionY?: number; subjectMotionX?: number; subjectMotionY?: number;
  subjectMotionRatio?: number; flowConfidence?: number; sceneCut?: boolean;
  trackId?: number | null; trackAge?: number; trackStability?: number;
  trackWidth?: number; trackHeight?: number; occluded?: boolean;
  predictionHorizonSeconds?: number; predictedTrackX?: number; predictedTrackY?: number;
  predictionConfidence?: number; trackUncertainty?: number;
};

type TranscriptInput = {
  startSeconds: number;
  endSeconds: number;
  text: string;
};

function projectTable(userId: string) {
  const safeUserId = userId.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 90);
  return 'projects_' + safeUserId;
}

function validClips(
  value: unknown,
  duration = Number.POSITIVE_INFINITY
): value is Clip[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20)
    return false;
  return value.every(
    clip =>
      clip &&
      typeof clip === 'object' &&
      Number.isFinite((clip as Clip).startSeconds) &&
      Number.isFinite((clip as Clip).endSeconds) &&
      (clip as Clip).startSeconds >= 0 &&
      (clip as Clip).endSeconds > (clip as Clip).startSeconds &&
      (clip as Clip).endSeconds <= duration
  );
}

function validCaptions(value: unknown): value is Caption[] {
  if (!Array.isArray(value) || value.length > 1000) return false;
  return value.every(caption =>
    caption &&
    typeof caption === 'object' &&
    typeof (caption as Caption).id === 'string' &&
    (caption as Caption).id.length > 0 &&
    (caption as Caption).id.length <= 120 &&
    Number.isFinite((caption as Caption).startSeconds) &&
    Number.isFinite((caption as Caption).endSeconds) &&
    (caption as Caption).startSeconds >= 0 &&
    (caption as Caption).endSeconds > (caption as Caption).startSeconds &&
    (caption as Caption).endSeconds <= 7200 &&
    typeof (caption as Caption).text === 'string' &&
    (caption as Caption).text.trim().length > 0 &&
    (caption as Caption).text.length <= 220
  );
}

function validProjectSettings(value: unknown): value is ProjectSettings {
  if (!value || typeof value !== 'object') return false;
  const s = value as ProjectSettings;
  return typeof s.editInstructions === 'string' && s.editInstructions.length <= 1500 &&
    typeof s.editScript === 'string' && s.editScript.length <= 4000 &&
    ['manual', 'automatic', 'hybrid'].includes(s.editingMode) &&
    ['none', 'fade', 'pop'].includes(s.captionAnimation) &&
    ['compact', 'standard', 'high'].includes(s.exportQuality) &&
    ['original', '9:16', '1:1', '16:9'].includes(s.exportAspect) &&
    ['720', '1080'].includes(s.exportResolution) &&
    ['0.5', '0.8', '1.2', '1.5', '2'].includes(s.crossfadeDuration) &&
    Number.isFinite(s.exportVolume) && s.exportVolume >= 0 && s.exportVolume <= 150 &&
    Number.isFinite(s.audioCleanup) && s.audioCleanup >= 0 && s.audioCleanup <= 100 &&
    ['ai', 'fixed'].includes(s.clipLengthMode) &&
    typeof s.customClipLength === 'string' && /^\d{1,2}$/.test(s.customClipLength) &&
    Number(s.customClipLength) >= 1 && Number(s.customClipLength) <= 45 &&
    typeof s.reframeEnabled === 'boolean' &&
    Number.isFinite(s.reframeX) && s.reframeX >= 0 && s.reframeX <= 1 &&
    Number.isFinite(s.reframeY) && s.reframeY >= 0 && s.reframeY <= 1;
}

function validCaptionStyle(value: unknown): value is CaptionStyle {
  if (!value || typeof value !== 'object') return false;
  const style = value as CaptionStyle;
  return ['26', '34', '42'].includes(style.fontSize) &&
    typeof style.color === 'string' &&
    /^#[0-9a-fA-F]{6}$/.test(style.color) &&
    (style.background === 'dark' || style.background === 'none');
}


function aiFailureResponse(err: unknown, feature: string) {
  let details = String(err);
  try {
    details += ' ' + JSON.stringify(err);
  } catch {
    // Keep the original error message if the provider error is not serializable.
  }
  if (/ai_usage_limit_exceeded|AI usage limit exceeded/i.test(details)) {
    const resetAt = details.match(/"daily"\s*:\s*"([^"]+)"/)?.[1];
    const resetMessage = resetAt
      ? ' The daily limit resets at ' + resetAt + ' (UTC).'
      : ' Please retry after the daily reset.';
    return error(
      'AI daily usage limit reached.' + resetMessage +
      ' You can still edit clips and captions manually.',
      429
    );
  }
  return error(feature + ' is temporarily unavailable. Please try again.', 502);
}

export const handler = router({
  'GET /api/health': [async () => json({ ok: true, version: '1.0.0-beta.1' })],

  'GET /api/projects': [
    requireAuth(),
    async ctx => {
      const result = await db.list<ProjectRecord>(
        projectTable(ctx.user!.userId),
        { limit: 50 }
      );
      const projects = result.items
        .filter(item => item.ownerId === ctx.user!.userId)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      return json({ projects });
    },
  ],

  'POST /api/projects': [
    requireAuth(),
    async ctx => {
      const body = (ctx.body || {}) as { title?: string; clips?: unknown; captions?: unknown; captionStyle?: unknown; settings?: unknown };
      const title =
        typeof body.title === 'string' ? body.title.trim().slice(0, 180) : '';
      if (!title) return error('A project title is required.', 400);
      if (!validClips(body.clips))
        return error('Add between 1 and 20 valid clips before saving.', 400);
      if (body.captions !== undefined && !validCaptions(body.captions))
        return error('One or more caption entries are invalid.', 400);
      if (body.captionStyle !== undefined && !validCaptionStyle(body.captionStyle))
        return error('Caption style settings are invalid.', 400);
      if (body.settings !== undefined && !validProjectSettings(body.settings))
        return error('Project editing settings are invalid.', 400);
      const now = new Date().toISOString();
      const record: ProjectRecord = {
        ownerId: ctx.user!.userId,
        title,
        clips: body.clips,
        captions: (body.captions as Caption[] | undefined) || [],
        captionStyle: (body.captionStyle as CaptionStyle | undefined) || {
          fontSize: '34', color: '#ffffff', background: 'dark',
        },
        settings: body.settings as ProjectSettings | undefined,
        createdAt: now,
        updatedAt: now,
      };
      const [id] = await db.add(projectTable(ctx.user!.userId), [record]);
      if (!id)
        return error('The project could not be saved. Please retry.', 503);
      return json({ project: { id, ...record } }, 201);
    },
  ],

  'PUT /api/projects/:id': [
    requireAuth(),
    async ctx => {
      const body = (ctx.body || {}) as { title?: string; clips?: unknown; captions?: unknown; captionStyle?: unknown; settings?: unknown };
      const [current] = await db.get<ProjectRecord>(
        projectTable(ctx.user!.userId),
        [ctx.params.id],
        { consistent: true }
      );
      if (!current || current.ownerId !== ctx.user!.userId)
        return error('Project not found.', 404);
      const title =
        typeof body.title === 'string'
          ? body.title.trim().slice(0, 180)
          : current.title;
      const clips = body.clips === undefined ? current.clips : body.clips;
      const captions = body.captions === undefined ? (current.captions || []) : body.captions;
      const captionStyle = body.captionStyle === undefined
        ? (current.captionStyle || { fontSize: '34', color: '#ffffff', background: 'dark' as const })
        : body.captionStyle;
      const settings = body.settings === undefined ? current.settings : body.settings;
      if (!title || !validClips(clips) || !validCaptions(captions) || !validCaptionStyle(captionStyle) || (settings !== undefined && !validProjectSettings(settings)))
        return error('Project title, clip ranges, or captions are invalid.', 400);
      const updated: ProjectRecord = {
        ...current,
        title,
        clips,
        captions,
        captionStyle,
        settings: settings as ProjectSettings | undefined,
        updatedAt: new Date().toISOString(),
      };
      const [ok] = await db.update(projectTable(ctx.user!.userId), [
        { id: ctx.params.id, record: updated },
      ]);
      if (!ok) return error('The project could not be updated.', 503);
      return json({ project: { id: ctx.params.id, ...updated } });
    },
  ],

  'DELETE /api/projects/:id': [
    requireAuth(),
    async ctx => {
      const [current] = await db.get<ProjectRecord>(
        projectTable(ctx.user!.userId),
        [ctx.params.id],
        { consistent: true }
      );
      if (!current || current.ownerId !== ctx.user!.userId)
        return error('Project not found.', 404);
      const [ok] = await db.delete(projectTable(ctx.user!.userId), [
        ctx.params.id,
      ]);
      if (!ok) return error('The project could not be deleted.', 503);
      return json({ deleted: true });
    },
  ],

  'POST /api/transcribe': [
    requireAuth(),
    async ctx => {
      const body = (ctx.body || {}) as {
        audioData?: string;
        startSeconds?: number;
      };
      const audioData = body.audioData;
      const startSeconds = Number(body.startSeconds);
      if (
        typeof audioData !== 'string' ||
        audioData.length < 100 ||
        audioData.length > 2_100_000 ||
        !Number.isFinite(startSeconds) ||
        startSeconds < 0 ||
        startSeconds > 1200
      ) {
        return error('The audio chunk is invalid or too large. Please retry transcription.', 400);
      }
      try {
        const result = await ai.ocr({
          audios: [{ data: audioData, mimeType: 'audio/wav' }],
          prompt: 'Transcribe the spoken words in this audio accurately. Return separate readable caption segments with startSeconds and endSeconds measured from the beginning of this audio chunk (0 to 45 seconds). Keep each segment short enough to read on screen, usually one phrase or sentence lasting about 1 to 5 seconds. Preserve the original language and punctuation. Ignore background music and non-speech sounds. If there is no intelligible speech, return an empty segments array.',
          schema: {
            type: 'object',
            properties: {
              segments: {
                type: 'array',
                maxItems: 100,
                items: {
                  type: 'object',
                  properties: {
                    startSeconds: { type: 'number', minimum: 0, maximum: 45 },
                    endSeconds: { type: 'number', minimum: 0, maximum: 45 },
                    text: { type: 'string' },
                  },
                  required: ['startSeconds', 'endSeconds', 'text'],
                },
              },
            },
            required: ['segments'],
          },
          maxRetries: 1,
          maxTokens: 2500,
          thinkingMode: 'FAST',
        });
        const data = result.data as {
          segments?: Array<{ startSeconds: number; endSeconds: number; text: string }>;
        } | undefined;
        const segments = (Array.isArray(data?.segments) ? data.segments : [])
          .filter(item =>
            Number.isFinite(item.startSeconds) &&
            Number.isFinite(item.endSeconds) &&
            item.startSeconds >= 0 &&
            item.endSeconds > item.startSeconds &&
            item.endSeconds <= 45 &&
            typeof item.text === 'string' &&
            item.text.trim().length > 0
          )
          .map(item => ({
            startSeconds: Number(item.startSeconds.toFixed(2)),
            endSeconds: Number(item.endSeconds.toFixed(2)),
            text: item.text.trim().slice(0, 220),
          }))
          .sort((a, b) => a.startSeconds - b.startSeconds);
        return json({ segments, chunkStartSeconds: startSeconds });
      } catch (err) {
        console.error('Caption transcription failed', err);
        return aiFailureResponse(err, 'AI transcription');
      }
    },
  ],

  'POST /api/reframe': [
    requireAuth(),
    async ctx => {
      const body = (ctx.body || {}) as { frames?: FrameInput[] };
      const frames = body.frames;
      if (!Array.isArray(frames) || frames.length < 3 || frames.length > 12) return error('Provide 3 to 12 chronological framing samples.', 400);
      const validFrames = frames.every(frame =>
        frame && Number.isFinite(frame.timeSeconds) && frame.timeSeconds >= 0 && frame.timeSeconds <= 7200 &&
        typeof frame.data === 'string' && frame.data.length > 20 && frame.data.length <= 1_500_000 &&
        /^[A-Za-z0-9+/]+={0,2}$/.test(frame.data) && ['image/jpeg', 'image/webp', 'image/png'].includes(frame.mimeType)
      );
      if (!validFrames || frames.reduce((sum, frame) => sum + frame.data.length, 0) > 8_000_000) return error('One or more framing samples are invalid or too large.', 400);
      const orderedFrames = [...frames].sort((a, b) => a.timeSeconds - b.timeSeconds);
      if (orderedFrames.some((frame, index) => index > 0 && frame.timeSeconds <= orderedFrames[index - 1].timeSeconds)) return error('Framing sample timestamps must be unique and chronological.', 400);
      try {
        const result = await ai.extract({
          prompt: 'You are a visual tracking analyst. Inspect all supplied chronological frames from the SAME video. In EACH frame, detect up to four clearly visible, relevant entities: people, animals, balls, vehicles or other prominent moving/foreground objects. Return a tight normalized bounding box (x, y, width, height) and its centre for each detection. Assign a stable trackId such as subject-1 or subject-2 ONLY when the same visible entity can be matched across frames using appearance, clothing/colour, shape, position continuity and scene context. Do not merge two people merely because they share a class or clothing colour. When adjacent sampled timestamps are more than 5 seconds apart, do not infer continuity from position alone; require distinctive appearance evidence. If identity becomes ambiguous after a cut, long occlusion or large time gap, start a new trackId instead of guessing. It is acceptable to omit uncertain detections. Confidence must reflect visual certainty, not how interesting the subject is. frameIndex is the exact zero-based index of the image in the supplied order. A still image does not prove movement; do not invent trajectory or events between frames. Use descriptive subject labels such as "person in dark top" or "football" and do not identify real people.',
          content: 'There are ' + orderedFrames.length + ' images. Exact frame index to source timestamp mapping: ' + orderedFrames.map((frame, index) => index + ' = ' + frame.timeSeconds.toFixed(2) + 's').join(' | ') + '. Return separate detections for distinct visible entities. Use the same trackId only for defensible visual identity matches.',
          images: orderedFrames.map(frame => ({ data: frame.data, mimeType: frame.mimeType })),
          schema: {
            type: 'object',
            properties: {
              detections: {
                type: 'array',
                maxItems: 48,
                items: {
                  type: 'object',
                  properties: {
                    frameIndex: { type: 'integer', minimum: 0, maximum: 11 },
                    trackId: { type: 'string' },
                    subject: { type: 'string' },
                    centerX: { type: 'number', minimum: 0, maximum: 1 },
                    centerY: { type: 'number', minimum: 0, maximum: 1 },
                    x: { type: 'number', minimum: 0, maximum: 1 },
                    y: { type: 'number', minimum: 0, maximum: 1 },
                    width: { type: 'number', minimum: 0.005, maximum: 1 },
                    height: { type: 'number', minimum: 0.005, maximum: 1 },
                    confidence: { type: 'number', minimum: 0, maximum: 1 },
                  },
                  required: ['frameIndex', 'trackId', 'centerX', 'centerY', 'x', 'y', 'width', 'height', 'confidence'],
                },
              },
            },
            required: ['detections'],
          },
          maxRetries: 1,
          maxTokens: 2200,
          thinkingMode: 'FAST',
        });
        const data = result.data as { detections?: Array<{ frameIndex: number; trackId: string; subject?: string; centerX: number; centerY: number; x: number; y: number; width: number; height: number; confidence: number }> } | undefined;
        const detections = (Array.isArray(data?.detections) ? data.detections : [])
          .filter(item =>
            Number.isInteger(item.frameIndex) && item.frameIndex >= 0 && item.frameIndex < orderedFrames.length &&
            typeof item.trackId === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(item.trackId) &&
            Number.isFinite(item.centerX) && item.centerX >= 0 && item.centerX <= 1 &&
            Number.isFinite(item.centerY) && item.centerY >= 0 && item.centerY <= 1 &&
            Number.isFinite(item.x) && item.x >= 0 && item.x < 1 &&
            Number.isFinite(item.y) && item.y >= 0 && item.y < 1 &&
            Number.isFinite(item.width) && item.width > 0 && item.width <= 1 &&
            Number.isFinite(item.height) && item.height > 0 && item.height <= 1 &&
            item.x + item.width <= 1.001 && item.y + item.height <= 1.001 &&
            Number.isFinite(item.confidence) && item.confidence >= 0 && item.confidence <= 1
          )
          .map(item => ({
            frameIndex: item.frameIndex,
            trackId: item.trackId,
            subject: String(item.subject || 'Visible subject').trim().slice(0, 80),
            centerX: Number((item.x + item.width / 2).toFixed(4)),
            centerY: Number((item.y + item.height / 2).toFixed(4)),
            x: Number(item.x.toFixed(4)), y: Number(item.y.toFixed(4)),
            width: Number(item.width.toFixed(4)), height: Number(item.height.toFixed(4)),
            confidence: Number(item.confidence.toFixed(3)),
            timeSeconds: Number(orderedFrames[item.frameIndex].timeSeconds.toFixed(3)),
          }))
          .filter((item, index, all) => all.findIndex(other => other.frameIndex === item.frameIndex && other.trackId === item.trackId) === index);
        return json({ detections, basis: 'multi_frame_semantic_association', continuousTracking: false, frameCount: orderedFrames.length });
      } catch (err) {
        console.error('Smart framing analysis failed', err);
        return aiFailureResponse(err, 'Smart framing analysis');
      }
    },
  ],

  'POST /api/analyze': [
    requireAuth(),
    async ctx => {
      const body = (ctx.body || {}) as {
        duration?: number;
        frames?: FrameInput[];
        timelineMotion?: MotionSample[];
        transcript?: TranscriptInput[];
        editInstructions?: string;
        editScript?: string;
        editingMode?: 'manual' | 'automatic' | 'hybrid';
        scriptBeats?: string[];
        clipLengthMode?: 'ai' | 'fixed';
        customClipLength?: number;
      };
      const duration = Number(body.duration);
      const frames = body.frames;
      const timelineMotion = body.timelineMotion || [];
      const transcriptInput = body.transcript;
      const validMotion = Array.isArray(timelineMotion) && timelineMotion.length <= 480 && timelineMotion.every((sample, index) =>
        sample && Number.isFinite(sample.timeSeconds) && sample.timeSeconds >= 0 && sample.timeSeconds <= Number(body.duration) &&
        Number.isFinite(sample.magnitude) && sample.magnitude >= 0 && sample.magnitude <= 1 &&
        ['left', 'right', 'up', 'down', 'mixed', 'still'].includes(sample.direction) &&
        Number.isFinite(sample.changedRegionRatio) && sample.changedRegionRatio >= 0 && sample.changedRegionRatio <= 1 &&
        Number.isFinite(sample.trackX) && sample.trackX >= 0 && sample.trackX <= 1 &&
        Number.isFinite(sample.trackY) && sample.trackY >= 0 && sample.trackY <= 1 &&
        Number.isFinite(sample.confidence) && sample.confidence >= 0 && sample.confidence <= 1 &&
        (sample.cameraMotionX === undefined || (Number.isFinite(sample.cameraMotionX) && Math.abs(sample.cameraMotionX) <= 1)) &&
        (sample.cameraMotionY === undefined || (Number.isFinite(sample.cameraMotionY) && Math.abs(sample.cameraMotionY) <= 1)) &&
        (sample.subjectMotionX === undefined || (Number.isFinite(sample.subjectMotionX) && Math.abs(sample.subjectMotionX) <= 1)) &&
        (sample.subjectMotionY === undefined || (Number.isFinite(sample.subjectMotionY) && Math.abs(sample.subjectMotionY) <= 1)) &&
        (sample.subjectMotionRatio === undefined || (Number.isFinite(sample.subjectMotionRatio) && sample.subjectMotionRatio >= 0 && sample.subjectMotionRatio <= 1)) &&
        (sample.flowConfidence === undefined || (Number.isFinite(sample.flowConfidence) && sample.flowConfidence >= 0 && sample.flowConfidence <= 1)) &&
        (sample.sceneCut === undefined || typeof sample.sceneCut === 'boolean') &&
        (sample.trackingGap === undefined || typeof sample.trackingGap === 'boolean') &&
        (sample.trackId === undefined || sample.trackId === null || (Number.isInteger(sample.trackId) && sample.trackId >= 1)) &&
        (sample.trackAge === undefined || (Number.isInteger(sample.trackAge) && sample.trackAge >= 0 && sample.trackAge <= 480)) &&
        (sample.trackStability === undefined || (Number.isFinite(sample.trackStability) && sample.trackStability >= 0 && sample.trackStability <= 1)) &&
        (sample.trackWidth === undefined || (Number.isFinite(sample.trackWidth) && sample.trackWidth >= 0 && sample.trackWidth <= 1)) &&
        (sample.trackHeight === undefined || (Number.isFinite(sample.trackHeight) && sample.trackHeight >= 0 && sample.trackHeight <= 1)) &&
        (sample.occluded === undefined || typeof sample.occluded === 'boolean') &&
        (sample.predictionHorizonSeconds === undefined || (Number.isFinite(sample.predictionHorizonSeconds) && sample.predictionHorizonSeconds >= 0 && sample.predictionHorizonSeconds <= 2.5)) &&
        (sample.predictedTrackX === undefined || (Number.isFinite(sample.predictedTrackX) && sample.predictedTrackX >= 0 && sample.predictedTrackX <= 1)) &&
        (sample.predictedTrackY === undefined || (Number.isFinite(sample.predictedTrackY) && sample.predictedTrackY >= 0 && sample.predictedTrackY <= 1)) &&
        (sample.predictionConfidence === undefined || (Number.isFinite(sample.predictionConfidence) && sample.predictionConfidence >= 0 && sample.predictionConfidence <= 1)) &&
        (sample.trackUncertainty === undefined || (Number.isFinite(sample.trackUncertainty) && sample.trackUncertainty >= 0 && sample.trackUncertainty <= 1)) &&
        (index === 0 || sample.timeSeconds > timelineMotion[index - 1].timeSeconds)
      );
      if (!validMotion) return error('Motion tracking context is invalid.', 400);
      const editInstructions = typeof body.editInstructions === 'string' ? body.editInstructions.trim().slice(0, 1500) : '';
      const editScript = typeof body.editScript === 'string' ? body.editScript.trim().slice(0, 4000) : '';
      const editingMode = ['manual', 'automatic', 'hybrid'].includes(body.editingMode || '') ? body.editingMode! : 'hybrid';
      const scriptBeatInput = body.scriptBeats;
      if (scriptBeatInput !== undefined && (!Array.isArray(scriptBeatInput) || scriptBeatInput.length > 12 || !scriptBeatInput.every(beat => typeof beat === 'string' && beat.trim().length > 0 && beat.length <= 350))) {
        return error('Script context must contain no more than 12 short, non-empty beats.', 400);
      }
      const scriptBeats = (scriptBeatInput || []).map(beat => beat.trim());
      if (transcriptInput !== undefined && (!Array.isArray(transcriptInput) || transcriptInput.length > 200)) {
        return error('Transcript context must contain no more than 200 timed segments.', 400);
      }
      if (transcriptInput && !transcriptInput.every(segment =>
        segment &&
        Number.isFinite(segment.startSeconds) &&
        Number.isFinite(segment.endSeconds) &&
        segment.startSeconds >= 0 &&
        segment.endSeconds > segment.startSeconds &&
        segment.endSeconds <= duration &&
        typeof segment.text === 'string' &&
        segment.text.trim().length > 0 &&
        segment.text.length <= 220
      )) {
        return error('One or more transcript segments are invalid.', 400);
      }
      const transcript = (transcriptInput || []).slice(0, 200).map(segment => ({
        startSeconds: Number(segment.startSeconds.toFixed(2)),
        endSeconds: Number(segment.endSeconds.toFixed(2)),
        text: segment.text.trim(),
      }));
      if (!Number.isFinite(duration) || duration <= 0 || duration > 7200) {
        return error(
          'Video duration must be between 1 second and 2 hours.',
          400
        );
      }
      if (!Array.isArray(frames) || frames.length < 3 || frames.length > 5) {
        return error('Provide 3 to 5 sampled frames.', 400);
      }
      const clipLengthMode = body.clipLengthMode === 'fixed' ? 'fixed' : 'ai';
      const customClipLength = Number(body.customClipLength ?? 15);
      if (clipLengthMode === 'fixed' && (!Number.isFinite(customClipLength) || customClipLength < 5 || customClipLength > 60)) {
        return error('Preferred clip length must be between 5 and 60 seconds.', 400);
      }
      const validFrames = frames.every(
        frame =>
          frame &&
          Number.isFinite(frame.timeSeconds) &&
          frame.timeSeconds >= 0 &&
          frame.timeSeconds <= duration &&
          typeof frame.data === 'string' &&
          frame.data.length > 20 &&
          frame.data.length <= 1_500_000 &&
          /^[A-Za-z0-9+/]+={0,2}$/.test(frame.data) &&
          ['image/jpeg', 'image/webp', 'image/png'].includes(frame.mimeType)
      );
      if (!validFrames || frames.reduce((sum, frame) => sum + frame.data.length, 0) > 8_000_000)
        return error(
          'One or more sampled frames are invalid or the batch exceeds the image request size limit.',
          400
        );
      const frameTimes = frames.map(frame => frame.timeSeconds);
      if (new Set(frameTimes).size !== frameTimes.length || frameTimes.some((time, index) => index > 0 && time < frameTimes[index - 1])) {
        return error('Sampled frame timestamps must be unique and in chronological order.', 400);
      }

      // Give each sampled frame transcript context from its own time window.
      // If that window is empty, include the nearest one or two timed segments.
      const frameTranscriptContext = frames.map(frame => {
        const distance = (segment: TranscriptInput) =>
          Math.abs((segment.startSeconds + segment.endSeconds) / 2 - frame.timeSeconds);
        const nearby = transcript
          .filter(segment =>
            segment.endSeconds >= frame.timeSeconds - 12 &&
            segment.startSeconds <= frame.timeSeconds + 12
          )
          .sort((left, right) => distance(left) - distance(right))
          .slice(0, 3);
        const selected = (nearby.length
          ? nearby
          : [...transcript].sort((left, right) => distance(left) - distance(right)).slice(0, 2)
        ).sort((left, right) => left.startSeconds - right.startSeconds);
        return 'Frame at ' + frame.timeSeconds.toFixed(2) + 's: ' +
          (selected.length
            ? selected.map(segment =>
                '[' + segment.startSeconds.toFixed(2) + '-' + segment.endSeconds.toFixed(2) + 's] ' + segment.text.slice(0, 160)
              ).join(' | ')
            : 'No nearby transcript segment.');
      }).join('\\n');
      const motionContext = timelineMotion.length
        ? timelineMotion.filter((sample, index) => index === 0 || index === timelineMotion.length - 1 || sample.sceneCut || sample.trackingGap || index % Math.max(1, Math.ceil(timelineMotion.length / 90)) === 0)
          .map(sample => sample.timeSeconds.toFixed(2) + 's: ' + (sample.sceneCut ? 'LIKELY SCENE CUT; ' : '') +
            (sample.trackingGap ? 'SPARSE SAMPLE GAP; previous motion track was reset; ' : '') +
            'camera drift ' + (sample.cameraMotionX ?? 0).toFixed(2) + '/' + (sample.cameraMotionY ?? 0).toFixed(2) +
            ', independent region motion ' + (sample.subjectMotionX ?? 0).toFixed(2) + '/' + (sample.subjectMotionY ?? 0).toFixed(2) +
            ', moving-region share ' + Math.round((sample.subjectMotionRatio ?? 0) * 100) +
            '%, dominant region ' + Math.round(sample.trackX * 100) + '%/' + Math.round(sample.trackY * 100) +
            '%, flow confidence ' + Math.round((sample.flowConfidence ?? sample.confidence) * 100) +
            '%, track continuity ' + Math.round((sample.trackStability ?? 0) * 100) +
            '%, track age ' + (sample.trackAge ?? 0) +
            ', 0.75s predicted position ' + Math.round((sample.predictedTrackX ?? sample.trackX) * 100) + '%/' + Math.round((sample.predictedTrackY ?? sample.trackY) * 100) + '% at ' + Math.round((sample.predictionConfidence ?? 0) * 100) + '% confidence' +
            (sample.occluded ? ', predicted through brief occlusion' : ''))
          .join('\\n').slice(0, 14000)
        : 'No motion telemetry supplied.';

      try {
        const result = await ai.extract({
          prompt:
            'Act as a senior short-form video editor and story producer. Review up to 5 sampled still frames from one user-owned video. They are supplied in strict chronological order, with timestamps; treat them as a small temporal sequence, not five unrelated pictures. First map what is visibly changing from frame to frame, note the time gaps, and use the supplied dense block-flow motion telemetry as supporting evidence. The local estimator uses coarse-to-fine block flow, robust camera translation/zoom/rotation compensation, coherent residual-region clustering, temporal association, track continuity, brief occlusion prediction, scene-cut resets, explicit resets after sampling gaps over 2.5 seconds and confidence estimates. It can still be confused by parallax, blur, low texture, repeated patterns, fast motion, cuts and occlusion. Track continuity describes an image region, not a guaranteed person or object identity. A sparse-sample-gap marker means continuity was deliberately reset; never bridge it by inference. Never infer a specific action from motion telemetry alone; require visible frame evidence. Identify visible subjects descriptively and keep a consistent subjectTrack label only when the same subject is clearly recognisable across supplied images. Then reason conservatively about a possible event arc: setup, action, outcome, reaction. Identify which phase each candidate actually supports. A phase may be absent from the samples; never fill gaps by imagination. Temporal order alone does not prove causation, and widely separated frames do not prove continuity. Distinguish the event from its consequence: only claim a result or reaction when a later supplied frame visibly supports it. A single frame may show a key instant, but never infer the unseen motion that led to it. Find up to 5 distinct, genuinely useful edit moments, not merely attractive frames. Actively look for decisive action or skill execution, a visible outcome, immediate reaction or celebration, a mistake or reversal, a reveal or surprising change, a turning point, a strong before/after contrast, a clear demonstration, and setup/payoff context. Think about each shot\'s job in the finished edit: hook, context, explanation, action, reaction, transition, escalation, payoff, or ending. Prefer moments that add new information or story value; avoid near-duplicates, repeated angles, and shots that do the same job. Crucially, timestamp proximity alone never makes two moments duplicates: preserve distinct setup, action, outcome and reaction phases even when they occur within a few seconds. Treat two candidates as duplicates only when their phase, subject and visual action are compatible and their time windows substantially overlap; preserve different script beats and clearly different subjects. For each candidate return a timestamp anchor and a safe clip range containing it. Recognise only observable action categories supported by the frames (examples: running, jumping, kicking, throwing, catching, dribbling, passing, shooting, celebrating, speaking, demonstrating, entering, leaving, or changing scene); return actionLabel only when specific enough to be useful. Return motionSummary as a short plain-language interpretation of the nearby telemetry, explicitly calling it approximate when uncertain. For event reconstruction, return eventGroupLabel for the broader event or sequence when supported, plus eventStartSeconds and eventEndSeconds estimating the visible event window; keep these within the video and do not stretch across unsupported gaps. ' +
            (editingMode === 'manual' ? 'MANUAL AI MODE: Treat the creator instructions as binding editorial constraints. Follow explicit priorities and exclusions; do not replace them with generic highlight preferences. If instructions conflict, preserve the most specific direction and explain uncertainty in the reason. ' : editingMode === 'automatic' ? 'AUTOMATIC AI MODE: Use sound editorial judgement to create a coherent first draft. Apply creator instructions and script as guidance, while selecting the strongest defensible footage. ' : 'HYBRID AI MODE: Find and rank useful moments, but these are proposals for the creator to review. Do not assume any suggestion has been approved or added to the final edit. ') +
            (editInstructions ? 'CREATOR BRIEF (high priority): ' + editInstructions + '. Parse this into objective, platform/format, tone, pacing, must-include priorities, and exclusions. Apply explicit exclusions first, then must-include priorities, then style preferences, then general editorial quality. Treat explicit must-include and must-avoid directions as hard constraints wherever sampled evidence permits. If the footage cannot satisfy a request, say so plainly rather than pretending it can. Every reason must name the visible evidence and connect it to a specific brief requirement; distinguish direct visual evidence from inference. ' : '') +
            (editScript ? 'SCRIPT-LED EDIT: The creator supplied this intended video or voiceover script: ' + editScript + '. Treat it as the intended narrative, not proof that the footage contains the described events. For each beat, identify its core visual subject/action and narrative function. Match only when a sampled frame visibly supports that idea. Preserve the script order in beat assignment even if source footage timestamps differ. Do not force a match to fill coverage. If no frame supports a beat, leave it unmatched; never substitute a generic clip and call it a match. ' : '') +
            (scriptBeats.length ? 'ORDERED SCRIPT BEATS (zero-based): ' + scriptBeats.map((beat, index) => index + ': ' + beat).join(' | ') + '. Match a frame to a beat only if the image itself provides a defensible visual relationship. A transcript can clarify context but cannot prove an unseen visual. Return scriptBeatIndex and matchConfidence only for a genuine match. Confidence rubric: 90-100 direct, specific visual support; 75-89 strong visual relationship; 60-74 partial but plausible; below 60 means omit the assignment. Do not map one shot to unrelated beats. The client merges results from separate frame batches, so prefer precise, conservative assignments over broad guesses. ' : '') +
            (clipLengthMode === 'fixed'
              ? 'Use a target duration of about ' + customClipLength + ' seconds for every clip, shortening only when necessary near the video boundaries.'
              : 'Choose a natural, varied duration independently for each moment, generally between 4 and 45 seconds depending on how much context the moment seems to need. Do not force every clip to have the same duration.') +
            ' When timed transcript segments are supplied, use only passages near each frame timestamp. Dialogue may clarify a punchline, explanation, speaker intent or topic shift, but speech alone never proves a visual event. Keep each candidate grounded in at least one sampled frame. Select boundaries that preserve setup, decisive moment and visible payoff when supported; avoid cutting mid-action or mid-sentence when transcript timing makes that apparent. Still frames cannot prove motion, continuity or events between samples, so label clip boundaries as estimates and never claim full-motion analysis. Return momentLabel as a short specific label when supported (examples: Skill move, Goal/score, Celebration, Key reaction, Mistake, Reveal, Turning point, Demonstration, Visual change, or Story setup); do not force a label if evidence is ambiguous. Return storyPurpose as a concise editorial role (for example Hook, Context, Build, Action, Reaction, Payoff, or Transition). For each candidate also return eventPhase as setup, action, outcome, reaction, or standalone. Use setup/action/outcome/reaction only when the ordered frames provide direct support for that phase; otherwise use standalone. Return sequenceEvidence as one short sentence naming the specific earlier/later frame evidence and its timestamps; if there is no useful sequence evidence, say that it is a single-frame observation. Return eventConfidence from 0 to 100 for confidence in the phase interpretation, not the highlight score; lower it when frames are sparse or separated by large gaps. Return reason as one concise evidence-based explanation: what is visibly present, what changed or why this instant matters, how it fits the surrounding story, and any uncertainty. Scores measure editorial usefulness supported by the supplied evidence, not certainty about unseen events. Also return visualEvidenceConfidence from 0 to 100 as a separate visual-only calibration: 90-100 means the visible pixels directly and clearly support the described subject/action; 75-89 means strong visible support; 55-74 means partial or ambiguous support; below 55 means the visual claim is too weak and the candidate must be omitted. Never raise visualEvidenceConfidence using transcript, creator script, motion telemetry or assumptions about events between stills. A transcript may clarify dialogue but cannot prove a visual event. Score each candidate using this evidence rubric: 90-100 = unmistakable standout moment with strong visual evidence; 75-89 = clearly interesting moment with specific visual evidence; 60-74 = moderately compelling moment supported by a frame and, when available, relevant transcript context; 40-59 = weak or ambiguous moment; 1-39 = ordinary footage with no clear highlight. Return only candidates scoring 60 or higher. Do not inflate scores because a frame is colourful, busy, or merely contains a person or object. Do not infer excitement, humour, skill, or an outcome from transcript alone. If evidence is weak or no moment meets the threshold, return an empty highlights array.',
          content:
            'Full video duration: ' +
            duration.toFixed(2) +
            ' seconds. Creator instructions: ' + (editInstructions || 'None supplied') + '. Intended script: ' + (editScript || 'None supplied') + '. Frame timestamps in order: ' +
            frames.map(frame => frame.timeSeconds.toFixed(2) + 's').join(', ') +
            (scriptBeats.length ? '\\nOrdered script beats: ' + scriptBeats.map((beat, index) => index + ': ' + beat).join(' | ') : '') +
            '\\nFull-timeline motion trace (camera-compensated visual-region tracking; continuity is not identity recognition):\\n' + motionContext +
            (transcript.length
              ? '\\nTimestamp-local transcript context for each sampled frame:\\n' + frameTranscriptContext.slice(0, 12000)
              : '\\nNo transcript was supplied; use visual evidence only.'),
          images: frames.map(frame => ({
            data: frame.data,
            mimeType: frame.mimeType,
          })),
          schema: {
            type: 'object',
            properties: {
              highlights: {
                type: 'array',
                maxItems: 5,
                items: {
                  type: 'object',
                  properties: {
                    timestampSeconds: { type: 'number', minimum: 0 },
                    momentType: {
                      type: 'string',
                      enum: ['action', 'reaction', 'visual', 'other'],
                    },
                    momentLabel: { type: 'string' },
                    startSeconds: { type: 'number', minimum: 0 },
                    endSeconds: { type: 'number', minimum: 0 },
                    score: { type: 'integer', minimum: 1, maximum: 100 },
                    reason: { type: 'string' },
                    storyPurpose: { type: 'string' },
                    eventPhase: { type: 'string', enum: ['setup', 'action', 'outcome', 'reaction', 'standalone'] },
                    sequenceEvidence: { type: 'string' },
                    eventConfidence: { type: 'number', minimum: 0, maximum: 100 },
                    actionLabel: { type: 'string' },
                    subjectTrack: { type: 'string' },
                    visualEvidenceConfidence: { type: 'number', minimum: 0, maximum: 100 },
                    motionSummary: { type: 'string' },
                    eventGroupLabel: { type: 'string' },
                    eventStartSeconds: { type: 'number', minimum: 0 },
                    eventEndSeconds: { type: 'number', minimum: 0 },
                    scriptBeatIndex: { type: 'integer', minimum: 0, maximum: 11 },
                    matchConfidence: { type: 'number', minimum: 0, maximum: 100 },
                    scriptBeat: { type: 'string' },
                  },
                  required: ['timestampSeconds', 'momentType', 'startSeconds', 'endSeconds', 'score', 'reason', 'visualEvidenceConfidence'],
                },
              },
            },
            required: ['highlights'],
          },
          maxRetries: 1,
          maxTokens: 1200,
          thinkingMode: 'FAST',
        });
        const data = result.data as {
          highlights?: Array<{
            timestampSeconds: number;
            momentType: 'action' | 'reaction' | 'visual' | 'other';
            momentLabel?: string;
            startSeconds: number;
            endSeconds: number;
            score: number;
            reason: string;
            storyPurpose?: string;
            eventPhase?: EventPhase;
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
            matchConfidence?: number;
            scriptBeat?: string;
          }>;
        };
        const highlights = (
          Array.isArray(data.highlights) ? data.highlights : []
        )
          .filter(
            item =>
              Number.isFinite(item.timestampSeconds) &&
              item.timestampSeconds >= 0 &&
              item.timestampSeconds <= duration
          )
          .map(item => {
            let startSeconds: number;
            let endSeconds: number;
            if (clipLengthMode === 'fixed') {
              const length = Math.min(customClipLength, duration);
              startSeconds = Math.max(0, Math.min(duration - length, item.timestampSeconds - length / 2));
              endSeconds = startSeconds + length;
            } else {
              const maxLength = Math.min(45, duration);
              const minLength = Math.min(4, maxLength);
              const anchor = Math.max(0, Math.min(duration, item.timestampSeconds));
              const proposedStart = Number(item.startSeconds);
              const proposedEnd = Number(item.endSeconds);
              startSeconds = Number.isFinite(proposedStart)
                ? Math.max(0, Math.min(duration, proposedStart))
                : anchor - 5;
              endSeconds = Number.isFinite(proposedEnd)
                ? Math.max(0, Math.min(duration, proposedEnd))
                : anchor + 5;

              // The identified moment must always remain inside its suggested clip.
              startSeconds = Math.min(startSeconds, anchor);
              endSeconds = Math.max(endSeconds, anchor);

              const proposedLength = endSeconds - startSeconds;
              if (!Number.isFinite(proposedLength) || proposedLength < minLength) {
                startSeconds = anchor - minLength / 2;
                startSeconds = Math.max(0, Math.min(duration - minLength, startSeconds));
                endSeconds = startSeconds + minLength;
              } else if (proposedLength > maxLength) {
                startSeconds = anchor - maxLength / 2;
                startSeconds = Math.max(0, Math.min(duration - maxLength, startSeconds));
                endSeconds = startSeconds + maxLength;
              }
            }
            return {
              startSeconds: Number(startSeconds.toFixed(2)),
              endSeconds: Number(endSeconds.toFixed(2)),
              score: Math.max(1, Math.min(100, Math.round(item.score || 1))),
              timestampSeconds: Number(item.timestampSeconds.toFixed(2)),
              momentType: ['action', 'reaction', 'visual', 'other'].includes(item.momentType)
                ? item.momentType
                : 'visual',
              ...(item.momentLabel ? { momentLabel: String(item.momentLabel).trim().slice(0, 36) } : {}),
              reason: String(item.reason || 'Potential visual highlight').slice(
                0,
                220
              ),
              ...(item.storyPurpose ? { storyPurpose: String(item.storyPurpose).slice(0, 40) } : {}),
              ...(item.eventPhase && ['setup', 'action', 'outcome', 'reaction', 'standalone'].includes(item.eventPhase)
                ? { eventPhase: item.eventPhase }
                : { eventPhase: 'standalone' as EventPhase }),
              ...(item.sequenceEvidence ? { sequenceEvidence: String(item.sequenceEvidence).trim().slice(0, 180) } : {}),
              ...(Number.isFinite(item.eventConfidence)
                ? { eventConfidence: Math.max(0, Math.min(100, Math.round(item.eventConfidence!))) }
                : {}),
              ...(item.actionLabel ? { actionLabel: String(item.actionLabel).trim().slice(0, 48) } : {}),
              ...(item.subjectTrack ? { subjectTrack: String(item.subjectTrack).trim().slice(0, 48) } : {}),
              ...(Number.isFinite(item.visualEvidenceConfidence) ? { visualEvidenceConfidence: Math.max(0, Math.min(100, Math.round(item.visualEvidenceConfidence!))) } : {}),
              ...(item.motionSummary ? { motionSummary: String(item.motionSummary).trim().slice(0, 140) } : {}),
              ...(item.eventGroupLabel ? { eventGroupLabel: String(item.eventGroupLabel).trim().slice(0, 48) } : {}),
              ...(Number.isFinite(item.eventStartSeconds) && Number.isFinite(item.eventEndSeconds) && item.eventEndSeconds! > item.eventStartSeconds!
                ? { eventStartSeconds: Math.max(0, Math.min(duration, item.eventStartSeconds!)), eventEndSeconds: Math.max(0, Math.min(duration, item.eventEndSeconds!)) }
                : {}),
              ...(Number.isInteger(item.scriptBeatIndex) && item.scriptBeatIndex >= 0 && item.scriptBeatIndex < scriptBeats.length
                ? {
                    scriptBeatIndex: item.scriptBeatIndex,
                    scriptBeat: String(item.scriptBeat || scriptBeats[item.scriptBeatIndex]).slice(0, 180),
                    matchConfidence: Math.max(0, Math.min(100, Math.round(Number(item.matchConfidence) || 0))),
                  }
                : {}),
            };
          })
          .filter(item => item.endSeconds > item.startSeconds && item.score >= 60 && (item.visualEvidenceConfidence ?? 0) >= 55)
          .sort((a, b) => {
            const rank = (item: typeof a) =>
              item.score * 0.72 +
              (item.visualEvidenceConfidence ?? 0) * 0.18 +
              (item.eventConfidence ?? 50) * 0.10;
            return rank(b) - rank(a);
          })
          .filter((item, index, items) => {
            const phase = item.eventPhase || 'standalone';
            const subject = item.subjectTrack?.trim().toLowerCase();
            const action = item.actionLabel?.trim().toLowerCase();
            return !items.slice(0, index).some(candidate => {
              const candidatePhase = candidate.eventPhase || 'standalone';
              if (candidatePhase !== phase) return false;

              const candidateSubject = candidate.subjectTrack?.trim().toLowerCase();
              if (subject && candidateSubject && subject !== candidateSubject) return false;

              const candidateAction = candidate.actionLabel?.trim().toLowerCase();
              if (action && candidateAction && action !== candidateAction) return false;

              if (item.scriptBeatIndex !== undefined && candidate.scriptBeatIndex !== undefined &&
                  item.scriptBeatIndex !== candidate.scriptBeatIndex) return false;

              const overlap = Math.max(0,
                Math.min(candidate.endSeconds, item.endSeconds) -
                Math.max(candidate.startSeconds, item.startSeconds)
              );
              const shorterDuration = Math.max(0.25, Math.min(
                candidate.endSeconds - candidate.startSeconds,
                item.endSeconds - item.startSeconds
              ));
              const overlapRatio = overlap / shorterDuration;
              const nearbyAnchor = Math.abs(candidate.timestampSeconds - item.timestampSeconds) < 3.5;
              const sameEvent = !!candidate.eventGroupLabel && !!item.eventGroupLabel &&
                candidate.eventGroupLabel.trim().toLowerCase() === item.eventGroupLabel.trim().toLowerCase();

              return overlapRatio > 0.5 || (nearbyAnchor && overlapRatio > 0.15) ||
                (sameEvent && overlapRatio > 0.78);
            });
          })
          .slice(0, 5);
        return json({ highlights, basis: transcript.length ? 'ordered_sampled_still_sequences_and_transcript' : 'ordered_sampled_still_sequences', sequenceFramesPerBatch: frames.length, continuousMotionVerified: false, transcriptSegmentsUsed: transcript.length, precisionPolicy: 'separate editorial value from visual evidence confidence; weakly supported candidates are excluded' });
      } catch (err: unknown) {
        console.error('AI moment analysis failed', err);
        return aiFailureResponse(err, 'AI moment analysis');
      }
    },
  ],
});
