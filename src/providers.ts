// Network + credential discovery for the Quota tab. Tokens and keys are read
// at runtime and never logged, printed, or written anywhere (see package
// README). All functions degrade to `source: "unavailable"` results
// with a human message instead of throwing.
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  decodeChatgptIdToken,
  parseCodexUsageJson,
  parseGoUsageJson,
  parseXaiApiKeyJson,
  parseXaiBillingJson,
  type CodexQuota,
  type GoQuota,
  type XaiQuota,
} from "./analyze.ts";

const REQUEST_TIMEOUT_MS = 10_000;

export interface CodexCreds {
  accessToken: string;
  accountId?: string;
  refreshToken?: string;
  email?: string;
  planType?: string;
}

/** Codex OAuth tokens, in order: the codex CLI auth file (~/.codex/auth.json,
 * CODEX_HOME overrides the location) or pi's /login entry (~/.pi/agent/
 * auth.json -> openai-codex). Read-only: the extension never writes back to
 * either file, even after a token refresh (refreshed tokens stay in memory). */
export function findCodexCreds(): CodexCreds | null {
  const home = process.env.CODEX_HOME ?? join(homedir(), ".codex");
  try {
    const raw = JSON.parse(readFileSync(join(home, "auth.json"), "utf8")) as Record<string, unknown>;
    const tokens = (raw?.tokens ?? {}) as Record<string, unknown>;
    const accessToken = typeof tokens.access_token === "string" ? tokens.access_token : undefined;
    if (accessToken) {
      const claims = typeof tokens.id_token === "string" ? decodeChatgptIdToken(tokens.id_token) : {};
      const identity = (raw?.agent_identity ?? {}) as Record<string, unknown>;
      return {
        accessToken,
        accountId: typeof tokens.account_id === "string" ? tokens.account_id : undefined,
        refreshToken: typeof tokens.refresh_token === "string" ? tokens.refresh_token : undefined,
        email: claims.email ?? (typeof identity.email === "string" ? identity.email : undefined),
        planType: claims.planType ?? (typeof identity.plan_type === "string" ? identity.plan_type : undefined),
      };
    }
  } catch {
    // fall through to pi's auth file
  }
  try {
    const raw = JSON.parse(readFileSync(join(homedir(), ".pi", "agent", "auth.json"), "utf8")) as Record<string, unknown>;
    const entry = (raw?.["openai-codex"] ?? {}) as Record<string, unknown>;
    const accessToken = typeof entry.access === "string" && entry.access !== "" ? entry.access : undefined;
    if (!accessToken) return null;
    const claims = decodeChatgptIdToken(accessToken);
    return {
      accessToken,
      accountId: typeof entry.accountId === "string" ? entry.accountId : claims.accountId,
      refreshToken: typeof entry.refresh === "string" && entry.refresh !== "" ? entry.refresh : undefined,
      email: claims.email,
      planType: claims.planType,
    };
  } catch {
    return null;
  }
}

/** OAuth client id used by the codex CLI for token refresh (openai/codex
 * `codex-rs/login`), overridable via CODEX_APP_SERVER_LOGIN_CLIENT_ID. */
const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

/** Refresh the Codex access token through the standard OAuth token endpoint
 * used by the codex CLI. Returns the new access token, or null on failure. */
export async function refreshCodexAccessToken(refreshToken: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch("https://auth.openai.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: CODEX_CLIENT_ID, grant_type: "refresh_token", refresh_token: refreshToken }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const json = (await res.json()) as Record<string, unknown>;
    return typeof json.access_token === "string" && json.access_token !== "" ? json.access_token : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Fetch the ChatGPT/Codex subscription usage. The endpoint is private
 * (same one behind chatgpt.com/codex/settings/usage and used by community
 * quota tools); it may change — the UI degrades to an error row. On a 401 the
 * access token is refreshed once (in memory) and the request retried. */
export async function fetchCodexUsage(creds: CodexCreds): Promise<CodexQuota> {
  const attempt = async (accessToken: string): Promise<CodexQuota> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch("https://chatgpt.com/backend-api/wham/usage", {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
          ...(creds.accountId ? { "ChatGPT-Account-Id": creds.accountId } : {}),
          Origin: "https://chatgpt.com",
          Referer: "https://chatgpt.com/",
          "User-Agent": "pi-usage/1.0 (pi agent quota check)",
        },
        signal: controller.signal,
      });
      if (res.status === 401) {
        return { source: "unavailable", error: "Codex token expired — run `codex login` to refresh" };
      }
      if (res.status === 403) {
        return { source: "unavailable", error: "Codex account cannot access this endpoint (403)" };
      }
      if (!res.ok) {
        return { source: "unavailable", error: `Codex usage endpoint returned HTTP ${res.status}` };
      }
      const parsed = parseCodexUsageJson(await res.json());
      if (!parsed || parsed.source !== "live") {
        return { source: "unavailable", error: "Unexpected response from the Codex usage endpoint" };
      }
      return { ...parsed, email: creds.email, planType: creds.planType ?? parsed.planType };
    } catch (err) {
      const aborted = err instanceof Error && err.name === "AbortError";
      return {
        source: "unavailable",
        error: aborted ? "Codex usage request timed out" : "Could not reach the Codex usage endpoint",
      };
    } finally {
      clearTimeout(timer);
    }
  };

  let quota = await attempt(creds.accessToken);
  if (quota.source === "unavailable" && creds.refreshToken) {
    const fresh = await refreshCodexAccessToken(creds.refreshToken);
    if (fresh) quota = await attempt(fresh);
  }
  return quota;
}

