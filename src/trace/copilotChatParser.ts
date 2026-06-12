import * as path from "path";
import * as fs from "fs";
import * as fsp from "fs/promises";
import {
  TraceAction,
  TraceTurn,
  computeRisk,
  cleanPrompt,
  isNoisePrompt
} from "./traceTypes";

/**
 * Parses VS Code / Copilot Chat sessions into turns.
 *
 * VS Code persists chat sessions for a workspace as JSON under
 *   <workspaceStorage>/<hash>/chatSessions/*.json
 * where <hash> is the same folder that holds this extension's own storage. We
 * derive that folder from the extension's storageUri (see traceService.ts), so
 * we only ever read the CURRENT workspace's chats.
 *
 * The schema evolves across VS Code versions, so this parser is intentionally
 * defensive: it pulls prompt text, file edits and tool calls where it can and
 * silently skips anything it doesn't recognize. Token counts are rarely present
 * in the session JSON, so they default to 0 (shown as "—" in the UI).
 */

interface RawRequest {
  requestId?: string;
  message?: { text?: string; parts?: unknown[] };
  response?: unknown[];
  result?: { metadata?: Record<string, unknown> };
  timestamp?: number;
  modelId?: string;
}

interface RawSession {
  version?: number;
  sessionId?: string;
  requests?: RawRequest[];
}

const MAX_PROMPT_LEN = 400;

function uriToPath(u: unknown): string | undefined {
  if (!u || typeof u !== "object") {
    return undefined;
  }
  const o = u as Record<string, unknown>;
  if (typeof o.fsPath === "string") {
    return o.fsPath;
  }
  if (typeof o.path === "string") {
    // VS Code serializes file URIs as "/c:/Users/..." — strip the leading slash.
    return o.path.replace(/^\/([a-zA-Z]:)/, "$1");
  }
  if (typeof o.external === "string") {
    return o.external;
  }
  return undefined;
}

function toRel(root: string, abs: string): string | undefined {
  const rel = path.relative(root, abs);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    return undefined;
  }
  return rel.replace(/\\/g, "/");
}

function readNumber(...vals: unknown[]): number {
  for (const v of vals) {
    if (typeof v === "number" && isFinite(v)) {
      return v;
    }
  }
  return 0;
}

/** Walk a chat response part and emit any actions it represents. */
function actionsFromPart(root: string, part: unknown): TraceAction[] {
  if (!part || typeof part !== "object") {
    return [];
  }
  const p = part as Record<string, unknown>;
  const kind = String(p.kind ?? "");
  const out: TraceAction[] = [];

  // File edits: textEditGroup / codeblockUri carry a target uri.
  if (kind === "textEditGroup" || p.uri) {
    const abs = uriToPath(p.uri);
    if (abs) {
      out.push({
        kind: "edit",
        tool: "edit",
        relPath: toRel(root, abs) ?? abs.replace(/\\/g, "/")
      });
    }
  }

  // Tool invocations.
  if (kind === "toolInvocationSerialized" || kind === "prepareToolInvocation") {
    const toolName = String(
      p.toolId ?? p.toolName ?? (p as { name?: string }).name ?? "tool"
    );
    const t = toolName.toLowerCase();
    let k: TraceAction["kind"] = "other";
    if (t.includes("edit") || t.includes("apply") || t.includes("insert")) {
      k = "edit";
    } else if (t.includes("create")) {
      k = "create";
    } else if (t.includes("read") || t.includes("file")) {
      k = "read";
    } else if (t.includes("search") || t.includes("grep") || t.includes("find")) {
      k = "search";
    } else if (t.includes("terminal") || t.includes("run")) {
      k = "run";
    }
    out.push({ kind: k, tool: toolName, detail: undefined });
  }

  return out;
}

