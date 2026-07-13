import { describe, expect, it } from "vitest";
import { createCredentialVault } from "./credentialVault.js";

describe("credential vault", () => {
  it("encrypts and decrypts a Jira credential without plaintext leakage", () => {
    const vault = createCredentialVault(Buffer.alloc(32, 7).toString("base64"));
    const ciphertext = vault.encrypt({
      username: "jira-user",
      password: "jira-password",
      redirect_username: "sso-user",
      redirect_password: "sso-password",
    });

    expect(ciphertext).toMatch(/^aes-256-gcm:v1\./);
    expect(ciphertext).not.toContain("jira-user");
    expect(ciphertext).not.toContain("jira-password");
    expect(vault.decrypt(ciphertext)).toEqual({
      username: "jira-user",
      password: "jira-password",
      redirect_username: "sso-user",
      redirect_password: "sso-password",
    });
  });

  it("rejects invalid keys and tampered ciphertext", () => {
    expect(() => createCredentialVault("too-short")).toThrow(/32-byte/);
    const vault = createCredentialVault(Buffer.alloc(32, 9).toString("base64"));
    const ciphertext = vault.encrypt({ username: "user", password: "password" });
    expect(() => vault.decrypt(`${ciphertext}x`)).toThrow("credential decryption failed");
  });
});
