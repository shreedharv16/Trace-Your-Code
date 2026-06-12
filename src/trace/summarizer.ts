import * as vscode from "vscode";
import * as fs from "fs";
import { TraceTurn } from "./traceTypes";
import {
  readEnvConfig,
  resolveProvider,
  keysFilePath,
  KEYS_FILE_NAME,
  LlmProvider,
  PROVIDERS,
  PROVIDER_INFO,
  PROVIDER_DEFAULT_MODEL
} from "./envConfig";

/**
 * Optional, opt-in AI-narration layer. Turns the STRUCTURED facts of a turn
 * (prompt + tool actions + files touched + the REAL shadow-git diff) into
 * plain-English narrative: per-turn explanations, file biographies, and
 * ranked breakage suspects. It annotates ground truth — it never invents
 * file changes.
 *
 * Provider-agnostic: OpenAI, Anthropic, Google Gemini, OpenRouter,
 * Azure OpenAI, or any OpenAI-compatible endpoint (Groq, Together, Mistral,
 * DeepSeek, local Ollama, …).
 *
 * Key handling: credentials are read ONLY from the workspace-root keys file
 * (api-keys.txt, .env fallback). Nothing is stored inside VS Code (no
 * SecretStorage, no settings) and nothing is ever transmitted anywhere except
 * directly to the provider the user configured.
 *
 * Privacy: bulk summaries send only metadata by default
 * (changeTracker.trace.sendDiffsToLLM gates diff content). The explicit
 * per-turn actions (Explain / Story / Investigate) always include the real
 * diff, since the user invokes them deliberately on specific content.
 */

const KEYS_FILE_TEMPLATE = `# Trace Your Code — API keys (LOCAL ONLY)
#
# This plain-text file is the ONLY place the AI-narration layer reads
# credentials from. Nothing is stored inside VS Code (no SecretStorage,
# no settings sync).
#
# It is gitignored so it won't be committed. NEVER commit this file.
# WARNING: this is plain text on disk. Anyone with file access can read it.
# Rotate the key if it is ever shared/exposed.
#
# One value per line as KEY=value. Lines starting with # are ignored.
#
# CHANGE_TRACKER_PROVIDER — one of:
#   openai | anthropic | gemini | openrouter | azure-openai | custom
# CHANGE_TRACKER_MODEL — model name (or Azure deployment name).
#   Leave empty to use the provider's default.
# CHANGE_TRACKER_ENDPOINT — only needed for azure-openai and custom
#   (an OpenAI-compatible /chat/completions URL).

CHANGE_TRACKER_PROVIDER=
CHANGE_TRACKER_API_KEY=
CHANGE_TRACKER_MODEL=
CHANGE_TRACKER_ENDPOINT=
`;

export class Summarizer {
  constructor(private readonly context: vscode.ExtensionContext) {}

  private cfg() {
    const c = vscode.workspace.getConfiguration("changeTracker.trace");
    const env = readEnvConfig();
    const provider = resolveProvider(c.get<string>("provider", ""), env);
    // Precedence: explicit Settings value, then keys-file, then provider default.
    const endpoint = (c.get<string>("endpoint", "").trim() || env.endpoint || "").trim();
    const model = (
      c.get<string>("model", "").trim() ||
      env.model ||
      PROVIDER_DEFAULT_MODEL[provider]
    ).trim();
    // AI narration is an EXPLICIT user toggle (default off). Having a key on
    // disk is necessary but never sufficient — the user must opt in.
    const on = c.get<boolean>("summarize", false);
    const needsEndpoint = PROVIDER_INFO[provider].needsEndpoint;
    const configured = !!env.apiKey && (!needsEndpoint || !!endpoint);
    return {
      provider,
      on,
      hasKey: configured,
      enabled: on && configured,
      endpoint,
      model,
      sendDiffs: c.get<boolean>("sendDiffsToLLM", false)
    };
  }

  /** The user's AI-narration toggle (regardless of whether a key exists). */
  get on(): boolean {
    return this.cfg().on;
  }

  /** Whether credentials are fully configured for the chosen provider. */
  get hasKey(): boolean {
    return this.cfg().hasKey;
  }

  /** AI narration actually works: toggle on AND credentials configured. */
  get enabled(): boolean {
    return this.cfg().enabled;
  }

  /** Flip the AI-narration toggle (persisted as a workspace setting). */
  async setOn(on: boolean): Promise<void> {
    const c = vscode.workspace.getConfiguration("changeTracker.trace");
    try {
      await c.update("summarize", on, vscode.ConfigurationTarget.Workspace);
    } catch {
      await c.update("summarize", on, vscode.ConfigurationTarget.Global);
    }
  }

