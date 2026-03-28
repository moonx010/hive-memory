export interface GatewayConfig {
  authRequired: boolean;
  rateLimitPerMin: number;
  auditEnabled: boolean;
  ssoEnabled: boolean;
}

export function loadGatewayConfig(): GatewayConfig {
  return {
    authRequired: process.env["CORTEX_AUTH_TOKEN"] !== undefined || process.env["CORTEX_ACL"] === "on",
    rateLimitPerMin: parseInt(process.env["CORTEX_RATE_LIMIT"] ?? "100", 10),
    auditEnabled: process.env["CORTEX_AUDIT"] === "on",
    ssoEnabled: process.env["CORTEX_SSO_ENABLED"] === "true",
  };
}
