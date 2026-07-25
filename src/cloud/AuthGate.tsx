import { useCallback, useContext, useEffect, useRef, useState, createContext } from "react";
import { useAuth, useClerk, useSignIn, useSignUp, useUser } from "@clerk/react";
import { isCloudConfigured } from "./config";

// Signed-in account, surfaced to the app header (email + sign out) and to the
// API backend (bearer token). Null in local dev (no Clerk), where the app runs
// unauthenticated against the demo tileset.
export type Account = {
  email: string;
  // UI gate only (shows the Admin button); /api/admin-users re-checks the role
  // server-side against Clerk, so a spoofed client gains nothing.
  isAdmin: boolean;
  signOut: () => void;
  getToken: () => Promise<string | null>;
};
const AccountContext = createContext<Account | null>(null);
export function useAccount(): Account | null {
  return useContext(AccountContext);
}

// Invite-only login gate (web). When Clerk is NOT configured (local dev), this
// is a pure pass-through so the viewer runs offline against the demo tileset.
export function AuthGate({ children }: { children: React.ReactNode }) {
  if (!isCloudConfigured()) {
    return <>{children}</>;
  }
  return <WebAuthGate>{children}</WebAuthGate>;
}

function WebAuthGate({ children }: { children: React.ReactNode }) {
  const { isLoaded, isSignedIn, getToken } = useAuth();
  const { user } = useUser();
  const { signOut } = useClerk();
  // Captured once on first render — read before anything below has a chance
  // to strip it off the URL.
  const [inviteTicket, setInviteTicket] = useState(
    () => new URLSearchParams(window.location.search).get("__clerk_ticket"),
  );

  if (!isLoaded) return <CenteredMessage>Loading…</CenteredMessage>;
  if (!isSignedIn) {
    return inviteTicket ? (
      <AcceptInvite ticket={inviteTicket} onGiveUp={() => setInviteTicket(null)} />
    ) : (
      <LoginScreen />
    );
  }

  return (
    <AccountContext.Provider
      value={{
        email: user?.primaryEmailAddress?.emailAddress ?? "",
        isAdmin: user?.publicMetadata.role === "admin",
        signOut: () => void signOut(),
        getToken: () => getToken(),
      }}
    >
      {children}
    </AccountContext.Provider>
  );
}

// Lands here when an invitation email's link redirects back with a
// `__clerk_ticket` query param. Ticket sign-up mirrors the email-code flow
// above: hand the ticket to Clerk, then finalize to activate the session
// (which flips `isSignedIn` and lets WebAuthGate render `children` normally).
// The ticket is single-use, so its query params are stripped from the URL as
// soon as we know the outcome — a page refresh must not retry it.
function AcceptInvite({
  ticket,
  onGiveUp,
}: {
  ticket: string;
  onGiveUp: () => void;
}) {
  const { signUp } = useSignUp();
  const [error, setError] = useState<string | null>(null);
  const attempted = useRef(false);

  useEffect(() => {
    if (!signUp || attempted.current) return;
    attempted.current = true;
    (async () => {
      try {
        const { error: ticketError } = await signUp.ticket({ ticket });
        if (ticketError) {
          setError(friendlyAuthError(ticketError));
          return;
        }
        if (signUp.status === "complete") {
          const { error: finalizeError } = await signUp.finalize();
          if (finalizeError) setError(friendlyAuthError(finalizeError));
        } else {
          setError(
            "That invitation is no longer valid. Ask the admin to send a new one.",
          );
        }
      } catch (err) {
        setError(friendlyAuthError(err));
      } finally {
        stripInviteParams();
      }
    })();
  }, [signUp, ticket]);

  if (error) {
    return (
      <div className="auth-screen">
        <div className="auth-card">
          <h1 className="auth-title">HutLabel</h1>
          <div className="auth-error" role="alert">
            {error}
          </div>
          <button type="button" className="btn primary auth-submit" onClick={onGiveUp}>
            Back to sign in
          </button>
        </div>
      </div>
    );
  }
  return <CenteredMessage>Accepting your invitation…</CenteredMessage>;
}

