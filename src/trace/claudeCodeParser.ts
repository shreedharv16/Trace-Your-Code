import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import * as fsp from "fs/promises";
import {
  TraceAction,
  TraceTurn,
  TokenUsage,
  computeRisk,
  cleanPrompt,
  isNoisePrompt
} from "./traceTypes";

/**
 * Parses Claude Code session logs into turns.
 *
 * Claude Code stores one JSONL file per session under
 *   ~/.claude/projects/<encoded-project-path>/<session-id>.jsonl
 * Each line is a JSON record. We only keep records whose `cwd` matches the
 * workspace folder, so a single global scan correctly attributes turns to the
 * project the user is reviewing.
 *
 * A "turn" = a real user prompt followed by the assistant's response(s) and the
 * tool calls it made, up to the next user prompt. Token usage and tool calls
 * are read as structured data — we never parse rendered text.
 */

interface RawRecord {
  type?: string; // "user" | "assistant" | "summary" | ...
  cwd?: string;
  timestamp?: string;
  sessionId?: string;
  uuid?: string;
  message?: {
    role?: string;
    content?: unknown;
    model?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
}

const MAX_PROMPT_LEN = 400;

function claudeProjectsDir(): string {
  return path.join(os.homedir(), ".claude", "projects");
}

/** Normalize for cross-platform path comparison. */
function normPath(p: string): string {
  return path.resolve(p).replace(/\\/g, "/").toLowerCase();
}

function toRel(root: string, abs: string): string | undefined {
  if (!abs) {
    return undefined;
  }
  const rel = path.relative(root, abs);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    return undefined; // outside the workspace
  }
  return rel.replace(/\\/g, "/");
}

/** Map a Claude tool name to our normalized action kind. */
function classifyTool(tool: string): TraceAction["kind"] {
  const t = tool.toLowerCase();
  if (t === "edit" || t === "multiedit") {
    return "edit";
  }
  if (t === "write") {
    return "create";
  }
  if (t.includes("delete") || t.includes("remove")) {
    return "delete";
  }
  if (t === "read" || t === "notebookread") {
    return "read";
  }
  if (t === "grep" || t === "glob" || t.includes("search")) {
    return "search";
  }
  if (t === "bash" || t.includes("exec") || t.includes("run")) {
    return "run";
  }
  return "other";
}

interface ToolUseBlock {
  type: string;
  name?: string;
  input?: Record<string, unknown>;
}

function extractText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (block && typeof block === "object") {
        const b = block as Record<string, unknown>;
        if (b.type === "text" && typeof b.text === "string") {
          parts.push(b.text);
        }
      }
    }
    return parts.join("\n");
  }
  return "";
}

/** Pull the assistant's reasoning ("thinking") blocks from a content array. */
function extractThinking(content: unknown): string {
  if (!Array.isArray(content)) {
    return "";
  }
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object") {
      const b = block as Record<string, unknown>;
      if (b.type === "thinking" && typeof b.thinking === "string") {
        parts.push(b.thinking);
      }
    }
  }
  return parts.join("\n");
}

function extractToolUses(content: unknown): ToolUseBlock[] {
  if (!Array.isArray(content)) {
    return [];
  }
  const out: ToolUseBlock[] = [];
  for (const block of content) {
    if (block && typeof block === "object") {
      const b = block as Record<string, unknown>;
      if (b.type === "tool_use" && typeof b.name === "string") {
        out.push({
          type: "tool_use",
          name: b.name,
          input: (b.input as Record<string, unknown>) ?? {}
        });
      }
    }
  }
  return out;
}

/** True when a content array contains only tool_result blocks (not user text). */
function isToolResultOnly(content: unknown): boolean {
  if (!Array.isArray(content) || content.length === 0) {
    return false;
  }
  return content.every((block) => {
    if (block && typeof block === "object") {
      return (block as Record<string, unknown>).type === "tool_result";
    }
    return false;
  });
}

function actionFromToolUse(root: string, tu: ToolUseBlock): TraceAction {
  const tool = tu.name ?? "tool";
  const kind = classifyTool(tool);
  const input = tu.input ?? {};
  let relPath: string | undefined;
  let detail: string | undefined;

  const filePath =
    (input.file_path as string) ||
    (input.path as string) ||
    (input.notebook_path as string) ||
    "";
  if (filePath) {
    relPath = toRel(root, filePath) ?? filePath.replace(/\\/g, "/");
  }
  if (kind === "run" && typeof input.command === "string") {
    detail = String(input.command).slice(0, 200);
  } else if (kind === "search") {
    detail = String(input.pattern ?? input.query ?? "").slice(0, 200);
  }
  return { kind, tool, relPath, detail };
}

