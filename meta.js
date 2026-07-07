// =============================================================
//  meta.js - Conexao com a Meta Marketing API
// =============================================================
//  Este modulo concentra TODA a logica de:
//   1) descobrir as contas de anuncio do token
//   2) puxar as campanhas e metricas de cada conta
//   3) derivar o "resultado" de cada campanha conforme o OBJETIVO
//      (videoview -> visualizacoes, mensagem -> conversas iniciadas,
//       engajamento -> engajamentos, lead -> leads, etc.)
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

// Le o valor de um action_type especifico dentro do array de actions.
function actionValue(actions, type) {
  if (!Array.isArray(actions)) return 0;
  for (const a of actions) if (a.action_type === type) return num(a.value);
  return 0;
}

// action_type da Meta para "conversas iniciadas por mensagem".
const MSG_TYPE = "onsite_conversion.messaging_conversation_started_7d";

// Deriva o "resultado" de uma linha de insights conforme o objetivo.
// A coluna "Resultados" do Ads Manager depende do objetivo de OTIMIZACAO
// do conjunto (optimization_goal); usamos ele como sinal principal e o
// objetivo da CAMPANHA (objective) como reforco. Retorna { type, value },
// onde `type` e uma chave canonica que a interface traduz em rotulo
// ("views", "conversas", "engaj.", "leads", "cliques", "impressoes").
// `value` e sempre um numero SOMAVEL (por isso usamos impressoes, e nao
// alcance, para objetivos de reconhecimento — alcance nao soma entre linhas).
function deriveResult(ins, goal, objective, leadTypes) {
  const A = ins.actions;
  const g = String(goal || "").toUpperCase();
  const o = String(objective || "").toUpperCase();

  const leads = countLeads(A, leadTypes);
  const messaging = actionValue(A, MSG_TYPE);
  const engagement = actionValue(A, "post_engagement");
  const clicks = actionValue(A, "link_click");
  const thruplay = num(ins.video_thruplay_watched_actions?.[0]?.value);
  const video = thruplay || actionValue(A, "video_view");
  const impressions = num(ins.impressions);
  const purchases =
    actionValue(A, "purchase") ||
    actionValue(A, "onsite_conversion.purchase") ||
    actionValue(A, "offsite_conversion.fb_pixel_purchase");
  const R = (type, value) => ({ type, value: value || 0 });

  // 1) Pelo optimization_goal do conjunto (sinal mais confiavel).
  if (g === "THRUPLAY" || g === "VIDEO_VIEWS") return R("video", video);
  if (g === "CONVERSATIONS" || g.startsWith("MESSAGING")) return R("messaging", messaging);
  if (["POST_ENGAGEMENT", "PROFILE_AND_PAGE_ENGAGEMENT", "ENGAGED_USERS", "PAGE_LIKES", "EVENT_RESPONSES"].includes(g))
    return R("engagement", engagement);
  if (g === "LEAD_GENERATION" || g === "QUALITY_LEAD") return R("leads", leads);
  if (g === "LINK_CLICKS") return R("clicks", clicks);
  if (g === "LANDING_PAGE_VIEWS") return R("clicks", actionValue(A, "landing_page_view") || clicks);
  if (["REACH", "IMPRESSIONS", "AD_RECALL_LIFT"].includes(g)) return R("impressions", impressions);
  if (g === "OFFSITE_CONVERSIONS" || g === "VALUE") return R("other", purchases || leads);

  // 2) Reforco pelo objetivo da campanha.
  if (o.includes("VIDEO")) return R("video", video);
  if (o.includes("MESSAG")) return R("messaging", messaging);
  if (o === "OUTCOME_TRAFFIC" || o === "TRAFFIC" || o === "LINK_CLICKS") return R("clicks", clicks);
  if (o === "OUTCOME_LEADS" || o === "LEAD_GENERATION") return R("leads", leads);
  if (o.includes("AWARENESS") || o === "REACH") return R("impressions", impressions);
  if (o.includes("SALES") || o === "CONVERSIONS") return R("other", purchases || leads);

  // 3) Heuristica: quando o objetivo e ambiguo (ex.: OUTCOME_ENGAGEMENT
  //    abrange video, mensagem e engajamento), escolhe o maior sinal real.
  const cand = [
    ["leads", leads], ["messaging", messaging], ["video", video],
    ["engagement", engagement], ["clicks", clicks],
  ].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  if (cand.length) return R(cand[0][0], cand[0][1]);
  if (impressions > 0) return R("impressions", impressions);
  return R("other", 0);
}

