import React, { useState, useEffect } from "react";
import Login from "./Login";
import Chat from "./Chat";

function App() {
  const [user, setUser] = useState(sessionStorage.getItem("username"));
  const [keyPassword, setKeyPassword] = useState("");
  const [theme, setTheme] = useState(localStorage.getItem("theme") || "dark");

  useEffect(() => {
    const root = document.documentElement;
    if (theme === "system") {
      const isDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
      root.setAttribute("data-theme", isDark ? "dark" : "light");
    } else {
      root.setAttribute("data-theme", theme);
    }
    localStorage.setItem("theme", theme);
  }, [theme]);

  // Listen for system theme changes if set to system
  useEffect(() => {
    if (theme !== "system") return;
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => {
      document.documentElement.setAttribute("data-theme", mediaQuery.matches ? "dark" : "light");
    };
    mediaQuery.addEventListener("change", handler);
    return () => mediaQuery.removeEventListener("change", handler);
  }, [theme]);

  return (
    <div className={user ? "app-root chat-root" : "app-root auth-root"}>
      {user ? (
        <Chat 
          user={user} 
          setUser={setUser} 
          keyPassword={keyPassword} 
          setKeyPassword={setKeyPassword}
          theme={theme}
          setTheme={setTheme}
        />
      ) : (
        <Login setUser={setUser} setKeyPassword={setKeyPassword} />
      )}
    </div>
  );
}

export default App;
