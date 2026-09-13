import React, { useState } from "react";

// window.APP_ENV is written by docker-entrypoint.d/40-generate-env.sh at container
// start (see index.html) — same built image, different text per environment. Falls
// back to "local" for `npm run dev`/tests, where env.js is never generated.
const APP_ENV = (window.APP_ENV || "local").toUpperCase();

const EMPTY_FORM = { username: "", password: "", full_name: "", email: "" };

// Two states: not logged in -> login form; logged in -> user list from /api/users.
// Add/edit/delete are admin-only (server-enforced via requireAdmin — the UI just
// hides controls a non-admin's request would get a 403 from anyway).
export default function App() {
  const [token, setToken] = useState(() => localStorage.getItem("token") || "");
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("password123");
  const [users, setUsers] = useState(null);
  const [me, setMe] = useState(null);
  const [error, setError] = useState("");
  const [newUser, setNewUser] = useState(EMPTY_FORM);
  const [editingId, setEditingId] = useState(null);
  const [editForm, setEditForm] = useState(EMPTY_FORM);

  function authHeaders(t = token) {
    return { Authorization: `Bearer ${t}` };
  }

  async function login(e) {
    e.preventDefault();
    setError("");
    const r = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    if (!r.ok) {
      setError((await r.json().catch(() => ({}))).error || `login failed (${r.status})`);
      return;
    }
    const { token: t } = await r.json();
    localStorage.setItem("token", t);
    setToken(t);
    loadMe(t);
    loadUsers(t);
  }

  async function loadMe(t = token) {
    const r = await fetch("/api/me", { headers: authHeaders(t) });
    if (r.ok) setMe(await r.json());
  }

  async function loadUsers(t = token) {
    setError("");
    const r = await fetch("/api/users", { headers: authHeaders(t) });
    if (r.status === 401) return logout();
    if (!r.ok) {
      setError(`could not load users (${r.status})`);
      return;
    }
    setUsers(await r.json());
  }

  function logout() {
    localStorage.removeItem("token");
    setToken("");
    setUsers(null);
    setMe(null);
  }

  async function createUser(e) {
    e.preventDefault();
    setError("");
    const r = await fetch("/api/users", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify(newUser),
    });
    if (!r.ok) {
      setError((await r.json().catch(() => ({}))).error || `could not create user (${r.status})`);
      return;
    }
    setNewUser(EMPTY_FORM);
    loadUsers();
  }

  function startEdit(u) {
    setEditingId(u.id);
    setEditForm({ username: u.username, password: "", full_name: u.full_name || "", email: u.email || "" });
  }

  async function saveEdit(id) {
    setError("");
    const body = { ...editForm };
    if (!body.password) delete body.password; // blank = leave password unchanged
    const r = await fetch(`/api/users/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      setError((await r.json().catch(() => ({}))).error || `could not update user (${r.status})`);
      return;
    }
    setEditingId(null);
    loadUsers();
  }

  async function deleteUser(u) {
    if (!window.confirm(`Delete user "${u.username}"? This cannot be undone.`)) return;
    setError("");
    const r = await fetch(`/api/users/${u.id}`, { method: "DELETE", headers: authHeaders() });
    if (!r.ok && r.status !== 204) {
      setError((await r.json().catch(() => ({}))).error || `could not delete user (${r.status})`);
      return;
    }
    loadUsers();
  }

  const box = { fontFamily: "system-ui, sans-serif", maxWidth: 720, margin: "40px auto", padding: "0 16px" };
  const input = { width: "100%" };

  if (!token) {
    return (
      <div style={box}>
        <h1 style={{ color: "crimson" }}>Sign in {APP_ENV} env</h1>
        <form onSubmit={login}>
          <div style={{ marginBottom: 8 }}>
            <label>Username<br />
              <input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus />
            </label>
          </div>
          <div style={{ marginBottom: 12 }}>
            <label>Password<br />
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </label>
          </div>
          <button type="submit">Log in</button>
        </form>
        {error && <p style={{ color: "crimson" }}>{error}</p>}
        <p style={{ color: "#666", fontSize: 13 }}>Demo users: admin / bwayne / ckent / dprince / bbanner — password <code>password123</code></p>
      </div>
    );
  }

  return (
    <div style={box}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h1>Users — {APP_ENV} env</h1>
        <button onClick={logout}>Log out</button>
      </div>
      {!users && <button onClick={() => loadUsers()}>Load users</button>}
      {error && <p style={{ color: "crimson" }}>{error}</p>}

      {users && (
        <table border="1" cellPadding="6" style={{ borderCollapse: "collapse", width: "100%" }}>
          <thead>
            <tr>
              <th>ID</th><th>Username</th><th>Name</th><th>Email</th><th>Admin</th><th>Created</th>
              {me?.is_admin && <th>Actions</th>}
            </tr>
          </thead>
          <tbody>
            {users.map((u) =>
              editingId === u.id ? (
                <tr key={u.id}>
                  <td>{u.id}</td>
                  <td><input style={input} value={editForm.username} onChange={(e) => setEditForm({ ...editForm, username: e.target.value })} /></td>
                  <td><input style={input} value={editForm.full_name} onChange={(e) => setEditForm({ ...editForm, full_name: e.target.value })} /></td>
                  <td><input style={input} value={editForm.email} onChange={(e) => setEditForm({ ...editForm, email: e.target.value })} /></td>
                  <td>{u.is_admin ? "yes" : "no"}</td>
                  <td>{new Date(u.created_at).toLocaleString()}</td>
                  <td>
                    <input style={input} type="password" placeholder="new password (optional)"
                      value={editForm.password} onChange={(e) => setEditForm({ ...editForm, password: e.target.value })} />
                    <button onClick={() => saveEdit(u.id)}>Save</button>
                    <button onClick={() => setEditingId(null)}>Cancel</button>
                  </td>
                </tr>
              ) : (
                <tr key={u.id}>
                  <td>{u.id}</td><td>{u.username}</td><td>{u.full_name}</td>
                  <td>{u.email}</td><td>{u.is_admin ? "yes" : "no"}</td>
                  <td>{new Date(u.created_at).toLocaleString()}</td>
                  {me?.is_admin && (
                    <td>
                      <button onClick={() => startEdit(u)}>Edit</button>
                      <button onClick={() => deleteUser(u)}>Delete</button>
                    </td>
                  )}
                </tr>
              )
            )}
          </tbody>
        </table>
      )}

      {me?.is_admin && (
        <form onSubmit={createUser} style={{ marginTop: 20 }}>
          <h3>Add user</h3>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
            <input placeholder="username" required value={newUser.username}
              onChange={(e) => setNewUser({ ...newUser, username: e.target.value })} />
            <input placeholder="password (min 8 chars)" type="password" required value={newUser.password}
              onChange={(e) => setNewUser({ ...newUser, password: e.target.value })} />
            <input placeholder="full name" value={newUser.full_name}
              onChange={(e) => setNewUser({ ...newUser, full_name: e.target.value })} />
            <input placeholder="email" value={newUser.email}
              onChange={(e) => setNewUser({ ...newUser, email: e.target.value })} />
          </div>
          <button type="submit">Add user</button>
        </form>
      )}
    </div>
  );
}
