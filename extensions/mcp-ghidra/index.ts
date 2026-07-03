/**
 * MCP Bridge Extension for pi
 *
 * Spawns MCP (Model Context Protocol) servers, discovers their tools,
 * and registers them as pi tools callable by the LLM.
 *
 * Configuration at ~/.pi/agent/mcp.json (global) or .pi/mcp.json (project):
 *   {
 *     "servers": {
 *       "ghidra": {
 *         "type": "local",
 *         "command": ["python3", "/path/to/bridge_mcp_ghidra.py"],
 *         "enabled": true
 *       }
 *     }
 *   }
 *
 * Tools are registered with the prefix "mcp__serverName__toolName".
 * The bridge handles MCP's JSON-RPC protocol over stdio.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type, type TSchema } from "typebox";
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface McpServerConfig {
  type: "local";
  command: string[];
  enabled?: boolean;
}

interface McpConfig {
  servers: Record<string, McpServerConfig>;
}

interface JsonSchema {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  description?: string;
  enum?: (string | number)[];
  const?: unknown;
  anyOf?: JsonSchema[];
  additionalProperties?: boolean;
}

interface McpToolDef {
  name: string;
  description?: string;
  inputSchema: JsonSchema;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// ---------------------------------------------------------------------------
// Config loader
// ---------------------------------------------------------------------------

const MCP_CONFIG_FILE = "mcp.json";

function loadMcpConfig(ctx?: ExtensionContext): McpConfig {
  const merged: McpConfig = { servers: {} };

  // Global config
  const globalPath = join(homedir(), ".pi", "agent", MCP_CONFIG_FILE);
  if (existsSync(globalPath)) {
    try {
      const data = JSON.parse(readFileSync(globalPath, "utf-8"));
      if (data.servers) Object.assign(merged.servers, data.servers);
    } catch { /* ignore */ }
  }

  // Project config (overrides / merges)
  if (ctx?.cwd) {
    const projectPath = join(ctx.cwd, ".pi", MCP_CONFIG_FILE);
    if (existsSync(projectPath)) {
      try {
        const data = JSON.parse(readFileSync(projectPath, "utf-8"));
        if (data.servers) Object.assign(merged.servers, data.servers);
      } catch { /* ignore */ }
    }
  }

  return merged;
}

// ---------------------------------------------------------------------------
// JSON Schema → TypeBox converter
// ---------------------------------------------------------------------------

function jsonSchemaToTypeBox(schema: JsonSchema, isRequired = true): TSchema {
  // Handle anyOf (used for nullable or enum-like schemas)
  if (schema.anyOf) {
    // Check if this is a nullable (one option is {type:"null"})
    const nonNull = schema.anyOf.filter((s) => s.type !== "null");
    if (nonNull.length === 1 && schema.anyOf.some((s) => s.type === "null")) {
      return Type.Optional(jsonSchemaToTypeBox(nonNull[0]!, false));
    }
    // Fallback: treat as union
    if (nonNull.length >= 1) {
      return jsonSchemaToTypeBox(nonNull[0]!, isRequired);
    }
  }

  // Handle const (literal values)
  if (schema.const !== undefined) {
    switch (typeof schema.const) {
      case "string": return Type.Literal(schema.const);
      case "number": return Type.Literal(schema.const);
      case "boolean": return Type.Literal(schema.const);
    }
  }

  // Handle enum
  if (schema.enum) {
    if (schema.enum.every((e) => typeof e === "string")) {
      return Type.Union(schema.enum.map((e) => Type.Literal(e)));
    }
    if (schema.enum.every((e) => typeof e === "number")) {
      return Type.Union(schema.enum.map((e) => Type.Literal(e)));
    }
  }

  switch (schema.type) {
    case "string":
      return isRequired ? Type.String() : Type.Optional(Type.String());

    case "number":
    case "integer":
      return isRequired ? Type.Number() : Type.Optional(Type.Number());

    case "boolean":
      return isRequired ? Type.Boolean() : Type.Optional(Type.Boolean());

    case "array":
      if (schema.items) {
        const itemSchema = jsonSchemaToTypeBox(schema.items, true);
        return isRequired ? Type.Array(itemSchema) : Type.Optional(Type.Array(itemSchema));
      }
      return isRequired ? Type.Array(Type.Any()) : Type.Optional(Type.Array(Type.Any()));

    case "object": {
      if (!schema.properties) {
        return isRequired ? Type.Record(Type.String(), Type.Any()) : Type.Optional(Type.Record(Type.String(), Type.Any()));
      }
      const props: Record<string, TSchema> = {};
      const requiredSet = new Set(schema.required ?? []);
      for (const [key, propSchema] of Object.entries(schema.properties)) {
        try {
          props[key] = jsonSchemaToTypeBox(propSchema, requiredSet.has(key));
        } catch {
          props[key] = Type.Optional(Type.Any());
        }
      }
      const obj = Type.Object(props, { additionalProperties: schema.additionalProperties ?? false });
      return isRequired ? obj : Type.Optional(obj);
    }

    default:
      // Unknown or missing type — accept anything
      return isRequired ? Type.Any() : Type.Optional(Type.Any());
  }
}

// ---------------------------------------------------------------------------
// MCP Client — manages one MCP server process over stdio JSON-RPC
// ---------------------------------------------------------------------------

class McpClient {
  private proc: ChildProcess | null = null;
  private requestId = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private buffer = "";
  private tools: McpToolDef[] = [];
  private dead = false;

  constructor(
    private name: string,
    private command: string[],
  ) {}

  get isAlive() { return !this.dead && this.proc !== null && !this.proc.killed; }

