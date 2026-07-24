// Admin user-management client for the WEB build. Talks to the `/api/admin-users`
// Vercel function (which holds CLERK_SECRET_KEY); the browser never sees that
// key. Also exports the pure email helpers and shared types used by AdminPanel.

export type Role = "user" | "admin";

export type AdminUser = {
  id: string;
  email: string;
  role: Role | null;
  last_seen_at: string | null;
};

type GetToken = () => Promise<string | null>;

// Lowercase + trim so the same address is never stored under two casings.
export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

// Pragmatic single-line check: one `@`, a dot-bearing domain, no whitespace.
// Clerk is the real validator; this just stops obvious typos client-side.
export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// Invoke the admin function with the signed-in user's session token, which the
// function uses for its admin check. On a non-2xx, surface the server's
// `{ error }` so the UI shows a real message instead of a bare status code.
async function invokeAdmin<T>(
  getToken: GetToken,
  action: string,
  payload: Record<string, unknown> = {},
): Promise<T> {
  const token = await getToken();
  if (!token) throw new Error("Not signed in.");
  const res = await fetch("/api/admin-users", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ action, ...payload }),
  });
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      /* keep the generic message if the body isn't JSON */
    }
    throw new Error(message);
  }
  return (await res.json()) as T;
}

export async function listUsers(getToken: GetToken): Promise<AdminUser[]> {
  const res = await invokeAdmin<{ users: AdminUser[] }>(getToken, "list");
  return res.users;
}

export async function addUser(
  getToken: GetToken,
  email: string,
  role: Role,
): Promise<void> {
  await invokeAdmin(getToken, "add", { email: normalizeEmail(email), role });
}

export async function setRole(
  getToken: GetToken,
  id: string,
  role: Role,
): Promise<void> {
  await invokeAdmin(getToken, "setRole", { id, role });
}

export async function removeUser(getToken: GetToken, id: string): Promise<void> {
  await invokeAdmin(getToken, "remove", { id });
}
