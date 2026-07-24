// Compatibility shim — real server lives in packages/core/src/mcp/. The
// RUNNING bridge process resolves this exact path when spawning the approver
// MCP for every Claude run (claude.js computes it at import time), so this
// must exist until that process is restarted on the new layout. Remove at
// Discord hard-cut.
import "../../packages/core/src/mcp/approval-server.js";
