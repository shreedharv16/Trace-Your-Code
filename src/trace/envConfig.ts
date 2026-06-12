import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";

/**
 * Minimal, dependency-free reader for a plain-text keys file at the workspace
 * root. This is the ONLY place the summarizer reads credentials from — nothing
 * is stored inside VS Code (no SecretStorage, no settings).
 *
 * Primary file:   api-keys.txt
 * Fallback file:  .env  (for backward compatibility)
 *
 * SECURITY: both files are gitignored by this project — keys must NEVER be
 * committed. Treat any key stored here as exposed if the file is shared, and
 * rotate it immediately if that happens.
 *
 * Recognized keys:
 *   CHANGE_TRACKER_PROVIDER   azure-openai | openai | anthropic | gemini |
 *                             openrouter | custom
 *   CHANGE_TRACKER_API_KEY    the provider's API key
 *   CHANGE_TRACKER_MODEL      model (or Azure deployment) name; empty = the
 *                             provider's default below
 *   CHANGE_TRACKER_ENDPOINT   full URL — required for azure-openai and custom,
 *                             ignored for the hosted providers
 */

/** Supported LLM providers for the optional AI-narration layer. */
export type LlmProvider =
  | "azure-openai"
  | "openai"
  | "anthropic"
  | "gemini"
  | "openrouter"
  | "custom";

export const PROVIDERS: LlmProvider[] = [
  "openai",
  "anthropic",
  "gemini",
  "openrouter",
  "azure-openai",
  "custom"
];

/** Sensible cheap-and-fast default model per provider. */
export const PROVIDER_DEFAULT_MODEL: Record<LlmProvider, string> = {
  "azure-openai": "", // deployment name — no universal default
  openai: "gpt-4o-mini",
  anthropic: "claude-haiku-4-5-20251001",
  gemini: "gemini-2.5-flash",
  openrouter: "openai/gpt-4o-mini",
  custom: ""
};

/** Human labels + hints for the key-setup QuickPick. */
export const PROVIDER_INFO: Record<
  LlmProvider,
  { label: string; hint: string; needsEndpoint: boolean }
> = {
  openai: {
    label: "OpenAI",
    hint: "api.openai.com — key from platform.openai.com",
    needsEndpoint: false
  },
  anthropic: {
    label: "Anthropic (Claude)",
    hint: "api.anthropic.com — key from console.anthropic.com",
    needsEndpoint: false
  },
  gemini: {
    label: "Google Gemini",
    hint: "generativelanguage.googleapis.com — key from AI Studio",
    needsEndpoint: false
  },
  openrouter: {
    label: "OpenRouter",
    hint: "one key, any model — openrouter.ai",
    needsEndpoint: false
  },
  "azure-openai": {
    label: "Azure OpenAI",
    hint: "your Azure resource endpoint + deployment",
    needsEndpoint: true
  },
  custom: {
    label: "Custom (OpenAI-compatible)",
    hint: "Groq, Together, Mistral, DeepSeek, Ollama, …",
    needsEndpoint: true
  }
};

export interface EnvConfig {
  provider?: LlmProvider;
  apiKey?: string;
  endpoint?: string;
  model?: string;
}

/** Workspace-root file the summarizer reads credentials from. */
export const KEYS_FILE_NAME = "api-keys.txt";
const FALLBACK_FILE_NAME = ".env";

/** Absolute path of the primary keys file, if a workspace is open. */
export function keysFilePath(): string | undefined {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  return root ? path.join(root, KEYS_FILE_NAME) : undefined;
}

function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const eq = line.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // strip surrounding quotes if present
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function asProvider(value: string | undefined): LlmProvider | undefined {
  if (!value) {
    return undefined;
  }
  const v = value.trim().toLowerCase();
  return (PROVIDERS as string[]).includes(v) ? (v as LlmProvider) : undefined;
}

/** Read credentials from api-keys.txt, falling back to .env. */
export function readEnvConfig(): EnvConfig {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) {
    return {};
  }
  // Try the primary keys file first, then .env.
  for (const name of [KEYS_FILE_NAME, FALLBACK_FILE_NAME]) {
    let text: string;
    try {
      text = fs.readFileSync(path.join(root, name), "utf8");
    } catch {
      continue;
    }
    const map = parseEnv(text);
    const cfg: EnvConfig = {
      provider: asProvider(map.CHANGE_TRACKER_PROVIDER),
      apiKey: map.CHANGE_TRACKER_API_KEY || undefined,
      endpoint: map.CHANGE_TRACKER_ENDPOINT || undefined,
      model: map.CHANGE_TRACKER_MODEL || undefined
    };
    if (cfg.apiKey || cfg.endpoint || cfg.model || cfg.provider) {
      return cfg;
    }
  }
  return {};
}

/**
 * Resolve the effective provider. Back-compat for pre-multi-provider configs:
 * an endpoint with no provider line means Azure OpenAI (the only option that
 * existed); no provider and no endpoint defaults to OpenAI.
 */
export function resolveProvider(
  explicit: string | undefined,
  env: EnvConfig
): LlmProvider {
  return (
    asProvider(explicit) ??
    env.provider ??
    (env.endpoint ? "azure-openai" : "openai")
  );
}
