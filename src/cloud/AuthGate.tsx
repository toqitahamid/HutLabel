import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { getSupabaseClient, isSupabaseConfigured } from "./supabase-client";

// Signed-in account, surfaced to the app header (email + sign out). Null in local
// dev (no Supabase), where the app runs unauthenticated against the demo tileset.
export type Account = { email: string; signOut: () => void };
const AccountContext = createContext<Account | null>(null);
export function useAccount(): Account | null {
  return useContext(AccountContext);
}

// Invite-only login gate (web). When Supabase is NOT configured (local dev), this
// is a pure pass-through so the viewer runs offline against the demo tileset.
export function AuthGate({ children }: { children: React.ReactNode }) {
  if (!isSupabaseConfigured()) {
    return <>{children}</>;
  }
  return <WebAuthGate>{children}</WebAuthGate>;
}

function WebAuthGate({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [configError, setConfigError] = useState<string | null>(null);

  useEffect(() => {
    let supabase;
    try {
      supabase = getSupabaseClient();
    } catch (e) {
      setConfigError(e instanceof Error ? e.message : String(e));
      setReady(true);
      return;
    }
    supabase.auth
      .getSession()
      .then(({ data }) => {
        setSession(data.session);
        setReady(true);
      })
      .catch(() => setReady(true));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  if (configError) return <ConfigErrorScreen message={configError} />;
  if (!ready) return <CenteredMessage>Loading…</CenteredMessage>;
  if (!session) return <LoginScreen />;

  return (
    <AccountContext.Provider
      value={{
        email: session.user.email ?? "",
        signOut: () => void getSupabaseClient().auth.signOut(),
      }}
    >
      {children}
    </AccountContext.Provider>
  );
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
// burns one-time link tokens). Invite-only: shouldCreateUser:false.
function LoginScreen() {
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
    setSubmitting(true);
    setError(null);
    try {
      const { error: otpError } = await getSupabaseClient().auth.signInWithOtp({
        email: email.trim(),
        options: { shouldCreateUser: false },
      });
      if (otpError) {
        setError(friendlyAuthError(otpError.message));
        return false;
      }
      setCooldown(60);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setSubmitting(false);
    }
  }, [email]);

  const verify = useCallback(
    async (token: string) => {
      setSubmitting(true);
      setError(null);
      try {
        const { error: verifyError } = await getSupabaseClient().auth.verifyOtp({
          email: email.trim(),
          token: token.trim(),
          type: "email",
        });
        if (verifyError) setError(friendlyAuthError(verifyError.message));
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setSubmitting(false);
      }
    },
    [email],
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

function friendlyAuthError(message: string): string {
  const m = message.toLowerCase();
  if (m.includes("signups not allowed") || m.includes("not allowed for otp")) {
    return "That email isn't on the team yet. Ask the admin to add you.";
  }
  if (m.includes("rate limit") || m.includes("too many")) {
    return "Too many requests. Wait a minute, then try again.";
  }
  if (m.includes("invalid") || m.includes("expired")) {
    return "That code is invalid or expired. Request a new one.";
  }
  return message;
}

function CenteredMessage({ children }: { children: React.ReactNode }) {
  return (
    <div className="auth-screen">
      <div className="auth-loading">{children}</div>
    </div>
  );
}

function ConfigErrorScreen({ message }: { message: string }) {
  return (
    <div className="auth-screen">
      <div className="auth-card">
        <h1 className="auth-title">HutLabel</h1>
        <div className="auth-error" role="alert">
          {message}
        </div>
      </div>
    </div>
  );
}
