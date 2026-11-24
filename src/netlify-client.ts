type ApiResponse<T> = { data: T };

async function request<T>(method: string, path: string, body?: unknown): Promise<ApiResponse<T>> {
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? { Accept: "application/json" } : {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const payload = await response.json().catch(() => ({})) as {
    error?: string;
  } & T;

  if (!response.ok) {
    throw new Error(payload.error || `Request failed (${response.status}).`);
  }
  return { data: payload };
}

export const api = {
  get: <T = any>(path: string) => request<T>("GET", path),
  post: <T = any>(path: string, body: unknown) => request<T>("POST", path, body),
  put: <T = any>(path: string, body: unknown) => request<T>("PUT", path, body),
  delete: <T = any>(path: string) => request<T>("DELETE", path),
};

export const auth = {
  async getUser() {
    try {
      const response = await api.get<{ user: { userId: string; email?: string; name?: string } }>("/api/me");
      return response.data.user ?? null;
    } catch (error) {
      if (error instanceof Error && /sign in|unauthorized/i.test(error.message)) return null;
      throw error;
    }
  },
  async signInWithRedirect() {
    // Netlify team SSO protects the site itself; reloading sends an expired
    // or unauthenticated browser session back through Netlify's access gate.
    window.location.reload();
  },
};
