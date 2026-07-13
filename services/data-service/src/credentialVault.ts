import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";

const VERSION = "aes-256-gcm:v1";

export interface UserCredentialPayload {
  username: string;
  password: string;
  redirect_username?: string;
  redirect_password?: string;
}

export interface CredentialVault {
  encrypt(payload: UserCredentialPayload): string;
  decrypt(ciphertext: string): UserCredentialPayload;
}

export function createCredentialVault(masterKey: string): CredentialVault {
  const key = decodeMasterKey(masterKey);
  return {
    encrypt(payload) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const plaintext = Buffer.from(JSON.stringify(validatePayload(payload)), "utf8");
      const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const authTag = cipher.getAuthTag();
      return [
        VERSION,
        iv.toString("base64url"),
        authTag.toString("base64url"),
        encrypted.toString("base64url"),
      ].join(".");
    },
    decrypt(ciphertext) {
      const [version, ivValue, tagValue, encryptedValue, ...extra] = ciphertext.split(".");
      if (
        version !== VERSION
        || !ivValue
        || !tagValue
        || !encryptedValue
        || extra.length > 0
      ) {
        throw new Error("unsupported credential ciphertext");
      }
      try {
        const decipher = createDecipheriv(
          "aes-256-gcm",
          key,
          Buffer.from(ivValue, "base64url"),
        );
        decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
        const plaintext = Buffer.concat([
          decipher.update(Buffer.from(encryptedValue, "base64url")),
          decipher.final(),
        ]).toString("utf8");
        return validatePayload(JSON.parse(plaintext));
      } catch {
        throw new Error("credential decryption failed");
      }
    },
  };
}

function decodeMasterKey(value: string): Buffer {
  const trimmed = value.trim();
  const key = /^[0-9a-f]{64}$/i.test(trimmed)
    ? Buffer.from(trimmed, "hex")
    : Buffer.from(trimmed, "base64");
  if (key.length !== 32) {
    throw new Error(
      "USER_CREDENTIALS_MASTER_KEY must be a 32-byte base64 or 64-character hex value",
    );
  }
  return key;
}

function validatePayload(value: unknown): UserCredentialPayload {
  if (!value || typeof value !== "object") {
    throw new Error("invalid credential payload");
  }
  const record = value as Record<string, unknown>;
  const username = requiredSecret(record.username, "username");
  const password = requiredSecret(record.password, "password");
  const redirectUsername = optionalSecret(record.redirect_username);
  const redirectPassword = optionalSecret(record.redirect_password);
  if (Boolean(redirectUsername) !== Boolean(redirectPassword)) {
    throw new Error("redirect username and password must be provided together");
  }
  return {
    username,
    password,
    ...(redirectUsername ? { redirect_username: redirectUsername } : {}),
    ...(redirectPassword ? { redirect_password: redirectPassword } : {}),
  };
}

function requiredSecret(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} is required`);
  }
  return value;
}

function optionalSecret(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}
