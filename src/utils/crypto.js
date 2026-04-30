export function toBase64(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}

export function fromBase64(b64) {
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}

export async function generateKeys() {
  return await crypto.subtle.generateKey(
    {
      name: "RSA-OAEP",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1,0,1]),
      hash: "SHA-256"
    },
    true,
    ["encrypt","decrypt"]
  );
}

export async function exportPublicKey(key) {
  const exported = await crypto.subtle.exportKey("spki", key);
  return Array.from(new Uint8Array(exported));
}

export async function deriveKey(password, salt, iterations = 400000) {
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(password),
    "PBKDF2",
    false,
    ["deriveKey"]
  );

  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt,
      iterations,
      hash: "SHA-256"
    },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

export async function exportPrivateKeyPkcs8Base64(privateKey) {
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", privateKey);
  return toBase64(pkcs8);
}

export async function importPrivateKeyPkcs8Base64(base64) {
  const pkcs8 = fromBase64(base64);
  return await crypto.subtle.importKey(
    "pkcs8",
    pkcs8,
    { name: "RSA-OAEP", hash: "SHA-256" },
    true,
    ["decrypt"]
  );
}

export async function exportPublicKeySpkiBase64(publicKey) {
  const spki = await crypto.subtle.exportKey("spki", publicKey);
  return toBase64(spki);
}

export async function importPublicKeySpkiBase64(base64) {
  const spki = fromBase64(base64);
  return await crypto.subtle.importKey(
    "spki",
    spki,
    { name: "RSA-OAEP", hash: "SHA-256" },
    true,
    ["encrypt"]
  );
}

export async function encryptKeyBackup(privateKey, password) {
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", privateKey);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aesKey = await deriveKey(password, salt);
  
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    aesKey,
    pkcs8
  );

  const digest = await crypto.subtle.digest("SHA-256", encrypted);

  return {
    encrypted_private_key: toBase64(encrypted),
    salt: toBase64(salt),
    iv: toBase64(iv),
    checksum: toBase64(digest),
    iterations: 400000
  };
}

export async function decryptKeyBackup(encryptedBase64, saltBase64, ivBase64, checksumBase64, iterations, password) {
  const encrypted = fromBase64(encryptedBase64);
  const salt = fromBase64(saltBase64);
  const iv = fromBase64(ivBase64);
  
  if (checksumBase64) {
    const digest = await crypto.subtle.digest("SHA-256", encrypted);
    if (toBase64(digest) !== checksumBase64) {
      throw new Error("Checksum mismatch: backup is corrupted");
    }
  }
  
  const aesKey = await deriveKey(password, salt, iterations);
  
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    aesKey,
    encrypted
  );

  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    decrypted,
    { name: "RSA-OAEP", hash: "SHA-256" },
    true,
    ["decrypt"]
  );

  return privateKey;
}

export async function encryptMessage(message, receiverPublicKeys) {
  const aesKey = await crypto.subtle.generateKey(
    { name:"AES-GCM", length:256 },
    true,
    ["encrypt","decrypt"]
  );

  const iv = crypto.getRandomValues(new Uint8Array(12));

  const encryptedData = await crypto.subtle.encrypt(
    { name:"AES-GCM", iv },
    aesKey,
    new TextEncoder().encode(message)
  );

  const rawKey = await crypto.subtle.exportKey("raw", aesKey);

  const encryptedKeys = {};
  for (const [username, pubKey] of Object.entries(receiverPublicKeys)) {
    const encKey = await crypto.subtle.encrypt(
      { name:"RSA-OAEP" },
      pubKey,
      rawKey
    );
    encryptedKeys[username] = Array.from(new Uint8Array(encKey));
  }

  return {
    message: Array.from(new Uint8Array(encryptedData)),
    key: encryptedKeys,
    iv: Array.from(iv)
  };
}

export async function decryptMessage(data, privateKey, currentUser) {
  let actualKey = data.key;
  if (data.key && !Array.isArray(data.key) && typeof data.key === 'object') {
    actualKey = data.key[currentUser];
  }

  if (!actualKey) {
    throw new Error("No AES key found for this user");
  }

  const aesKeyRaw = await crypto.subtle.decrypt(
    { name:"RSA-OAEP" },
    privateKey,
    new Uint8Array(actualKey)
  );

  const aesKey = await crypto.subtle.importKey(
    "raw",
    aesKeyRaw,
    { name:"AES-GCM" },
    false,
    ["decrypt"]
  );

  const decrypted = await crypto.subtle.decrypt(
    { name:"AES-GCM", iv:new Uint8Array(data.iv) },
    aesKey,
    new Uint8Array(data.message)
  );

  return new TextDecoder().decode(decrypted);
}
