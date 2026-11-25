import { getStore } from "@netlify/blobs";
import { getUser } from "@netlify/identity";
import type { Config, Context } from "@netlify/functions";

type Project = {
  id: string;
  ownerId: string;
  title: string;
  clips: unknown[];
  captions: unknown[];
  captionStyle: unknown;
  settings?: unknown;
  createdAt: string;
  updatedAt: string;
};

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });

const error = (message: string, status: number) => json({ error: message }, status);

const MAX_PROJECT_BODY_BYTES = 512 * 1024;

async function readJsonBody(request: Request): Promise<
  | { ok: true; value: unknown }
  | { ok: false; status: 400 | 413 }
> {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_PROJECT_BODY_BYTES) {
    return { ok: false, status: 413 };
  }
  if (!request.body) return { ok: false, status: 400 };

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_PROJECT_BODY_BYTES) {
        await reader.cancel();
        return { ok: false, status: 413 };
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, status: 400 };
  } finally {
    reader.releaseLock();
  }
}

function validProjectSettings(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const s = value as Record<string, unknown>;
  return typeof s.editInstructions === "string" && s.editInstructions.length <= 1500 &&
    typeof s.editScript === "string" && s.editScript.length <= 4000 &&
    ["manual", "automatic", "hybrid"].includes(String(s.editingMode)) &&
    ["none", "fade", "pop"].includes(String(s.captionAnimation)) &&
    ["compact", "standard", "high"].includes(String(s.exportQuality)) &&
    ["original", "9:16", "1:1", "16:9"].includes(String(s.exportAspect)) &&
    ["720", "1080"].includes(String(s.exportResolution)) &&
    ["0.5", "0.8", "1.2", "1.5", "2"].includes(String(s.crossfadeDuration)) &&
    typeof s.exportVolume === "number" && Number.isFinite(s.exportVolume) && s.exportVolume >= 0 && s.exportVolume <= 150 &&
    typeof s.audioCleanup === "number" && Number.isFinite(s.audioCleanup) && s.audioCleanup >= 0 && s.audioCleanup <= 100 &&
    ["ai", "fixed"].includes(String(s.clipLengthMode)) &&
    typeof s.customClipLength === "string" && /^\d{1,2}$/.test(s.customClipLength) &&
    Number(s.customClipLength) >= 1 && Number(s.customClipLength) <= 45 &&
    typeof s.reframeEnabled === "boolean" &&
    typeof s.reframeX === "number" && Number.isFinite(s.reframeX) && s.reframeX >= 0 && s.reframeX <= 1 &&
    typeof s.reframeY === "number" && Number.isFinite(s.reframeY) && s.reframeY >= 0 && s.reframeY <= 1 &&
    (s.exportFormat === undefined || ["auto", "mp4", "webm"].includes(String(s.exportFormat))) &&
    (s.sourceAudioEnabled === undefined || typeof s.sourceAudioEnabled === "boolean");
}

function isProjectBody(value: unknown): value is {
  title: string; clips: Array<{ startSeconds: number; endSeconds: number }>;
  captions?: Array<{ id: string; startSeconds: number; endSeconds: number; text: string }>;
  captionStyle?: { fontSize: string; color: string; background: "dark" | "none" };
  settings?: unknown;
} {
  if (!value || typeof value !== "object") return false;
  const body = value as Record<string, unknown>;
  if (typeof body.title !== "string" || !body.title.trim() || body.title.length > 180) return false;
  if (!Array.isArray(body.clips) || body.clips.length < 1 || body.clips.length > 20) return false;
  if (!body.clips.every((clip) => {
    if (!clip || typeof clip !== "object") return false;
    const item = clip as Record<string, unknown>;
    return typeof item.startSeconds === "number" && Number.isFinite(item.startSeconds) &&
      typeof item.endSeconds === "number" && Number.isFinite(item.endSeconds) &&
      item.startSeconds >= 0 && item.endSeconds > item.startSeconds;
  })) return false;
  if (body.captions !== undefined) {
    if (!Array.isArray(body.captions) || body.captions.length > 1000) return false;
    if (!body.captions.every((caption) => {
      if (!caption || typeof caption !== "object") return false;
      const item = caption as Record<string, unknown>;
      return typeof item.id === "string" && item.id.length > 0 && item.id.length <= 120 &&
        typeof item.startSeconds === "number" && Number.isFinite(item.startSeconds) && item.startSeconds >= 0 &&
        typeof item.endSeconds === "number" && Number.isFinite(item.endSeconds) &&
        item.endSeconds > item.startSeconds && item.endSeconds <= 7200 &&
        typeof item.text === "string" && item.text.trim().length > 0 && item.text.length <= 220;
    })) return false;
  }
  if (body.captionStyle !== undefined) {
    if (!body.captionStyle || typeof body.captionStyle !== "object" || Array.isArray(body.captionStyle)) return false;
    const style = body.captionStyle as Record<string, unknown>;
    if (!["26", "34", "42"].includes(String(style.fontSize)) ||
      typeof style.color !== "string" || !/^#[0-9a-fA-F]{6}$/.test(style.color) ||
      !["dark", "none"].includes(String(style.background))) return false;
  }
  if (body.settings !== undefined && !validProjectSettings(body.settings)) return false;
  return true;
}