/** Pull markdown/text reply and "thinking" reasoning out of one response part. */
function textFromPart(part: unknown): { response?: string; reasoning?: string } {
  if (!part || typeof part !== "object") {
    return {};
  }
  const p = part as Record<string, unknown>;
  const kind = String(p.kind ?? "");

  // Reasoning blocks.
  if (kind === "thinking") {
    const v = p.value;
    if (typeof v === "string" && v.trim()) {
      return { reasoning: v };
    }
    const inner = (v as Record<string, unknown>)?.value;
    if (typeof inner === "string" && inner.trim()) {
      return { reasoning: inner };
    }
    return {};
  }

  // Markdown reply parts: value is either a string or { value: "..." }.
  const v = p.value;
  let text: string | undefined;
  if (typeof v === "string") {
    text = v;
  } else if (v && typeof v === "object") {
    const inner = (v as Record<string, unknown>).value;
    if (typeof inner === "string") {
      text = inner;
    }
  }
  // Only treat as response when it isn't a tool/system control part.
  if (
    text &&
    text.trim() &&
    !kind.startsWith("toolInvocation") &&
    !kind.startsWith("prepareTool") &&
    kind !== "mcpServersStarting"
  ) {
    return { response: text };
  }
  return {};
}

function turnFromRequest(
  root: string,
  sessionId: string,
  index: number,
  req: RawRequest
): TraceTurn | undefined {
  const rawPrompt = (req.message?.text ?? "").trim();
  if (!rawPrompt || isNoisePrompt(rawPrompt)) {
    return undefined;
  }
  const prompt = cleanPrompt(rawPrompt);
  if (!prompt) {
    return undefined;
  }

  const actions: TraceAction[] = [];
  const responseParts: string[] = [];
  const reasoningParts: string[] = [];
  for (const part of req.response ?? []) {
    actions.push(...actionsFromPart(root, part));
    const { response, reasoning } = textFromPart(part);
    if (response) {
      responseParts.push(response);
    }
    if (reasoning) {
      reasoningParts.push(reasoning);
    }
  }

  const filesTouched = Array.from(
    new Set(
      actions
        .filter((a) => ["edit", "create", "delete"].includes(a.kind))
        .map((a) => a.relPath)
        .filter((p): p is string => !!p)
    )
  );

  const meta = req.result?.metadata ?? {};
  const input = readNumber(
    (meta as { promptTokens?: number }).promptTokens,
    (meta as { inputTokens?: number }).inputTokens
  );
  const output = readNumber(
    (meta as { completionTokens?: number }).completionTokens,
    (meta as { outputTokens?: number }).outputTokens
  );

  const response = responseParts.join("\n").trim();
  const reasoning = reasoningParts.join("\n").trim();

  return {
    id: `copilot:${sessionId}:${index}`,
    source: "copilot-chat",
    sessionId,
    timestamp: req.timestamp
      ? new Date(req.timestamp).toISOString()
      : new Date().toISOString(),
    prompt: prompt.slice(0, MAX_PROMPT_LEN),
    model: req.modelId || undefined,
    reasoning: reasoning ? reasoning.slice(0, 2000) : undefined,
    response: response ? response.slice(0, 2000) : undefined,
    actions,
    filesTouched,
    tokens: { input, output },
    risk: computeRisk(filesTouched)
  };
}

/** Parse all Copilot/VS Code chat turns from the workspace's chatSessions dir. */
export async function parseCopilotChat(
  rootFsPath: string,
  chatSessionsDir: string | undefined
): Promise<TraceTurn[]> {
  if (!chatSessionsDir || !fs.existsSync(chatSessionsDir)) {
    return [];
  }
  let files: string[];
  try {
    files = (await fsp.readdir(chatSessionsDir)).filter((f) =>
      f.endsWith(".json")
    );
  } catch {
    return [];
  }

  const turns: TraceTurn[] = [];
  for (const name of files) {
    let raw: RawSession;
    try {
      const text = await fsp.readFile(
        path.join(chatSessionsDir, name),
        "utf8"
      );
      raw = JSON.parse(text) as RawSession;
    } catch {
      continue;
    }
    const sessionId = raw.sessionId ?? name.replace(/\.json$/, "");
    const reqs = raw.requests ?? [];
    reqs.forEach((req, i) => {
      const turn = turnFromRequest(rootFsPath, sessionId, i, req);
      if (turn) {
        turns.push(turn);
      }
    });
  }

  turns.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return turns;
}