async function listSessionFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...(await listSessionFiles(full)));
    } else if (e.isFile() && e.name.endsWith(".jsonl")) {
      out.push(full);
    }
  }
  return out;
}

/** Parse all Claude Code turns that belong to the given workspace root. */
export async function parseClaudeCode(rootFsPath: string): Promise<TraceTurn[]> {
  const dir = claudeProjectsDir();
  if (!fs.existsSync(dir)) {
    return [];
  }
  const wanted = normPath(rootFsPath);
  const files = await listSessionFiles(dir);
  const turns: TraceTurn[] = [];

  for (const file of files) {
    let text: string;
    try {
      text = await fsp.readFile(file, "utf8");
    } catch {
      continue;
    }
    const records: RawRecord[] = [];
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      try {
        records.push(JSON.parse(trimmed) as RawRecord);
      } catch {
        // skip malformed line
      }
    }
    if (records.length === 0) {
      continue;
    }
    // Only sessions whose records run in this workspace.
    const inWorkspace = records.some(
      (r) => r.cwd && normPath(r.cwd) === wanted
    );
    if (!inWorkspace) {
      continue;
    }

    turns.push(...groupSession(records, rootFsPath));
  }

  turns.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return turns;
}

function groupSession(records: RawRecord[], root: string): TraceTurn[] {
  const out: TraceTurn[] = [];
  let current: TraceTurn | undefined;
  // Accumulators for the assistant side of the current turn.
  let responseParts: string[] = [];
  let reasoningParts: string[] = [];
  let turnIndex = 0;

  const finalize = () => {
    if (current) {
      current.filesTouched = Array.from(
        new Set(
          current.actions
            .filter((a) =>
              ["edit", "create", "delete"].includes(a.kind)
            )
            .map((a) => a.relPath)
            .filter((p): p is string => !!p)
        )
      );
      current.risk = computeRisk(current.filesTouched);
      const response = responseParts.join("\n").trim();
      const reasoning = reasoningParts.join("\n").trim();
      if (response) {
        current.response = response.slice(0, 2000);
      }
      if (reasoning) {
        current.reasoning = reasoning.slice(0, 2000);
      }
      out.push(current);
      current = undefined;
      responseParts = [];
      reasoningParts = [];
    }
  };

  for (const rec of records) {
    const role = rec.message?.role ?? rec.type;
    const content = rec.message?.content;

    const rawUserText =
      role === "user" && !isToolResultOnly(content)
        ? extractText(content)
        : "";

    if (rawUserText) {
      finalize();
      // Skip machine/system event turns (slash commands, IDE notices, etc.).
      if (isNoisePrompt(rawUserText)) {
        continue;
      }
      const sessionId = rec.sessionId ?? "claude";
      current = {
        id: `claude:${sessionId}:${turnIndex++}`,
        source: "claude-code",
        sessionId,
        timestamp: rec.timestamp ?? new Date().toISOString(),
        prompt: cleanPrompt(rawUserText).slice(0, MAX_PROMPT_LEN),
        actions: [],
        filesTouched: [],
        tokens: { input: 0, output: 0 }
      };
      continue;
    }

    if (role === "assistant" && current) {
      // accumulate token usage
      const usage = rec.message?.usage;
      if (usage) {
        const t: TokenUsage = current.tokens;
        t.input += usage.input_tokens ?? 0;
        t.output += usage.output_tokens ?? 0;
        if (usage.cache_read_input_tokens) {
          t.cacheRead = (t.cacheRead ?? 0) + usage.cache_read_input_tokens;
        }
        if (usage.cache_creation_input_tokens) {
          t.cacheWrite =
            (t.cacheWrite ?? 0) + usage.cache_creation_input_tokens;
        }
      }
      const text = extractText(content).trim();
      if (text) {
        responseParts.push(text);
      }
      const thinking = extractThinking(content).trim();
      if (thinking) {
        reasoningParts.push(thinking);
      }
      for (const tu of extractToolUses(content)) {
        current.actions.push(actionFromToolUse(root, tu));
      }
      // capture the model that produced this turn
      if (rec.message?.model) {
        current.model = rec.message.model;
      }
      // keep the assistant timestamp as the turn time (most recent activity)
      if (rec.timestamp) {
        current.timestamp = rec.timestamp;
      }
    }
  }

  finalize();
  return out;
}
