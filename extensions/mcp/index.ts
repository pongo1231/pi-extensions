/**
 * MCP Bridge Extension for pi (self-contained, cross-platform)
 *
 * Spawns MCP (Model Context Protocol) servers defined in mcp.json, discovers
 * their tools via the tools/list JSON-RPC method, and registers them as pi
 * tools callable by the LLM. This is a *generalized* MCP client — it works
 * with any MCP-compliant stdio server.
 *
 * Configuration at ~/.pi/agent/mcp.json (global) or .pi/mcp.json (project):
 *   {
 *     "servers": {
 *       "ghidra": {
 *         "type": "local",
 *         "command": ["bash", "./run-ghidra.sh"]
 *       }
 *     }
 *   }
 *
 * `cwd` defaults to the extension directory. Unnecessary when using relative
 * paths to scripts bundled in the extension.
 *
 * On Windows, `bash ./foo.sh` is auto-resolved to `foo.cmd` if present.
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
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";


// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface McpServerConfig {
  type: "local";
  /** Shell command + args. Tilde in paths is expanded.
   *  On Windows, .bat/.cmd args are wrapped with cmd /c automatically. */
  command: string[];
  /** Working directory for spawned process (optional, defaults to pi cwd) */
  cwd?: string;
  /** Extra environment variables (merged into process.env) */
  env?: Record<string, string>;
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

interface JsonRpcNotification {
  jsonrpc: "2.0";
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
// Helpers
// ---------------------------------------------------------------------------

function expandTilde(p: string): string {
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

/** Detect if we're on Windows (runtime check). */
const isWindows = process.platform === "win32";

/** Directory of this extension (resolved from import.meta). */
const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * Normalize a command array for the current platform.
 *
 * On Windows:
 *   - If the command is `bash ./foo.sh`, resolve to `./foo.cmd` instead
 *     (so users write one portable config that works on both platforms).
 *   - If a .bat or .cmd is passed directly, wrap with `cmd /d /c`.
 *   - .exe and .com binaries are passed through as-is.
 *
 * On Unix: tilde expansion only.
 */
function normalizeCommand(argv: string[]): { cmd: string; args: string[] } {
  const expanded = argv.map(expandTilde);
  let cmd = expanded[0]!;
  let args = expanded.slice(1);

  if (isWindows) {
    // If user wrote ["bash", "./foo.sh"] — switch to ./foo.cmd
    if (cmd === "bash" && args.length > 0) {
      const script = args[0]!;
      if (script.endsWith(".sh")) {
        const scriptCmd = script.replace(/\.sh$/, ".cmd");
        if (existsSync(scriptCmd)) {
          cmd = scriptCmd;
          args = args.slice(1);
        }
      }
    }

    // .bat / .cmd are not direct executables — wrap with cmd.exe
    const lower = cmd.toLowerCase();
    if (lower.endsWith(".bat") || lower.endsWith(".cmd")) {
      return { cmd: "cmd", args: ["/d", "/c", cmd, ...args] };
    }
  }

  return { cmd, args };
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
    } catch { /* ignore invalid config */ }
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
    const nonNull = schema.anyOf.filter((s) => s.type !== "null");
    if (nonNull.length === 1 && schema.anyOf.some((s) => s.type === "null")) {
      return Type.Optional(jsonSchemaToTypeBox(nonNull[0]!, false));
    }
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

    case "array": {
      const itemSchema = schema.items
        ? jsonSchemaToTypeBox(schema.items, true)
        : Type.Any();
      return isRequired
        ? Type.Array(itemSchema)
        : Type.Optional(Type.Array(itemSchema));
    }

    case "object": {
      if (!schema.properties) {
        return isRequired
          ? Type.Record(Type.String(), Type.Any())
          : Type.Optional(Type.Record(Type.String(), Type.Any()));
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
      const obj = Type.Object(props, {
        additionalProperties: schema.additionalProperties ?? false,
      });
      return isRequired ? obj : Type.Optional(obj);
    }

    default:
      return isRequired ? Type.Any() : Type.Optional(Type.Any());
  }
}

// ---------------------------------------------------------------------------
// MCP Client — manages one MCP server process over stdio JSON-RPC
// ---------------------------------------------------------------------------

class McpClient {
  private proc: ChildProcess | null = null;
  private requestId = 0;
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private tools: McpToolDef[] = [];
  private dead = false;
  private name: string;
  private command: string[];
  private cwd: string;
  private env: Record<string, string>;

