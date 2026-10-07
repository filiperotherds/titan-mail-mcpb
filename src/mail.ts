import { ImapFlow, type SearchObject } from "imapflow";
import { simpleParser } from "mailparser";
import nodemailer from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import type { Account } from "./config.js";

const MAX_BODY_CHARS = 20_000;

async function withImap<T>(account: Account, fn: (client: ImapFlow) => Promise<T>): Promise<T> {
  const client = new ImapFlow({
    host: account.imap.host,
    port: account.imap.port,
    secure: account.imap.secure,
    auth: { user: account.email, pass: account.resolvedPassword },
    logger: false,
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.logout().catch(() => client.close());
  }
}

export async function listFolders(account: Account) {
  return withImap(account, async (client) => {
    const folders = await client.list({ statusQuery: { messages: true, unseen: true } });
    return folders.map((f) => ({
      caminho: f.path,
      nome: f.name,
      uso_especial: f.specialUse ?? null,
      total: f.status?.messages ?? null,
      nao_lidos: f.status?.unseen ?? null,
    }));
  });
}

export interface SearchParams {
  pasta: string;
  de?: string;
  para?: string;
  assunto?: string;
  texto?: string;
  desde?: string;
  ate?: string;
  nao_lidos?: boolean;
  limite: number;
}

export async function searchEmails(account: Account, p: SearchParams) {
  return withImap(account, async (client) => {
    const lock = await client.getMailboxLock(p.pasta, { readOnly: true });
    try {
      const query: SearchObject = {};
      if (p.de) query.from = p.de;
      if (p.para) query.to = p.para;
      if (p.assunto) query.subject = p.assunto;
      if (p.texto) query.body = p.texto;
      if (p.desde) query.since = new Date(p.desde);
      // BEFORE do IMAP é exclusivo; somamos um dia para "até" ser inclusivo.
      if (p.ate) query.before = new Date(new Date(p.ate).getTime() + 86_400_000);
      if (p.nao_lidos) query.seen = false;
      if (Object.keys(query).length === 0) query.all = true;

      const uids = (await client.search(query, { uid: true })) || [];
      const total = uids.length;
      // UIDs crescem com a chegada; os mais recentes ficam no fim.
      const selected = uids.slice(-p.limite).reverse();
      if (selected.length === 0) return { total, emails: [] };

      const emails = [];
      for await (const msg of client.fetch(selected, { envelope: true, flags: true, bodyStructure: true }, { uid: true })) {
        const env = msg.envelope;
        emails.push({
          uid: msg.uid,
          data: env?.date ? new Date(env.date).toISOString() : null,
          de: env?.from?.map(formatAddress).join(", ") ?? "",
          para: env?.to?.map(formatAddress).join(", ") ?? "",
          assunto: env?.subject ?? "",
          lido: msg.flags?.has("\\Seen") ?? false,
          tem_anexos: hasAttachments(msg.bodyStructure),
        });
      }
      emails.sort((a, b) => b.uid - a.uid);
      return { total, emails };
    } finally {
      lock.release();
    }
  });
}

export async function readEmail(account: Account, pasta: string, uid: number, marcarComoLido: boolean) {
  return withImap(account, async (client) => {
    const lock = await client.getMailboxLock(pasta, { readOnly: !marcarComoLido });
    try {
      const msg = await client.fetchOne(String(uid), { source: true, flags: true }, { uid: true });
      if (!msg || !msg.source) return null;
      if (marcarComoLido) await client.messageFlagsAdd(String(uid), ["\\Seen"], { uid: true });

      const parsed = await simpleParser(msg.source);
      let corpo = parsed.text ?? (parsed.html ? htmlToText(parsed.html) : "");
      const truncado = corpo.length > MAX_BODY_CHARS;
      if (truncado) corpo = corpo.slice(0, MAX_BODY_CHARS);

      return {
        uid,
        pasta,
        message_id: parsed.messageId ?? null,
        data: parsed.date?.toISOString() ?? null,
        de: parsed.from?.text ?? "",
        para: addressText(parsed.to),
        cc: addressText(parsed.cc),
        assunto: parsed.subject ?? "",
        corpo,
        corpo_truncado: truncado,
        anexos: parsed.attachments.map((a) => ({
          nome: a.filename ?? "(sem nome)",
          tipo: a.contentType,
          tamanho_bytes: a.size,
        })),
      };
    } finally {
      lock.release();
    }
  });
}

export interface SendParams {
  para: string[];
  cc?: string[];
  cco?: string[];
  assunto: string;
  corpo: string;
  responder_a_message_id?: string;
}

export async function sendEmail(account: Account, p: SendParams) {
  const message = {
    from: account.fromName ? { name: account.fromName, address: account.email } : account.email,
    to: p.para,
    cc: p.cc,
    bcc: p.cco,
    subject: p.assunto,
    text: p.corpo,
    inReplyTo: p.responder_a_message_id,
    references: p.responder_a_message_id,
  };

  const transport = nodemailer.createTransport({
    host: account.smtp.host,
    port: account.smtp.port,
    secure: account.smtp.secure,
    auth: { user: account.email, pass: account.resolvedPassword },
  });
  const info = await transport.sendMail(message);

  let copiaSalvaEm: string | null = null;
  if (account.saveSentCopy) {
    // Muitos servidores IMAP (incluindo o Titan) não guardam cópia do que sai via SMTP.
    copiaSalvaEm = await withImap(account, async (client) => {
      const sent = (await client.list()).find((f) => f.specialUse === "\\Sent");
      if (!sent) return null;
      const raw = await new MailComposer({ ...message, messageId: info.messageId, date: new Date() }).compile().build();
      await client.append(sent.path, raw, ["\\Seen"]);
      return sent.path;
    }).catch(() => null);
  }

  return { message_id: info.messageId, aceitos: info.accepted, rejeitados: info.rejected, copia_salva_em: copiaSalvaEm };
}

function formatAddress(a: { name?: string; address?: string }) {
  return a.name ? `${a.name} <${a.address}>` : (a.address ?? "");
}

function addressText(a: { text: string } | { text: string }[] | undefined) {
  if (!a) return "";
  return Array.isArray(a) ? a.map((x) => x.text).join(", ") : a.text;
}

function hasAttachments(node: any): boolean {
  if (!node) return false;
  if (node.disposition === "attachment") return true;
  return Array.isArray(node.childNodes) && node.childNodes.some(hasAttachments);
}

function htmlToText(html: string) {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