  async getApiKey(): Promise<string | undefined> {
    // Read only from the workspace keys file (api-keys.txt / .env fallback).
    return readEnvConfig().apiKey;
  }

  /**
   * "Set API Key" — guided flow. AI narration is strictly OPTIONAL: the
   * tracker, time machine and dashboard all work without it; the key only
   * unlocks Explain / file stories / ranked breakage suspects.
   */
  async setApiKey(): Promise<void> {
    const filePath = keysFilePath();
    if (!filePath) {
      vscode.window.showWarningMessage(
        "Trace Your Code: open a folder first so the keys file has a home."
      );
      return;
    }

    const pick = await vscode.window.showQuickPick(
      [
        {
          label: "$(key) Choose a provider & enter the key here",
          description: "recommended — written to api-keys.txt for you",
          action: "input"
        },
        {
          label: "$(go-to-file) Open api-keys.txt to edit by hand",
          description: "advanced",
          action: "file"
        },
        {
          label: "$(circle-slash) Keep AI narration off",
          description: "everything except Explain/Story/Investigate-analysis works without a key",
          action: "off"
        }
      ],
      {
        placeHolder:
          "AI narration is optional — the tracker & dashboard fully work without it. Configure it?"
      }
    );
    if (!pick || pick.action === "off") {
      return;
    }

    if (pick.action === "file") {
      await this.openKeysFile(filePath);
      return;
    }

    await this.promptKeyAndEndpoint(filePath);
  }

  /**
   * The bare provider+key+model(+endpoint) input flow (no entry QuickPick).
   * Used directly when the user flips the AI toggle ON without a key.
   */
  async promptKeyAndEndpoint(filePathOverride?: string): Promise<void> {
    const filePath = filePathOverride ?? keysFilePath();
    if (!filePath) {
      vscode.window.showWarningMessage(
        "Trace Your Code: open a folder first so the keys file has a home."
      );
      return;
    }
    const env = readEnvConfig();
    const current = resolveProvider(undefined, env);

    // 1/4 — provider
    const providerPick = await vscode.window.showQuickPick(
      PROVIDERS.map((p) => ({
        label: PROVIDER_INFO[p].label + (p === current && env.apiKey ? "  (current)" : ""),
        description: PROVIDER_INFO[p].hint,
        provider: p
      })),
      {
        title: "Trace Your Code — AI provider (1/4)",
        placeHolder: "Which LLM should narrate your project story?",
        ignoreFocusOut: true
      }
    );
    if (!providerPick) {
      return;
    }
    const provider = providerPick.provider as LlmProvider;
    const info = PROVIDER_INFO[provider];

    // 2/4 — API key (masked)
    const sameProvider = provider === current;
    const key = await vscode.window.showInputBox({
      title: `Trace Your Code — ${info.label} API key (2/4)`,
      prompt:
        "Stored ONLY in api-keys.txt at the workspace root (gitignored), never inside VS Code.",
      password: true,
      ignoreFocusOut: true,
      placeHolder:
        sameProvider && env.apiKey ? "(leave empty to keep the current key)" : "paste your key…"
    });
    if (key === undefined) {
      return; // cancelled
    }

    // 3/4 — model
    const model = await vscode.window.showInputBox({
      title: `Trace Your Code — model (3/4)`,
      prompt:
        provider === "azure-openai"
          ? "Your Azure deployment name."
          : "Model name. Leave as-is unless you want a specific one.",
      value:
        (sameProvider ? env.model : undefined) ||
        PROVIDER_DEFAULT_MODEL[provider],
      ignoreFocusOut: true
    });
    if (model === undefined) {
      return;
    }

    // 4/4 — endpoint, only when the provider needs one
    let endpoint = sameProvider ? env.endpoint ?? "" : "";
    if (info.needsEndpoint) {
      const entered = await vscode.window.showInputBox({
        title: `Trace Your Code — endpoint URL (4/4)`,
        prompt:
          provider === "azure-openai"
            ? "Your Azure OpenAI endpoint URL (a 'responses' or 'chat/completions' URL including api-version)."
            : "Full URL of an OpenAI-compatible chat-completions endpoint, e.g. https://api.groq.com/openai/v1/chat/completions",
        value: endpoint,
        ignoreFocusOut: true
      });
      if (entered === undefined) {
        return;
      }
      endpoint = entered.trim();
    }

    try {
      let text = fs.existsSync(filePath)
        ? fs.readFileSync(filePath, "utf8")
        : KEYS_FILE_TEMPLATE;
      text = upsertEnvLine(text, "CHANGE_TRACKER_PROVIDER", provider);
      if (key.trim()) {
        text = upsertEnvLine(text, "CHANGE_TRACKER_API_KEY", key.trim());
      }
      text = upsertEnvLine(text, "CHANGE_TRACKER_MODEL", model.trim());
      text = upsertEnvLine(text, "CHANGE_TRACKER_ENDPOINT", endpoint);
      fs.writeFileSync(filePath, text, "utf8");
    } catch (err) {
      vscode.window.showErrorMessage(
        `Trace Your Code: could not write ${KEYS_FILE_NAME} (${String(err)}).`
      );
      return;
    }

    if (this.enabled) {
      vscode.window.showInformationMessage(
        `Trace Your Code: AI narration is ON via ${info.label} — Explain, file stories and ranked breakage suspects are now available. (Everything else never needed the key.)`
      );
    } else if (this.hasKey) {
      vscode.window.showInformationMessage(
        `Trace Your Code: ${info.label} configured. Flip the AI narration toggle on (timeline panel or dashboard) to start using it.`
      );
    } else {
      vscode.window.showInformationMessage(
        `Trace Your Code: saved to ${KEYS_FILE_NAME}. Add a key and turn the AI toggle on — the tracker and dashboard keep working either way.`
      );
    }
  }

