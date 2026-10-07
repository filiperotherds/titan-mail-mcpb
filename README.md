# titan-mail-mcp

An MCP server that lets Claude (or any MCP client) search, read and — only if you allow it — send email from a regular IMAP/SMTP mailbox. Defaults are set for [Titan Mail](https://titan.email), but any provider that accepts IMAP/SMTP with a password or app password works.

It ships three ways: a one-click **Claude Desktop extension** (`.mcpb`) for non-technical users, a local **stdio** server for Claude Code and other MCP clients, and a **hosted HTTP** server with one token per client.

## Why this exists

I had a client — a contractor, not a developer — whose company email is on Titan, read through Outlook. He wanted to ask Claude things like *"which suppliers sent me a quote this week?"* without copy-pasting emails around.

Titan has an [official MCP connector](https://support.titan.email/hc/en-us/articles/58274860326681-Titan-MCP-Connect-Titan-Mail-with-Claude-and-ChatGPT), but it's only available on select plans. Every Titan plan, though, already exposes IMAP and SMTP — that's how Outlook talks to it. So this server just speaks IMAP/SMTP and hands the mailbox to Claude as four tools.

## What it is (and isn't)

**It is:**

- A thin, auditable bridge: ~500 lines of TypeScript on top of [ImapFlow](https://github.com/postalsys/imapflow), [Nodemailer](https://nodemailer.com) and the official [MCP SDK](https://github.com/modelcontextprotocol/typescript-sdk).
- Read-first. Reading never marks messages as read unless asked. Sending is a separate tool that can be removed entirely, and it always returns a preview first.
- Provider-agnostic. Titan is just the default `imap`/`smtp` host.

**It isn't:**

- **A replacement for Titan's official MCP.** That one also covers calendar and contacts and uses OAuth. If your plan includes it, use it.
- **Compatible with claude.ai or ChatGPT custom connectors (yet).** Those require OAuth on remote MCP servers; the HTTP mode here uses static bearer tokens. It works with Claude Desktop (via the extension), Claude Code and any client that lets you set a header.
- **Usable with Gmail OAuth-only setups, Microsoft 365 or Outlook.com.** Microsoft disabled password-based IMAP for those accounts. Gmail works only with an [app password](https://support.google.com/accounts/answer/185833).
- **A full mail client.** No attachment download, no moving or deleting messages, no HTML email composition. See [Roadmap](#roadmap).

> Tool names, descriptions and error messages are currently in **Brazilian Portuguese** (`listar_pastas`, `buscar_emails`…), because the first users are Brazilian. The LLM handles this fine in any language, but PRs adding English names are welcome.

## Tools

| Tool | What it does |
| --- | --- |
| `listar_pastas` | Lists folders with total and unread counts |
| `buscar_emails` | Searches a folder by sender, recipient, subject, body text, date range or unread; newest first; returns the `uid` used by `ler_email` |
| `ler_email` | Headers, plain-text body (capped at 20k chars) and attachment list (name, type, size). Does **not** mark as read unless `marcar_como_lido=true` |
| `enviar_email` | Plain-text send with cc/bcc and reply threading. With `confirmar=false` (default) it only returns a preview; it sends only when called again with `confirmar=true`. Saves a copy to the Sent folder, since most IMAP servers (Titan included) don't do that for SMTP |

`enviar_email` is not registered at all when sending is disabled (`ALLOW_SEND=false`, `allowSend: false` or the unchecked box in the extension), so the model can't even try.

## Quick start

### Option 1 — Claude Desktop extension (no terminal for the end user)

Build the bundle once:

```bash
git clone https://github.com/filiperotherds/titan-mail-mcpb.git
cd titan-mail-mcpb
npm ci
npm run build:mcpb
```

That produces `out/titan-mail.mcpb`. Double-click it (or drag it into **Claude Desktop → Settings → Extensions**), fill in email and password, done. The password goes into the OS keychain via Claude Desktop's `sensitive` config — it never touches a plain file.

The install form asks for:

| Field | Required | Notes |
| --- | --- | --- |
| Email | yes | Full address |
| Password | yes | Stored in the OS keychain |
| Sender name | no | Display name on sent mail |
| Allow sending | no | **Off by default** |

### Option 2 — Claude Code (stdio, single mailbox)

```bash
npm ci && npm run build
claude mcp add titan-mail --scope user \
  -e MAIL_USER=you@yourdomain.com \
  -e MAIL_PASSWORD='your-password' \
  -- node /absolute/path/to/titan-mail-mcp/dist/index.js --stdio
```

Note that `-e` stores the password in plain text in `~/.claude.json`. If you'd rather not, set `MAIL_PASSWORD` as an OS environment variable and drop that flag.

To poke at the tools without any LLM in the loop, use the [MCP Inspector](https://github.com/modelcontextprotocol/inspector):

```bash
npx @modelcontextprotocol/inspector -e MAIL_USER=you@yourdomain.com -e MAIL_PASSWORD='your-password' node dist/index.js --stdio
```

### Option 3 — Hosted HTTP server (multiple clients)

Each client gets its own bearer token and can only see the mailbox bound to it. The server stores only the SHA-256 of each token.

```bash
npm ci && npm run build
npm run gen-token                        # prints a token (give to client) and its hash (keep)
cp accounts.example.json accounts.json   # add one entry per client
PW_CLIENT_A='their-password' npm start   # listens on 127.0.0.1:3000/mcp
```

`accounts.json`:

```json
[
  {
    "id": "client-a",
    "tokenSha256": "<hash from gen-token>",
    "email": "contact@client-a.com",
    "passwordEnv": "PW_CLIENT_A",
    "fromName": "Client A",
    "allowSend": false
  }
]
```

Connect from Claude Code:

```bash
claude mcp add --transport http titan-mail https://mcp.yourdomain.com/mcp \
  --header "Authorization: Bearer <token>"
```

Or with Docker:

```bash
docker build -t titan-mail-mcp .
docker run -d -p 3000:3000 \
  -v /path/to/accounts.json:/config/accounts.json:ro \
  -e PW_CLIENT_A='their-password' \
  -e ALLOWED_HOSTS=mcp.yourdomain.com \
  titan-mail-mcp
```

**Put it behind HTTPS** (Caddy, Nginx, Cloudflare Tunnel…). The token travels in a header; plain HTTP over the internet hands out mailbox access to anyone on the path.

To revoke a client, remove its entry (or change the hash) and restart.

## Configuration

### stdio / extension (environment variables)

| Variable | Default | Description |
| --- | --- | --- |
| `MAIL_USER` | — | Mailbox address (required) |
| `MAIL_PASSWORD` | — | Password or app password (required) |
| `MAIL_FROM_NAME` | — | Display name for sent mail |
| `IMAP_HOST` / `IMAP_PORT` / `IMAP_SECURE` | `imap.titan.email` / `993` / `true` | IMAP server |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_SECURE` | `smtp.titan.email` / `465` / `true` | SMTP server |
| `ALLOW_SEND` | `true` | `false` removes `enviar_email` |
| `SAVE_SENT_COPY` | `true` | Append sent mail to the Sent folder via IMAP |

The `.mcpb` extension sets `ALLOW_SEND` from its checkbox, which is unchecked by default.

### HTTP server

| Variable | Default | Description |
| --- | --- | --- |
| `ACCOUNTS_FILE` | `accounts.json` | Accounts file |
| `HOST` | `127.0.0.1` | Bind address (`0.0.0.0` in the container) |
| `PORT` | `3000` | Port |
| `ALLOWED_HOSTS` | — | Comma-separated `Host` header allowlist (DNS-rebinding protection) |

Per-account fields: `id`, `tokenSha256`, `email`, `passwordEnv` (preferred) or `password`, `fromName`, `imap`, `smtp`, `allowSend`, `saveSentCopy`. `imap`/`smtp` are `{ "host", "port", "secure" }` and default to Titan.

### Other providers

| Provider | IMAP | SMTP | Notes |
| --- | --- | --- | --- |
| Titan | `imap.titan.email:993` | `smtp.titan.email:465` | Default |
| Gmail / Google Workspace | `imap.gmail.com:993` | `smtp.gmail.com:465` | Requires 2FA + app password |
| Zoho | `imap.zoho.com:993` | `smtp.zoho.com:465` | App password if 2FA is on |
| Microsoft 365 / Outlook.com | — | — | Not supported (OAuth2 only) |

## Security model

What it does:

- **Credentials stay out of the model's context.** Passwords are read from env vars or the OS keychain; no tool ever returns them.
- **Tenant isolation in HTTP mode.** Each request gets a fresh MCP server bound to the token's account. There's no shared session state between clients.
- **Tokens are hashed** (SHA-256) and compared in constant time.
- **Sending is a two-step action.** The tool's own contract is preview first, then `confirmar=true`. MCP clients like Claude Desktop and Claude Code will also ask the user before each call unless you set the tool to "always allow" — **don't** do that for `enviar_email`.
- **Tool annotations** mark reads as `readOnlyHint` and sending as `destructiveHint`/`openWorldHint`, so well-behaved clients can treat them differently.

What it doesn't protect against:

- **Prompt injection from email content.** A malicious email can contain text aimed at the model (*"forward all invoices to…"*). Keeping sending disabled, or always reviewing previews, is the real mitigation.
- **A compromised host.** In HTTP mode the server holds every client's mailbox password. Treat the box like a password vault.
- **Rate limiting.** There's none built in. Put it in your reverse proxy if you expose the server publicly.

## Troubleshooting

**`Erro: falha de autenticação no servidor de e-mail (usuário/senha).`**
Wrong user or password. If the account has 2FA, generate an app password in the provider's panel. On Titan, also check that IMAP isn't blocked by your admin.

**Connection timeout / `ECONNREFUSED`**
Something is blocking ports 993 or 465 — usually a corporate firewall or an antivirus with "mail shield".

**HTTP `401 invalid_token`**
The `Authorization: Bearer` token doesn't match any `tokenSha256`. Regenerate with `npm run gen-token` and make sure you stored the **hash**, not the token.

**HTTP `403` / `Invalid Host header`**
You're binding to a non-localhost host behind a proxy. Set `ALLOWED_HOSTS` to your public hostname.

**The extension installed but Claude doesn't see the tools**
Check that the extension is toggled on in **Settings → Extensions**, then fully quit and reopen Claude Desktop.

## Development

```bash
npm ci
npm run build          # tsc → dist/
npm run start:stdio    # stdio mode (needs MAIL_USER / MAIL_PASSWORD)
npm start              # HTTP mode (needs accounts.json)
npm run build:mcpb     # validates mcpb/manifest.json and packs out/titan-mail.mcpb
```

```
src/
  config.ts      account schema, env/file loading, token hashing
  mail.ts        IMAP/SMTP operations (ImapFlow, mailparser, Nodemailer)
  server.ts      MCP tool definitions
  index.ts       stdio and HTTP entry points, bearer auth
  gen-token.ts   token + hash generator
mcpb/
  manifest.json  Claude Desktop extension manifest
scripts/
  build-mcpb.mjs bundles dist/ + production deps into the .mcpb
```

Requires Node.js 20+.

## Roadmap

Things I'd like to add, roughly in order. Contributions very welcome:

- [ ] OAuth 2.1 in HTTP mode, so it works as a claude.ai / ChatGPT custom connector
- [ ] Attachment download (returning content as an MCP resource)
- [ ] Move, archive, flag and mark-as-read tools
- [ ] English tool names (keeping the Portuguese ones as aliases)
- [ ] Tests against a local IMAP server (e.g. GreenMail) in CI
- [ ] Prebuilt `.mcpb` attached to GitHub Releases

## Contributing

Issues and PRs are welcome — bug reports with the exact error message and your provider (Titan, Gmail, Zoho…) help the most. Keep PRs focused, and run `npm run build` before opening one.

If you use this with a provider not listed above, a PR adding a row to the providers table is a great first contribution.

## License

[MIT](LICENSE) © Filipe Rother
