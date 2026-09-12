/**
 * npm run setup — generate the demo fixture through the fina-olap MCP stdio
 * server (tool `generate_fixture`). Spawns the venv binary if present,
 * otherwise `fina-olap-mcp` from PATH.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const command = join(root, ".venv", "bin", "fina-olap-mcp");
const mcp = existsSync(command) ? command : "fina-olap-mcp";

const transport = new StdioClientTransport({
  command: mcp,
  args: [],
  env: {
    ...process.env,
    FINA_OLAP_FIXTURE: join(root, "data", "sample.parquet"),
  },
});

const client = new Client({ name: "fina-olap-setup", version: "1.0.0" });
await client.connect(transport);
const result = await client.callTool({
  name: "generate_fixture",
  arguments: { row_count: 3000 },
});
await client.close();

console.log("fixture ready:");
console.log(typeof result.content === "string" ? result.content : JSON.stringify(result, null, 2));