  private async openKeysFile(filePath: string): Promise<void> {
    if (!fs.existsSync(filePath)) {
      try {
        fs.writeFileSync(filePath, KEYS_FILE_TEMPLATE, "utf8");
      } catch (err) {
        vscode.window.showErrorMessage(
          `Trace Your Code: could not create ${KEYS_FILE_NAME} (${String(err)}).`
        );
        return;
      }
    }
    const doc = await vscode.workspace.openTextDocument(
      vscode.Uri.file(filePath)
    );
    await vscode.window.showTextDocument(doc, { preview: false });
    vscode.window.showInformationMessage(
      `Trace Your Code: fill in CHANGE_TRACKER_PROVIDER and CHANGE_TRACKER_API_KEY in ${KEYS_FILE_NAME}, then save. It is gitignored and never stored inside VS Code.`
    );
  }

  /** Build the grounded prompt for one turn. */
  private buildInput(turn: TraceTurn, diff?: string): string {
    const lines: string[] = [];
    lines.push(
      "You explain what an AI coding turn actually did, grounded ONLY in the facts below.",
      "Write 1-2 short sentences, plain English, past tense. Do not invent files or changes.",
      "",
      `User prompt: ${turn.prompt || "(none)"}`,
      `Tool actions: ${
        turn.actions.map((a) => a.tool).join(", ") || "(none)"
      }`,
      `Files touched: ${turn.filesTouched.join(", ") || "(none)"}`
    );
    if (turn.response) {
      lines.push(`Assistant said: ${turn.response.slice(0, 600)}`);
    }
    if (diff && this.cfg().sendDiffs) {
      lines.push("", "Diff (truncated):", diff.slice(0, 4000));
    }
    return lines.join("\n");
  }

  get sendDiffs(): boolean {
    return this.cfg().sendDiffs;
  }

  /**
   * Low-level completion, provider-aware. Returns undefined if disabled,
   * missing credentials, or on any network/parse failure (callers keep the
   * structured facts either way).
   */
  private async complete(
    input: string,
    maxTokens: number
  ): Promise<string | undefined> {
    const { enabled, provider, endpoint, model } = this.cfg();
    if (!enabled) {
      return undefined;
    }
    const key = await this.getApiKey();
    if (!key || typeof fetch !== "function") {
      return undefined;
    }

    const req = buildRequest(provider, { endpoint, model, key, input, maxTokens });
    if (!req) {
      return undefined;
    }

    try {
      const res = await fetch(req.url, {
        method: "POST",
        headers: req.headers,
        body: JSON.stringify(req.body)
      });
      if (!res.ok) {
        return undefined;
      }
      const json = (await res.json()) as unknown;
      return extractText(json);
    } catch {
      return undefined;
    }
  }

  /**
   * Summarize one turn (short, ambient). Diff content is included only when
   * changeTracker.trace.sendDiffsToLLM is enabled — this path can run in bulk
   * without the user looking at it, so it stays metadata-only by default.
   */
  async summarizeTurn(
    turn: TraceTurn,
    diff?: string
  ): Promise<string | undefined> {
    return this.complete(this.buildInput(turn, diff), 160);
  }

