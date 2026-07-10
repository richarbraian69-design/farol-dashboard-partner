// =============================================================
//  server.js - Servidor do Farol
// =============================================================
//  Responsavel por:
//   - guardar o token do Meta com seguranca (so no servidor)
//   - servir a interface (pasta public/)
//   - expor o endpoint /api/data que entrega os dados ja tratados
// =============================================================

import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getDashboardData, getActionTypesReport, DATE_PRESETS } from "./meta.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

// Marca da versao no ar: aparece no rodape do painel e em /api/health.
// Sempre que subir uma mudanca, confira se este valor mudou na tela.
const BUILD = "2026-07-09 · contatos-no-site";

// Live se QUALQUER uma das variaveis de token estiver definida.
const isLive = () =>
  Boolean(process.env.META_ACCESS_TOKENS || process.env.META_ACCESS_TOKEN);

app.use(express.static(path.join(__dirname, "public")));

// Endpoint principal de dados.
//   /api/data?range=last_7d&threshold=35
// Cache curto em memoria: evita refazer as buscas pesadas no Meta a
// cada carregamento. Chave = periodo (o teto e aplicado no navegador,
// entao nao afeta os dados buscados). O botao "Atualizar" envia
// fresh=1 para forcar uma busca nova.
const cache = new Map();
const CACHE_TTL = (parseInt(process.env.CACHE_TTL_SECONDS, 10) || 300) * 1000;

app.get("/api/data", async (req, res) => {
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
          build: BUILD,
          cached: true,
          cacheAge: Math.round((Date.now() - c.ts) / 1000),
        });
      }
    }

    const data = await getDashboardData({ datePreset: range, threshold });
    if (!data.demo) cache.set(range, { ts: Date.now(), data });
    res.json({ ...data, build: BUILD });
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

// Diagnostico: mostra os action_type reais que a Meta devolve, por conta.
//   /api/debug/actions?range=last_7d
// Use quando o painel mostrar "-" mas o gerenciador mostrar numero: o nome
// exato do evento aparece aqui e pode ir para CONTACT_ACTION_TYPES.
app.get("/api/debug/actions", async (req, res) => {
  try {
    const range = DATE_PRESETS[req.query.range] ? req.query.range : "last_7d";
    res.json(await getActionTypesReport({ datePreset: range }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    build: BUILD,
    mode: isLive() ? "live" : "demo",
  });
});

app.listen(PORT, () => {
  const mode = isLive() ? "CONECTADO ao Meta" : "MODO DEMO";
  console.log(`\n  Farol rodando em  http://localhost:${PORT}`);
  console.log(`  Build:  ${BUILD}`);
  console.log(`  Status: ${mode}\n`);
});
