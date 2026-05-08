import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Markdown } from "@earendil-works/pi-tui";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

type AuthEntry = Record<string, unknown>;

type Credentials = {
  provider: string;
  accessToken: string;
  accountId?: string;
  email?: string;
  expires?: number;
};

type WindowInfo = {
  used_percent?: number;
  limit_window_seconds?: number;
  reset_after_seconds?: number;
  reset_at?: number;
};

type RateLimitInfo = {
  allowed?: boolean;
  limit_reached?: boolean;
  primary_window?: WindowInfo | null;
  secondary_window?: WindowInfo | null;
};

type UsageResponse = {
  user_id?: string;
  account_id?: string;
  email?: string;
  plan_type?: string;
  rate_limit?: RateLimitInfo;
  code_review_rate_limit?: RateLimitInfo;
  credits?: {
    has_credits?: boolean;
    unlimited?: boolean;
    balance?: string | number | null;
    approx_local_messages?: [number, number];
    approx_cloud_messages?: [number, number];
  };
  spend_control?: { reached?: boolean };
};

const AUTH_PATH = join(homedir(), ".pi", "agent", "auth.json");
const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const BAR_WIDTH = 12;
const TIMEOUT_MS = 10_000;

export default function (pi: ExtensionAPI) {
  pi.registerMessageRenderer("codex-quota", (message, _options, _theme) => {
    return new Markdown(String(message.content ?? ""), 0, 0, getMarkdownTheme());
  });

  pi.registerCommand("codex-quota", {
    description: "Show OpenAI Codex 5h and 7d quota usage from Pi OAuth credentials",
    handler: async (_args, ctx) => {
      try {
        const markdown = await buildQuotaMarkdown();
        pi.sendMessage({ customType: "codex-quota", content: markdown, display: true });
      } catch (error) {
        ctx.ui.notify(formatSafeError(error), "error");
      }
    },
  });

  pi.registerCommand("codex-usage", {
    description: "Alias for /codex-quota",
    handler: async (_args, ctx) => {
      try {
        const markdown = await buildQuotaMarkdown();
        pi.sendMessage({ customType: "codex-quota", content: markdown, display: true });
      } catch (error) {
        ctx.ui.notify(formatSafeError(error), "error");
      }
    },
  });

}

async function buildQuotaMarkdown(): Promise<string> {
  const credentials = await loadCredentials();
  const usage = await fetchUsage(credentials);
  return renderUsage(credentials, usage);
}

async function loadCredentials(): Promise<Credentials> {
  let raw: string;
  try {
    raw = await readFile(AUTH_PATH, "utf8");
  } catch {
    throw new Error(`Pi auth file not found: ${AUTH_PATH}. Run /login and choose OpenAI/Codex first.`);
  }

  let auth: Record<string, unknown>;
  try {
    auth = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error(`Failed to parse Pi auth file: ${AUTH_PATH}`);
  }

  const providerOrder = ["openai-codex", "codex", "openai", "chatgpt"];
  const entries = Object.entries(auth).sort(([a], [b]) => {
    const ai = providerOrder.indexOf(a);
    const bi = providerOrder.indexOf(b);
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
  });

  for (const [provider, value] of entries) {
    if (!providerOrder.includes(provider) && !provider.toLowerCase().includes("openai") && !provider.toLowerCase().includes("codex") && !provider.toLowerCase().includes("chatgpt")) {
      continue;
    }
    if (!isRecord(value)) continue;

    const accessToken = pickString(value, ["access", "accessToken", "access_token", "token"])
      ?? (isRecord(value.tokens) ? pickString(value.tokens, ["access_token", "accessToken", "access", "token"]) : undefined);
    if (!accessToken) continue;

    const jwt = decodeJwtPayload(accessToken);
    const accountId = pickString(value, ["accountId", "account_id"])
      ?? (isRecord(value.tokens) ? pickString(value.tokens, ["account_id", "accountId"]) : undefined)
      ?? pickJwtString(jwt, ["chatgpt_account_id", "account_id", "accountId"]);
    const email = pickString(value, ["email"])
      ?? (isRecord(value.tokens) ? pickString(value.tokens, ["email"]) : undefined)
      ?? pickJwtString(jwt, ["email"]);
    const expires = pickNumber(value, ["expires", "expiresAt", "expires_at"])
      ?? (isRecord(value.tokens) ? pickNumber(value.tokens, ["expires", "expiresAt", "expires_at"]) : undefined)
      ?? pickJwtNumber(jwt, ["exp"]);

    return { provider, accessToken, accountId, email, expires };
  }

  throw new Error("No usable OpenAI/Codex OAuth access token found in Pi auth.json. Run /login and choose OpenAI/Codex first.");
}

