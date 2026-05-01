import React, { useState } from "react";
import { API_BASE_URL } from "./config";

function Login({ setUser, setKeyPassword }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [isSignup, setIsSignup] = useState(false);
  const [message, setMessage] = useState({ text: "", type: "" });

  const showMessage = (text, type) => {
    setMessage({ text, type });
    setTimeout(() => setMessage({ text: "", type: "" }), 3000);
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!username || !password) {
      showMessage("Enter username & password", "error");
      return;
    }

    const endpoint = isSignup ? "signup" : "login";

    fetch(`${API_BASE_URL}/${endpoint}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ username, password })
    })
      .then(res => res.json())
      .then(data => {
        if (isSignup) {
          if (data.status === "success") {
            showMessage("Signup successful. Please login.", "success");
            setIsSignup(false);
            setPassword("");
          } else {
            showMessage("User exists", "error");
          }
        } else {
          if (data.status === "success") {
            sessionStorage.setItem("username", username);
            sessionStorage.setItem("token", data.token);
            setKeyPassword(password);
            setUser(username);
          } else {
            showMessage("Invalid credentials", "error");
          }
        }
      })
      .catch(() => showMessage("Server error", "error"));
  };

  return (
    <div className="auth-container">
      <h2>{isSignup ? "Create Account" : "Welcome Back"}</h2>
      <p style={{ color: 'var(--text-muted)', fontSize: '14px', marginBottom: '24px', marginTop: '-12px' }}>
        {isSignup ? 'Join SecureChat — encrypted messaging' : 'End-to-end encrypted messaging'}
      </p>
      
      {message.text && (
        <div className={`message ${message.type}`}>
          {message.text}
        </div>
      )}

      <form onSubmit={handleSubmit}>
        <input
          placeholder="Username"
          value={username}
          onChange={e => setUsername(e.target.value)}
        />
        <input
          type="password"
          placeholder="Password"
          value={password}
          onChange={e => setPassword(e.target.value)}
        />

        <button type="submit">{isSignup ? "Sign Up" : "Login"}</button>
      </form>

      <div 
        className="toggle-link" 
        onClick={() => setIsSignup(!isSignup)}
      >
        {isSignup ? "Already have an account? Login" : "Don't have an account? Sign up"}
      </div>
    </div>
  );
}

export default Login;
