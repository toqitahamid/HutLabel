import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClerkClient, verifyToken } from "@clerk/backend";
import { neon } from "@neondatabase/serverless";

// Shared helpers for the /api functions. Underscore-prefixed so Vercel does not
// expose this file as a route.

export function sql() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  return neon(url);
}

export function clerk() {
  return createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY! });
}

// Verify the Clerk session JWT from the Authorization header. Returns the Clerk
// user id, or null (after writing a 401) when the request isn't authenticated.
export async function requireUser(
  req: VercelRequest,
  res: VercelResponse,
): Promise<string | null> {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) {
    res.status(401).json({ error: "Missing bearer token" });
    return null;
  }
  try {
    const payload = await verifyToken(token, {
      secretKey: process.env.CLERK_SECRET_KEY!,
    });
    return payload.sub;
  } catch (err) {
    console.error("verifyToken failed:", err);
    res.status(401).json({ error: "Invalid or expired session" });
    return null;
  }
}

// Roles live in Clerk `public_metadata.role` (see admin-users.ts). Writes a
// 403 and returns false when the signed-in user isn't an admin; the caller
// should return immediately in that case.
export async function requireAdmin(
  userId: string,
  res: VercelResponse,
): Promise<boolean> {
  const me = await clerk().users.getUser(userId);
  if (me.publicMetadata.role !== "admin") {
    res.status(403).json({ error: "Admin access required" });
    return false;
  }
  return true;
}
