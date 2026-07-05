# Farol — Monitor de CPL para Meta Ads

Dashboard centralizado que reúne **todas as suas contas de Meta Ads** em uma só tela, calcula o **custo por lead (CPL)** de cada campanha e **acende um alerta vermelho** sempre que o CPL passa do teto que você definir (padrão: R$ 35).

Em vez de entrar conta por conta no Gerenciador, você abre uma página e vê, de imediato, quais contas e quais campanhas estão estouradas.

---

## O que ele faz

- Lista **todas as contas** que seu token tem acesso (ou só as que você indicar).
- Para cada campanha, mostra **investimento, leads e CPL**.
- Destaca em vermelho, com marcador pulsante, toda campanha **acima do teto**.
- Filtros: busca por nome, "só mostrar alertas", ordenação por nº de alertas / maior CPL / maior gasto.
- Seletor de **período** (hoje, ontem, 7/14/30 dias, mês atual, mês passado).
- O **teto de CPL é ajustável na própria tela** — muda na hora, sem recarregar.
- KPIs no topo: contas ativas, campanhas acima do teto, investimento total, leads totais e CPL médio geral.

---

## Como o token fica seguro

O token do Meta **fica somente no servidor** (no arquivo `.env`, que nunca é enviado ao navegador). A tela conversa com o seu próprio servidor através do endpoint `/api/data`, e é o servidor quem fala com o Meta. Assim, ninguém que abra o dashboard consegue ver ou roubar o token.

---

## Passo 1 — Instalar

Você precisa do **Node.js 18 ou superior** ([baixe aqui](https://nodejs.org)).

```bash
cd farol-cpl-dashboard
npm install
```

## Passo 2 — Rodar em modo demonstração (opcional, mas recomendado)

Antes de mexer com token, veja a interface funcionando com dados de exemplo:

```bash
npm start
```

Abra **http://localhost:3000**. Você verá 20 contas fictícias, várias com campanhas acima de R$ 35. É o produto final — só falta plugar seus dados reais.

## Passo 3 — Gerar o token do Meta

A forma recomendada para agência é um **Usuário do Sistema (System User)**, porque o token é de longa duração e não expira a cada poucas horas.

1. Acesse o **[Gerenciador de Negócios (Business Manager)](https://business.facebook.com/)**.
2. Vá em **Configurações do Negócio → Usuários → Usuários do sistema**.
3. Clique em **Adicionar**, dê um nome (ex.: "Farol Dashboard") e função **Admin** ou **Funcionário**.
4. Em **Atribuir ativos**, vincule **todas as contas de anúncio** que você quer monitorar, com permissão de leitura.
5. Clique em **Gerar novo token**:
   - Selecione o seu **App** (se ainda não tem um, crie um app rápido em [developers.facebook.com](https://developers.facebook.com/) — tipo "Empresa").
   - Marque a permissão **`ads_read`** (e `read_insights`, se aparecer).
   - Gere e **copie o token** (ele só aparece uma vez — guarde com cuidado).

> O token é como uma senha. Não compartilhe nem suba para repositórios públicos.

## Passo 4 — Configurar

```bash
cp .env.example .env
```

Abra o arquivo `.env` e cole seu token:

```
META_ACCESS_TOKEN=COLE_SEU_TOKEN_AQUI
CPL_THRESHOLD=35
```

- Para monitorar **todas** as contas do token, deixe `META_AD_ACCOUNT_IDS` vazio.
- Para limitar a contas específicas, liste os IDs:
  `META_AD_ACCOUNT_IDS=act_1234567890,act_9876543210`

## Passo 5 — Rodar com dados reais

```bash
npm start
```

Abra **http://localhost:3000**. Agora os números são das suas contas reais. A faixa amarela de "modo demonstração" desaparece.

---

## Login (proteger o painel)

Por padrão a URL é pública. Para exigir usuário e senha, defina **três variáveis** (no `.env` local ou nas variáveis da Render):

```
AUTH_USER=seu_usuario
AUTH_PASSWORD=uma_senha_forte
SESSION_SECRET=um_texto_longo_e_aleatorio
```

- Com `AUTH_USER` e `AUTH_PASSWORD` preenchidos, o painel passa a mostrar uma **tela de login**; a página e a API de dados ficam protegidas.
- `SESSION_SECRET` assina o cookie de sessão. Use algo longo e aleatório (gere com: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`). Se não definir, um é gerado a cada reinício (você terá que logar de novo após cada deploy).
- A sessão dura 7 dias. Há um botão **Sair** no topo do painel.
- Se as variáveis ficarem vazias, o painel continua aberto (sem login) — útil para testes locais.

## Links de notas por conta (Google Docs)

Você pode exibir, em cada conta, um link para um documento (Google Docs ou qualquer URL) onde anotou detalhes do cliente.

1. Copie `account-links.example.json` para `account-links.json`.
2. Para cada conta, adicione uma linha. A **chave** pode ser o **nome da conta** (como aparece no painel) ou o **ID** (`act_123...`); o **valor** é o link:
   ```json
   {
     "PROGRESS - TED": "https://docs.google.com/document/d/SEU_DOC/edit",
     "[CAO1] RENATO JUNIOR": "https://docs.google.com/document/d/OUTRO/edit"
   }
   ```
3. Suba o `account-links.json` junto com os outros arquivos (ele entra no repositório normalmente — não é um segredo). Quando presente, aparece um botão **📄 Notas** no cabeçalho da conta.

## Cache (desempenho)

Para não refazer as buscas pesadas no Meta a cada carregamento, o painel guarda o resultado por um tempo curto (padrão **5 minutos**). O botão **Atualizar** força uma busca nova ignorando o cache. Para mudar o tempo, defina `CACHE_TTL_SECONDS` no `.env` (ou nas variáveis da Render).

## Ajustes comuns

**O que conta como "lead"?**
O Meta classifica leads de formas diferentes (formulário instantâneo, pixel do site, etc.). O `.env` já cobre os tipos mais comuns em `LEAD_ACTION_TYPES`. Se o seu CPL aparecer zerado em campanhas que você sabe que geram lead, é provável que o seu evento de conversão use outro `action_type` — me avise o tipo de campanha e eu ajusto a lista.

**Erro de permissão / token inválido**
Confirme que o token tem `ads_read` e que as contas estão atribuídas ao Usuário do Sistema.

**Mudar o teto padrão**
Altere `CPL_THRESHOLD` no `.env` (ou simplesmente mude o valor no campo "Teto de CPL" na tela).

---

## Para deixar online (próximo passo, quando quiser)

Hoje o dashboard roda no seu computador. Para acessá-lo de qualquer lugar e deixá-lo sempre ligado, dá para hospedar em serviços como **Render**, **Railway** ou **Fly.io** (têm planos gratuitos). É só me pedir que eu te passo o passo a passo desse deploy.

---

## Estrutura dos arquivos

```
farol-cpl-dashboard/
├── server.js          → servidor (guarda o token, serve a API e a tela)
├── meta.js            → conexão com o Meta + cálculo de CPL + dados demo
├── public/
│   └── index.html     → o dashboard (interface completa)
├── .env.example       → modelo de configuração
├── package.json
└── README.md
```