type IdentityUser = {
  id: string;
  email?: string;
  name?: string;
  userMetadata?: { full_name?: string };
};

type UserResolver = (
  request: Request,
  context: Context
) => Promise<IdentityUser | null>;

const resolveIdentityUser: UserResolver = async () => await getUser();

type ProjectStore = {
  list(options: { prefix: string }): Promise<{ blobs: Array<{ key: string }> }>;
  get(key: string, options: { type: "json" }): Promise<unknown>;
  setJSON(key: string, value: unknown): Promise<unknown>;
  delete(key: string): Promise<unknown>;
};

type StoreFactory = (options: {
  name: string;
  consistency: "strong";
}) => ProjectStore;

const defaultStoreFactory = getStore as unknown as StoreFactory;

export function createHandler(
  storeFactory: StoreFactory = defaultStoreFactory,
  userResolver: UserResolver = resolveIdentityUser
) {
  return async (request: Request, context: Context): Promise<Response> => {
    const url = new URL(request.url);
    const path = url.pathname.replace(new RegExp("/+$"), "") || "/";

    // Match the original public health endpoint; user data routes remain protected.
    if (path === "/api/health" && request.method === "GET") {
      return json({ ok: true, service: "clipforge-api", version: "migration-preview" });
    }

    const user = await userResolver(request, context);
    if (!user?.id) return error("Please sign in to continue.", 401);

    try {
      const store = storeFactory({ name: "clipforge-projects", consistency: "strong" });
      const prefix = `users/${encodeURIComponent(user.id)}/projects/`;

      if (path === "/api/me" && request.method === "GET") {
        return json({ user: {
          userId: user.id,
          email: user.email ?? undefined,
          name: user.name ?? user.userMetadata?.full_name ?? undefined,
        } });
      }

      if (path === "/api/projects" && request.method === "GET") {
        // Netlify Blobs automatically retrieves all pages unless paginate:true.
        // Sort before applying the original API's 50-project limit; blob keys are
        // random IDs and therefore do not represent project recency.
        const { blobs } = await store.list({ prefix });
        const records = await Promise.all(
          blobs.map(async (blob) =>
            await store.get(blob.key, { type: "json" }) as Project | null
          )
        );
        const projects = records
          .filter((item): item is Project => !!item && item.ownerId === user.id)
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
          .slice(0, 50);
        return json({ projects });
      }

      if (path === "/api/projects" && request.method === "POST") {
        const parsed = await readJsonBody(request);
        if (!parsed.ok) {
          return error(
            parsed.status === 413 ? "Project data is too large." : "Invalid JSON request.",
            parsed.status
          );
        }
        const body: unknown = parsed.value;
        if (!isProjectBody(body)) {
          return error("Project title and valid clip data are required.", 400);
        }
        const now = new Date().toISOString();
        const id = crypto.randomUUID();
        const project: Project = {
          id,
          ownerId: user.id,
          title: body.title.trim().slice(0, 180),
          clips: body.clips,
          captions: body.captions ?? [],
          captionStyle: body.captionStyle ?? { fontSize: "34", color: "#ffffff", background: "dark" },
          settings: body.settings,
          createdAt: now,
          updatedAt: now,
        };
        await store.setJSON(prefix + id, project);
        return json({ project }, 201);
      }

      const match = path.match(new RegExp("^/api/projects/([A-Za-z0-9-]+)$"));
      if (match) {
        const id = match[1];
        const key = prefix + id;

        if (request.method === "PUT" || request.method === "DELETE") {
          const current = await store.get(key, { type: "json" }) as Project | null;
          if (!current || current.ownerId !== user.id) {
            return error("Project not found.", 404);
          }

          if (request.method === "PUT") {
            const parsed = await readJsonBody(request);
            if (!parsed.ok) {
              return error(
                parsed.status === 413 ? "Project data is too large." : "Invalid JSON request.",
                parsed.status
              );
            }
            const body: unknown = parsed.value;
            if (!body || typeof body !== "object" || Array.isArray(body)) {
              return error("A valid project object is required.", 400);
            }
            const patch = body as Partial<Project>;
            if (!isProjectBody({ ...current, ...patch })) {
              return error("Project title and valid clip data are required.", 400);
            }
            const updated: Project = {
              ...current,
              title: typeof patch.title === "string" ? patch.title.trim().slice(0, 180) : current.title,
              clips: Array.isArray(patch.clips) ? patch.clips : current.clips,
              captions: Array.isArray(patch.captions) ? patch.captions : current.captions,
              captionStyle: patch.captionStyle ?? current.captionStyle,
              settings: patch.settings ?? current.settings,
              updatedAt: new Date().toISOString(),
            };
            await store.setJSON(key, updated);
            return json({ project: updated });
          }

          await store.delete(key);
          return json({ deleted: true });
        }
      }

      if (["/api/analyze", "/api/reframe", "/api/transcribe"].includes(path) && request.method === "POST") {
        return error("AI processing is not enabled on this migration yet. No paid AI provider has been connected.", 503);
      }

      return error("Not found.", 404);
    } catch (err) {
      console.error("Clipforge API request failed", err);
      return error("The service is temporarily unavailable. Please try again.", 503);
    }
  };
}

export const config: Config = { path: "/api/*" };

export default createHandler();

