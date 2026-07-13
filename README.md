# Pi Codex Quota Extension

A Pi Coding Agent extension that displays OpenAI Codex quota usage from Pi OAuth credentials.

## Install

Install directly from GitHub:

```bash
pi install git:github.com/habitssss/pi-codex-quota-extension
```

Then restart Pi or run `/reload` so the extension is loaded.

## Commands

- `/codex-quota` - show the currently available Codex quota windows
- `/codex-usage` - alias for `/codex-quota`

## Manual install

Alternatively, copy `codex-quota.ts` into your Pi agent extensions directory:

```bash
cp codex-quota.ts ~/.pi/agent/extensions/codex-quota.ts
```

Then restart Pi or run `/reload`.

## Notes

- Reads OAuth credentials from `~/.pi/agent/auth.json` at runtime.
- Tokens are used only in the request header and are never displayed.
- Quota windows are labeled from the durations returned by OpenAI, so the output adapts when short-term limits are added or removed.
- Uses OpenAI's undocumented internal `wham/usage` endpoint, which may change without notice.