/** Hint shown when no OpenCode Go key is found anywhere. */
export const GO_KEY_HINT =
  "No OpenCode Go API key — checked OPENCODE_GO_API_KEY/OPENCODE_API_KEY, pi auth.json, settings, opencode auth.json";

/** Resolve a stored key value the same way Pi does for auth.json / models.json:
 * `!command` runs via the shell (stdout only, cached, never logged),
 * `$VAR` / `${VAR}` read the environment, anything else is the literal key. */
const commandResultCache = new Map<string, string | null>();

function executeCommand(command: string): string | null {
  if (commandResultCache.has(command)) return commandResultCache.get(command) ?? null;
  try {
    const output = execSync(command, {
      encoding: "utf-8",
      timeout: REQUEST_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const value = output || null;
    commandResultCache.set(command, value);
    return value;
  } catch {
    commandResultCache.set(command, null);
    return null;
  }
}

function resolveKey(value: string): string | null {
  if (value.startsWith("!")) return executeCommand(value.slice(1));
  const envMatch = value.match(/^\$(?:([A-Za-z_][A-Za-z0-9_]*)|{([A-Za-z_][A-Za-z0-9_]*)})$/);
  if (envMatch) return process.env[envMatch[1] ?? envMatch[2] ?? ""] ?? null;
  return value || null;
}

/** Read a pi auth.json API-key entry ({ provider: { type, key } }). */
function piAuthKey(provider: string): string | null {
  try {
    const raw = JSON.parse(readFileSync(join(homedir(), ".pi", "agent", "auth.json"), "utf8")) as Record<string, unknown>;
    const entry = (raw?.[provider] ?? {}) as Record<string, unknown>;
    return typeof entry.key === "string" && entry.key !== "" ? resolveKey(entry.key) : null;
  } catch {
    return null;
  }
}

/** OpenCode Go API key from (in order): the OPENCODE_GO_API_KEY or
 * OPENCODE_API_KEY env var (pi's documented env for OpenCode Go), pi's
 * auth.json (opencode-go entry), the `opencode-go.apiKey` provider setting in
 * ~/.pi/agent/settings.json, or the opencode CLI auth file. */
export function findGoApiKey(): string | null {
  const fromEnv = process.env.OPENCODE_GO_API_KEY ?? process.env.OPENCODE_API_KEY;
  if (fromEnv) return fromEnv;
  const fromPiAuth = piAuthKey("opencode-go");
  if (fromPiAuth) return fromPiAuth;
  try {
    const settings = JSON.parse(readFileSync(join(homedir(), ".pi", "agent", "settings.json"), "utf8")) as Record<
      string,
      unknown
    >;
    const providers = (settings?.providers ?? {}) as Record<string, unknown>;
    const go = (providers["opencode-go"] ?? {}) as Record<string, unknown>;
    if (typeof go.apiKey === "string" && go.apiKey !== "") {
      const key = resolveKey(go.apiKey);
      if (key) return key;
    }
  } catch {
    // fall through to the opencode auth file
  }
  try {
    const auth = JSON.parse(readFileSync(join(homedir(), ".config", "opencode", "auth.json"), "utf8")) as Record<
      string,
      unknown
    >;
    const entry = (auth?.["opencode-go"] ?? {}) as Record<string, unknown>;
    if (typeof entry.key === "string" && entry.key !== "") {
      const key = resolveKey(entry.key);
      if (key) return key;
    }
  } catch {
    // no key available
  }
  return null;
}

/** Live usage from the OpenCode Zen Go endpoint (server-computed rolling /
 * weekly / monthly windows). Requires a Go API key (see findGoApiKey). */
export async function fetchGoUsage(key: string): Promise<GoQuota> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch("https://opencode.ai/zen/go/v1/usage", {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      signal: controller.signal,
    });
    if (res.status === 401) return { source: "unavailable", error: "OpenCode Go key rejected (401)" };
    if (res.status === 403) return { source: "unavailable", error: "OpenCode Go key has no Go plan (403)" };
    if (!res.ok) return { source: "unavailable", error: `OpenCode Go endpoint returned HTTP ${res.status}` };
    const parsed = parseGoUsageJson(await res.json());
    if (!parsed) return { source: "unavailable", error: "Unexpected response from the OpenCode Go endpoint" };
    return parsed;
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return {
      source: "unavailable",
      error: aborted ? "OpenCode Go request timed out" : "Could not reach the OpenCode Go endpoint",
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Hint shown when no xAI credential is found anywhere. */
export const XAI_KEY_HINT =
  "No xAI auth — checked /login xai (auth.json), XAI_API_KEY, settings providers.xai.apiKey";

/** OAuth client id used by pi's bundled xAI login. */
const XAI_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";

export type XaiCreds =
  | { kind: "oauth"; access: string; refresh?: string }
  | { kind: "api"; key: string };

function readPiAuthEntry(provider: string): Record<string, unknown> | null {
  try {
    const raw = JSON.parse(readFileSync(join(homedir(), ".pi", "agent", "auth.json"), "utf8")) as Record<string, unknown>;
    const entry = raw?.[provider];
    return entry && typeof entry === "object" ? (entry as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** xAI credentials, in order: pi /login OAuth, XAI_API_KEY, auth.json API key,
 * then settings `providers.xai.apiKey`. OAuth is preferred so the Quota tab
 * can show the Grok/X subscription windows. */
export function findXaiCreds(): XaiCreds | null {
  const entry = readPiAuthEntry("xai");
  if (entry?.type === "oauth") {
    const access = typeof entry.access === "string" && entry.access !== "" ? entry.access : undefined;
    if (access) {
      return {
        kind: "oauth",
        access,
        refresh: typeof entry.refresh === "string" && entry.refresh !== "" ? entry.refresh : undefined,
      };
    }
  }
  const fromEnv = process.env.XAI_API_KEY;
  if (fromEnv) return { kind: "api", key: fromEnv };
  const fromPiAuth = piAuthKey("xai");
  if (fromPiAuth) return { kind: "api", key: fromPiAuth };
  try {
    const settings = JSON.parse(readFileSync(join(homedir(), ".pi", "agent", "settings.json"), "utf8")) as Record<
      string,
      unknown
    >;
    const providers = (settings?.providers ?? {}) as Record<string, unknown>;
    const xai = (providers.xai ?? {}) as Record<string, unknown>;
    if (typeof xai.apiKey === "string" && xai.apiKey !== "") {
      const key = resolveKey(xai.apiKey);
      if (key) return { kind: "api", key };
    }
  } catch {
    // no key available
  }
  return null;
}

/** Refresh the xAI OAuth access token. Returns the new access token, or null. */
export async function refreshXaiAccessToken(refreshToken: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch("https://auth.x.ai/oauth2/token", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: XAI_CLIENT_ID,
        refresh_token: refreshToken,
      }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const json = (await res.json()) as Record<string, unknown>;
    return typeof json.access_token === "string" && json.access_token !== "" ? json.access_token : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchXaiBilling(accessToken: string): Promise<XaiQuota> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch("https://cli-chat-proxy.grok.com/v1/billing?format=credits", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
        "X-XAI-Token-Auth": "xai-grok-cli",
        "x-grok-client-surface": "grok-build",
        "User-Agent": "pi-usage/1.0 (pi agent quota check)",
      },
      signal: controller.signal,
    });
    if (res.status === 401) return { source: "unavailable", error: "xAI token expired — run `/login xai` to refresh" };
    if (res.status === 403) return { source: "unavailable", error: "xAI account cannot access billing (403)" };
    if (!res.ok) return { source: "unavailable", error: `xAI billing endpoint returned HTTP ${res.status}` };
    const parsed = parseXaiBillingJson(await res.json());
    if (!parsed || parsed.source !== "live") {
      return { source: "unavailable", error: "Unexpected response from the xAI billing endpoint" };
    }
    return parsed;
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return {
      source: "unavailable",
      error: aborted ? "xAI billing request timed out" : "Could not reach the xAI billing endpoint",
    };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchXaiApiKey(key: string): Promise<XaiQuota> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch("https://api.x.ai/v1/api-key", {
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: "application/json",
        "User-Agent": "pi-usage/1.0 (pi agent quota check)",
      },
      signal: controller.signal,
    });
    if (res.status === 401) return { source: "unavailable", error: "xAI API key rejected (401)" };
    if (res.status === 403) return { source: "unavailable", error: "xAI API key has no access (403)" };
    if (!res.ok) return { source: "unavailable", error: `xAI api-key endpoint returned HTTP ${res.status}` };
    const parsed = parseXaiApiKeyJson(await res.json());
    if (!parsed || parsed.source !== "live") {
      return { source: "unavailable", error: "Unexpected response from the xAI api-key endpoint" };
    }
    return parsed;
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return {
      source: "unavailable",
      error: aborted ? "xAI api-key request timed out" : "Could not reach the xAI api-key endpoint",
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Live usage from the Grok subscription billing endpoint (OAuth) or the
 * xAI API key credit fields. On a 401 the OAuth token is refreshed once in
 * memory and the request retried. */
export async function fetchXaiUsage(creds: XaiCreds): Promise<XaiQuota> {
  if (creds.kind === "api") return fetchXaiApiKey(creds.key);
  let quota = await fetchXaiBilling(creds.access);
  if (quota.source === "unavailable" && creds.refresh) {
    const fresh = await refreshXaiAccessToken(creds.refresh);
    if (fresh) quota = await fetchXaiBilling(fresh);
  }
  return quota;
}