  /**
   * Grounded "Explain this change" — the deep narrative for one turn. Unlike
   * ambient summaries, this is an explicit user action on a specific turn, so
   * the REAL shadow-git diff is always included: the explanation describes
   * what actually landed on disk, not what the model claimed.
   */
  async explainTurn(
    turn: TraceTurn,
    realDiff: string
  ): Promise<string | undefined> {
    const lines: string[] = [
      "You are explaining one AI coding turn to the developer who owns this project,",
      "so they can LEARN what happened. Ground every statement in the diff below —",
      "never invent files, functions or behavior that are not in the diff.",
      "",
      "Write 3-6 short sentences covering:",
      "1) WHAT changed (files, functions/classes added, removed or modified),",
      "2) WHY — how the change serves the user's prompt,",
      "3) anything the developer should double-check (edge cases, risky spots).",
      "Plain English, past tense, no headers, no bullet lists.",
      "",
      `User prompt: ${turn.prompt || "(none)"}`
    ];
    if (turn.reasoning) {
      lines.push(`Assistant's reasoning (its own thinking): ${turn.reasoning.slice(0, 1200)}`);
    }
    if (turn.response) {
      lines.push(`Assistant's reply (its own claim): ${turn.response.slice(0, 800)}`);
    }
    if (turn.facts) {
      lines.push(
        `Declarations added: ${turn.facts.added.join(", ") || "(none)"}`,
        `Declarations removed: ${turn.facts.removed.join(", ") || "(none)"}`
      );
    }
    lines.push(
      `Files touched: ${turn.filesTouched.join(", ") || "(none)"}`,
      "",
      "Actual diff (ground truth):",
      realDiff.slice(0, 9000) || "(no diff captured for this turn)"
    );
    return this.complete(lines.join("\n"), 500);
  }

  /**
   * "Tell me this file's story" — biography of one file across many turns.
   * Each chapter contributes its prompt and the diff it applied to the file.
   */
  async fileStory(
    relPath: string,
    chapters: Array<{ when: string; prompt: string; diff: string }>
  ): Promise<string | undefined> {
    const lines: string[] = [
      `You are narrating the life story of the file "${relPath}" so its owner`,
      "understands how it evolved. Ground everything in the diffs below.",
      "Write one short paragraph per chapter, chronological, plain English:",
      "what the change did to this file and why (per the prompt). End with a",
      "2-sentence overall arc (e.g. 'started as X, grew Y, refactored to Z').",
      ""
    ];
    let budget = 9000;
    chapters.forEach((c, i) => {
      const d = c.diff.slice(0, Math.max(500, Math.floor(budget / Math.max(1, chapters.length - i))));
      budget -= d.length;
      lines.push(
        `--- Chapter ${i + 1} (${c.when}) ---`,
        `Prompt: ${c.prompt.slice(0, 300)}`,
        `Diff:`,
        d || "(no diff captured)",
        ""
      );
    });
    return this.complete(lines.join("\n"), 700);
  }

  /**
   * Breakage detective: "it worked around turn X, it's broken now — what
   * changed?" Gets the cumulative real diff between the two points and asks
   * for ranked suspects with reasons.
   */
  async investigate(
    description: string,
    fromLabel: string,
    cumulativeDiff: string,
    changedFiles: string[]
  ): Promise<string | undefined> {
    const lines: string[] = [
      "You are a debugging detective. The developer says something broke in",
      "their project. Below is the COMPLETE real diff of everything that",
      "changed between the last-known-good point and now. Identify the most",
      "likely culprit changes.",
      "",
      "Output: a short ranked list (1., 2., 3., max 4 items). For each: the",
      "file + change, why it could cause the described problem, and how to",
      "verify. If nothing in the diff can plausibly cause it, say so honestly.",
      "",
      `Problem description: ${description || "(not given — look for risky changes)"}`,
      `Last known good: ${fromLabel}`,
      `Files changed since then: ${changedFiles.join(", ") || "(none)"}`,
      "",
      "Cumulative diff (ground truth):",
      cumulativeDiff.slice(0, 11000) || "(empty diff)"
    ];
    return this.complete(lines.join("\n"), 700);
  }
}

// ---------------------------------------------------------------------------
// Provider request shapes
// ---------------------------------------------------------------------------

