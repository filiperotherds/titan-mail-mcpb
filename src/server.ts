import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Account } from "./config.js";
import { listFolders, readEmail, searchEmails, sendEmail } from "./mail.js";

const json = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
const fail = (message: string) => ({ content: [{ type: "text" as const, text: message }], isError: true });

async function run<T>(fn: () => Promise<T>) {
  try {
    return json(await fn());
  } catch (err: any) {
    if (err?.authenticationFailed) return fail("Erro: falha de autenticação no servidor de e-mail (usuário/senha).");
    const detail = err?.responseText ?? err?.response ?? err?.message ?? String(err);
    return fail(`Erro: ${detail}`);
  }
}

/** Cria um servidor MCP ligado a uma única conta de e-mail. */
export function createMailServer(account: Account): McpServer {
  const server = new McpServer({ name: "titan-mail-mcp", version: "1.0.0" });

  server.registerTool(
    "listar_pastas",
    {
      title: "Listar pastas",
      description: "Lista as pastas da caixa de e-mail com total de mensagens e não lidas.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    () => run(() => listFolders(account)),
  );

  server.registerTool(
    "buscar_emails",
    {
      title: "Buscar e-mails",
      description:
        "Busca e-mails numa pasta por remetente, destinatário, assunto, texto, período ou não lidos. " +
        "Retorna os mais recentes primeiro, com o uid usado por ler_email.",
      inputSchema: {
        pasta: z.string().default("INBOX").describe("Caminho da pasta (veja listar_pastas)"),
        de: z.string().optional().describe("Parte do remetente (nome ou endereço)"),
        para: z.string().optional().describe("Parte do destinatário"),
        assunto: z.string().optional(),
        texto: z.string().optional().describe("Texto no corpo da mensagem"),
        desde: z.string().optional().describe("Data inicial, AAAA-MM-DD (inclusiva)"),
        ate: z.string().optional().describe("Data final, AAAA-MM-DD (inclusiva)"),
        nao_lidos: z.boolean().optional().describe("Somente não lidos"),
        limite: z.number().int().min(1).max(100).default(20),
      },
      annotations: { readOnlyHint: true },
    },
    (args) => run(() => searchEmails(account, args)),
  );

  server.registerTool(
    "ler_email",
    {
      title: "Ler e-mail",
      description: "Lê o conteúdo completo de um e-mail (cabeçalhos, corpo em texto e lista de anexos).",
      inputSchema: {
        uid: z.number().int().positive().describe("uid retornado por buscar_emails"),
        pasta: z.string().default("INBOX"),
        marcar_como_lido: z.boolean().default(false),
      },
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    ({ uid, pasta, marcar_como_lido }) =>
      run(async () => {
        const email = await readEmail(account, pasta, uid, marcar_como_lido);
        if (!email) throw new Error(`e-mail uid ${uid} não encontrado em ${pasta}`);
        return email;
      }),
  );

  if (account.allowSend) {
    server.registerTool(
      "enviar_email",
      {
        title: "Enviar e-mail",
        description:
          "Envia um e-mail em texto simples. Com confirmar=false (padrão) apenas devolve uma prévia; " +
          "mostre a prévia ao usuário e só chame de novo com confirmar=true depois que ele aprovar.",
        inputSchema: {
          para: z.array(z.string().email()).min(1),
          cc: z.array(z.string().email()).optional(),
          cco: z.array(z.string().email()).optional(),
          assunto: z.string(),
          corpo: z.string(),
          responder_a_message_id: z.string().optional().describe("message_id do e-mail respondido (de ler_email)"),
          confirmar: z.boolean().default(false),
        },
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      },
      ({ confirmar, ...msg }) =>
        run(async () => {
          if (!confirmar) {
            return { status: "previa", de: account.email, ...msg, aviso: "Nada foi enviado. Reenvie com confirmar=true." };
          }
          return { status: "enviado", ...(await sendEmail(account, msg)) };
        }),
    );
  }

  return server;
}
