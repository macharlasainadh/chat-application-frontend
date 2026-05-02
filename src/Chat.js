import React, { useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";
import {
  generateKeys,
  encryptMessage,
  decryptMessage,
  decryptKeyBackup,
  encryptKeyBackup,
  exportPrivateKeyPkcs8Base64,
  importPrivateKeyPkcs8Base64,
  exportPublicKeySpkiBase64,
  importPublicKeySpkiBase64
} from "./utils/crypto";
import { API_BASE_URL } from "./config";

const socket = io(API_BASE_URL, { transports: ["websocket"], autoConnect: false });

function normalizeUsers(users) {
  return users.map(item => (
    typeof item === "string"
      ? { username: item, online: true, last_seen: null }
      : item
  ));
}

function parseContent(text) {
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && parsed.kind) {
      return parsed;
    }
  } catch {
    // Plain text from older messages.
  }
  return { kind: "text", text };
}

function formatLastSeen(lastSeen) {
  if (!lastSeen) return "Last seen unavailable";

  const date = new Date(lastSeen.replace(" ", "T") + "Z");
  if (Number.isNaN(date.getTime())) return `Last seen ${lastSeen}`;

  const diff = Date.now() - date.getTime();
  const minutes = Math.max(1, Math.floor(diff / 60000));
  if (minutes < 2) return "Last seen just now";
  if (minutes < 60) return `Last seen ${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Last seen ${hours}h ago`;

  return `Last seen ${date.toLocaleDateString()}`;
}

function formatBytes(size) {
  if (!size) return "";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function formatMessageTime(dateStr) {
  if (!dateStr) return "";
  // Handle 'YYYY-MM-DD HH:MM:SS' or ISO strings
  const cleanDateStr = dateStr.includes(" ") && !dateStr.includes("T")
    ? dateStr.replace(" ", "T") + "Z"
    : dateStr;
  const date = new Date(cleanDateStr);
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: true }).toLowerCase();
}

function fileKind(mimeType = "") {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType === "application/pdf") return "pdf";
  return "doc";
}

function AttachmentPreview({ file }) {
  const [objectUrl, setObjectUrl] = useState("");
  const [loadError, setLoadError] = useState("");
  const token = sessionStorage.getItem("token");
  const kind = fileKind(file.mime_type);

  useEffect(() => {
    let revoked = false;
    let nextObjectUrl = "";

    async function loadFile() {
      try {
        const res = await fetch(`${API_BASE_URL}${file.url}`, {
          headers: { Authorization: token }
        });
        if (!res.ok) throw new Error("File unavailable");
        const blob = await res.blob();
        if (revoked) return;
        nextObjectUrl = URL.createObjectURL(blob);
        setObjectUrl(nextObjectUrl);
      } catch (err) {
        setLoadError(err.message);
      }
    }

    loadFile();

    return () => {
      revoked = true;
      if (nextObjectUrl) URL.revokeObjectURL(nextObjectUrl);
    };
  }, [file.url, token]);

  if (loadError) {
    return <div className="attachment-error">{loadError}</div>;
  }

  return (
    <div className="attachment-card">
      {kind === "image" && objectUrl && (
        <img className="attachment-image" src={objectUrl} alt={file.name} />
      )}
      {kind === "video" && objectUrl && (
        <video className="attachment-video" src={objectUrl} controls />
      )}
      <div className="attachment-meta">
        <div>
          <div className="attachment-name">{file.name}</div>
          <div className="attachment-detail">{kind.toUpperCase()} {formatBytes(file.size)}</div>
        </div>
        {objectUrl && (
          <a className="attachment-link" href={objectUrl} download={file.name}>
            Open
          </a>
        )}
      </div>
    </div>
  );
}

