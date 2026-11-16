# pi-usage

A local Pi package providing the `/usage` command. It reports token and cost history from Pi session files and includes Usage, Quota, and Sessions views.

## Install locally

Add this package as a local source in the Pi agent `settings.json`:

```json
{
  "packages": [
    "/Users/<user>/www/personal-projects/pi-usage"
  ]
}
```

Pi loads `src/index.ts` as the package's sole extension entrypoint. The extension uses Pi's session manager to locate local session history and can show the same report as text outside the TUI.

## Features

- Usage totals, model/tool breakdowns, activity history, charts, periods, and local limits.
- Quota tab for Codex, OpenCode Go, and xAI where credentials are available.
- Session history and per-session drill-downs.
- Quota retrieval is lazy: credentials are looked up and remote endpoints contacted only when the Quota tab is first opened or refreshed.

Quota integrations use provider-specific endpoints, including endpoints that are unofficial and may change:

- **Codex:** reads OAuth data from `~/.codex/auth.json` (or `CODEX_HOME`) and Pi's `~/.pi/agent/auth.json`; queries `https://chatgpt.com/backend-api/wham/usage` and refreshes in memory through `https://auth.openai.com/oauth/token` when needed.
- **OpenCode Go:** checks the supported environment, Pi settings/auth, and OpenCode auth sources; queries `https://opencode.ai/zen/go/v1/usage`.
- **xAI:** reads supported Pi OAuth or API-key sources; queries the Grok billing endpoint or `https://api.x.ai/v1/api-key` as appropriate.

Quota fetches happen only when the Quota tab is opened or refreshed. Missing credentials or endpoint failures degrade to an unavailable/error row and do not prevent local reporting. Credential values are read at runtime and are never logged, printed, or persisted by the plugin. Review `src/providers.ts` before changing credential handling.

Optional local token and budget limits are read from a `usageLimits` object in `~/.pi/agent/settings.json`; the plugin does not write settings. Session records remain in Pi's normal session directory. Do not copy real sessions or auth files into this package.

## Development

Tested with Pi 0.87.1; the extension requires the Pi extension API and TUI peer packages declared in `package.json`. Run tests with Bun.

```sh
bun test tests/*.test.ts
```

Tests use synthetic session records and quota payloads; do not add real session or credential files to this package.
