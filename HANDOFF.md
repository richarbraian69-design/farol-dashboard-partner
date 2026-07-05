# Farol — Briefing para continuar o projeto em outro chat

> Cole este documento no novo chat **junto com o arquivo `farol-cpl-dashboard.zip`**.
> O zip contém TODO o código e o README. Este briefing explica o contexto e as
> decisões que não são óbvias só lendo o código.

---

## 1. O que é o projeto

Um dashboard web ("Farol") que centraliza, numa só tela, o desempenho de **muitas
contas de Meta Ads** (de vários clientes/Business Managers), com foco em **custo
por lead (CPL)**. Ele acende um alerta vermelho quando uma campanha/conjunto/anúncio
passa de um teto de CPL (padrão R$35) ou quando gasta sem trazer lead.

Hierarquia exibida: **conta → campanha → conjunto de anúncios → anúncio**, cada
nível com investimento, leads e CPL próprios.

## 2. Stack e arquitetura

- **Backend:** Node.js + Express (`server.js`). Sem framework de build.
- **Lógica do Meta:** `meta.js` — busca na Marketing API, cálculo de CPL, dados demo.
- **Interface:** `public/index.html` — arquivo único com HTML + CSS + JS puro (vanilla),
  sem dependências de front. Tema escuro tipo "painel de monitoramento".
- **Rodar local:** `npm install && npm start` → http://localhost:3000
- **Modo demo:** sem token configurado, ele roda com dados de exemplo (ótimo para testar a interface).

## 3. Como está hospedado (deploy)

- Código em um **repositório privado no GitHub**.
- Hospedado na **Render** (plano gratuito, Web Service). Build: `npm install`. Start: `npm start`.
- Atualizar = subir os arquivos novos no GitHub; a Render republica sozinha.
- **Variáveis de ambiente na Render:**
  - `META_ACCESS_TOKENS` — vários tokens separados por vírgula, **um por Business Manager**.
  - `CPL_THRESHOLD` — teto de CPL (ex.: 35).
  - `CACHE_TTL_SECONDS` — cache em segundos (padrão 300).
  - `META_AD_ACCOUNT_IDS` (opcional) — restringe a contas específicas.
  - `LEAD_ACTION_TYPES` (opcional) — tipos de ação contados como "lead".

## 4. Decisões e armadilhas importantes (aprendidas na prática)

Estas são as partes que custaram tempo para acertar — **não refazer do zero**:

- **Várias BMs = vários tokens.** Um token de System User só enxerga a BM onde foi
  gerado. Por isso o `META_ACCESS_TOKENS` aceita vários. O painel junta as contas de
  todos e remove duplicatas. Há um **diagnóstico de tokens** na tela mostrando, por
  token: nº de contas, "0 contas" ou erro.
- **Leads NÃO podem ser somados entre tipos de ação.** O Meta reporta o mesmo lead
  sob vários `action_type` ao mesmo tempo (`lead`, `onsite_conversion.lead_grouped`,
  `leadgen_grouped`...). Somar dobra/triplica. A solução foi pegar o **MAIOR valor**
  entre os tipos de lead (= total já deduplicado). Isso foi um bug real corrigido.
- **Só campanhas ATIVAS aparecem**, mas dentro delas mostramos **todos os conjuntos e
  anúncios (ativos e pausados)** que tiveram entrega no período — para analisar se um
  conjunto/anúncio desligado trouxe lead. Filtro feito por `campaign.effective_status === "ACTIVE"`.
  A busca é feita no nível de **anúncio** (`/ads`) com `adset`, `campaign`, `creative` e
  `insights` aninhados, e a árvore é montada no código.
- **Regra de alerta (vermelho):** CPL acima do teto **OU** gastou ≥ teto e trouxe **zero** leads.
- **Link do Instagram** vem de `creative.instagram_permalink_url`. **Nem todo anúncio tem**
  (só os que usam uma publicação real do Instagram). Quando não tem, mostra "sem link IG".
- **Notas por conta:** arquivo `account-links.json` mapeia nome OU id da conta → URL
  (ex.: Google Docs). Aparece como botão "📄 Notas" no cabeçalho da conta.
- **Cache curto (5 min)** para não refazer buscas pesadas; o botão "Atualizar" força dados novos.

## 5. Armadilhas do lado do Meta (configuração das contas)

- O System User precisa ter: a permissão **`ads_read`** no token **E** as **contas de
  anúncio atribuídas** a ele (são coisas separadas — ter ads_read sem contas atribuídas
  retorna "0 contas").
- O **app** precisa estar no portfólio da BM (Configurações do Negócio → Apps →
  Conectar/Solicitar acesso a um ID de app). **Um único app** pode ser reaproveitado em
  todas as BMs (o "dono" é uma BM só; nas outras, conecta-se o mesmo App ID).
- Dá para **reutilizar um System User existente** se a BM já tiver um. Ao gerar o token,
  **NUNCA clicar em "Revogar tokens"** — isso apaga todos os tokens já existentes daquele
  System User e quebraria outras integrações. Basta "Gerar token".

## 6. Estado atual

- No ar, na Render, puxando dados reais de ~19 Business Managers (imobiliárias e correlatos).
- Tudo funcionando: multi-conta, diagnóstico de tokens, árvore conta→campanha→conjunto→anúncio,
  link do Instagram, notas por conta, cache, alertas de CPL e de "gastou sem lead".

## 7. Ideias futuras já mapeadas (para não repetir a sugestão)

1. Histórico/tendência de CPL (banco leve, ex.: Postgres grátis da Render).
2. Alertas automáticos (WhatsApp/e-mail/Slack) das campanhas acima do teto.
3. Teto de CPL configurável por conta/cliente.
4. Mais métricas (CTR, frequência, ritmo de orçamento).
5. Botão de pausar campanha pelo próprio painel (API de escrita + confirmação).
6. Prévia visual do criativo no painel.
7. Comparação entre períodos (7 dias vs. 7 anteriores).
8. Exportar para Excel/PDF.
9. Visão por responsável (equipe) e filtro "minhas contas".
10. Agrupar por BM/cliente e salvar filtros favoritos.

## 8. O que muda no NOVO caso (clínicas de harmonização facial)

(Preencher com o que você vai pedir — exemplos do que costuma mudar:)
- A definição de "resultado/lead" pode ser outra (ex.: agendamentos, conversas no
  WhatsApp, em vez de leads de formulário) → muda o `LEAD_ACTION_TYPES` / a métrica.
- O teto de custo por resultado provavelmente é diferente de R$35.
- Métricas e textos da tela podem mudar (nomenclatura, colunas).
- Pode haver outro conjunto de Business Managers/contas.

---

## Mensagem sugerida para abrir o novo chat

> Olá! Estou continuando um projeto existente. Anexei o código completo
> (`farol-cpl-dashboard.zip`) e um briefing (`HANDOFF.md`) que explica a
> arquitetura, o deploy (GitHub + Render) e as decisões já tomadas. Por favor,
> leia os dois antes de começar. Quero **partir exatamente desse dashboard** e
> adaptá-lo para clínicas de harmonização facial. Vou te dizer, passo a passo, o
> que mudar — comece confirmando que entendeu a estrutura atual.
