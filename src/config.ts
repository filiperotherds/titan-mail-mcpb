import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";

const serverSchema = z.object({
  host: z.string(),
  port: z.number().int(),
  secure: z.boolean().default(true),
});

const accountSchema = z
  .object({
    id: z.string().min(1),
    /** SHA-256 (hex) do token de acesso do cliente. Nunca guardamos o token em claro. */
    tokenSha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    email: z.string().email(),
    /** Senha em claro (desaconselhado) ou nome da variável de ambiente que contém a senha. */
    password: z.string().optional(),
    passwordEnv: z.string().optional(),
    fromName: z.string().optional(),
    imap: serverSchema.default({ host: "imap.titan.email", port: 993, secure: true }),
    smtp: serverSchema.default({ host: "smtp.titan.email", port: 465, secure: true }),
    allowSend: z.boolean().default(true),
    saveSentCopy: z.boolean().default(true),
  })
  .refine((a) => a.password || a.passwordEnv, { message: "informe password ou passwordEnv" });

export type Account = z.infer<typeof accountSchema> & { resolvedPassword: string };

function resolve(raw: z.infer<typeof accountSchema>): Account {
  const resolvedPassword = raw.passwordEnv ? process.env[raw.passwordEnv] : raw.password;
  if (!resolvedPassword) {
    throw new Error(`Conta "${raw.id}": variável de ambiente ${raw.passwordEnv} não definida`);
  }
  return { ...raw, resolvedPassword };
}

/** Carrega as contas do arquivo apontado por ACCOUNTS_FILE (modo multi-cliente). */
export function loadAccountsFile(path: string): Account[] {
  const parsed = z.array(accountSchema).parse(JSON.parse(readFileSync(path, "utf8")));
  const accounts = parsed.map(resolve);
  const ids = new Set<string>();
  for (const a of accounts) {
    if (ids.has(a.id)) throw new Error(`id de conta duplicado: ${a.id}`);
    if (!a.tokenSha256) throw new Error(`Conta "${a.id}": tokenSha256 é obrigatório no modo HTTP`);
    ids.add(a.id);
  }
  return accounts;
}

/** Conta única a partir de variáveis de ambiente (modo stdio / uso local). */
export function loadAccountFromEnv(): Account {
  // Hosts como o Claude Desktop podem repassar "${user_config.x}" literal quando um campo opcional fica vazio.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([, v]) => v && !v.startsWith("${")),
  ) as NodeJS.ProcessEnv;
  return resolve(
    accountSchema.parse({
      id: "local",
      email: env.MAIL_USER,
      passwordEnv: "MAIL_PASSWORD",
      fromName: env.MAIL_FROM_NAME,
      imap: env.IMAP_HOST
        ? { host: env.IMAP_HOST, port: Number(env.IMAP_PORT ?? 993), secure: env.IMAP_SECURE !== "false" }
        : undefined,
      smtp: env.SMTP_HOST
        ? { host: env.SMTP_HOST, port: Number(env.SMTP_PORT ?? 465), secure: env.SMTP_SECURE !== "false" }
        : undefined,
      allowSend: env.ALLOW_SEND !== "false",
      saveSentCopy: env.SAVE_SENT_COPY !== "false",
    }),
  );
}

export function sha256(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function findAccountByToken(accounts: Account[], token: string): Account | undefined {
  const hash = Buffer.from(sha256(token), "hex");
  return accounts.find((a) => timingSafeEqual(Buffer.from(a.tokenSha256!, "hex"), hash));
}