async function fetchUsage(credentials: Credentials): Promise<UsageResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${credentials.accessToken}`,
      Accept: "application/json",
      "User-Agent": "pi-codex-quota-extension",
    };
    if (credentials.accountId) headers["ChatGPT-Account-Id"] = credentials.accountId;

    const response = await fetch(USAGE_URL, {
      method: "GET",
      headers,
      signal: controller.signal,
    });

    const text = await response.text();
    if (response.status === 401 || response.status === 403) {
      throw new Error("OpenAI/Codex OAuth credentials are expired or unauthorized. Re-run /login for OpenAI/Codex.");
    }
    if (!response.ok) {
      throw new Error(`Codex usage API returned HTTP ${response.status}: ${truncate(text, 240)}`);
    }

    try {
      return JSON.parse(text) as UsageResponse;
    } catch {
      throw new Error("Codex usage API returned non-JSON response.");
    }
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Codex usage API timed out after ${TIMEOUT_MS / 1000}s.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function renderUsage(credentials: Credentials, usage: UsageResponse): string {
  const lines: string[] = [];
  const plan = usage.plan_type ?? "unknown";
  const email = usage.email ?? credentials.email;
  const accountId = usage.account_id ?? credentials.accountId;

  lines.push("# Codex quota");
  lines.push("");
  lines.push(`- **Plan:** ${escapeMd(plan)}`);
  if (email) lines.push(`- **Account:** ${escapeMd(email)}`);
  if (accountId) lines.push(`- **Account ID:** ${escapeMd(maskAccountId(accountId))}`);
  lines.push(`- **Credential source:** ${escapeMd(credentials.provider)} in \`${AUTH_PATH}\``);
  if (credentials.expires) lines.push(`- **OAuth token expires:** ${formatEpoch(credentials.expires)}`);
  lines.push(`- **Updated:** ${new Date().toLocaleString()}`);
  lines.push("");

  const rate = usage.rate_limit;
  if (rate) {
    if (typeof rate.allowed === "boolean") lines.push(`- **Allowed:** ${rate.allowed ? "yes" : "no"}`);
    if (typeof rate.limit_reached === "boolean") lines.push(`- **Limit reached:** ${rate.limit_reached ? "yes" : "no"}`);
    if (typeof rate.allowed === "boolean" || typeof rate.limit_reached === "boolean") lines.push("");

    lines.push(renderWindow("5h window", rate.primary_window));
    lines.push("");
    lines.push(renderWindow("7d window", rate.secondary_window));
  } else {
    lines.push("No `rate_limit` field found in the API response. The internal API schema may have changed.");
  }

  if (usage.code_review_rate_limit) {
    lines.push("");
    lines.push("## Code review quota");
    lines.push("");
    lines.push(renderWindow("Primary window", usage.code_review_rate_limit.primary_window));
    if (usage.code_review_rate_limit.secondary_window) {
      lines.push("");
      lines.push(renderWindow("Secondary window", usage.code_review_rate_limit.secondary_window));
    }
  }

  if (usage.credits) {
    lines.push("");
    lines.push("## Credits");
    lines.push("");
    lines.push(`- **Has credits:** ${usage.credits.has_credits ? "yes" : "no"}`);
    lines.push(`- **Unlimited:** ${usage.credits.unlimited ? "yes" : "no"}`);
    if (usage.credits.balance != null) lines.push(`- **Balance:** ${escapeMd(String(usage.credits.balance))}`);
    if (usage.credits.approx_local_messages) lines.push(`- **Approx local messages:** ${usage.credits.approx_local_messages[0]}–${usage.credits.approx_local_messages[1]}`);
    if (usage.credits.approx_cloud_messages) lines.push(`- **Approx cloud messages:** ${usage.credits.approx_cloud_messages[0]}–${usage.credits.approx_cloud_messages[1]}`);
  }

  if (usage.spend_control?.reached != null) {
    lines.push("");
    lines.push(`**Spend control reached:** ${usage.spend_control.reached ? "yes" : "no"}`);
  }

  lines.push("");
  lines.push("> Uses OpenAI's undocumented internal `wham/usage` endpoint. It may change without notice. Tokens are never displayed.");
  return lines.join("\n");
}

