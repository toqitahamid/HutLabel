import type { VercelRequest, VercelResponse } from "@vercel/node";
import { clerk, requireAdmin, requireUser } from "./_lib.js";

// Admin user management (FlagLabel's `admin-users` Edge Function, ported to a
// Vercel function + Clerk Backend API). Action-based POST endpoint; the browser
// never sees CLERK_SECRET_KEY. Roles live in Clerk `public_metadata.role`.
//
//   { action: "list" }
//   { action: "add",     email, role }
//   { action: "setRole", id, role }
//   { action: "remove",  id }
//
// "add" creates the Clerk user outright with the chosen role in
// publicMetadata; the admin is responsible for telling the person to sign in
// with their email to receive a login code.

type Role = "user" | "admin";
const ROLES: readonly string[] = ["user", "admin"];

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  const userId = await requireUser(req, res);
  if (!userId) return;
  if (!(await requireAdmin(userId, res))) return;

  const client = clerk();

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
    // Clerk API errors carry { status, errors: [{ message, longMessage }] }.
    // `status` is Clerk's own HTTP status for the failure (422 for things
    // like "already a member") — surface those as 400s with Clerk's message
    // instead of a blanket 500.
    const clerkErr = err as {
      status?: number;
      errors?: Array<{ longMessage?: string; message?: string }>;
    };
    const msg =
      clerkErr.errors?.[0]?.longMessage ??
      clerkErr.errors?.[0]?.message ??
      (err instanceof Error ? err.message : String(err));
    const status =
      typeof clerkErr.status === "number" && clerkErr.status < 500 ? 400 : 500;
    res.status(status).json({ error: msg });
  }
}
