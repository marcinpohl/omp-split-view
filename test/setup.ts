import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The extension resolves its config path from the agent directory at module
// load, so isolate it before any test imports the module.
process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "omp-split-view-test-"));
