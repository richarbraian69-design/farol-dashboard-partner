// =============================================================
//  meta.js - Conexao com a Meta Marketing API e calculo de CPL
// =============================================================
//  Este modulo concentra TODA a logica de:
//   1) descobrir as contas de anuncio do token
//   2) puxar as campanhas e metricas (gasto + leads) de cada conta
//   3) calcular o custo por lead (CPL) de cada campanha
//   4) gerar dados de exemplo quando nao ha token (modo demo)
// =============================================================

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const GRAPH = (version) => `https://graph.facebook.com/${version}`;

// Le o arquivo opcional account-links.json, que mapeia conta -> link
// de um Google Docs (ou qualquer URL). A chave pode ser o ID da conta
// (act_123...) OU o nome exato da conta como aparece no painel.
// Ex.: { "act_123456": "https://docs.google.com/...", "Cliente X": "https://..." }
function loadAccountLinks() {
  try {
    const p = path.join(__dirname, "account-links.json");
    if (existsSync(p)) return JSON.parse(readFileSync(p, "utf8"));
  } catch (e) {
    console.error("Aviso: account-links.json invalido —", e.message);
  }
  return {};
}

// Limita quantas contas sao consultadas em paralelo, para nao
// estourar o limite de requisicoes (rate limit) do Meta.
const CONCURRENCY = 5;

// Janelas de tempo aceitas pelo dashboard -> date_preset do Meta.
export const DATE_PRESETS = {
  today: "today",
  yesterday: "yesterday",
  last_7d: "last_7d",
  last_14d: "last_14d",
  last_30d: "last_30d",
  this_month: "this_month",
  last_month: "last_month",
};

