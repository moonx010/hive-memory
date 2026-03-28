# Open Questions

## Fresh-Eyes Remediation - 2026-03-29
- [ ] Should `connector_marketplace` tool name be renamed to `connector_registry` (API breaking change)? -- Affects MCP clients that reference the tool by name
- [ ] SSO: Should we add a real OIDC implementation or keep the shell with guard? -- Determines future investment vs. cleanup
- [ ] database.ts decomposition: Use function extraction (ops modules) or mixin pattern? -- Functions are simpler but mixins preserve `this` access
- [ ] Cloud backup: What external storage target (S3, R2, GCS)? -- Determines dependency and credential management for production deployments
- [ ] Should backup include encryption at rest? -- Depends on whether cortex.db stores sensitive data in practice
