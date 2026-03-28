/**
 * SSO Foundation — interface + auto-provisioning.
 *
 * IMPORTANT: No SAML/OIDC flow is implemented yet.
 * This module provides the interface for future SSO provider integration
 * (e.g., via WorkOS, Auth0, or custom SAML).
 *
 * Current capabilities:
 * - Config loading from env vars
 * - User auto-provisioning from SSO callback data
 *
 * NOT implemented: login flow, token validation, callback handling.
 */
import type { HiveDatabase } from "../db/database.js";
import { createUser } from "../auth.js";

export interface SSOProvider {
  readonly id: string;
  readonly name: string;
  /** Initiate SSO login — returns redirect URL */
  getLoginUrl(redirectUri: string): string;
  /** Validate SSO callback — returns user info */
  validateCallback(code: string): Promise<{ email: string; name: string; orgId?: string }>;
}

export interface SSOConfig {
  enabled: boolean;
  provider: "saml" | "oidc" | "none";
  issuerUrl?: string;
  clientId?: string;
  clientSecret?: string;
}

/** Load SSO config from env vars */
export function loadSSOConfig(): SSOConfig {
  return {
    enabled: process.env["CORTEX_SSO_ENABLED"] === "true",
    provider: ((process.env["CORTEX_SSO_PROVIDER"] || "none")) as SSOConfig["provider"],
    issuerUrl: process.env["CORTEX_SSO_ISSUER_URL"],
    clientId: process.env["CORTEX_SSO_CLIENT_ID"],
    clientSecret: process.env["CORTEX_SSO_CLIENT_SECRET"],
  };
}

/** Provision or update a user from SSO callback */
export function provisionSSOUser(
  db: HiveDatabase,
  ssoResult: { email: string; name: string; orgId?: string },
): { userId: string; apiKey: string; isNew: boolean } {
  if (!loadSSOConfig().enabled) {
    throw new Error("SSO is not enabled. Set CORTEX_SSO_ENABLED=true and configure a provider.");
  }
  // Check if user exists by email
  const existing = db.listUsers().find(u => u.email === ssoResult.email);
  if (existing) {
    return { userId: existing.id, apiKey: "", isNew: false };
  }

  // Create new user (auto-provisioning)
  const { user, plaintextKey } = createUser(db, ssoResult.name, ssoResult.email);

  // Assign to org if provided
  if (ssoResult.orgId) {
    db.assignUserToOrg(user.id, ssoResult.orgId);
  }

  return { userId: user.id, apiKey: plaintextKey, isNew: true };
}
