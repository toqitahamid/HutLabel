import { useCallback, useEffect, useState } from "react";
import {
  listUsers,
  addUser,
  setRole,
  removeUser,
  revokeInvite,
  isValidEmail,
  type AdminUser,
  type Role,
} from "./admin-users";
import type { Account } from "./AuthGate";

// Admin-only user management for the web build (FlagLabel's AdminPanel). Lists
// users, invites new people by email, toggles role, and removes. All privileged
// work happens in the `/api/admin-users` function; this component only calls
// the client wrapper and reflects loading/error state. Styling uses the shared
// modal vocabulary (`upload-overlay`, `btn`) plus `admin-*` classes in App.css.

type AdminPanelProps = {
  account: Account;
  onClose: () => void;
};

function formatLastSeen(iso: string | null): string {
  if (!iso) return "never";
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function AdminPanel(props: AdminPanelProps) {
  const { account, onClose } = props;
  const { email: currentEmail, getToken } = account;

  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [newEmail, setNewEmail] = useState("");
  const [newRole, setNewRole] = useState<Role>("user");

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setUsers(await listUsers(getToken));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [getToken]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Escape closes the panel when not mid-mutation.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [busy, onClose]);

  const onAdd = useCallback(async () => {
    const email = newEmail.trim();
    if (!isValidEmail(email)) {
      setError("Enter a valid email address.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await addUser(getToken, email, newRole);
      setNewEmail("");
      setNewRole("user");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [getToken, newEmail, newRole, refresh]);

  const onChangeRole = useCallback(
    async (u: AdminUser, role: Role) => {
      setBusy(true);
      setError(null);
      try {
        await setRole(getToken, u.id, role);
        await refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [getToken, refresh],
  );

  const onRemove = useCallback(
    async (u: AdminUser) => {
      setBusy(true);
      setError(null);
      try {
        await removeUser(getToken, u.id);
        await refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [getToken, refresh],
  );

  const onRevoke = useCallback(
    async (u: AdminUser) => {
      setBusy(true);
      setError(null);
      try {
        await revokeInvite(getToken, u.id);
        await refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [getToken, refresh],
  );

  const onBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget && !busy) onClose();
    },
    [busy, onClose],
  );

  const activeCount = users.filter((u) => u.status === "active").length;
  const invitedCount = users.length - activeCount;

  return (
    <div
      className="upload-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Manage users"
      onClick={onBackdropClick}
    >
      <div className="upload-modal admin-modal">
        <div className="upload-modal-head">
          <div className="upload-modal-title">Manage users</div>
          <div className="upload-modal-sub">
            Add or remove people who can sign in to HutLabel.
          </div>
        </div>

        <div className="upload-modal-body">
          <div className="admin-addrow">
            <input
              className="admin-email-input"
              type="email"
              placeholder="name@university.edu"
              value={newEmail}
              disabled={busy}
              onChange={(e) => setNewEmail(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void onAdd();
              }}
            />
            <select
              className="admin-role-select"
              value={newRole}
              disabled={busy}
              onChange={(e) => setNewRole(e.target.value as Role)}
            >
              <option value="user">user</option>
              <option value="admin">admin</option>
            </select>
            <button
              type="button"
              className="btn primary"
              disabled={busy || newEmail.trim() === ""}
              onClick={() => void onAdd()}
            >
              Add user
            </button>
          </div>

          <p className="admin-hint">
            Adding someone sends them an email invitation to join HutLabel.
            Pending invites appear below until accepted.
          </p>

          {error && (
            <div className="auth-error" role="alert">
              {error}
            </div>
          )}

          {loading ? (
            <div className="admin-empty">Loading users…</div>
          ) : users.length === 0 ? (
            <div className="admin-empty">No users yet.</div>
          ) : (
            <div className="admin-userlist">
              {users.map((u) => {
                const isSelf = u.email.toLowerCase() === currentEmail.toLowerCase();
                const isInvited = u.status === "invited";
                return (
                  <div className="admin-userrow" key={u.id}>
                    <span className="admin-uemail">
                      {u.email}
                      {isSelf && <span className="admin-self"> (you)</span>}
                    </span>
                    {isInvited && <span className="admin-badge">Invited</span>}
                    <span className="admin-ulast">
                      {isInvited ? "—" : `last seen ${formatLastSeen(u.last_seen_at)}`}
                    </span>
                    {isInvited ? (
                      <button
                        type="button"
                        className="admin-remove"
                        disabled={busy}
                        onClick={() => void onRevoke(u)}
                        title={`Revoke invitation for ${u.email}`}
                      >
                        Revoke
                      </button>
                    ) : (
                      <>
                        <select
                          className="admin-role-select"
                          value={u.role ?? "user"}
                          disabled={busy || isSelf}
                          onChange={(e) =>
                            void onChangeRole(u, e.target.value as Role)
                          }
                          title={
                            isSelf ? "You can't change your own role" : "Change role"
                          }
                        >
                          <option value="user">user</option>
                          <option value="admin">admin</option>
                        </select>
                        <button
                          type="button"
                          className="admin-remove"
                          disabled={busy || isSelf}
                          onClick={() => void onRemove(u)}
                          title={
                            isSelf
                              ? "You can't remove yourself"
                              : `Remove ${u.email}`
                          }
                        >
                          Remove
                        </button>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="upload-modal-foot">
          <span className="upload-count">
            {activeCount} user{activeCount === 1 ? "" : "s"}
            {invitedCount > 0 ? `, ${invitedCount} invited` : ""}
          </span>
          <span className="upload-actions">
            <button
              type="button"
              className="btn primary"
              disabled={busy}
              onClick={onClose}
            >
              Done
            </button>
          </span>
        </div>
      </div>
    </div>
  );
}
