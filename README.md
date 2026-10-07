# titan-mail-mcp

Servidor MCP que expõe uma caixa de e-mail via IMAP/SMTP. O padrão é o Titan
(`imap.titan.email` / `smtp.titan.email`), mas cada conta pode apontar para qualquer provedor.

## Ferramentas

| Ferramenta | O que faz |
| --- | --- |
| `listar_pastas` | Pastas com total de mensagens e não lidas |
| `buscar_emails` | Busca por remetente, destinatário, assunto, texto, período e não lidos (mais recentes primeiro) |
| `ler_email` | Cabeçalhos, corpo em texto (até 20 mil caracteres) e lista de anexos. Não marca como lido, a não ser que `marcar_como_lido=true` |
| `enviar_email` | Envio em texto simples. Com `confirmar=false` (padrão) só devolve uma prévia; envia apenas com `confirmar=true`. Salva uma cópia em "Enviados". |

## Modos de execução

### HTTP (hospedado, vários clientes)

Cada cliente recebe um **token próprio** e só enxerga a caixa de e-mail ligada a esse token.
O servidor guarda apenas o hash SHA-256 do token.

```bash
npm ci
npm run build
npm run gen-token          # gera token + hash para um cliente
cp accounts.example.json accounts.json   # e edite
PW_CLIENTE_EXEMPLO='senha' npm start
```

Endpoint: `POST /mcp` com `Authorization: Bearer <token>`. Health check: `GET /healthz`.

| Variável | Padrão | Descrição |
| --- | --- | --- |
| `ACCOUNTS_FILE` | `accounts.json` | Arquivo de contas |
| `HOST` | `127.0.0.1` | Interface de escuta (`0.0.0.0` em container) |
| `PORT` | `3000` | Porta |
| `ALLOWED_HOSTS` | — | Hostnames aceitos no header `Host`, separados por vírgula (ex.: `mcp.seudominio.com.br`) |

Campos de cada conta em `accounts.json`: `id`, `tokenSha256`, `email`, `passwordEnv` (nome da
variável com a senha; prefira isso a `password` em claro), `fromName`, `imap`, `smtp`,
`allowSend` (false remove a ferramenta de envio) e `saveSentCopy`.

### Docker

```bash
docker build -t titan-mail-mcp .
docker run -d -p 3000:3000 \
  -v /caminho/accounts.json:/config/accounts.json:ro \
  -e PW_CLIENTE_EXEMPLO='senha' \
  -e ALLOWED_HOSTS=mcp.seudominio.com.br \
  titan-mail-mcp
```

Coloque o servidor **atrás de HTTPS** (Caddy, Nginx, Cloudflare Tunnel etc.). O token viaja no
header, então HTTP puro na internet expõe o acesso à caixa de e-mail.

### stdio (local, uma conta)

```bash
MAIL_USER=contato@seudominio.com.br MAIL_PASSWORD='senha' npm run start:stdio
```

Variáveis opcionais: `MAIL_FROM_NAME`, `IMAP_HOST`/`IMAP_PORT`/`IMAP_SECURE`,
`SMTP_HOST`/`SMTP_PORT`/`SMTP_SECURE`, `ALLOW_SEND=false`, `SAVE_SENT_COPY=false`.

## Conectando clientes

**Claude Code (servidor hospedado):**

```bash
claude mcp add --transport http titan-mail https://mcp.seudominio.com.br/mcp --header "Authorization: Bearer <token>"
```

**Claude Code (local, stdio):**

```bash
claude mcp add titan-mail -e MAIL_USER=contato@seudominio.com.br -e MAIL_PASSWORD=senha -- node /caminho/titan-mail-mcp/dist/index.js --stdio
```

Outros clientes MCP que aceitam Streamable HTTP com header customizado funcionam da mesma forma.
O claude.ai e o ChatGPT exigem OAuth em conectores remotos e **não** aceitam token fixo; para eles
seria preciso adicionar um fluxo OAuth ao servidor.

## Adicionar ou revogar um cliente

1. `npm run gen-token` e entregue o token ao cliente.
2. Acrescente a conta em `accounts.json` com o `tokenSha256` gerado e defina a variável da senha.
3. Reinicie o servidor. Para revogar, remova a conta (ou troque o hash) e reinicie.
