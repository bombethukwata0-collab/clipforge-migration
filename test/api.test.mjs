import test from "node:test";
import assert from "node:assert/strict";
import { createHandler } from "../netlify/functions/api.mts";

function createMemoryStore() {
  const records = new Map();
  return {
    records,
    async list({ prefix }) {
      return { blobs: [...records.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key })) };
    },
    async get(key) {
      return records.has(key) ? structuredClone(records.get(key)) : null;
    },
    async setJSON(key, value) {
      records.set(key, structuredClone(value));
      return { modified: true };
    },
    async delete(key) {
      records.delete(key);
    },
  };
}

function makeRequest(path, method = "GET", body) {
  return new Request("https://clipforge.test" + path, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const validProject = {
  title: "Match highlights",
  clips: [{ startSeconds: 2, endSeconds: 7, reason: "Strong attacking sequence", score: 0.92 }],
  captions: [{ id: "caption-1", startSeconds: 2.2, endSeconds: 3.8, text: "What a pass!" }],
  captionStyle: { fontSize: "34", color: "#ffffff", background: "dark" },
  settings: {
    editInstructions: "Keep the strongest moments",
    editScript: "Opening, action, reaction",
    editingMode: "hybrid",
    captionAnimation: "pop",
    exportQuality: "high",
    exportAspect: "9:16",
    exportResolution: "1080",
    crossfadeDuration: "0.8",
    exportVolume: 110,
    audioCleanup: 25,
    clipLengthMode: "fixed",
    customClipLength: "15",
    reframeEnabled: true,
    reframeX: 0.55,
    reframeY: 0.45,
    exportFormat: "mp4",
    sourceAudioEnabled: true,
  },
};

test("health endpoint remains public", async () => {
  const handler = createHandler(() => createMemoryStore());
  const response = await handler(makeRequest("/api/health"), {});
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ok, true);
});

test("project CRUD persists and retrieves records for the signed-in user", async () => {
  const store = createMemoryStore();
  const handler = createHandler(() => store);
  const context = { user: { id: "user-a", email: "a@example.test" } };

  const createdResponse = await handler(makeRequest("/api/projects", "POST", validProject), context);
  assert.equal(createdResponse.status, 201);
  const created = (await createdResponse.json()).project;
  assert.ok(created.id);
  assert.equal(created.ownerId, "user-a");

  const listResponse = await handler(makeRequest("/api/projects"), context);
  assert.equal(listResponse.status, 200);
  assert.equal((await listResponse.json()).projects.length, 1);

  const updateResponse = await handler(makeRequest("/api/projects/" + created.id, "PUT", { title: "Final highlights" }), context);
  assert.equal(updateResponse.status, 200);
  const updated = (await updateResponse.json()).project;
  assert.equal(updated.title, "Final highlights");
  assert.equal(updated.clips[0].startSeconds, 2);\n  assert.equal(updated.captions[0].text, "What a pass!");\n  assert.deepEqual(updated.settings, validProject.settings);\n  assert.deepEqual(updated.captionStyle, validProject.captionStyle);

  const deleteResponse = await handler(makeRequest("/api/projects/" + created.id, "DELETE"), context);
  assert.equal(deleteResponse.status, 200);
  assert.deepEqual(await deleteResponse.json(), { deleted: true });

  const afterDelete = await handler(makeRequest("/api/projects"), context);
  assert.deepEqual((await afterDelete.json()).projects, []);
});

test("a different user cannot list, update, or delete another user's project", async () => {
  const store = createMemoryStore();
  const handler = createHandler(() => store);
  const owner = { user: { id: "owner" } };
  const other = { user: { id: "other" } };

  const createdResponse = await handler(makeRequest("/api/projects", "POST", validProject), owner);
  const created = (await createdResponse.json()).project;

  const otherList = await handler(makeRequest("/api/projects"), other);
  assert.deepEqual((await otherList.json()).projects, []);

  const update = await handler(makeRequest("/api/projects/" + created.id, "PUT", { title: "Hijack" }), other);
  assert.equal(update.status, 404);

  const remove = await handler(makeRequest("/api/projects/" + created.id, "DELETE"), other);
  assert.equal(remove.status, 404);

  const ownerList = await handler(makeRequest("/api/projects"), owner);
  assert.equal((await ownerList.json()).projects[0].title, validProject.title);
});

test("invalid update bodies are rejected without changing the saved project", async () => {
  const store = createMemoryStore();
  const handler = createHandler(() => store);
  const context = { user: { id: "user-a" } };
  const createdResponse = await handler(makeRequest("/api/projects", "POST", validProject), context);
  const created = (await createdResponse.json()).project;

  const nullBody = await handler(makeRequest("/api/projects/" + created.id, "PUT", null), context);
  assert.equal(nullBody.status, 400);

  const invalidJson = await handler(new Request("https://clipforge.test/api/projects/" + created.id, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: "{",
  }), context);
  assert.equal(invalidJson.status, 400);

  const list = await handler(makeRequest("/api/projects"), context);
  assert.equal((await list.json()).projects[0].title, validProject.title);
});

test("protected project routes reject requests without a Netlify user", async () => {
  const handler = createHandler(() => createMemoryStore());
  const response = await handler(makeRequest("/api/projects"), {});
  assert.equal(response.status, 401);
});

test("storage errors return a safe service error instead of crashing the function", async () => {
  const handler = createHandler(() => ({
    list: async () => { throw new Error("private storage details"); },
    get: async () => null,
    setJSON: async () => undefined,
    delete: async () => undefined,
  }));
  const response = await handler(makeRequest("/api/projects"), { user: { id: "user-a" } });
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /temporarily unavailable/i);
});