// Drops `__clerk_ticket`/`__clerk_status` from the URL without a navigation,
// so a refresh after acceptance (or after a failed, consumed ticket) doesn't
// resubmit it.
function stripInviteParams() {
  const url = new URL(window.location.href);
  url.searchParams.delete("__clerk_ticket");
  url.searchParams.delete("__clerk_status");
  window.history.replaceState({}, "", url.toString());
}

const OTP_LEN = 6;

function OtpBoxes({
  value,
  onChange,
  onComplete,
  disabled,
}: {
  value: string;
  onChange: (next: string) => void;
  onComplete: (full: string) => void;
  disabled?: boolean;
}) {
  const refs = useRef<Array<HTMLInputElement | null>>([]);
  const digits = Array.from({ length: OTP_LEN }, (_, i) => value[i] ?? "");

  const commit = (next: string) => {
    const packed = next.replace(/\D/g, "").slice(0, OTP_LEN);
    onChange(packed);
    if (packed.length === OTP_LEN) onComplete(packed);
    return packed;
  };
  const focusBox = (i: number) => {
    const clamped = Math.max(0, Math.min(i, OTP_LEN - 1));
    refs.current[clamped]?.focus();
    refs.current[clamped]?.select();
  };
  const handleChange = (i: number, raw: string) => {
    const digit = raw.replace(/\D/g, "").slice(-1);
    if (!digit) return;
    commit(value.slice(0, i) + digit + value.slice(i + 1));
    focusBox(i + 1);
  };
  const handleKeyDown = (i: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Backspace") {
      e.preventDefault();
      if (value[i]) onChange(value.slice(0, i) + value.slice(i + 1));
      else if (i > 0) {
        onChange(value.slice(0, i - 1) + value.slice(i));
        focusBox(i - 1);
      }
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      focusBox(i - 1);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      focusBox(i + 1);
    }
  };
  const handlePaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    const pasted = e.clipboardData.getData("text").replace(/\D/g, "");
    if (!pasted) return;
    e.preventDefault();
    focusBox(commit(pasted).length);
  };

  return (
    <div className="otp-boxes" role="group" aria-label="6-digit verification code">
      {digits.map((d, i) => (
        <input
          key={i}
          ref={(el) => {
            refs.current[i] = el;
          }}
          className="otp-box"
          type="text"
          inputMode="numeric"
          autoComplete={i === 0 ? "one-time-code" : "off"}
          maxLength={1}
          value={d}
          disabled={disabled}
          aria-label={`Digit ${i + 1}`}
          autoFocus={i === 0}
          onChange={(e) => handleChange(i, e.target.value)}
          onKeyDown={(e) => handleKeyDown(i, e)}
          onPaste={handlePaste}
          onFocus={(e) => e.target.select()}
        />
      ))}
    </div>
  );
}

