import React, { useState } from "react";

// Two states: not logged in -> login form; logged in -> user list from /api/users.
export default function App() {
  const [token, setToken] = useState(() => localStorage.getItem("token") || "");
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("password123");
  const [users, setUsers] = useState(null);
  const [error, setError] = useState("");

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
    const { token } = await r.json();
    localStorage.setItem("token", token);
    setToken(token);
    loadUsers(token);
  }

  async function loadUsers(t = token) {
    setError("");
    const r = await fetch("/api/users", { headers: { Authorization: `Bearer ${t}` } });
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
  }

  const box = { fontFamily: "system-ui, sans-serif", maxWidth: 640, margin: "40px auto", padding: "0 16px" };

  if (!token) {
    return (
      <div style={box}>
        <h1>Sign in</h1>
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
        <h1>Users</h1>
        <button onClick={logout}>Log out</button>
      </div>
      {!users && <button onClick={() => loadUsers()}>Load users</button>}
      {error && <p style={{ color: "crimson" }}>{error}</p>}
      {users && (
        <table border="1" cellPadding="6" style={{ borderCollapse: "collapse", width: "100%" }}>
          <thead>
            <tr><th>ID</th><th>Username</th><th>Name</th><th>Email</th><th>Created</th></tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>{u.id}</td><td>{u.username}</td><td>{u.full_name}</td>
                <td>{u.email}</td><td>{new Date(u.created_at).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
