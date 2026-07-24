// Compatibility shim — the bridge moved to packages/core in the AgentDeck monorepo
// restructure. Keeps `node src/index.js` (the long-standing start command, and
// any terminal/muscle-memory restart) working until the Discord bridge is
// retired at hard-cut. Remove with it.
import "../packages/core/src/index.js";
