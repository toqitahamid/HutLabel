import { ClerkProvider } from "@clerk/react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import App from "./App";
import { AuthGate } from "./cloud/AuthGate";
import { clerkPublishableKey } from "./cloud/config";
import "./index.css";

// Cloud mode (Clerk key present): auth gate + API backend. Local dev (no key):
// no provider at all — the app runs offline against the decoded demo tileset.
const gated = (
  <AuthGate>
    <App />
  </AuthGate>
);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {clerkPublishableKey ? (
      <ClerkProvider publishableKey={clerkPublishableKey} afterSignOutUrl="/">
        {gated}
      </ClerkProvider>
    ) : (
      gated
    )}
  </StrictMode>,
);