function renderWindow(title: string, window: WindowInfo | null | undefined): string {
  if (!window) return `## ${title}\n\nNo data.`;
  const percent = typeof window.used_percent === "number" ? window.used_percent : undefined;
  const bar = percent == null ? "n/a" : progressBar(percent);
  const duration = typeof window.limit_window_seconds === "number" ? formatDuration(window.limit_window_seconds) : "unknown";
  const resetAt = typeof window.reset_at === "number" ? formatEpoch(window.reset_at) : "unknown";
  const resetAfter = typeof window.reset_after_seconds === "number" ? formatDuration(window.reset_after_seconds) : undefined;

  const lines = [`## ${title}`, ""];
  lines.push(`**Usage:** ${bar}${percent == null ? "" : ` ${formatPercent(percent)}`}`);
  lines.push(`- **Window:** ${duration}`);
  lines.push(`- **Reset at:** ${resetAt}`);
  if (resetAfter) lines.push(`- **Reset after:** ${resetAfter}`);
  return lines.join("\n");
}

function progressBar(percent: number): string {
  const filled = Math.round((Math.min(Math.max(percent, 0), 100) / 100) * BAR_WIDTH);
  return "█".repeat(filled) + "░".repeat(BAR_WIDTH - filled);
}

function formatPercent(value: number): string {
  return `${Number.isInteger(value) ? value : value.toFixed(1)}%`;
}

function formatEpoch(epochSeconds: number): string {
  const date = new Date(epochSeconds * 1000);
  const now = new Date();
  const time = date.toLocaleTimeString(undefined, { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
  if (date.toDateString() === now.toDateString()) return time;
  return `${time} on ${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return "unknown";
  const s = Math.max(0, Math.round(seconds));
  const days = Math.floor(s / 86_400);
  const hours = Math.floor((s % 86_400) / 3_600);
  const minutes = Math.floor((s % 3_600) / 60);
  const secs = s % 60;
  const parts: string[] = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  if (!parts.length || (!days && !hours && secs)) parts.push(`${secs}s`);
  return parts.join(" ");
}

function isRecord(value: unknown): value is AuthEntry {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pickString(record: AuthEntry, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function pickNumber(record: AuthEntry, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number") return value > 10_000_000_000 ? Math.floor(value / 1000) : value;
  }
  return undefined;
}

function pickJwtString(payload: Record<string, unknown> | undefined, keys: string[]): string | undefined {
  if (!payload) return undefined;
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function pickJwtNumber(payload: Record<string, unknown> | undefined, keys: string[]): number | undefined {
  if (!payload) return undefined;
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "number") return value;
  }
  return undefined;
}

function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  const part = token.split(".")[1];
  if (!part) return undefined;
  try {
    const normalized = part.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function maskAccountId(accountId: string): string {
  if (accountId.length <= 10) return accountId;
  return `${accountId.slice(0, 6)}…${accountId.slice(-4)}`;
}

function escapeMd(value: string): string {
  return value.replace(/[\\`*_{}[\]()#+.!|-]/g, "\\$&");
}

function truncate(value: string, max: number): string {
  const sanitized = sanitize(value);
  return sanitized.length <= max ? sanitized : `${sanitized.slice(0, max)}…`;
}

function formatSafeError(error: unknown): string {
  if (error instanceof Error) return sanitize(error.message);
  return sanitize(String(error));
}

function sanitize(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/(access|refresh|id)_?token[\"'=:\s]+[A-Za-z0-9._~+/=-]+/gi, "$1_token [redacted]");
}