  async start(): Promise<void> {
    if (this.dead) throw new Error(`MCP server "${this.name}" was shut down`);

    // Expand ~ in command paths (spawn doesn't expand it)
    const expandPath = (p: string) =>
      p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;

    const [cmd, ...args] = this.command.map(expandPath);
    if (!cmd) throw new Error(`No command for MCP server "${this.name}"`);

    this.proc = spawn(cmd!, args, {
      stdio: ["pipe", "pipe", "pipe"], // stdin, stdout, stderr
      env: { ...process.env },
    });

    const rl = createInterface({ input: this.proc.stdout!, crlfDelay: Infinity });
    rl.on("line", (line: string) => {
      this.handleLine(line);
    });

    this.proc.on("error", (err) => {
      this.dead = true;
      this.rejectAll(new Error(`MCP "${this.name}" process error: ${err.message}`));
    });

    this.proc.on("exit", (code) => {
      this.dead = true;
      if (code !== 0 && code !== null) {
        this.rejectAll(new Error(`MCP "${this.name}" exited with code ${code}`));
      }
    });

    // MCP initialization handshake
    const initResult = await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "pi-mcp-bridge", version: "1.0.0" },
    });

    // Send initialized notification (no response expected)
    this.send({ jsonrpc: "2.0", method: "notifications/initialized" });

    return;
  }

  async discoverTools(): Promise<McpToolDef[]> {
    const result = await this.request("tools/list");
    const data = result as { tools?: McpToolDef[] };
    this.tools = data.tools ?? [];
    return this.tools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    return this.request("tools/call", { name, arguments: args });
  }

  shutdown(): void {
    this.dead = true;
    this.rejectAll(new Error("MCP bridge shutting down"));
    if (this.proc && !this.proc.killed) {
      this.proc.kill();
    }
  }

  // --- private ---

  private nextId(): number {
    return ++this.requestId;
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    try {
      const msg = JSON.parse(line) as JsonRpcResponse;
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        if (msg.error) {
          reject(new Error(`MCP error ${msg.error.code}: ${msg.error.message}`));
        } else {
          resolve(msg.result);
        }
      }
    } catch {
      // Ignore parse errors (might be log output on stderr leaking)
    }
  }

  private send(msg: Record<string, unknown>): void {
    if (!this.proc?.stdin || this.proc.killed || this.dead) {
      throw new Error(`MCP "${this.name}" is not running`);
    }
    this.proc.stdin.write(JSON.stringify(msg) + "\n");
  }

  private request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (!this.proc || this.proc.killed || this.dead) {
      return Promise.reject(new Error(`MCP "${this.name}" is not running`));
    }
    const id = this.nextId();
    const req: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.send(req);
      } catch (err) {
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  private rejectAll(err: Error): void {
    for (const [, { reject }] of this.pending) {
      reject(err);
    }
    this.pending.clear();
  }
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  const clients = new Map<string, McpClient>();
  let started = false;

  async function startBridges(ctx: ExtensionContext): Promise<void> {
    if (started) return;
    started = true;

    const config = loadMcpConfig(ctx);
    const entries = Object.entries(config.servers).filter(
      ([, s]) => s.type === "local" && s.enabled !== false,
    );

    for (const [name, serverConfig] of entries) {
      try {
        const client = new McpClient(name, serverConfig.command);
        await client.start();

        const tools = await client.discoverTools();
        clients.set(name, client);

        for (const toolDef of tools) {
          registerMcpTool(pi, name, toolDef, client);
        }

        if (tools.length > 0) {
          ctx.ui.notify(
            `MCP "${name}": ${tools.length} tools loaded`,
            "info",
          );
        }
      } catch (err) {
        ctx.ui.notify(
          `MCP "${name}": ${err instanceof Error ? err.message : "failed to start"}`,
          "error",
        );
      }
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    await startBridges(ctx);
  });

  pi.on("session_shutdown", async () => {
    for (const client of clients.values()) {
      client.shutdown();
    }
    clients.clear();
    started = false;
  });
}

// ---------------------------------------------------------------------------
// Tool registration helper
// ---------------------------------------------------------------------------

function registerMcpTool(
  pi: ExtensionAPI,
  serverName: string,
  toolDef: McpToolDef,
  client: McpClient,
): string {
  const piToolName = `mcp__${serverName}__${toolDef.name}`;

  // Convert JSON Schema to TypeBox
  let paramsSchema: TSchema;
  try {
    paramsSchema = jsonSchemaToTypeBox(toolDef.inputSchema, true);
  } catch {
    paramsSchema = Type.Object({}, { additionalProperties: true });
  }

  pi.registerTool({
    name: piToolName,
    label: `MCP ${toolDef.name}`,
    description: toolDef.description ?? `MCP tool: ${toolDef.name} (from ${serverName})`,

    parameters: paramsSchema,

    async execute(_toolCallId, params, signal, _onUpdate) {
      if (signal?.aborted) {
        return { content: [{ type: "text" as const, text: "Cancelled" }] };
      }

      const result = await client.callTool(toolDef.name, params as Record<string, unknown>);

      // MCP tools return content as an array of content blocks
      const content = result as { content?: Array<{ type: string; text?: string }> };
      if (content?.content) {
        const text = content.content
          .map((c) => c.text ?? "")
          .join("\n");
        return {
          content: [{ type: "text" as const, text: text || JSON.stringify(result, null, 2) }],
          details: { server: serverName, tool: toolDef.name },
        };
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        details: { server: serverName, tool: toolDef.name },
      };
    },

    renderCall(args, theme, _context) {
      let text = theme.fg("toolTitle", theme.bold(`mcp/${serverName}/${toolDef.name} `));
      text += theme.fg("muted", JSON.stringify(args));
      return new Text(text, 0, 0);
    },
  });

  return piToolName;
}