// Consolida o resultado de varios filhos: soma os valores e define o tipo.
// Se todos os filhos compartilham o mesmo tipo, mantem; se divergem (raro
// dentro de uma campanha), marca "misto".
function rollupResult(children) {
  const types = new Set(children.map((c) => c.resultType).filter(Boolean));
  const resultType = types.size === 1 ? [...types][0] : (types.size === 0 ? "other" : "misto");
  const result = children.reduce((x, c) => x + (c.result || 0), 0);
  return { result, resultType };
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
async function listAdAccounts(token, version) {
  const fields = "name,account_id,account_status,currency";
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
// Cada nivel recebe seus proprios totais (gasto e resultado).
async function fetchAccountCampaigns(account, config) {
  const { version, datePreset, leadTypes } = config;
  const token = account._token || config.token;
  const insightsSub =
    `insights.date_preset(${datePreset})` +
    `{spend,impressions,actions,video_thruplay_watched_actions}`;
  const fields =
    `name,effective_status,` +
    `adset{id,name,effective_status,optimization_goal},` +
    `campaign{id,name,effective_status,objective},` +
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
    const r = deriveResult(ins, as.optimization_goal, camp.objective, leadTypes);
    if (spend <= 0 && r.value <= 0) continue; // sem atividade real

    const ad = {
      id: row.id,
      name: row.name,
      active: row.effective_status === "ACTIVE",
      instagramUrl: row.creative?.instagram_permalink_url || null,
      spend,
      result: r.value,
      resultType: r.type,
    };

    if (!campMap.has(camp.id)) {
      campMap.set(camp.id, {
        id: camp.id,
        name: camp.name,
        objective: camp.objective || null,
        adsetMap: new Map(),
      });
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
      const { result, resultType } = rollupResult(s.ads);
      return {
        id: s.id,
        name: s.name,
        active: s.active,
        spend,
        result,
        resultType,
        ads: s.ads,
      };
    });
    const spend = adsets.reduce((x, s) => x + s.spend, 0);
    const { result, resultType } = rollupResult(adsets);
    return { id: c.id, name: c.name, spend, result, resultType, adsets };
  });

  const spend = campaigns.reduce((s, c) => s + c.spend, 0);
  const { result, resultType } = rollupResult(campaigns);
  return {
    id: account.id,
    name: account.name || account.id,
    currency: account.currency || "BRL",
    spend,
    result,
    resultType,
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
          result: 0,
          resultType: "other",
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
function buildDemoData() {
  const clientes = [
    "Clinica Face Harmonia", "Estetica Bella Pelle", "Studio Lorena Bevilaqua",
    "Instituto Renova Estetica", "Clinica Vittalis", "Espaco Derme & Arte",
    "Harmoniza Odonto & Face", "Clinica Dra. Paula Reis", "Belle Ame Estetica",
    "Studio Facial Prime", "Clinica NovaPele", "Espaco Rejuvenesce",
    "Instituto Sublime", "Clinica Essence", "Derma Studio Aurora",
    "Clinica Lumiere", "Face & Forma", "Studio Beleza Real",
    "Clinica Vitta Estetica", "Espaco Zenith",
  ];

  // Cada tipo de campanha reflete um objetivo diferente. O `type` e a chave
  // canonica que a interface traduz em rotulo; o intervalo define a ordem de
  // grandeza plausivel do resultado por anuncio.
  const DEMO_TYPES = [
    { type: "video",       name: "Videoview - Institucional",  min: 200,  max: 2500 },
    { type: "messaging",   name: "Mensagens - WhatsApp",       min: 4,    max: 40 },
    { type: "engagement",  name: "Engajamento - Reels",        min: 80,   max: 900 },
    { type: "leads",       name: "Leads - Avaliacao",          min: 2,    max: 25 },
    { type: "clicks",      name: "Trafego - Agendamento",      min: 20,   max: 260 },
    { type: "impressions", name: "Alcance - Regiao",           min: 2000, max: 30000 },
  ];

  // Gerador pseudo-aleatorio com semente fixa: dados estaveis a cada carga.
  let seed = 42;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const inRange = (t) => t.min + Math.floor(rand() * (t.max - t.min));
  const segmentos = [
    "18-24 · Cidade", "25-34 · Regiao", "35-44 · BR", "Lookalike 1%",
    "Interesses - Estetica", "Retargeting 7d", "Aberto", "Mulheres 30-50",
  ];

  const accounts = clientes.map((nome, i) => {
    const nCamp = 2 + Math.floor(rand() * 4);
    const usados = new Set();
    const campaigns = [];
    for (let c = 0; c < nCamp; c++) {
      let ct = pick(DEMO_TYPES);
      while (usados.has(ct.name)) ct = pick(DEMO_TYPES);
      usados.add(ct.name);

      const nAdsets = 1 + Math.floor(rand() * 3);
      const adsets = [];
      for (let a = 0; a < nAdsets; a++) {
        const paused = rand() < 0.25;
        const nAds = 1 + Math.floor(rand() * 3);
        const ads = [];
        for (let d = 0; d < nAds; d++) {
          const adPaused = rand() < 0.25;
          // ~12% dos anuncios gastaram sem gerar resultado no periodo.
          const dead = rand() < 0.12;
          const result = dead ? 0 : inRange(ct);
          const spend = +(25 + rand() * 260).toFixed(2);
          ads.push({
            id: `demo_ad_${i}_${c}_${a}_${d}`,
            name: `Criativo ${d + 1} — ${pick(["Vídeo", "Imagem", "Carrossel"])}`,
            active: !adPaused,
            instagramUrl: rand() < 0.8 ? "https://www.instagram.com/p/EXEMPLO123/" : null,
            spend,
            result,
            resultType: ct.type,
          });
        }
        adsets.push({
          id: `demo_a_${i}_${c}_${a}`,
          name: pick(segmentos),
          active: !paused,
          spend: +ads.reduce((s, x) => s + x.spend, 0).toFixed(2),
          result: ads.reduce((s, x) => s + x.result, 0),
          resultType: ct.type,
          ads,
        });
      }
      campaigns.push({
        id: `demo_c_${i}_${c}`,
        name: ct.name,
        spend: +adsets.reduce((s, x) => s + x.spend, 0).toFixed(2),
        result: adsets.reduce((s, x) => s + x.result, 0),
        resultType: ct.type,
        adsets,
      });
    }
    const types = new Set(campaigns.map((x) => x.resultType));
    return {
      id: `act_demo_${i}`,
      name: nome,
      currency: "BRL",
      docUrl: i % 4 === 0 ? "https://docs.google.com/document/d/EXEMPLO" : null,
      spend: +campaigns.reduce((s, x) => s + x.spend, 0).toFixed(2),
      result: campaigns.reduce((s, x) => s + x.result, 0),
      resultType: types.size === 1 ? [...types][0] : "misto",
      campaigns,
    };
  });

  return {
    generatedAt: new Date().toISOString(),
    currency: "BRL",
    accounts,
  };
}