function num(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

// Conta os leads de uma linha de insights SEM contar em dobro.
// O Meta reporta o mesmo lead sob varios action_type que se sobrepoem
// (ex.: "lead", "onsite_conversion.lead_grouped", "leadgen_grouped"),
// todos com o mesmo valor. Somar todos infla o numero (cada lead conta
// 2x ou mais). Por isso pegamos o MAIOR valor entre os tipos de lead
// configurados: ele corresponde ao total ja deduplicado do Meta.
function countLeads(actions, leadTypes) {
  if (!Array.isArray(actions)) return 0;
  let max = 0;
  for (const a of actions) {
    if (leadTypes.includes(a.action_type)) {
      const v = num(a.value);
      if (v > max) max = v;
    }
  }
  return max;
}

async function fetchJson(url) {
  const res = await fetch(url);
  const data = await res.json();
  if (!res.ok || data.error) {
    const msg = data?.error?.message || `HTTP ${res.status}`;
    const err = new Error(msg);
    err.metaError = data?.error || null;
    throw err;
  }
  return data;
}

// Busca, com paginacao, todas as contas de anuncio de UM token.
// Cada conta e marcada com o token que a encontrou (_token), para
// que depois saibamos qual credencial usar ao buscar as campanhas.
// Tambem ja traz os campos de saldo: spend_cap e amount_spent.
async function listAdAccounts(token, version) {
  const fields = "name,account_id,account_status,currency,spend_cap,amount_spent,balance";
  let url =
    `${GRAPH(version)}/me/adaccounts?fields=${fields}` +
    `&limit=200&access_token=${encodeURIComponent(token)}`;

  const accounts = [];
  while (url) {
    const page = await fetchJson(url);
    for (const a of page.data || []) accounts.push({ ...a, _token: token });
    url = page.paging?.next || null;
  }
  return accounts;
}

// Busca os ANUNCIOS de UMA conta junto com: status do anuncio, o link
// do Instagram do criativo, e os dados de conjunto e campanha-mae (com
// seus status) e os insights do periodo — tudo aninhado. Com isso, em
// UMA chamada por conta, montamos a arvore completa:
//   campanha (so ativas) -> conjunto (ativos + pausados) -> anuncio
// Cada nivel recebe seus proprios totais (gasto, leads, CPL).
async function fetchAccountCampaigns(account, config) {
  const { version, datePreset, leadTypes } = config;
  const token = account._token || config.token;
  const insightsSub = `insights.date_preset(${datePreset}){spend,actions}`;
  const fields =
    `name,effective_status,` +
    `adset{id,name,effective_status},` +
    `campaign{id,name,effective_status},` +
    `creative{instagram_permalink_url,effective_instagram_media_id},` +
    insightsSub;
  let next =
    `${GRAPH(version)}/${account.id}/ads?fields=${encodeURIComponent(fields)}` +
    `&limit=500&access_token=${encodeURIComponent(token)}`;

  // Junta todas as paginas de resultados.
  const rows = [];
  while (next) {
    const page = await fetchJson(next);
    rows.push(...(page.data || []));
    next = page.paging?.next || null;
  }

  // Monta a arvore campanha -> conjunto -> anuncio.
  const campMap = new Map();
  for (const row of rows) {
    const camp = row.campaign || {};
    const as = row.adset || {};
    if (!camp.id || !as.id) continue;
    // Item 1: so campanhas ativas (conjuntos e anuncios dentro delas
    // podem estar ativos OU pausados, e ambos serao mostrados).
    if (camp.effective_status !== "ACTIVE") continue;

    const ins = row.insights?.data?.[0];
    if (!ins) continue; // anuncio sem entrega no periodo -> ignora
    const spend = num(ins.spend);
    const leads = countLeads(ins.actions, leadTypes);
    if (spend <= 0 && leads <= 0) continue; // sem atividade real

    const ad = {
      id: row.id,
      name: row.name,
      active: row.effective_status === "ACTIVE",
      instagramUrl: row.creative?.instagram_permalink_url || null,
      spend,
      leads,
      cpl: leads > 0 ? spend / leads : null,
    };

    if (!campMap.has(camp.id)) {
      campMap.set(camp.id, { id: camp.id, name: camp.name, adsetMap: new Map() });
    }
    const cEntry = campMap.get(camp.id);
    if (!cEntry.adsetMap.has(as.id)) {
      cEntry.adsetMap.set(as.id, {
        id: as.id,
        name: as.name,
        active: as.effective_status === "ACTIVE",
        ads: [],
      });
    }
    cEntry.adsetMap.get(as.id).ads.push(ad);
  }

  // Consolida totais de baixo para cima: anuncio -> conjunto -> campanha.
  const campaigns = [...campMap.values()].map((c) => {
    const adsets = [...c.adsetMap.values()].map((s) => {
      const spend = s.ads.reduce((x, a) => x + a.spend, 0);
      const leads = s.ads.reduce((x, a) => x + a.leads, 0);
      return {
        id: s.id,
        name: s.name,
        active: s.active,
        spend,
        leads,
        cpl: leads > 0 ? spend / leads : null,
        ads: s.ads,
      };
    });
    const spend = adsets.reduce((x, s) => x + s.spend, 0);
    const leads = adsets.reduce((x, s) => x + s.leads, 0);
    return { id: c.id, name: c.name, spend, leads, cpl: leads > 0 ? spend / leads : null, adsets };
  });

  const spend = campaigns.reduce((s, c) => s + c.spend, 0);
  const leads = campaigns.reduce((s, c) => s + c.leads, 0);
  // Calcula o saldo de fundos pre-pagos quando disponivel.
  // spend_cap e amount_spent vem em centavos (sem virgula), entao
  // dividimos por 100 para obter o valor real na moeda da conta.
  // Contas pos-pagas nao tem spend_cap definido (null ou "0").
  const spendCap = num(account.spend_cap);
  const amountSpent = num(account.amount_spent);
  const fundsTotal = spendCap > 0 ? spendCap / 100 : null;
  const fundsSpent = spendCap > 0 ? amountSpent / 100 : null;
  const fundsRemaining = fundsTotal != null ? fundsTotal - fundsSpent : null;
  const fundsPct = fundsTotal > 0 ? (fundsSpent / fundsTotal) * 100 : null;

  return {
    id: account.id,
    name: account.name || account.id,
    currency: account.currency || "BRL",
    spend,
    leads,
    cpl: leads > 0 ? spend / leads : null,
    // Saldo de fundos (null = conta pos-paga, sem dado disponivel)
    fundsTotal,
    fundsSpent,
    fundsRemaining,
    fundsPct,
    campaigns,
  };
}

// Processa as contas em lotes para respeitar o rate limit.
async function inBatches(items, size, worker) {
  const out = [];
  for (let i = 0; i < items.length; i += size) {
    const batch = items.slice(i, i + size);
    const results = await Promise.allSettled(batch.map(worker));
    results.forEach((r, idx) => {
      if (r.status === "fulfilled") out.push(r.value);
      else
        out.push({
          id: batch[idx].id,
          name: batch[idx].name || batch[idx].id,
          error: r.reason?.message || "Falha ao carregar a conta",
          campaigns: [],
          spend: 0,
          leads: 0,
          cpl: null,
        });
    });
  }
  return out;
}

// Ponto de entrada principal: devolve o payload completo do dashboard.
export async function getDashboardData({
  datePreset = "last_7d",
  threshold = 35,
} = {}) {
  // Aceita varios tokens (um por BM) em META_ACCESS_TOKENS, separados
  // por virgula. Mantem compatibilidade com o META_ACCESS_TOKEN unico.
  const tokens = (
    process.env.META_ACCESS_TOKENS ||
    process.env.META_ACCESS_TOKEN ||
    ""
  )
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const version = process.env.META_API_VERSION?.trim() || "v21.0";
  const leadTypes = (
    process.env.LEAD_ACTION_TYPES ||
    "lead,onsite_conversion.lead_grouped,offsite_conversion.fb_pixel_lead,leadgen_grouped"
  )
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  // Nenhum token -> modo demonstracao.
  if (!tokens.length) {
    return { demo: true, ...buildDemoData({ threshold }), threshold, datePreset };
  }

  const config = { version, datePreset, leadTypes };
  const notices = [];

  // Resolve quais contas consultar.
  let accountsToQuery = [];
  const explicit = (process.env.META_AD_ACCOUNT_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((id) => (id.startsWith("act_") ? id : `act_${id}`));

  const tokenReport = [];

  if (explicit.length) {
    // Contas fixas: usa o primeiro token como credencial padrao.
    accountsToQuery = explicit.map((id) => ({ id, _token: tokens[0] }));
  } else {
    // Para cada token (cada BM), lista suas contas e junta tudo.
    for (let i = 0; i < tokens.length; i++) {
      const label = `Token #${i + 1}`;
      try {
        const accs = await listAdAccounts(tokens[i], version);
        accountsToQuery.push(...accs);
        tokenReport.push({
          label,
          ok: true,
          count: accs.length,
          accounts: accs.map((a) => a.name || a.id),
        });
        if (accs.length === 0) {
          notices.push(
            `${label}: token valido, mas nao retornou nenhuma conta de anuncio (verifique se o System User tem contas atribuidas e se o token foi gerado com a permissao ads_read).`
          );
        }
      } catch (err) {
        tokenReport.push({ label, ok: false, count: 0, error: err.message });
        notices.push(`${label}: ${err.message}`);
      }
    }
    // Remove contas repetidas (uma mesma conta pode estar em mais de
    // uma BM) mantendo a primeira ocorrencia.
    const seen = new Set();
    accountsToQuery = accountsToQuery.filter((a) => {
      if (seen.has(a.id)) return false;
      seen.add(a.id);
      return true;
    });
  }

  const accounts = await inBatches(accountsToQuery, CONCURRENCY, (acc) =>
    fetchAccountCampaigns(acc, config)
  );

  // Anexa o link (Google Docs etc.) de cada conta, casando por ID ou nome.
  const links = loadAccountLinks();
  for (const a of accounts) {
    a.docUrl = links[a.id] || links[a.name] || null;
  }

  return {
    demo: false,
    generatedAt: new Date().toISOString(),
    currency: accounts[0]?.currency || "BRL",
    threshold,
    datePreset,
    accounts,
    notices,
    tokenReport,
    tokenCount: tokens.length,
  };
}

// -------------------------------------------------------------
//  DADOS DE EXEMPLO (modo demo)
// -------------------------------------------------------------
function buildDemoData({ threshold }) {
  const clientes = [
    "Clinica OdontoVita", "Imobiliaria Horizonte", "Auto Escola Pioneira",
    "Estetica Bella Pelle", "Curso Aprova Mais", "Academia CorpoForte",
    "Advocacia Mendes & Cia", "Pet Shop Patinhas", "Restaurante Sabor da Serra",
    "Construtora Alicerce", "Salao Studio Vip", "Faculdade Saber+",
    "Consultorio Dr. Lima", "Loja Solar Energia", "Financeira CrediFacil",
    "Buffet Festa Boa", "Otica Visao Clara", "Marcenaria Madeira Nobre",
    "Seguros ProtegeBem", "Spa Recanto Zen",
  ];

  const tiposCampanha = [
    "Captacao - Trafego Frio", "Remarketing - Site", "Lookalike 1%",
    "Promo Mensal", "Interesses - Geral", "Video View -> Lead",
    "Formulario Instantaneo", "Black Friday",
  ];

  // Gerador pseudo-aleatorio com semente fixa: dados estaveis a cada carga.
  let seed = 42;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const segmentos = [
    "18-24 · RJ", "25-34 · SP", "35-44 · BR", "Lookalike 1%",
    "Interesses A", "Interesses B", "Retargeting 7d", "Aberto",
  ];

  const accounts = clientes.map((nome, i) => {
    const nCamp = 2 + Math.floor(rand() * 4);
    const usados = new Set();
    const campaigns = [];
    for (let c = 0; c < nCamp; c++) {
      let tipo = pick(tiposCampanha);
      while (usados.has(tipo)) tipo = pick(tiposCampanha);
      usados.add(tipo);

      // Cada campanha tem de 1 a 3 conjuntos.
      const nAdsets = 1 + Math.floor(rand() * 3);
      const adsets = [];
      for (let a = 0; a < nAdsets; a++) {
        const paused = rand() < 0.25; // ~1/4 dos conjuntos pausados
        // Cada conjunto tem de 1 a 3 anuncios.
        const nAds = 1 + Math.floor(rand() * 3);
        const ads = [];
        for (let d = 0; d < nAds; d++) {
          const adPaused = rand() < 0.25;
          let leads, cpl, sp;
          if (rand() < 0.12) {
            leads = 0;
            sp = +(35 + rand() * 50).toFixed(2);
            cpl = null;
          } else {
            leads = 1 + Math.floor(rand() * 25);
            cpl = 13 + rand() * rand() * 72;
            sp = +(cpl * leads).toFixed(2);
          }
          const hasIg = rand() < 0.8;
          ads.push({
            id: `demo_ad_${i}_${c}_${a}_${d}`,
            name: `Criativo ${d + 1} — ${pick(["Vídeo", "Imagem", "Carrossel"])}`,
            active: !adPaused,
            instagramUrl: hasIg ? "https://www.instagram.com/p/EXEMPLO123/" : null,
            spend: sp,
            leads,
            cpl: cpl != null ? +cpl.toFixed(2) : null,
          });
        }
        const aspend = +ads.reduce((s, x) => s + x.spend, 0).toFixed(2);
        const aleads = ads.reduce((s, x) => s + x.leads, 0);
        adsets.push({
          id: `demo_a_${i}_${c}_${a}`,
          name: pick(segmentos),
          active: !paused,
          spend: aspend,
          leads: aleads,
          cpl: aleads > 0 ? +(aspend / aleads).toFixed(2) : null,
          ads,
        });
      }
      const spend = +adsets.reduce((s, x) => s + x.spend, 0).toFixed(2);
      const leads = adsets.reduce((s, x) => s + x.leads, 0);
      campaigns.push({
        id: `demo_c_${i}_${c}`,
        name: tipo,
        spend,
        leads,
        cpl: leads > 0 ? +(spend / leads).toFixed(2) : null,
        adsets,
      });
    }
    const spend = campaigns.reduce((s, x) => s + x.spend, 0);
    const leads = campaigns.reduce((s, x) => s + x.leads, 0);
    // ~60% das contas demo são pré-pagas, ~40% pós-pagas.
    const isPrepaid = rand() < 0.6;
    const fundsTotal = isPrepaid ? +(500 + rand() * 4500).toFixed(2) : null;
    const fundsSpent = isPrepaid ? +(fundsTotal * (0.2 + rand() * 0.85)).toFixed(2) : null;
    const fundsRemaining = isPrepaid ? +(fundsTotal - fundsSpent).toFixed(2) : null;
    const fundsPct = isPrepaid ? (fundsSpent / fundsTotal) * 100 : null;
    return {
      id: `act_demo_${i}`,
      name: nome,
      currency: "BRL",
      docUrl: i % 4 === 0 ? "https://docs.google.com/document/d/EXEMPLO" : null,
      spend: +spend.toFixed(2),
      leads,
      cpl: leads > 0 ? +(spend / leads).toFixed(2) : null,
      fundsTotal,
      fundsSpent,
      fundsRemaining,
      fundsPct,
      campaigns,
    };
  });

  return {
    generatedAt: new Date().toISOString(),
    currency: "BRL",
    accounts,
  };
}