  constructor(name: string, config: McpServerConfig, defaultCwd: string) {
    this.name = name;
    this.command = config.command;
    this.cwd = config.cwd ? expandTilde(config.cwd) : defaultCwd;
    this.env = { ...process.env, ...config.env };
  }

  get isAlive(): boolean {
    return !this.dead && this.proc !== null && !this.proc.killed;
  }

  async start(): Promise<void> {
    if (this.dead) throw new Error(`MCP server "${this.name}" was shut down`);

    const { cmd, args } = normalizeCommand(this.command);

    this.proc = spawn(cmd, args, {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"], // stdin, stdout, stderr
      env: this.env,
    });

    // Set up stdout line reader for JSON-RPC responses
    const rl = createInterface({
      input: this.proc.stdout!,
      crlfDelay: Infinity,
    });
    rl.on("line", (line: string) => {
      this.handleLine(line);
    });

    // Forward stderr for debugging (log only first 200 chars per line)
    if (this.proc.stderr) {
      const stderrRl = createInterface({
        input: this.proc.stderr,
        crlfDelay: Infinity,
      });
      stderrRl.on("line", (line: string) => {
        const truncated = line.length > 200 ? line.slice(0, 200) + "..." : line;
        // Stderr may contain JSON-RPC on some implementations — try parse
        try {
          const msg: unknown = JSON.parse(line);
          if (typeof msg === "object" && msg !== null) {
            this.handleLine(line);
            return;
          }
        } catch {
          // Not JSON — log prefix for debugging
        }
      });
    }

    this.proc.on("error", (err) => {
      this.dead = true;
      const code = (err as NodeJS.ErrnoException).code;
      const hint = code === "ENOENT"
        ? `MCP server "${this.name}" could not be started — "${this.command[0]}" was not found.`
        : `MCP server "${this.name}" process error: ${err.message}`;
      this.rejectAll(new Error(hint));
    });

    this.proc.on("exit", (code) => {
      this.dead = true;
      if (code !== 0 && code !== null) {
        this.rejectAll(
          new Error(`MCP server "${this.name}" stopped (exit code ${code}). Is the backend running?`),
        );
      }
    });

    // MCP initialization handshake
    await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "pi-mcp-bridge", version: "1.0.0" },
    });

    // Send initialized notification (no response expected)
    try {
      this.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    } catch {
      // process already dead — initialize request will have failed too
    }
  }

  async discoverTools(): Promise<McpToolDef[]> {
    const result = await this.request("tools/list");
    const data = result as { tools?: McpToolDef[] };
    this.tools = data.tools ?? [];
    return this.tools;
  }

  async callTool(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    return this.request("tools/call", { name: toolName, arguments: args });
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
      const msg = JSON.parse(line) as
        | JsonRpcResponse
        | JsonRpcNotification;
      // Response to a pending request
      if ("id" in msg && msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        if (msg.error) {
          reject(
            new Error(
              `MCP error ${msg.error.code}: ${msg.error.message}` +
                (msg.error.data ? ` (${JSON.stringify(msg.error.data)})` : ""),
            ),
          );
        } else {
          resolve(msg.result);
        }
      }
      // Notifications (like tools/list_changed) are currently ignored
    } catch {
      // Ignore parse errors (might be log output)
    }
  }

  private send(msg: Record<string, unknown>): void {
    if (!this.proc?.stdin || this.proc.killed || this.dead) {
      throw new Error(`MCP "${this.name}" is not running`);
    }
    this.proc.stdin.write(JSON.stringify(msg) + "\n");
  }

  private request(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<unknown> {
    if (!this.proc || this.proc.killed || this.dead) {
      return Promise.reject(
        new Error(`MCP "${this.name}" is not running`),
      );
    }
    const id = this.nextId();
    const req: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
      params,
    };
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
    label: `MCP ${serverName}/${toolDef.name}`,
    description:
      toolDef.description ??
      `MCP tool: ${toolDef.name} (from ${serverName})`,

    parameters: paramsSchema,

    async execute(_toolCallId, params, signal, _onUpdate) {
      if (signal?.aborted) {
        return {
          content: [{ type: "text" as const, text: "Cancelled" }],
        };
      }

      if (!client.isAlive) {
        const msg =
          `MCP server "${serverName}" is not running. ` +
          `Restart pi or reload with /reload to reconnect.`;
        return {
          content: [{ type: "text" as const, text: msg }],
          details: { server: serverName, tool: toolDef.name, error: "server_dead" },
        };
      }

      let result: unknown;
      try {
        result = await client.callTool(
          toolDef.name,
          params as Record<string, unknown>,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const msg =
          `MCP tool "${toolDef.name}" on server "${serverName}" failed: ${message}\n` +
          `The server may have crashed — try /reload to restart it.`;
        return {
          content: [{ type: "text" as const, text: msg }],
          details: { server: serverName, tool: toolDef.name, error: message },
        };
      }

      // MCP tools return content as an array of content blocks
      const content = result as {
        content?: Array<{ type: string; text?: string }>;
      };
      if (content?.content) {
        const text = content.content.map((c) => c.text ?? "").join("\n");
        return {
          content: [
            {
              type: "text" as const,
              text: text || JSON.stringify(result, null, 2),
            },
          ],
          details: { server: serverName, tool: toolDef.name },
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
        details: { server: serverName, tool: toolDef.name },
      };
    },

    renderCall(args, theme, _context) {
      let text = theme.fg(
        "toolTitle",
        theme.bold(`mcp/${serverName}/${toolDef.name} `),
      );
      text += theme.fg("muted", JSON.stringify(args));
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded }, theme, _context) {
      const details = result.details as
        | { server: string; tool: string }
        | undefined;
      if (!expanded) {
        return new Text(
          theme.fg("success", `✓ mcp/${details?.server ?? serverName}/${details?.tool ?? toolDef.name}`),
          0,
          0,
        );
      }
      // Show a snippet of the result in expanded view
      const text = result.content?.[0]?.text ?? "";
      const snippet =
        text.length > 200 ? text.slice(0, 200) + "..." : text;
      return new Text(
        theme.fg("success", `✓ mcp/${details?.server ?? serverName}/${details?.tool ?? toolDef.name}`) +
          "\n" +
          theme.fg("dim", snippet),
        0,
        0,
      );
    },
  });

  return piToolName;
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
      ([, s]) => s.type === "local",
    );

    if (entries.length === 0) return;

    const loaded: string[] = [];
    const failed: string[] = [];

    for (const [name, serverConfig] of entries) {
      try {
        const client = new McpClient(name, serverConfig, EXTENSION_DIR);
        await client.start();

        const tools = await client.discoverTools();
        clients.set(name, client);

        for (const toolDef of tools) {
          registerMcpTool(pi, name, toolDef, client);
        }

        loaded.push(name);
      } catch (err) {
        clients.delete(name);
        failed.push(name);
      }
    }

    if (ctx.hasUI && (loaded.length > 0 || failed.length > 0)) {
      const parts: string[] = [];
      if (loaded.length > 0) {
        parts.push(`Loaded: ${loaded.join(", ")}`);
      }
      if (failed.length > 0) {
        parts.push(`Unavailable: ${failed.map((f) => f.replace(/ \[.*\]/, "")).join(", ")}`);
      }
      ctx.ui.notify(`MCP Servers ${parts.join(" | ")}`, "info");
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
