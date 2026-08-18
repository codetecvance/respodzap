# Deploy no Vercel — Passo a Passo

## 1. Suba o código para o GitHub

1. Crie um repositório no GitHub (ex: `respodzap`)
2. Na pasta do projeto, rode:
```bash
git init
git add .
git commit -m "SaaS multi-tenant Vercel + Neon"
git branch -M main
git remote add origin https://github.com/SEU-USUARIO/respodzap.git
git push -u origin main
```

> ⚠️ O arquivo `.env` NÃO vai (está no .gitignore). As configurações entram no painel do Vercel.

## 2. Importe no Vercel

1. Acesse `vercel.com` → **Add New** → **Project**
2. Importe o repositório `respodzap`
3. Framework: **Other** (o Vercel detecta Node.js)
4. Nome do projeto: **respodzap** → URL: `https://respodzap.vercel.app`

## 3. Configure as variáveis de ambiente (Settings → Environment Variables)

| Variável | Valor |
|---|---|
| `DATABASE_URL` | A connection string do Neon (a mesma do `.env`) |
| `APP_ID` | Seu App ID do Meta (Configurações > Básico) |
| `APP_SECRET` | A chave secreta do app Meta |
| `VERIFY_TOKEN` | O mesmo do `.env` (ex: qualquer string segura) |
| `PHONE_NUMBER_ID` | Seu Phone Number ID (fallback global — tenant 1) |
| `ACCESS_TOKEN` | O token do WhatsApp (o de 60 dias) |
| `MP_ACCESS_TOKEN` | O token do Mercado Pago (APP_USR-...) |
| `SMTP_HOST` | `smtp.gmail.com` |
| `SMTP_PORT` | `465` |
| `SMTP_USER` | Seu e-mail Gmail (remetente) |
| `SMTP_PASS` | A senha de app do Gmail |
| `NOTIFY_EMAIL` | Seu e-mail de notificações |
| `ADMIN_PASSWORD` | Sua senha do painel |
| `BUSINESS_PHONE` | Seu número (notificações administrativas) |
| `WEBHOOK_URL` | `https://respodzap.vercel.app` |
| `NODE_ENV` | `production` |

## 4. Deploy

Clique em **Deploy** (ou `vercel --prod` na pasta). A URL será `https://respodzap.vercel.app`.

## 5. Atualize o webhook na Meta

No painel Meta (WhatsApp → Configuração → Webhook):
- **URL de retorno de chamada**: `https://respodzap.vercel.app/webhook`
- **Verificar token**: o mesmo `VERIFY_TOKEN` definido nas variáveis do Vercel
- Campo assinado: `messages`

> Todos os números (de todos os clientes) apontam para **esta mesma URL** — o roteador identifica cada cliente pelo `phone_number_id`.

## 6. Cron diário (licenças)

O Vercel Cron roda `https://respodzap.vercel.app/api/cron` todo dia às 09:00:
- Avisa de licenças vencidas e prestes a vencer (7/3/1 dias)
- Envia o **PIX de renovação automático** 3 dias antes

## 7. Primeiro uso no ar

1. Acesse `https://respodzap.vercel.app/admin` (senha do painel)
2. **Clientes** → seu Tenant 1 "CodetecVance" já existe (migrado)
3. **Assinaturas** → licença de 30 dias já criada
4. Envie mensagem para o seu número → o bot responde pela URL fixa

## Limites gratuitos (20 clientes ≈ folga de 95%)

- Vercel Hobby: 100 mil requisições/mês (~3.300/dia)
- Neon Free: 100 CU-horas/mês + 0,5 GB
- Quando crescer para 100+: subir para Vercel Pro (~US$ 20/mês) e/ou Neon Launch — **sem mudar o código**.

## CI/CD e Branch Protection

### GitHub Actions (automático)

O projeto possui 3 workflows automáticos:

| Workflow | Arquivo | Quando roda |
|----------|---------|-------------|
| **CI** | `.github/workflows/ci.yml` | Todo push e PR na main |
| **Deploy Preview** | `.github/workflows/deploy-preview.yml` | Em PRs para a main |
| **Deploy Production** | `.github/workflows/deploy-prod.yml` | Push na main |

### Secrets necessários no GitHub

Configure em **Settings → Secrets and variables → Actions**:

| Secret | Como obter |
|--------|-----------|
| `VERCEL_TOKEN` | Vercel → Settings → Tokens → Create |
| `VERCEL_ORG_ID` | Do arquivo `.vercel/project.json` (campo `orgId`) |
| `VERCEL_PROJECT_ID` | Do arquivo `.vercel/project.json` (campo `projectId`) |

### Branch Protection (recomendado)

Para proteger a branch `main`, configure via GitHub CLI:

```bash
gh api repos/SEU-USUARIO/respodzap/branches/main/protection \
  --method PUT \
  --field required_status_checks='{"strict":true,"contexts":["lint-and-test"]}' \
  --field enforce_admins=true \
  --field required_pull_request_reviews='{"required_approving_review_count":1,"dismiss_stale_reviews":true}' \
  --field restrictions=null
```

Ou manualmente em **Settings → Branches → Add rule**:
- Branch name pattern: `main`
- ☑ Require a pull request before merging
- ☑ Require approvals: 1
- ☑ Require status checks to pass (selecione `lint-and-test`)
- ☑ Do not allow bypassing the above settings

### Migrações do Banco

```bash
# Verificar status das migrações
npm run migrate:neon -- --status

# Aplicar migrações pendentes
npm run migrate:neon
```

### Dicas

- **Fotos de produtos em produção**: cole URLs completas (ex: Vercel Blob ou o site do cliente) no campo "Imagem" do produto — a cola local não existe no Vercel.
- **Upload local (dev)**: funciona na sua máquina; em produção use URLs.
- **Painel admin** funciona normalmente no Vercel (sessões em memória; se reiniciar, faça login de novo).
