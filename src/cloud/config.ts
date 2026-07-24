// Cloud-mode switch (web build). When the Clerk publishable key is absent
// (plain `npm run dev` against the decoded demo tileset), the app runs
// unauthenticated and offline; when present, the auth gate and the /api
// backend are active. Serve /api locally with `vercel dev`, not `vite`.
export const clerkPublishableKey: string | undefined = import.meta.env
  .VITE_CLERK_PUBLISHABLE_KEY as string | undefined;

export function isCloudConfigured(): boolean {
  return Boolean(clerkPublishableKey);
}
