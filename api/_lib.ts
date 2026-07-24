import type { VercelRequest, VercelResponse } from "@vercel/node";
import { verifyToken } from "@clerk/backend";
import { neon } from "@neondatabase/serverless";

// Shared helpers for the /api functions. Underscore-prefixed so Vercel does not
// expose this file as a route.

export function sql() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  return neon(url);
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
