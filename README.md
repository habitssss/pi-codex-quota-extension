# Pi Codex Quota Extension

A Pi Coding Agent extension that displays OpenAI Codex quota usage from Pi OAuth credentials.

## Commands

- `/codex-quota` - show Codex 5h and 7d quota usage
- `/codex-usage` - alias for `/codex-quota`

## Install

Copy `codex-quota.ts` into your Pi agent extensions directory:

```bash
cp codex-quota.ts ~/.pi/agent/extensions/codex-quota.ts
```

Then restart or reload Pi so the extension is loaded.

## Notes

- Reads OAuth credentials from `~/.pi/agent/auth.json` at runtime.
- Tokens are used only in the request header and are never displayed.
- Uses OpenAI's undocumented internal `wham/usage` endpoint, which may change without notice.
