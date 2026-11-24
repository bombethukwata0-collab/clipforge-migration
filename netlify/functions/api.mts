import { getStore } from "@netlify/blobs";
import type { Context } from "@netlify/functions";

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
    headers: { "content-type": "application/json; charset=utf-8" },
  });

const error = (message: string, status: number) => json({ error: message }, status);

function isProjectBody(value: unknown): value is {
  title: string; clips: unknown[]; captions?: unknown[];
  captionStyle?: unknown; settings?: unknown;
} {
  if (!value || typeof value !== "object") return false;
  const body = value as Record<string, unknown>;
  return typeof body.title === "string" && body.title.trim().length > 0 &&
    Array.isArray(body.clips) && body.clips.length >= 1 && body.clips.length <= 20 &&
    (body.captions === undefined || (Array.isArray(body.captions) && body.captions.length <= 1000));
}

export default async (request: Request, context: Context) => {
  const user = context.user;
  if (!user?.id) return error("Sign in through the protected Netlify site to continue.", 401);

  const url = new URL(request.url);
  const path = url.pathname.replace(/\\/+$/, "") || "/";
  const store = getStore({ name: "clipforge-projects", consistency: "strong" });
  const prefix = `users/${encodeURIComponent(user.id)}/projects/`;

  if (path === "/api/health" && request.method === "GET") {
    return json({ ok: true, service: "clipforge-api", version: "migration-preview" });
  }

  if (path === "/api/me" && request.method === "GET") {
    return json({ user: { userId: user.id, email: user.email ?? undefined } });
  }

  if (path === "/api/projects" && request.method === "GET") {
    const { blobs } = await store.list({ prefix });
    const projects: Project[] = [];
    for (const blob of blobs.slice(0, 50)) {
      const item = await store.get(blob.key, { type: "json" }) as Project | null;
      if (item && item.ownerId === user.id) projects.push(item);
    }
    projects.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return json({ projects });
  }

  if (path === "/api/projects" && request.method === "POST") {
    let body: unknown;
    try { body = await request.json(); } catch { return error("Invalid JSON request.", 400); }
    if (!isProjectBody(body)) return error("Project title and valid clip data are required.", 400);
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    const project: Project = {
      id, ownerId: user.id, title: body.title.trim().slice(0, 180),
      clips: body.clips, captions: body.captions ?? [],
      captionStyle: body.captionStyle ?? { fontSize: "34", color: "#ffffff", background: "dark" },
      settings: body.settings, createdAt: now, updatedAt: now,
    };
    await store.setJSON(prefix + id, project);
    return json({ project }, 201);
  }

  const match = path.match(/^\\/api\\/projects\\/([A-Za-z0-9-]+)$/);
  if (match) {
    const id = match[1];
    const key = prefix + id;
    const current = await store.get(key, { type: "json" }) as Project | null;
    if (!current || current.ownerId !== user.id) return error("Project not found.", 404);

    if (request.method === "PUT") {
      let body: unknown;
      try { body = await request.json(); } catch { return error("Invalid JSON request.", 400); }
      if (!isProjectBody({ ...current, ...(body as object) })) {
        return error("Project title and valid clip data are required.", 400);
      }
      const patch = body as Partial<Project>;
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

    if (request.method === "DELETE") {
      await store.delete(key);
      return json({ deleted: true });
    }
  }

  if (["/api/analyze", "/api/reframe", "/api/transcribe"].includes(path) && request.method === "POST") {
    return error("AI processing is not enabled on this migration yet. No paid AI provider has been connected.", 503);
  }

  return error("Not found.", 404);
};

export const config = { path: "/api/*" };
