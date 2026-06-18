import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type AdminStatus = "unclaimed" | "initializing" | "ready";

export type ClaimState = {
  code_hash: string;
  created_at: string;
  expires_at: string;
  used_at: string | null;
};

export type PendingTransfer = {
  to_user_id: string;
  created_at: string;
  expires_at: string;
};

export type AdminState = {
  admin_user_id: string | null;
  status: AdminStatus;
  claim: ClaimState | null;
  pending_transfer: PendingTransfer | null;
  initialized_at: string | null;
};

export function hashClaimCode(code: string): string {
  return `sha256:${crypto.createHash("sha256").update(code, "utf8").digest("hex")}`;
}

export function generateClaimCode(): string {
  return crypto.randomBytes(18).toString("base64url");
}

export class AdminStore {
  private filePath: string;

  constructor(private privateDir: string) {
    this.filePath = path.join(privateDir, "admin.json");
  }

  read(): AdminState {
    if (!fs.existsSync(this.filePath)) return defaultState();
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      return validateAdminState(parsed, this.filePath);
    } catch (error) {
      if (error instanceof SyntaxError || error instanceof AdminStateValidationError) {
        throw new Error(`Invalid admin state file: ${this.filePath}`);
      }
      throw error;
    }
  }

  write(state: AdminState): void {
    fs.mkdirSync(this.privateDir, { recursive: true });
    fs.chmodSync(this.privateDir, 0o700);

    const tempPath = path.join(
      this.privateDir,
      `.admin.${process.pid}.${Date.now()}.${crypto.randomBytes(6).toString("hex")}.tmp`
    );
    const json = `${JSON.stringify(state, null, 2)}\n`;
    const fd = fs.openSync(tempPath, "wx", 0o600);
    let completed = false;
    try {
      fs.writeFileSync(fd, json, "utf8");
      fs.fsyncSync(fd);
      completed = true;
    } finally {
      fs.closeSync(fd);
      if (!completed) {
        try {
          fs.unlinkSync(tempPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
    }

    fs.renameSync(tempPath, this.filePath);
    fs.chmodSync(this.filePath, 0o600);
  }

  writeClaim(code: string, expiresAt: Date): void {
    const state = this.read();
    state.claim = {
      code_hash: hashClaimCode(code),
      created_at: new Date().toISOString(),
      expires_at: expiresAt.toISOString(),
      used_at: null
    };
    this.write(state);
  }

  resetWithClaim(code: string, expiresAt: Date): void {
    this.write({
      admin_user_id: null,
      status: "unclaimed",
      claim: {
        code_hash: hashClaimCode(code),
        created_at: new Date().toISOString(),
        expires_at: expiresAt.toISOString(),
        used_at: null
      },
      pending_transfer: null,
      initialized_at: null
    });
  }

  verifyClaim(userId: string, code: string, now = new Date()): boolean {
    const state = this.read();
    if (state.admin_user_id || state.status !== "unclaimed" || !state.claim || state.claim.used_at) return false;
    if (now > new Date(state.claim.expires_at)) return false;
    if (state.claim.code_hash !== hashClaimCode(code)) return false;
    state.admin_user_id = userId;
    state.status = "initializing";
    state.claim.used_at = now.toISOString();
    this.write(state);
    return true;
  }

  isAdmin(userId: string): boolean {
    return this.read().admin_user_id === userId;
  }

  markReady(now = new Date()): void {
    const state = this.read();
    if (!state.admin_user_id) throw new Error("Cannot mark ready before admin claim");
    state.status = "ready";
    state.initialized_at = now.toISOString();
    this.write(state);
  }

  markInitializing(): void {
    const state = this.read();
    if (!state.admin_user_id) throw new Error("Cannot initialize before admin claim");
    state.status = "initializing";
    state.initialized_at = null;
    this.write(state);
  }

  startTransfer(fromUserId: string, toUserId: string, now = new Date(), ttlSeconds = 86400): boolean {
    const state = this.read();
    if (state.admin_user_id !== fromUserId) return false;
    state.pending_transfer = {
      to_user_id: toUserId,
      created_at: now.toISOString(),
      expires_at: new Date(now.getTime() + ttlSeconds * 1000).toISOString()
    };
    this.write(state);
    return true;
  }

  acceptTransfer(userId: string, now = new Date()): boolean {
    const state = this.read();
    const transfer = state.pending_transfer;
    if (!transfer || transfer.to_user_id !== userId || now > new Date(transfer.expires_at)) return false;
    state.admin_user_id = userId;
    state.pending_transfer = null;
    this.write(state);
    return true;
  }

  cancelTransfer(userId: string): boolean {
    const state = this.read();
    if (state.admin_user_id !== userId || !state.pending_transfer) return false;
    state.pending_transfer = null;
    this.write(state);
    return true;
  }
}

function defaultState(): AdminState {
  return {
    admin_user_id: null,
    status: "unclaimed",
    claim: null,
    pending_transfer: null,
    initialized_at: null
  };
}

class AdminStateValidationError extends Error {}

function validateAdminState(value: unknown, filePath: string): AdminState {
  if (!isPlainObject(value)) throw new AdminStateValidationError(`Invalid admin state file: ${filePath}`);

  const state = value as Record<string, unknown>;
  if (!isNullableString(state.admin_user_id)) {
    throw new AdminStateValidationError(`Invalid admin state file: ${filePath}`);
  }
  if (!isAdminStatus(state.status)) {
    throw new AdminStateValidationError(`Invalid admin state file: ${filePath}`);
  }
  if (!isClaimState(state.claim)) {
    throw new AdminStateValidationError(`Invalid admin state file: ${filePath}`);
  }
  if (!isPendingTransfer(state.pending_transfer)) {
    throw new AdminStateValidationError(`Invalid admin state file: ${filePath}`);
  }
  if (!isNullableString(state.initialized_at)) {
    throw new AdminStateValidationError(`Invalid admin state file: ${filePath}`);
  }
  if (state.status !== "unclaimed" && !state.admin_user_id) {
    throw new AdminStateValidationError(`Invalid admin state file: ${filePath}`);
  }
  if (state.status === "unclaimed" && state.admin_user_id) {
    throw new AdminStateValidationError(`Invalid admin state file: ${filePath}`);
  }

  return {
    admin_user_id: state.admin_user_id,
    status: state.status,
    claim: state.claim,
    pending_transfer: state.pending_transfer,
    initialized_at: state.initialized_at
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
  return typeof value === "string" || value === null;
}

function isAdminStatus(value: unknown): value is AdminStatus {
  return value === "unclaimed" || value === "initializing" || value === "ready";
}

function isClaimState(value: unknown): value is ClaimState | null {
  if (value === null) return true;
  if (!isPlainObject(value)) return false;
  return (
    typeof value.code_hash === "string" &&
    typeof value.created_at === "string" &&
    typeof value.expires_at === "string" &&
    isNullableString(value.used_at)
  );
}

function isPendingTransfer(value: unknown): value is PendingTransfer | null {
  if (value === null) return true;
  if (!isPlainObject(value)) return false;
  return (
    typeof value.to_user_id === "string" &&
    typeof value.created_at === "string" &&
    typeof value.expires_at === "string"
  );
}
