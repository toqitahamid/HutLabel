import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClerkClient } from "@clerk/backend";
import { requireUser } from "./_lib";

// Admin user management (FlagLabel's `admin-users` Edge Function, ported to a
// Vercel function + Clerk Backend API). Action-based POST endpoint; the browser
// never sees CLERK_SECRET_KEY. Roles live in Clerk `public_metadata.role`.
//
//   { action: "list" }
//   { action: "add",     email, role }
//   { action: "setRole", id, role }
//   { action: "remove",  id }

type Role = "user" | "admin";
const ROLES: readonly string[] = ["user", "admin"];

function clerk() {
  return createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY! });
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  const userId = await requireUser(req, res);
  if (!userId) return;

  const client = clerk();
  const me = await client.users.getUser(userId);
  if (me.publicMetadata.role !== "admin") {
    res.status(403).json({ error: "Admin access required" });
    return;
  }

  const body = req.body as {
    action?: string;
    email?: string;
    id?: string;
    role?: string;
  };

  try {
    switch (body.action) {
      case "list": {
        const { data } = await client.users.getUserList({ limit: 200 });
        const users = data.map((u) => ({
          id: u.id,
          email:
            u.emailAddresses.find((e) => e.id === u.primaryEmailAddressId)
              ?.emailAddress ??
            u.emailAddresses[0]?.emailAddress ??
            "",
          role: (u.publicMetadata.role as Role | undefined) ?? "user",
          last_seen_at: u.lastActiveAt
            ? new Date(u.lastActiveAt).toISOString()
            : u.lastSignInAt
              ? new Date(u.lastSignInAt).toISOString()
              : null,
        }));
        users.sort((a, b) => a.email.localeCompare(b.email));
        res.status(200).json({ users });
        return;
      }
      case "add": {
        const email = body.email?.trim().toLowerCase();
        if (!email || !ROLES.includes(body.role ?? "")) {
          res.status(400).json({ error: "email and role are required" });
          return;
        }
        await client.users.createUser({
          emailAddress: [email],
          publicMetadata: { role: body.role as Role },
        });
        res.status(200).json({ ok: true });
        return;
      }
      case "setRole": {
        if (!body.id || !ROLES.includes(body.role ?? "")) {
          res.status(400).json({ error: "id and role are required" });
          return;
        }
        if (body.id === userId) {
          res.status(400).json({ error: "You can't change your own role." });
          return;
        }
        await client.users.updateUserMetadata(body.id, {
          publicMetadata: { role: body.role as Role },
        });
        res.status(200).json({ ok: true });
        return;
      }
      case "remove": {
        if (!body.id) {
          res.status(400).json({ error: "id is required" });
          return;
        }
        if (body.id === userId) {
          res.status(400).json({ error: "You can't remove yourself." });
          return;
        }
        await client.users.deleteUser(body.id);
        res.status(200).json({ ok: true });
        return;
      }
      default:
        res.status(400).json({ error: `Unknown action: ${body.action}` });
        return;
    }
  } catch (err) {
    // Clerk API errors carry { errors: [{ message, longMessage }] }.
    const clerkErr = err as { errors?: Array<{ longMessage?: string; message?: string }> };
    const msg =
      clerkErr.errors?.[0]?.longMessage ??
      clerkErr.errors?.[0]?.message ??
      (err instanceof Error ? err.message : String(err));
    res.status(500).json({ error: msg });
  }
}
