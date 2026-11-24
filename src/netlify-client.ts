import {
  getUser,
  handleAuthCallback,
  login,
  logout,
  signup,
} from "@netlify/identity";

type IdentityUser = {
  id: string;
  email?: string;
  name?: string;
  userMetadata?: { full_name?: string };
};

type AppUser = { userId: string; email?: string; name?: string };

function normalizeUser(user: IdentityUser | null): AppUser | null {
  if (!user) return null;
  return {
    userId: user.id,
    email: user.email,
    name: user.name ?? user.userMetadata?.full_name,
  };
}

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
    return normalizeUser(await getUser() as IdentityUser | null);
  },
  async handleCallback() {
    return await handleAuthCallback();
  },
  async signIn(email: string, password: string) {
    return normalizeUser(await login(email, password) as IdentityUser);
  },
  async signUp(email: string, password: string) {
    return normalizeUser(await signup(email, password) as IdentityUser);
  },
  async signOut() {
    await logout();
  },
};
