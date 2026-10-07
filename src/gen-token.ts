import { randomBytes } from "node:crypto";
import { sha256 } from "./config.js";

// Gera um token de acesso para um novo cliente. Entregue o token ao cliente
// e guarde apenas o hash no accounts.json.
const token = `tmcp_${randomBytes(32).toString("base64url")}`;
console.log(`token (entregue ao cliente, não fica salvo):\n  ${token}\n`);
console.log(`tokenSha256 (coloque no accounts.json):\n  ${sha256(token)}`);
