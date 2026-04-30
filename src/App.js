import React, { useState } from "react";
import Login from "./Login";
import Chat from "./Chat";

function App() {
  const [user, setUser] = useState(sessionStorage.getItem("username"));
  const [keyPassword, setKeyPassword] = useState("");

  return (
    <div className={user ? "app-root chat-root" : "app-root auth-root"}>
      {user ? (
        <Chat user={user} setUser={setUser} keyPassword={keyPassword} setKeyPassword={setKeyPassword} />
      ) : (
        <Login setUser={setUser} setKeyPassword={setKeyPassword} />
      )}
    </div>
  );
}

export default App;