// Passwordless email OTP (code, not link — institutional Safe Links prefetch
// burns one-time link tokens). Invite-only: the Clerk instance runs in
// restricted sign-up mode, so sending a code to an unknown email fails.
function LoginScreen() {
  const { signIn } = useSignIn();
  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  const sendCode = useCallback(async (): Promise<boolean> => {
    if (!signIn) return false;
    setSubmitting(true);
    setError(null);
    try {
      const { error: sendError } = await signIn.emailCode.sendCode({
        emailAddress: email.trim(),
      });
      if (sendError) {
        setError(friendlyAuthError(sendError));
        return false;
      }
      setCooldown(60);
      return true;
    } catch (err) {
      setError(friendlyAuthError(err));
      return false;
    } finally {
      setSubmitting(false);
    }
  }, [signIn, email]);

  const verify = useCallback(
    async (token: string) => {
      if (!signIn) return;
      setSubmitting(true);
      setError(null);
      try {
        const { error: verifyError } = await signIn.emailCode.verifyCode({
          code: token.trim(),
        });
        if (verifyError) {
          setError(friendlyAuthError(verifyError));
          return;
        }
        if (signIn.status === "complete") {
          const { error: finalizeError } = await signIn.finalize();
          if (finalizeError) setError(friendlyAuthError(finalizeError));
        } else {
          setError("Sign-in incomplete. Request a new code and try again.");
        }
      } catch (err) {
        setError(friendlyAuthError(err));
      } finally {
        setSubmitting(false);
      }
    },
    [signIn],
  );

  if (step === "email") {
    return (
      <div className="auth-screen">
        <form
          className="auth-card"
          onSubmit={async (e) => {
            e.preventDefault();
            if (await sendCode()) {
              setCode("");
              setStep("code");
            }
          }}
        >
          <h1 className="auth-title">HutLabel</h1>
          <p className="auth-subtitle">Sign in to label muskrat huts.</p>
          <label className="auth-field">
            <span>Email</span>
            <input
              type="email"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoFocus
            />
          </label>
          {error && (
            <div className="auth-error" role="alert">
              {error}
            </div>
          )}
          <button type="submit" className="btn primary auth-submit" disabled={submitting}>
            {submitting ? "Sending code…" : "Send code"}
          </button>
          <p className="auth-note">
            Access is invite-only. Contact the admin if your email isn't recognized.
          </p>
        </form>
      </div>
    );
  }

  return (
    <div className="auth-screen">
      <form
        className="auth-card"
        onSubmit={(e) => {
          e.preventDefault();
          void verify(code);
        }}
      >
        <h1 className="auth-title">Check your email</h1>
        <p className="auth-subtitle">
          We sent a 6-digit code to <strong>{email}</strong>.
        </p>
        <div className="otp-field">
          <span className="otp-label">Verification code</span>
          <OtpBoxes
            value={code}
            onChange={setCode}
            onComplete={(full) => void verify(full)}
            disabled={submitting}
          />
        </div>
        {error && (
          <div className="auth-error" role="alert">
            {error}
          </div>
        )}
        <button
          type="submit"
          className="btn primary auth-submit"
          disabled={submitting || code.length < 6}
        >
          {submitting ? "Verifying…" : "Verify & sign in"}
        </button>
        <div className="auth-actions">
          <button
            type="button"
            className="auth-linkbtn"
            onClick={() => {
              void signIn?.reset();
              setStep("email");
              setError(null);
            }}
          >
            Use a different email
          </button>
          <button
            type="button"
            className="auth-linkbtn"
            disabled={submitting || cooldown > 0}
            onClick={() => sendCode()}
          >
            {cooldown > 0 ? `Resend in ${cooldown}s` : "Resend code"}
          </button>
        </div>
      </form>
    </div>
  );
}

// Map Clerk error shapes/codes to labeler-friendly text. New-API methods return
// a ClerkError ({ code, message }); legacy paths throw { errors: [{ code, ... }] }.
function friendlyAuthError(err: unknown): string {
  const direct = err as { code?: string; message?: string };
  const legacy = err as { errors?: Array<{ code?: string; message?: string }> };
  const first = legacy.errors?.[0] ?? direct;
  const code = first?.code ?? "";
  if (code === "form_identifier_not_found") {
    return "That email isn't on the team yet. Ask the admin to add you.";
  }
  if (code === "form_code_incorrect" || code === "verification_expired") {
    return "That code is invalid or expired. Request a new one.";
  }
  if (code === "too_many_requests") {
    return "Too many requests. Wait a minute, then try again.";
  }
  if (code.includes("ticket") || code.includes("invitation")) {
    return "That invitation is no longer valid. Ask the admin to send a new one.";
  }
  return first?.message ?? (err instanceof Error ? err.message : String(err));
}

function CenteredMessage({ children }: { children: React.ReactNode }) {
  return (
    <div className="auth-screen">
      <div className="auth-loading">{children}</div>
    </div>
  );
}