function Chat({ user, setUser, keyPassword, setKeyPassword, theme, setTheme }) {
  const [directUsers, setDirectUsers] = useState([]);
  const [groups, setGroups] = useState([]);
  const [activeChat, setActiveChat] = useState(null);
  const [messages, setMessages] = useState([]);
  const [unread, setUnread] = useState({});
  const [typingUser, setTypingUser] = useState("");
  const [message, setMessage] = useState("");
  const [selectedFile, setSelectedFile] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [editingMessage, setEditingMessage] = useState(null);
  const [keyLoadError, setKeyLoadError] = useState(null);
  const [backupVersion, setBackupVersion] = useState(1);
  const [showProfileEdit, setShowProfileEdit] = useState(false);
  const [profileForm, setProfileForm] = useState({ display_name: "", bio: "", avatar: "" });
  const [keys, setKeys] = useState(null);
  const [showSidebar, setShowSidebar] = useState(window.innerWidth <= 768);
  const [showKebabMenu, setShowKebabMenu] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [activeMessage, setActiveMessage] = useState(null);
  const [menuPosition, setMenuPosition] = useState(null);

  const [showCreateGroup, setShowCreateGroup] = useState(false);
  const [showManageMembers, setShowManageMembers] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");
  const [newGroupIcon, setNewGroupIcon] = useState("chat");
  const [newGroupMembers, setNewGroupMembers] = useState([]);
  const [memberToAdd, setMemberToAdd] = useState("");
  const [chatPreviews, setChatPreviews] = useState([]);

  const [searchTerm, setSearchTerm] = useState("");
  const [searchResults, setSearchResults] = useState([]);
  const [isSearching, setIsSearching] = useState(false);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);

  const keysRef = useRef(null);
  const activeChatRef = useRef(null);
  const chatRef = useRef(null);
  const typingTimeoutRef = useRef(null);
  const typingDebounceRef = useRef(null);
  const searchTimeoutRef = useRef(null);
  const fileInputRef = useRef(null);

  const activeGroup = activeChat?.type === "group" ? groups.find(g => g.id === activeChat.id) : null;
  const activeDirectUser = activeChat?.type === "direct"
    ? (directUsers.find(u => u.username === activeChat.id) || { username: activeChat.id, online: false })
    : null;

  useEffect(() => { keysRef.current = keys; }, [keys]);
  useEffect(() => { activeChatRef.current = activeChat; }, [activeChat]);

  useEffect(() => {
    const close = () => setActiveMessage(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, []);

  let pressTimer;
  const openMenu = (e, msg) => {
    e.stopPropagation();
    e.preventDefault();
    const menuWidth = 200;
    const menuHeight = 260;
    let x = e.clientX;
    let y = e.clientY;

    if (x + menuWidth > window.innerWidth) x = window.innerWidth - menuWidth - 10;
    if (y + menuHeight > window.innerHeight) y = window.innerHeight - menuHeight - 10;
    if (x < 10) x = 10;
    if (y < 10) y = 10;

    setActiveMessage(msg);
    setMenuPosition({ x, y });
  };

  const handleContextMenu = (e, msg) => {
    e.preventDefault();
    openMenu(e, msg);
  };

  const handleTouchStart = (e, msg) => {
    const touch = e.touches[0];
    const clientX = touch.clientX;
    const clientY = touch.clientY;
    pressTimer = setTimeout(() => {
      openMenu({ clientX, clientY, stopPropagation: () => { }, preventDefault: () => { } }, msg);
    }, 500);
  };
  const handleTouchEnd = () => clearTimeout(pressTimer);

  useEffect(() => {
    if (chatRef.current) {
      const { scrollTop, scrollHeight, clientHeight } = chatRef.current;
      if (scrollHeight - scrollTop - clientHeight < 150) {
        chatRef.current.scrollTop = chatRef.current.scrollHeight;
      }
    }
  }, [messages]);

  const handleScroll = (e) => {
    const { scrollTop, scrollHeight, clientHeight } = e.target;
    const isFarFromBottom = scrollHeight - scrollTop - clientHeight > 300;
    setShowScrollToBottom(isFarFromBottom);
  };

  const scrollToBottom = () => {
    if (chatRef.current) {
      chatRef.current.scrollTo({ top: chatRef.current.scrollHeight, behavior: 'smooth' });
    }
  };

  useEffect(() => {
    let isMounted = true;

    async function init() {
      try {
        const token = sessionStorage.getItem("token");
        socket.auth = { token };
        if (!socket.connected) socket.connect();

        let keyPair = null;
        const storedPriv = sessionStorage.getItem("privateKey");
        const storedPub = sessionStorage.getItem("publicKey");

        const backupRes = await fetch(`${API_BASE_URL}/get-key`, {
          headers: { Authorization: `Bearer ${token}` }
        });
        const backup = backupRes.ok ? await backupRes.json() : (backupRes.status === 409 ? await backupRes.json() : { error: "no_key" });
        const backupExists = !backup.error;

        if (backup.version) setBackupVersion(backup.version);



        // if (backupExists && keyPassword && !storedPriv) {
        //   try {
        //     const privKey = await decryptKeyBackup(backup.encrypted_private_key, backup.salt, backup.iv, backup.checksum, backup.iterations, keyPassword);
        //     const pubKey = backup.public_key ? await importPublicKeySpkiBase64(backup.public_key) : null;
        //     keyPair = { privateKey: privKey, publicKey: pubKey };
        //     const privB64 = await exportPrivateKeyPkcs8Base64(privKey);
        //     sessionStorage.setItem("privateKey", privB64);
        //     if (backup.public_key) sessionStorage.setItem("publicKey", backup.public_key);
        //   } catch {
        //     setKeyLoadError({
        //       message: "Incorrect password or corrupted backup.",
        //       action: "auth_failed"
        //     });
        //     return;
        //   }
        // }

        if (!keyPair && storedPriv) {
          try {
            keyPair = {
              privateKey: await importPrivateKeyPkcs8Base64(storedPriv),
              publicKey: storedPub
                ? await importPublicKeySpkiBase64(storedPub)
                : null
            };

            // ✅ ADD THIS FIX HERE
            if (!storedPub && backup.public_key) {
              sessionStorage.setItem("publicKey", backup.public_key);
              keyPair.publicKey = await importPublicKeySpkiBase64(backup.public_key);
            }

          } catch {
            sessionStorage.removeItem("privateKey");
            sessionStorage.removeItem("publicKey");

            console.warn("Corrupted session key, falling back to backup...");
          }
        }

        if (!keyPair && backupExists) {
          if (!keyPassword && !storedPriv) {
            setKeyLoadError({
              message: "Please enter your password to unlock messages.",
              action: "auth_required"
            });
            return;
          }

          try {
            const privKey = await decryptKeyBackup(
              backup.encrypted_private_key,
              backup.salt,
              backup.iv,
              backup.checksum,
              backup.iterations,
              keyPassword
            );

            const pubKey = backup.public_key
              ? await importPublicKeySpkiBase64(backup.public_key)
              : null;

            keyPair = { privateKey: privKey, publicKey: pubKey };

            const privB64 = await exportPrivateKeyPkcs8Base64(privKey);
            sessionStorage.setItem("privateKey", privB64);
            if (backup.public_key) {
              sessionStorage.setItem("publicKey", backup.public_key);
            }

            setKeyLoadError(null);

          } catch (err) {
            setKeyLoadError({
              message: "Incorrect password or corrupted backup.",
              action: "auth_failed"
            });
            return;
          }
        }

        if (!keyPair && backup.error === "no_key") {
          const generated = await generateKeys();
          keyPair = { privateKey: generated.privateKey, publicKey: generated.publicKey };
          const privB64 = await exportPrivateKeyPkcs8Base64(keyPair.privateKey);
          const pubB64 = await exportPublicKeySpkiBase64(keyPair.publicKey);
          sessionStorage.setItem("privateKey", privB64);
          sessionStorage.setItem("publicKey", pubB64);

          if (keyPassword) {
            const backupPayload = await encryptKeyBackup(keyPair.privateKey, keyPassword);
            await fetch(`${API_BASE_URL}/save-key`, {
              method: "POST",
              headers: {
                Authorization: token,
                "Content-Type": "application/json"
              },
              body: JSON.stringify({
                ...backupPayload,
                version: 1,
                public_key: pubB64
              })
            });
          }
        }

        if (!isMounted) return;

        setKeyLoadError("");
        setKeys(prevKeys => prevKeys || keyPair);
        socket.emit("user_join");

        socket.emit("get_groups");
      } catch (err) {
        console.error("Key initialization failed:", err);
        setKeyLoadError("Could not initialize encryption keys for this session.");
      }
    }

    init();

    const messageFromPayload = async (data) => {
      const isDeleted = data.deleted_for_everyone || data.status === "deleted";
      if (isDeleted) {
        return {
          id: data.id,
          sender: data.sender,
          content: { kind: "deleted" },
          status: data.status || "sent",
          edited_at: data.edited_at || null,
          deleted_for_everyone: true,
          deleted_by: data.deleted_by,
          edited: Boolean(data.edited),
          reactions: data.reactions || {},
          created_at: data.created_at || new Date().toISOString()
        };
      }

      const currentKeys = keysRef.current;
      if (!currentKeys) return null;
      try {
        const text = await decryptMessage(data, currentKeys.privateKey, user);
        return {
          id: data.id,
          sender: data.sender,
          content: parseContent(text),
          status: data.status || "sent",
          edited_at: data.edited_at || null,
          deleted_for_everyone: false,
          deleted_by: data.deleted_by,
          edited: Boolean(data.edited),
          reactions: data.reactions || {},
          created_at: data.created_at || new Date().toISOString()
        };
      } catch (err) {
        return {
          id: data.id,
          sender: data.sender,
          content: { kind: "text", text: "Encrypted" },
          status: data.status || "sent",
          edited_at: data.edited_at || null,
          deleted_for_everyone: false,
          deleted_by: data.deleted_by,
          edited: Boolean(data.edited),
          reactions: data.reactions || {},
          created_at: data.created_at || new Date().toISOString()
        };
      }
    };

    const handleReceiveMessage = async (data) => {
      const currentActive = activeChatRef.current;
      try {
        const formatted = await messageFromPayload(data);
        if (!formatted) return;

        const isGroup = data.chat_type === "group";
        const targetId = isGroup ? data.chat_id : (data.sender === user ? data.chat_id : data.sender);
        const chatKey = isGroup ? `group:${targetId}` : `direct:${targetId}`;
        const isActive = currentActive && currentActive.type === data.chat_type && currentActive.id === targetId;

        if (isActive) {
          setMessages(prev => {
            const ids = new Set(prev.map(m => m.id));
            if (ids.has(formatted.id)) return prev;
            return [...prev, formatted].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
          });
          if (data.type === "direct" && data.sender !== user) {
            socket.emit("messages_read", { sender: data.sender });
          }
        } else if (data.sender !== user) {
          setUnread(prev => ({ ...prev, [chatKey]: (prev[chatKey] || 0) + 1 }));
          if (data.type === "direct") {
            socket.emit("message_delivered", { id: data.id, sender: data.sender });
          }
        }
        fetchChatPreviews(); // Update previews when message arrives
      } catch (err) {
        console.error("Decrypt failed:", err);
      }
    };

    const handleMessageEdited = async (data) => {
      try {
        const currentKeys = keysRef.current;
        if (!currentKeys) return;
        let nextContent;
        try {
          const text = await decryptMessage(data, currentKeys.privateKey, user);
          nextContent = parseContent(text);
        } catch (err) {
          nextContent = { kind: "text", text: "Encrypted" };
        }
        setMessages(prev => prev.map(m => (
          m.id === data.id ? {
            ...m,
            content: nextContent,
            edited_at: data.edited_at,
            edited: true,
            reactions: data.reactions || m.reactions
          } : m
        )));
        fetchChatPreviews(); // Update preview after edit
      } catch (err) {
        console.error("Edit decrypt failed:", err);
      }
    };

    const handleMessageDeleted = (data) => {
      if (data.mode === "me") {
        setMessages(prev => prev.filter(m => m.id !== data.id));
      } else {
        setMessages(prev => prev.map(m => (
          m.id === data.id ? { ...m, content: { kind: "deleted" }, deleted_for_everyone: true } : m
        )));
      }
      fetchChatPreviews(); // Update preview after deletion
    };

    const handleStatusUpdate = (update) => {
      setMessages(prev => prev.map(m => {
        if (m.sender === user) {
          if (update.read_all && m.status !== "read") {
            return { ...m, status: "read" };
          }
          if (update.id && m.id === update.id) {
            return { ...m, status: update.status };
          }
        }
        return m;
      }));
    };

    const handleMessageReacted = (data) => {
      setMessages(prev => prev.map(m => (
        m.id === data.id ? { ...m, reactions: data.reactions } : m
      )));
    };

    const handleUpdateUsers = (updatedUsers) => setDirectUsers(normalizeUsers(updatedUsers));
    const handleReceiveGroups = (groupsData) => setGroups(groupsData);
    const handleGroupAdded = (data) => socket.emit("join_group_room", data);
    const handleGroupUpdated = () => socket.emit("get_groups");
    const handleGroupRemoved = (data) => {
      socket.emit("leave_group_room", data);
      const currentActive = activeChatRef.current;
      if (currentActive?.type === "group" && currentActive?.id === data.group_id) {
        setActiveChat(null);
      }
    };

    const handleUserTyping = (data) => {
      const currentActive = activeChatRef.current;
      if (!currentActive) return;

      const isGroup = data.chat_type === "group";
      const isMatch = currentActive.type === data.chat_type &&
        (isGroup ? currentActive.id === data.chat_id : currentActive.id === data.sender);

      if (isMatch && data.sender !== user) {
        setTypingUser(`${data.sender} is typing...`);
        clearTimeout(typingTimeoutRef.current);
        typingTimeoutRef.current = setTimeout(() => setTypingUser(""), 1000);
      }
    };

    socket.on("receive_message", handleReceiveMessage);
    socket.on("message_edited", handleMessageEdited);
    socket.on("message_deleted", handleMessageDeleted);
    socket.on("message_reacted", handleMessageReacted);
    socket.on("update_users", handleUpdateUsers);
    socket.on("receive_groups", handleReceiveGroups);
    socket.on("group_added", handleGroupAdded);
    socket.on("group_updated", handleGroupUpdated);
    socket.on("group_removed", handleGroupRemoved);
    socket.on("user_typing", handleUserTyping);
    socket.on("message_status_update", handleStatusUpdate);

    return () => {
      isMounted = false;
      socket.off("receive_message", handleReceiveMessage);
      socket.off("message_edited", handleMessageEdited);
      socket.off("message_deleted", handleMessageDeleted);
      socket.off("message_reacted", handleMessageReacted);
      socket.off("update_users", handleUpdateUsers);
      socket.off("receive_groups", handleReceiveGroups);
      socket.off("group_added", handleGroupAdded);
      socket.off("group_updated", handleGroupUpdated);
      socket.off("group_removed", handleGroupRemoved);
      socket.off("user_typing", handleUserTyping);
      socket.off("message_status_update", handleStatusUpdate);
    };
  }, [user, keyPassword]);

  const fetchPublicKey = async (username) => {
    const token = sessionStorage.getItem("token");
    const res = await fetch(`${API_BASE_URL}/public-key/${username}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!res.ok) throw new Error(`Public key not found for ${username}`);
    const data = await res.json();
    return data.public_key;
  };

  const getReceiverPublicKeys = async () => {
    if (!keys || !activeChat) throw new Error("Chat is not ready");

    const receiverPublicKeys = {};
    if (keys.publicKey) {
      receiverPublicKeys[user] = keys.publicKey;
    } else {
      throw new Error("Missing own public key. Please wait or re-login.");
    }

    if (activeChat.type === "direct") {
      const pubKeyData = await fetchPublicKey(activeChat.id);
      console.log(`Public key (raw) for ${activeChat.id}:`, pubKeyData);
      console.log(`Key length for ${activeChat.id}:`, pubKeyData?.length);
      if (!pubKeyData) {
        alert(`${activeChat.id} has not set up encryption keys yet.`);
        throw new Error("Receiver missing public key");
      }
      receiverPublicKeys[activeChat.id] = await importPublicKeySpkiBase64(pubKeyData);
      return receiverPublicKeys;
    }

    const group = groups.find(g => g.id === activeChat.id);
    if (!group) throw new Error("Group not found");

    for (const member of group.members) {
      if (member.username !== user) {
        try {
          const pubKeyData = await fetchPublicKey(member.username);
          if (!pubKeyData) {
            console.warn(`Member ${member.username} has no public key. Skipping.`);
            continue;
          }
          receiverPublicKeys[member.username] = await importPublicKeySpkiBase64(pubKeyData);
        } catch (err) {
          console.warn(`Missing public key for ${member.username}. Skipping.`, err);
        }
      }
    }

    return receiverPublicKeys;
  };

  const encryptForActiveChat = async (plainText) => {
    const receiverPublicKeys = await getReceiverPublicKeys();
    return encryptMessage(plainText, receiverPublicKeys);
  };

  const fetchConversation = async (chatType, chatId) => {
    const token = sessionStorage.getItem("token");
    try {
      const endpoint = chatType === "group" ? `/messages/group/${chatId}` : `/messages/user/${chatId}`;
      const res = await fetch(`${API_BASE_URL}${endpoint}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const history = await res.json();

      if (history.error) throw new Error(history.error);       const formattedHistory = await Promise.all(history.map(async msg => {
        const sender = msg[0];
        const id = msg[6];
        const status = msg[7] || "sent";
        const edited_at = msg[8] || null;
        const deleted_for_everyone = Boolean(msg[9]);
        const deleted_by = msg[10];
        const edited = Boolean(msg[11]);
        const reactions = msg[12] ? JSON.parse(msg[12]) : {};
        const created_at = msg[5];

        if (deleted_for_everyone) {
          return { id, sender, content: { kind: "deleted" }, status, edited_at, deleted_for_everyone, deleted_by, edited, reactions, created_at };
        }

        try {
          const data = {
            message: JSON.parse(msg[2]),
            key: JSON.parse(msg[3]),
            iv: JSON.parse(msg[4])
          };
          const text = await decryptMessage(data, keys.privateKey, user);
          return { id, sender, content: parseContent(text), status, edited_at, deleted_for_everyone, deleted_by, edited, reactions, created_at };
        } catch {
          return { id, sender, content: { kind: "text", text: "Encrypted" }, status, edited_at, deleted_for_everyone, deleted_by, edited, reactions, created_at };
        }
      }));
      
      setMessages(prev => {
        const ids = new Set(prev.map(m => m.id));
        const incoming = formattedHistory;
        return [...prev, ...incoming.filter(m => !ids.has(m.id))].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
      });
    } catch (err) {
      console.error("Error fetching history:", err);
      setMessages([{ sender: "System", content: { kind: "text", text: "Failed to load messages." } }]);
    }
  };

  const handleChatClick = (type, id) => {
    setActiveChat({ type, id });
    setEditingMessage(null);
    setMessage("");
    setSelectedFile(null);
    setShowSidebar(false);
    fetchConversation(type, id);
    if (type === "direct" && unread[`direct:${id}`]) {
      socket.emit("messages_read", { sender: id });
    }
    setUnread(prev => {
      const nextUnread = { ...prev };
      delete nextUnread[`${type}:${id}`];
      return nextUnread;
    });
  };

  const createGroup = () => {
    if (!newGroupName.trim()) return;
    socket.emit("create_group", {
      name: newGroupName,
      icon: newGroupIcon,
      members: newGroupMembers
    });
    setShowCreateGroup(false);
    setNewGroupName("");
    setNewGroupMembers([]);
  };

  const uploadFile = async (file) => {
    const token = sessionStorage.getItem("token");
    const formData = new FormData();
    formData.append("file", file);

    const res = await fetch(`${API_BASE_URL}/upload`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: formData
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Upload failed");
    return data;
  };

  const sendMessageHandler = async (e) => {
    e.preventDefault();
    if ((!message.trim() && !selectedFile) || !keys || !activeChat) return;

    try {
      setUploading(Boolean(selectedFile));

      if (editingMessage) {
        const encrypted = await encryptForActiveChat(message.trim());
        socket.emit("edit_message", { id: editingMessage.id, ...encrypted });
        setEditingMessage(null);
        setMessage("");
        return;
      }

      let contentText = message.trim();
      if (selectedFile) {
        const uploaded = await uploadFile(selectedFile);
        contentText = JSON.stringify({
          kind: "attachment",
          caption: message.trim(),
          file: uploaded
        });
      }

      const encrypted = await encryptForActiveChat(contentText);
      const payload = { type: activeChat.type, ...encrypted };

      if (activeChat.type === "direct") payload.receiver_user = activeChat.id;
      else payload.group_id = activeChat.id;

      socket.emit("send_message", payload);
      setMessage("");
      setSelectedFile(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
    } catch (err) {
      console.error("Failed to send message:", err);
      alert("Failed to send message: " + err.message);
    } finally {
      setUploading(false);
    }
  };

  const handleTyping = (e) => {
    setMessage(e.target.value);
    if (activeChat && !editingMessage && !typingDebounceRef.current) {
      const payload = { type: activeChat.type };
      if (activeChat.type === "direct") payload.receiver_user = activeChat.id;
      else payload.group_id = activeChat.id;
      
      socket.emit("typing", payload);
      
      typingDebounceRef.current = setTimeout(() => {
        typingDebounceRef.current = null;
      }, 500);
    }
  };

  const startEditing = (msg) => {
    if (msg.content.kind !== "text") return;
    setEditingMessage(msg);
    setMessage(msg.content.text);
    setSelectedFile(null);
  };

  const cancelEditing = () => {
    setEditingMessage(null);
    setMessage("");
  };

  const deleteMessage = (msg, mode) => {
    socket.emit("delete_message", { id: msg.id, mode });
  };

  const handleReact = (msgId, emoji) => {
    // Optimistic Update
    setMessages(prev => prev.map(m => {
      if (m.id !== msgId) return m;
      const reactions = { ...m.reactions };
      const entry = { ...(reactions[emoji] || { count: 0, users: [] }) };
      const users = [...entry.users];

      if (users.includes(user)) {
        const idx = users.indexOf(user);
        users.splice(idx, 1);
      } else {
        users.push(user);
      }

      if (users.length > 0) {
        reactions[emoji] = { count: users.length, users };
      } else {
        delete reactions[emoji];
      }
      return { ...m, reactions };
    }));

    socket.emit("react_message", { id: msgId, emoji });
  };

  const handleLogout = () => {
    sessionStorage.removeItem("privateKey");
    sessionStorage.removeItem("publicKey");
    sessionStorage.removeItem("token");
    sessionStorage.removeItem("username");
    setKeyPassword("");
    setUser(null);
    socket.disconnect();
  };

  const handleOpenProfile = () => {
    const me = directUsers.find(u => u.username === user);
    if (me) {
      setProfileForm({ display_name: me.display_name || "", bio: me.bio || "", avatar: me.avatar || "" });
    }
    setShowProfileEdit(true);
  };

  const handleResetKeys = async () => {
    if (!window.confirm("This will permanently prevent you from reading existing messages. Continue?")) return;
    const token = sessionStorage.getItem("token");
    const generated = await generateKeys();
    const privB64 = await exportPrivateKeyPkcs8Base64(generated.privateKey);
    const pubB64 = await exportPublicKeySpkiBase64(generated.publicKey);
    sessionStorage.setItem("privateKey", privB64);
    sessionStorage.setItem("publicKey", pubB64);

    if (keyPassword) {
      const backupPayload = await encryptKeyBackup(generated.privateKey, keyPassword);
      await fetch(`${API_BASE_URL}/save-key`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ ...backupPayload, version: backupVersion + 1, public_key: pubB64 })
      });
    }

    window.location.reload();
  };

  const fetchChatPreviews = async () => {
    const token = sessionStorage.getItem("token");
    if (!token) return;
    try {
      const res = await fetch(`${API_BASE_URL}/chat-list`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) {
        const data = await res.json();
        setChatPreviews(data);
      }
    } catch (err) {
      console.error("Failed to fetch chat previews:", err);
    }
  };

  useEffect(() => {
    if (user) fetchChatPreviews();
  }, [user]);

  const handleSearch = (val) => {
    setSearchTerm(val);
    clearTimeout(searchTimeoutRef.current);

    if (!val.trim() || val.length <= 1) {
      setSearchResults([]);
      setIsSearching(false);
      return;
    }

    searchTimeoutRef.current = setTimeout(async () => {
      setIsSearching(true);
      try {
        const token = sessionStorage.getItem("token");
        const res = await fetch(`${API_BASE_URL}/search-users?q=${encodeURIComponent(val.trim())}`, {
          headers: { Authorization: `Bearer ${token}` }
        });
        const data = await res.json();
        console.log("Search API response:", data);

        if (res.ok && Array.isArray(data)) {
          setSearchResults(data);
        } else {
          console.error("Search error or unexpected format:", data);
          setSearchResults([]);
        }
      } catch (err) {
        console.error("Search failed:", err);
        setSearchResults([]);
      } finally {
        setIsSearching(false);
      }
    }, 300);
  };

  const clearSearch = () => {
    setSearchTerm("");
    setSearchResults([]);
    setIsSearching(false);
  };

  const getInitials = (name) => {
    return name?.charAt(0).toUpperCase() || "?";
  };

  const renderAvatar = (userObj) => {
    if (userObj.avatar && userObj.avatar.length > 2) { // URL or Base64
      if (userObj.avatar.startsWith("http") || userObj.avatar.startsWith("data:")) {
        return <img src={userObj.avatar} alt="avatar" className="avatar-img" />;
      }
    }
    // Fallback to emoji or initials
    return <span className="avatar-fallback">{userObj.avatar || getInitials(userObj.display_name || userObj.username)}</span>;
  };

  const renderStatus = (status) => {
    if (status === "sent") return "✔";
    if (status === "delivered") return "✔✔";
    if (status === "read") return <span style={{ color: "#3b82f6" }}>✔✔</span>;
    return "✔";
  };

  const renderMessageContent = (msg) => {
    if (msg.content.kind === "deleted") {
      const deletedByText = msg.deleted_by ? ` (by ${msg.deleted_by})` : "";
      return <span className="deleted-message">This message was deleted{deletedByText}.</span>;
    }

    if (msg.content.kind === "attachment") {
      return (
        <>
          <AttachmentPreview file={msg.content.file} />
          {msg.content.caption && <div className="message-text">{msg.content.caption}</div>}
        </>
      );
    }

    return <span className="message-text">{msg.content.text}</span>;
  };

  return (
    <div className={`app-container ${activeChat ? "chat-active" : ""}`}>
      <div className={`sidebar ${showSidebar ? "active" : ""}`}>
        <div className="sidebar-header">
          <h3>SecureChat <span>@{user}</span></h3>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            {activeChat && <button className="sidebar-close" onClick={() => setShowSidebar(false)} aria-label="Close sidebar">✕</button>}
            <button className="create-group-btn" onClick={() => setShowCreateGroup(true)} aria-label="Create group">+</button>

            <div className="kebab-menu">
              <button className="kebab-btn" onClick={() => setShowKebabMenu(!showKebabMenu)}>⋮</button>
              {showKebabMenu && (
                <div className="dropdown-menu">
                  <button className="dropdown-item" onClick={() => { setShowSettings(true); setShowKebabMenu(false); }}>Settings</button>
                  <button className="dropdown-item" onClick={() => { handleOpenProfile(); setShowKebabMenu(false); }}>Profile</button>
                  <button className="dropdown-item" onClick={handleLogout}>Logout</button>
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="sidebar-search">
          <input
            type="text"
            placeholder="Search users..."
            value={searchTerm}
            onChange={(e) => handleSearch(e.target.value)}
          />
        </div>

        {searchTerm.length >= 2 && (
          <div className="sidebar-section">
            <div className="search-results-label">
              <h4>SEARCH RESULTS</h4>
              <button onClick={clearSearch}>Clear</button>
            </div>
            <div className="users-list">
              {isSearching ? (
                <div style={{ padding: '10px', fontSize: '13px', color: 'var(--text-muted)' }}>Searching...</div>
              ) : searchResults.length === 0 ? (
                <div style={{ padding: '10px', fontSize: '13px', color: 'var(--text-muted)' }}>No users found</div>
              ) : (
                searchResults.map(resultUsername => (
                  <button
                    type="button"
                    className={`user-item ${activeChat?.type === "direct" && activeChat.id === resultUsername ? "active" : ""}`}
                    key={resultUsername}
                    onClick={() => {
                      handleChatClick("direct", resultUsername);
                      clearSearch();
                    }}
                  >
                    <div className="avatar-circle">{getInitials(resultUsername)}</div>
                    <span className="user-copy" style={{ marginLeft: '10px' }}>
                      <span>{resultUsername}</span>
                      <small>New contact</small>
                    </span>
                  </button>
                ))
              )}
            </div>
          </div>
        )}

        {searchTerm.length < 2 && (
          <>
            <div className="sidebar-section">
              <h4>DIRECT MESSAGES</h4>
              <div className="users-list">
                {directUsers.map(u => {
                  const unreadKey = `direct:${u.username}`;
                  const preview = chatPreviews.find(p => p.username === u.username);
                  return (
                    <button
                      type="button"
                      className={`user-item ${activeChat?.type === "direct" && activeChat.id === u.username ? "active" : ""}`}
                      key={u.username}
                      onClick={() => handleChatClick("direct", u.username)}
                    >
                      <div style={{ position: 'relative' }}>
                        <div className="avatar-circle">{renderAvatar(u)}</div>
                        <span className={`status-indicator ${u.online ? "online" : "offline"}`} style={{ position: 'absolute', bottom: -2, right: -2 }}></span>
                      </div>
                      <span className="user-copy" style={{ marginLeft: '10px' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                          <span style={{ fontWeight: 600 }}>{u.display_name || u.username} {u.username === user && "(You)"}</span>
                          {preview && <small style={{ fontSize: '10px', opacity: 0.6 }}>{formatMessageTime(preview.time)}</small>}
                        </div>
                        <small style={{ opacity: 0.8, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '180px' }}>
                          {preview ? (
                            <>
                              {preview.sender === user ? "You: " : ""}
                              {preview.last_message}
                            </>
                          ) : (u.bio ? u.bio : (u.online ? "Online" : formatLastSeen(u.last_seen)))}
                        </small>
                      </span>
                      {unread[unreadKey] > 0 && <span className="unread-badge">{unread[unreadKey]}</span>}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="sidebar-section">
              <h4>GROUPS</h4>
              <div className="users-list">
                {groups.map(g => {
                  const unreadKey = `group:${g.id}`;
                  return (
                    <button
                      type="button"
                      className={`user-item ${activeChat?.type === "group" && activeChat.id === g.id ? "active" : ""}`}
                      key={g.id}
                      onClick={() => handleChatClick("group", g.id)}
                    >
                      <span className="group-icon">{g.icon}</span>
                      <span className="user-copy">
                        <span>{g.name}</span>
                        <small>{g.members.length} members</small>
                      </span>
                      {unread[unreadKey] > 0 && <span className="unread-badge">{unread[unreadKey]}</span>}
                    </button>
                  );
                })}
              </div>
            </div>
          </>
        )}

      </div>

      <div className="chat-area">
        <button className="sidebar-toggle" onClick={() => {
          if (activeChat && window.innerWidth <= 768) {
            setActiveChat(null);
          } else {
            setShowSidebar(!showSidebar);
          }
        }} aria-label="Toggle sidebar">
          {(activeChat && window.innerWidth <= 768) ? "←" : "☰"}
        </button>
        {keyLoadError && (
          <div className="key-error">
            <p>{keyLoadError.message}</p>
            <div style={{ marginTop: '10px', display: 'flex', gap: '10px' }}>
              <button onClick={handleLogout} className="secondary-btn">Retry / Logout</button>
              <button onClick={handleResetKeys} style={{ backgroundColor: '#dc3545', color: 'white', border: 'none', borderRadius: '4px', padding: '8px 16px', cursor: 'pointer' }}>Reset Keys (Wipes old history)</button>
            </div>
          </div>
        )}
        {!activeChat ? (
          <div className="no-chat-selected">
            <h2>Select a conversation to start messaging</h2>
            <p style={{ color: 'var(--text-muted)', fontSize: '13px' }}>Your messages are end-to-end encrypted</p>
          </div>
        ) : (
          <>
            <div className="chat-header mobile-header-spacing">
              <div style={{ display: 'flex', alignItems: 'center' }}>
                {activeChat.type === "direct" && activeDirectUser && (
                  <div className="avatar-circle" style={{ marginRight: '10px', width: '32px', height: '32px' }}>{renderAvatar(activeDirectUser)}</div>
                )}
                <div>
                  <h3>
                    {activeChat.type === "group" ? `${activeGroup?.icon} ${activeGroup?.name}` : `${activeDirectUser?.display_name || activeChat.id}`}
                  </h3>
                  <span className="chat-subtitle">
                    {activeChat.type === "group"
                      ? `${activeGroup?.members.length || 0} members`
                      : activeDirectUser?.online ? "Online" : formatLastSeen(activeDirectUser?.last_seen)}
                  </span>
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                {activeChat.type === "group" && (
                  <button className="secondary-btn" onClick={() => setShowManageMembers(true)}>Manage Members</button>
                )}
              </div>
            </div>

            <div className="messages-container" ref={chatRef} onScroll={handleScroll}>
              {messages.map((m, i) => {
                const isMine = m.sender === user;
                return (
                  <div key={m.id || i} className={`message-row ${isMine ? "mine" : "others"}`}>
                    <div
                      className={`message-bubble ${isMine ? "mine" : "others"}`}
                      onContextMenu={(e) => handleContextMenu(e, m)}
                      onTouchStart={(e) => {
                        e.preventDefault();
                        handleTouchStart(e, m);
                      }}
                      onTouchEnd={handleTouchEnd}
                    >
                      {!isMine && activeChat?.type === "group" && <div className="message-sender">{m.sender}</div>}
                      {!m.deleted_for_everyone && (
                        <div className="dropdown-arrow" onClick={(e) => openMenu(e, m)}>⌄</div>
                      )}
                      <div className="message-content-wrapper">
                        {renderMessageContent(m)}
                        <div className="message-meta-inline">
                          <span className="message-time">{formatMessageTime(m.created_at)}</span>
                          {isMine && activeChat?.type === "direct" && !m.deleted_for_everyone ? (
                            <span className="message-status-ticks">{renderStatus(m.status)}</span>
                          ) : null}
                        </div>
                      </div>
                      {m.reactions && Object.keys(m.reactions).length > 0 && (
                        <div className="message-reactions">
                          {Object.entries(m.reactions).map(([emoji, entry]) => {
                            const count = entry?.count || (Array.isArray(entry) ? entry.length : 0);
                            const users = entry?.users || (Array.isArray(entry) ? entry : []);
                            return count > 0 && (
                              <span key={emoji} className="reaction-badge reaction-pop" title={users.join(", ")}>
                                {emoji} {count}
                              </span>
                            );
                          })}
                        </div>
                      )}
                      {m.edited && !m.deleted_for_everyone && (
                        <div className="message-edited-tag">Edited</div>
                      )}
                    </div>
                  </div>
                );
              })}
              {showScrollToBottom && (
                <button className="scroll-to-bottom" onClick={scrollToBottom} aria-label="Scroll to bottom">
                  ↓
                </button>
              )}
            </div>

            {typingUser && <div className="typing-indicator">{typingUser}</div>}

            {selectedFile && (
              <div className="selected-file">
                <span>{selectedFile.name} ({formatBytes(selectedFile.size)})</span>
                <button type="button" onClick={() => {
                  setSelectedFile(null);
                  if (fileInputRef.current) fileInputRef.current.value = "";
                }}>Remove</button>
              </div>
            )}

            {editingMessage && (
              <div className="edit-banner">
                <span>Editing message</span>
                <button type="button" onClick={cancelEditing}>Cancel</button>
              </div>
            )}

            <form className="input-area" onSubmit={sendMessageHandler}>
              <input
                ref={fileInputRef}
                className="file-input"
                type="file"
                accept="image/*,video/*,.pdf,.doc,.docx,.txt,.rtf"
                onChange={e => setSelectedFile(e.target.files?.[0] || null)}
                disabled={Boolean(editingMessage)}
              />
              <button type="button" className="attach-btn" onClick={() => fileInputRef.current?.click()} disabled={Boolean(editingMessage)} title="Attach file">
                📎
              </button>
              <input
                value={message}
                onChange={handleTyping}
                placeholder={editingMessage ? "Edit sent text..." : selectedFile ? "Add a caption..." : "Type a secure message..."}
              />
              <button type="submit" disabled={uploading}>
                {uploading ? "Sending..." : editingMessage ? "Save" : "Send"}
              </button>
            </form>
          </>
        )}
      </div>

      {showCreateGroup && (
        <div className="modal-overlay">
          <div className="modal">
            <h2>Create Group</h2>
            <div className="form-group">
              <label>Icon</label>
              <input value={newGroupIcon} onChange={e => setNewGroupIcon(e.target.value)} maxLength={12} />
            </div>
            <div className="form-group">
              <label>Group Name</label>
              <input value={newGroupName} onChange={e => setNewGroupName(e.target.value)} placeholder="e.g. Project Team" />
            </div>
            <div className="form-group">
              <label>Select Members</label>
              <div className="members-select-list">
                {directUsers.filter(u => u.username !== user).map(u => (
                  <label key={u.username} className="member-checkbox">
                    <input
                      type="checkbox"
                      checked={newGroupMembers.includes(u.username)}
                      onChange={(e) => {
                        if (e.target.checked) setNewGroupMembers(prev => [...prev, u.username]);
                        else setNewGroupMembers(prev => prev.filter(m => m !== u.username));
                      }}
                    />
                    {u.username}
                  </label>
                ))}
              </div>
            </div>
            <div className="modal-actions">
              <button className="secondary-btn" onClick={() => setShowCreateGroup(false)}>Cancel</button>
              <button onClick={createGroup}>Create</button>
            </div>
          </div>
        </div>
      )}

      {showProfileEdit && (
        <div className="modal-overlay">
          <div className="modal">
            <h2>Edit Profile</h2>
            <div className="form-group">
              <label>Display Name</label>
              <input value={profileForm.display_name} onChange={e => setProfileForm(p => ({ ...p, display_name: e.target.value }))} placeholder="E.g. Rahul" />
            </div>
            <div className="form-group">
              <label>Bio</label>
              <input value={profileForm.bio} onChange={e => setProfileForm(p => ({ ...p, bio: e.target.value }))} placeholder="E.g. Busy coding 🚀" />
            </div>
            <div className="form-group">
              <label>Avatar (Emoji or URL)</label>
              <input value={profileForm.avatar} onChange={e => setProfileForm(p => ({ ...p, avatar: e.target.value }))} placeholder="🚀 or https://..." />
            </div>
            <div className="modal-actions">
              <button className="secondary-btn" onClick={() => setShowProfileEdit(false)}>Cancel</button>
              <button onClick={async () => {
                const token = sessionStorage.getItem("token");
                await fetch(`${API_BASE_URL}/profile`, {
                  method: "POST",
                  headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
                  body: JSON.stringify(profileForm)
                });
                setShowProfileEdit(false);
              }}>Save</button>
            </div>
          </div>
        </div>
      )}

      {showManageMembers && activeGroup && (
        <div className="modal-overlay">
          <div className="modal">
            <h2>Manage Members</h2>
            <div className="members-select-list member-list">
              {activeGroup.members.map(m => (
                <div key={m.username} className="member-row">
                  <span>{m.username} {m.role === "owner" ? "(Owner)" : ""}</span>
                  {(activeGroup.members.find(x => x.username === user)?.role === "owner" && m.username !== user) && (
                    <button
                      className="secondary-btn compact"
                      onClick={() => socket.emit("remove_member", { group_id: activeGroup.id, username: m.username })}
                    >Remove</button>
                  )}
                </div>
              ))}
            </div>

            {activeGroup.members.find(x => x.username === user)?.role === "owner" && (
              <div className="form-group add-member-row">
                <select value={memberToAdd} onChange={e => setMemberToAdd(e.target.value)}>
                  <option value="">Select user to add...</option>
                  {directUsers
                    .filter(u => !activeGroup.members.some(m => m.username === u.username))
                    .map(u => <option key={u.username} value={u.username}>{u.username}</option>)}
                </select>
                <button onClick={() => {
                  if (memberToAdd) {
                    socket.emit("add_member", { group_id: activeGroup.id, username: memberToAdd });
                    setMemberToAdd("");
                  }
                }}>Add</button>
              </div>
            )}

            <div className="modal-actions">
              <button onClick={() => setShowManageMembers(false)}>Close</button>
            </div>
          </div>
        </div>
      )}

      {showSettings && (
        <div className="modal-overlay">
          <div className="modal">
            <h2>Settings</h2>
            <div className="settings-option">
              <label>Appearance</label>
              <div className="theme-options">
                <button className={`theme-btn ${theme === 'light' ? 'active' : ''}`} onClick={() => setTheme('light')}>Light</button>
                <button className={`theme-btn ${theme === 'dark' ? 'active' : ''}`} onClick={() => setTheme('dark')}>Dark</button>
                <button className={`theme-btn ${theme === 'system' ? 'active' : ''}`} onClick={() => setTheme('system')}>System Default</button>
              </div>
            </div>
            <div className="modal-actions">
              <button onClick={() => setShowSettings(false)}>Close</button>
            </div>
          </div>
        </div>
      )}
      {activeMessage && menuPosition && (
        <div
          className="floating-context-menu"
          style={{
            position: "fixed",
            top: menuPosition.y,
            left: menuPosition.x,
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {!activeMessage.deleted_for_everyone && (
            <div className="menu-reaction-bar">
              {["👍", "❤️", "😂", "😮", "😢", "🔥"].map(emoji => (
                <button key={emoji} onClick={() => { handleReact(activeMessage.id, emoji); setActiveMessage(null); }}>{emoji}</button>
              ))}
            </div>
          )}
          {activeMessage.sender === user && !activeMessage.deleted_for_everyone && (
            <>
              <div className="menu-item" onClick={() => { startEditing(activeMessage); setActiveMessage(null); }}>Edit</div>
              <div className="menu-item delete-all" onClick={() => {
                if (window.confirm("Are you sure you want to delete this message for everyone?")) {
                  deleteMessage(activeMessage, "everyone");
                }
                setActiveMessage(null);
              }}>Delete for everyone</div>
            </>
          )}
          <div className="menu-item" onClick={() => { deleteMessage(activeMessage, "me"); setActiveMessage(null); }}>Delete for me</div>
        </div>
      )}
    </div>
  );
}

export default Chat;
