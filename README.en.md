# Free Claude Code on your own server

[Русская версия](README.md)

Not affiliated with Anthropic. Claude Code is installed from the official npm package.

A coding and writing assistant that runs in the terminal of your VPS. Under the hood it is Claude Code (the Anthropic CLI), but instead of paid models it uses the free tiers of several LLM providers. A small local router sits between them: when one provider hits its limit or hangs, the agent moves on to the next one by itself.

## What it is and what it is not

- **Claude Code - yes, free. Claude models - no.** Anthropic has no free API access, and free providers do not serve Claude models. You get open models instead: Kimi, DeepSeek, GLM, Nemotron, Qwen, gpt-oss, Gemini Flash and similar. They are weaker than Claude, especially on large tasks.
- **Your requests go to the providers.** Everything the agent reads and writes (code, text, pieces of files) is sent to the servers of the providers you connected. Do not give it passwords, access keys, personal data or other people's documents. Some free tiers may use requests for model training.
- **Limits are small and change.** By the evening the best models may run out; then the agent uses whatever is left or asks you to wait. More providers mean fewer pauses.
- **No web search.** WebSearch in Claude Code is a server-side Anthropic feature; free providers do not have it. The agent can read a page only if you give it the link and it downloads it with a command.
- **One account per provider.** Do not create several accounts to stretch the limits and do not share your key: that breaks the providers' rules and gets you banned.

## Requirements

- A VPS with Ubuntu 24.04, 1 GB RAM or more, root or sudo access.
- An e-mail address, and for some providers a phone number. None of the listed providers asks for a bank card.

Useful links:
- An inexpensive VPS for AI projects - [link](https://xorek.cloud/?from=52306), promo code r52306.
- Paying for a foreign service from Russia - [link](https://platipomiru.com/?code=IXT2JCYW).

Это не реклама: я сам пользуюсь, выбирайте любые. (This is not an ad: I use these services myself, pick any you like.) The links are referral links.

## Install

Open the server terminal (the hosting web console or your usual SSH session) and paste one command:

> [!WARNING]
> **Install command - copy it in full**
>
> ```
> curl -fsSL https://ty-biznesmen.ru/apps/claude-code-free/install.sh | sudo bash
> ```

The script is readable - you can download and inspect it first. All versions are pinned. Node.js and the project package are checked against SHA-256 sums; Claude Code is installed from the official npm package of a fixed version. Running it again is safe: it updates what is needed and keeps your keys.

What the installer does:

1. Installs Node.js 22 into its own folder `/opt/free-agent` (nothing global) and Claude Code from the official Anthropic package.
2. Creates a service account `freeagent` (no login) and a regular account `aiagent` with no password and no admin rights; Claude Code always runs as `aiagent` and does not see your environment variables.
3. Starts the router as a systemd service listening on `127.0.0.1` only.
4. Enables the ufw firewall: all incoming traffic is blocked except SSH (the port is detected, including non-standard ones). If other public services are already running, or the SSH port cannot be detected, it does not enable the firewall and tells you what to do.
5. Points Claude Code at the router. No Anthropic subscription login, telemetry off.

## Commands

```
agent              # start Claude Code in /home/aiagent/work
sudo agent-setup   # key wizard: providers one by one, with sign-up and key links
sudo agent-stats   # requests, successes, 429/5xx/timeouts per provider for 24 h (sudo agent-stats 6 - for 6 h)
```

More wizard commands:

```
sudo agent-setup add groq       # add or replace one provider key
sudo agent-setup list           # which providers have a key
sudo agent-setup remove groq    # remove a key
sudo agent-uninstall            # remove everything (the firewall stays on)
```

Providers: NVIDIA build.nvidia.com, OpenRouter, Cerebras, Groq, Mistral, Google AI Studio. Start with NVIDIA and OpenRouter - they are the strongest for code. Keys are stored in `/etc/free-agent/keys.json` (mode 600, readable by the service account only). On OpenRouter only free models are used.

How failover works: 429 - pause that model (the whole provider if 429s repeat) and try the next; 5xx or network error - next; no first token for 30 s - next (`first_token_timeout_s` in `/etc/free-agent/config.json`); a cut-off in the middle of an answer - Claude Code retries by itself.

## For code reviewers

- `router/` - the router (Node 22, no external dependencies): `server.mjs` (provider choice, pauses, stats), `upstream.mjs` (first-token wait), `convert.mjs` (Anthropic Messages <-> OpenAI chat/completions);
- `cli/setup.mjs` - key wizard, `cli/stats.mjs` - stats;
- `catalog/models.json` - own catalog of providers and models, nothing is fetched from third-party catalogs;
- `bin/run-claude` - starts Claude Code as `aiagent`; `install.sh`, `uninstall.sh`;
- `tests/` - `node --test tests/router.test.mjs` (with a mock provider), `bash tests/container-test.sh` (install into a clean Ubuntu 24.04 in Docker).

The router talks only to providers you entered a key for. No telemetry, no update checks, no calls to the project's servers.

## Author

Author and developer - Aleksei Gavrilov (Алексей Гаврилов).

- Website: https://ty-biznesmen.ru/
- Telegram bot: https://t.me/aleksey_ai_rabota_bot

## License

GNU GPL version 3 or later (GPL-3.0-or-later), see LICENSE and NOTICE.
Copyright (c) 2026 Aleksei Gavrilov. If you use or modify the code, keep the author credit and the same license.

The routing idea comes from FreeLLMAPI by Tashfeen Ahmed (MIT, https://github.com/tashfeenahmed/freellmapi). No code was copied from it; the code here is written from scratch.
