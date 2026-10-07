import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { findAccountByToken, loadAccountFromEnv, loadAccountsFile, type Account } from "./config.js";
import { createMailServer } from "./server.js";

const mode = process.argv.includes("--stdio") ? "stdio" : "http";

if (mode === "stdio") {
  await createMailServer(loadAccountFromEnv()).connect(new StdioServerTransport());
} else {
  startHttp();
}

function startHttp() {
  const accountsFile = process.env.ACCOUNTS_FILE ?? "accounts.json";
  const accounts = loadAccountsFile(accountsFile);
  const host = process.env.HOST ?? "127.0.0.1";
  const port = Number(process.env.PORT ?? 3000);
  const allowedHosts = process.env.ALLOWED_HOSTS?.split(",").map((h) => h.trim());

  const app = createMcpExpressApp({ host, allowedHosts });
  app.set("trust proxy", 1);

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true });
  });

  const auth = requireBearerAuth({
    verifier: {
      async verifyAccessToken(token) {
        const account = findAccountByToken(accounts, token);
        if (!account) throw new InvalidTokenError("token inválido");
        // O middleware exige expiração; os tokens são estáticos, então renovamos a cada requisição.
        return { token, clientId: account.id, scopes: [], expiresAt: Math.floor(Date.now() / 1000) + 3600 };
      },
    },
  });

  const byId = new Map<string, Account>(accounts.map((a) => [a.id, a]));

  // Modo stateless: um servidor/transporte por requisição, isolado por conta.
  app.post("/mcp", auth, async (req, res) => {
    const account = byId.get(req.auth!.clientId)!;
    const server = createMailServer(account);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error(`[${account.id}]`, err);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Erro interno" }, id: null });
      }
    }
  });

  const methodNotAllowed = (_req: unknown, res: { status: (c: number) => { json: (b: unknown) => void } }) =>
    res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Método não permitido" }, id: null });
  app.get("/mcp", methodNotAllowed);
  app.delete("/mcp", methodNotAllowed);

  app.listen(port, host, () => {
    console.log(`titan-mail-mcp ouvindo em http://${host}:${port}/mcp (${accounts.length} conta(s))`);
  });
}
