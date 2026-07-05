// =============================================================
//  server.js - Servidor do Farol
// =============================================================
//  Responsavel por:
//   - guardar o token do Meta com seguranca (so no servidor)
//   - proteger o painel com login (ver auth.js)
//   - servir a interface (pasta public/)
//   - expor o endpoint /api/data que entrega os dados ja tratados
// =============================================================

import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getDashboardData, DATE_PRESETS } from "./meta.js";
import {
  authEnabled,
  isAuthed,
  handleLogin,
  handleLogout,
  loginPageHtml,
} from "./auth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ---------- Login / sessao ----------
app.get("/login", (req, res) => {
  if (isAuthed(req)) return res.redirect("/");
  res.type("html").send(loginPageHtml());
});
app.post("/api/login", handleLogin);
app.post("/api/logout", handleLogout);

// Middleware que exige login para a pagina e a API de dados.
function requireAuth(req, res, next) {
  if (isAuthed(req)) return next();
  // Para chamadas de API, responde 401; para paginas, manda pro login.
  if (req.path.startsWith("/api/")) {
    return res.status(401).json({ error: "Não autenticado.", login: true });
  }
  return res.redirect("/login");
}

// ---------- Endpoint principal de dados (protegido) ----------
// Cache curto em memoria: evita refazer as buscas pesadas no Meta a
// cada carregamento. Chave = periodo. "Atualizar" envia fresh=1.
const cache = new Map();
const CACHE_TTL = (parseInt(process.env.CACHE_TTL_SECONDS, 10) || 300) * 1000;

app.get("/api/data", requireAuth, async (req, res) => {
  try {
    const range = DATE_PRESETS[req.query.range] ? req.query.range : "last_7d";
    const threshold =
      parseFloat(req.query.threshold) ||
      parseFloat(process.env.CPL_THRESHOLD) ||
      35;
    const fresh = req.query.fresh === "1";

    if (!fresh && cache.has(range)) {
      const c = cache.get(range);
      if (Date.now() - c.ts < CACHE_TTL) {
        return res.json({
          ...c.data,
          threshold,
          cached: true,
          cacheAge: Math.round((Date.now() - c.ts) / 1000),
          auth: authEnabled,
        });
      }
    }

    const data = await getDashboardData({ datePreset: range, threshold });
    if (!data.demo) cache.set(range, { ts: Date.now(), data });
    res.json({ ...data, auth: authEnabled });
  } catch (err) {
    console.error("Erro ao carregar dados:", err.message);
    res.status(500).json({
      error: err.message || "Erro inesperado ao consultar o Meta.",
      hint: err.metaError
        ? "O Meta retornou um erro. Verifique se o token e valido e tem as permissoes ads_read."
        : undefined,
    });
  }
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, auth: authEnabled });
});

// ---------- Pagina principal (protegida) ----------
app.get("/", requireAuth, (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Arquivos estaticos (sem servir index.html automaticamente, para que
// a pagina sempre passe pela checagem de login acima).
app.use(express.static(path.join(__dirname, "public"), { index: false }));

app.listen(PORT, () => {
  console.log(`\n  Farol rodando em  http://localhost:${PORT}`);
  console.log(`  Login: ${authEnabled ? "ATIVADO" : "DESATIVADO (defina AUTH_USER e AUTH_PASSWORD)"}\n`);
});
