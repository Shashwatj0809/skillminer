/**
 * MCP server mode (stdio, newline-delimited JSON-RPC 2.0).
 *
 * Zero-dependency implementation of the slice of the Model Context Protocol
 * needed to expose skillminer to any MCP client (Claude Code, Claude Desktop,
 * Codex, Cursor, ...): initialize, tools/list, tools/call, ping.
 *
 * Register it, e.g. for Claude Code:
 *   claude mcp add skillminer -- npx skillminer mcp
 */
import readline from "node:readline";
import { scan, build, improve, listRepos, exportSkills, importSkills, defaultOutDir } from "../index.js";

const PROTOCOL_VERSION = "2024-11-05";

const TOOLS = [
  {
    name: "scan_logs",
    description:
      "Scan local agent logs (Claude Code, Codex, Claude Desktop exports) and report how many conversations each provider has, without building anything.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "list_repos",
    description: "List repositories/directories that have agent-session history available for repo-scoped skill building.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "build_skills",
    description:
      "Mine all local agent logs and (re)build global + per-repo skills. Pass repo to build for one repository only.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "Absolute path of a repo to scope the build to (optional)." },
        outDir: { type: "string", description: `Output directory (default ${defaultOutDir()}).` },
      },
      additionalProperties: false,
    },
  },
  {
    name: "improve_skills",
    description:
      "Re-scan logs, fold new sessions into the existing generated skills (merging, never clobbering hand edits), and report what changed.",
    inputSchema: {
      type: "object",
      properties: {
        outDir: { type: "string", description: "Skills directory to improve (defaults to the last build's)." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "export_skills",
    description:
      "Bundle all generated skills into a portable .skillpack.json file that can be imported on another machine.",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string", description: "Where to write the pack (default ./skillminer-<date>.skillpack.json)." },
        outDir: { type: "string", description: "Skills directory to export from (defaults to the last build's)." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "import_skills",
    description:
      "Import a .skillpack.json into the local skills directory. Existing skills are merged (read + appended, deduplicated), never overwritten.",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string", description: "Path to the .skillpack.json to import." },
        outDir: { type: "string", description: "Skills directory to import into (defaults to the last build's)." },
      },
      required: ["file"],
      additionalProperties: false,
    },
  },
];

async function callTool(name, args = {}) {
  switch (name) {
    case "scan_logs": {
      const { report } = scan();
      return report;
    }
    case "list_repos":
      return listRepos();
    case "build_skills":
      return await build({ repoFilter: args.repo, outDir: args.outDir });
    case "improve_skills":
      return await improve({ outDir: args.outDir });
    case "export_skills":
      return exportSkills({ outDir: args.outDir, file: args.file });
    case "import_skills":
      return importSkills(args.file, { outDir: args.outDir });
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export function startMcpServer() {
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");

  rl.on("line", async (line) => {
    if (!line.trim()) return;
    let req;
    try {
      req = JSON.parse(line);
    } catch {
      return;
    }
    const { id, method, params } = req;
    const reply = (result) => id !== undefined && send({ jsonrpc: "2.0", id, result });
    const fail = (code, message) => id !== undefined && send({ jsonrpc: "2.0", id, error: { code, message } });

    try {
      switch (method) {
        case "initialize":
          reply({
            protocolVersion: params?.protocolVersion ?? PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: "skillminer", version: "0.1.0" },
          });
          break;
        case "notifications/initialized":
          break; // notification, no response
        case "ping":
          reply({});
          break;
        case "tools/list":
          reply({ tools: TOOLS });
          break;
        case "tools/call": {
          const result = await callTool(params.name, params.arguments);
          reply({ content: [{ type: "text", text: JSON.stringify(result, null, 2) }] });
          break;
        }
        default:
          fail(-32601, `Method not found: ${method}`);
      }
    } catch (err) {
      fail(-32000, String(err?.message ?? err));
    }
  });
}