interface LlmRequest {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

function buildRequest(
  provider: LlmProvider,
  p: { endpoint: string; model: string; key: string; input: string; maxTokens: number }
): LlmRequest | undefined {
  const chatBody = {
    model: p.model,
    messages: [{ role: "user", content: p.input }],
    max_tokens: p.maxTokens
  };

  switch (provider) {
    case "openai":
      return {
        url: "https://api.openai.com/v1/chat/completions",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${p.key}`
        },
        // Newer OpenAI models reject max_tokens in favor of max_completion_tokens.
        body: {
          model: p.model,
          messages: [{ role: "user", content: p.input }],
          max_completion_tokens: p.maxTokens
        }
      };

    case "anthropic":
      return {
        url: "https://api.anthropic.com/v1/messages",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": p.key,
          "anthropic-version": "2023-06-01"
        },
        body: {
          model: p.model,
          max_tokens: p.maxTokens,
          messages: [{ role: "user", content: p.input }]
        }
      };

    case "gemini":
      return {
        url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
          p.model
        )}:generateContent`,
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": p.key
        },
        body: {
          contents: [{ parts: [{ text: p.input }] }],
          generationConfig: { maxOutputTokens: p.maxTokens }
        }
      };

    case "openrouter":
      return {
        url: "https://openrouter.ai/api/v1/chat/completions",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${p.key}`
        },
        body: chatBody
      };

    case "azure-openai": {
      if (!p.endpoint) {
        return undefined;
      }
      // Support both the "responses" API and chat-completions deployments —
      // the user pastes the full URL (including api-version), we adapt the body.
      const isResponses = p.endpoint.includes("/responses");
      return {
        url: p.endpoint,
        headers: {
          "Content-Type": "application/json",
          "api-key": p.key
        },
        body: isResponses
          ? { model: p.model, input: p.input, max_output_tokens: p.maxTokens }
          : chatBody
      };
    }

    case "custom":
      if (!p.endpoint) {
        return undefined;
      }
      return {
        url: p.endpoint,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${p.key}`
        },
        body: chatBody
      };
  }
}

/** Replace `KEY=...` in env-file text, or append it if missing. */
function upsertEnvLine(text: string, key: string, value: string): string {
  const re = new RegExp(`^${key}=.*$`, "m");
  if (re.test(text)) {
    return text.replace(re, `${key}=${value}`);
  }
  return text.replace(/\s*$/, "\n") + `${key}=${value}\n`;
}

/**
 * Pull the assistant text out of any supported provider's response shape,
 * defensively: OpenAI/OpenRouter/Azure chat-completions, Azure "responses",
 * Anthropic messages, and Gemini generateContent.
 */
function extractText(json: unknown): string | undefined {
  if (!json || typeof json !== "object") {
    return undefined;
  }
  const o = json as Record<string, unknown>;

  // Azure "responses" convenience field.
  if (typeof o.output_text === "string" && o.output_text.trim()) {
    return o.output_text.trim();
  }

  // Azure "responses" structured output.
  const output = o.output;
  if (Array.isArray(output)) {
    const parts: string[] = [];
    for (const item of output) {
      const content = (item as Record<string, unknown>)?.content;
      if (Array.isArray(content)) {
        for (const c of content) {
          const text = (c as Record<string, unknown>)?.text;
          if (typeof text === "string") {
            parts.push(text);
          }
        }
      }
    }
    if (parts.length) {
      return parts.join(" ").trim();
    }
  }

  // OpenAI / OpenRouter / Azure chat-completions.
  const choices = o.choices;
  if (Array.isArray(choices) && choices.length) {
    const msg = (choices[0] as Record<string, unknown>)?.message as
      | Record<string, unknown>
      | undefined;
    if (msg && typeof msg.content === "string" && msg.content.trim()) {
      return msg.content.trim();
    }
  }

  // Anthropic messages: { content: [{ type: "text", text: "..." }] }
  const content = o.content;
  if (Array.isArray(content)) {
    const parts = content
      .map((b) => (b as Record<string, unknown>)?.text)
      .filter((t): t is string => typeof t === "string");
    if (parts.length) {
      return parts.join(" ").trim();
    }
  }

  // Gemini: { candidates: [{ content: { parts: [{ text: "..." }] } }] }
  const candidates = o.candidates;
  if (Array.isArray(candidates) && candidates.length) {
    const cand = candidates[0] as Record<string, unknown>;
    const cc = cand?.content as Record<string, unknown> | undefined;
    const parts = cc?.parts;
    if (Array.isArray(parts)) {
      const texts = parts
        .map((b) => (b as Record<string, unknown>)?.text)
        .filter((t): t is string => typeof t === "string");
      if (texts.length) {
        return texts.join(" ").trim();
      }
    }
  }

  return undefined;
}
