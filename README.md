# RespVZap — Chatbot Profissional de Vendas para WhatsApp

Chatbot de vendas + atendimento para WhatsApp Business API (Meta Cloud API).

Recebe pedidos, mostra produtos com **imagens e preços** no chat, processa carrinho de compras,
emite **PIX via Mercado Pago** e confirma o pagamento automaticamente por webhook.

---

## Recursos

| Funcionalidade | Descrição |
|---|---|
| **Catálogo com imagem** | Cada produto aparece como card interativo com foto, nome, preço |
| **Carrinho de compras** | Adicionar/remover itens, visualizar total |
| **3 formas de pagamento** | PIX (QR + copia e cola), Cartão de Crédito e Cartão de Débito |
| **Confirmação automática** | Webhook do Mercado Pago avisa quando o pagamento é aprovado |
| **Atendente humano** | Escalada para um vendedor via WhatsApp |
| **Histórico de pedidos** | Cliente consulta pedidos anteriores |
| **Painel administrativo** | Gerenciar produtos, fotos, mensagens, pedidos e leads pela web |

---

## PAINEL ADMINISTRATIVO (o jeito fácil de gerenciar)

Abra no navegador:

```
http://localhost:3001/admin
```

**Senha padrão:** definida em `ADMIN_PASSWORD` no `.env` (mude a padrão antes de publicar!)

| Aba | O que faz |
|---|---|
| **Dashboard** | KPIs (leads, pedidos, faturamento, ticket médio), gráfico de pedidos dos últimos 14 dias, formas de pagamento, produtos mais vendidos, ações rápidas |
| **Produtos** | Adicionar produto, editar nome/preço/descrição, ativar/desativar, excluir |
| **Produtos → Enviar foto** | Upload de imagem (5MB máx) — depois é só copiar o nome e colar no campo "Imagem" do produto |
| **Pedidos** | Filtro por status, alterar status (pago/enviado/entregue/cancelado), detalhes com itens e endereço |
| **Leads** | Busca, alterar status (novo/contatado/convertido/fechado), ver conversa completa no chat |
| **Perguntas** | Adicionar/editar perguntas do fluxo (ex: endereço de entrega no checkout) |
| **Mensagens** | Editar todos os textos do bot com dica de variáveis de cada mensagem |
| **Configurações** | Frete, frete grátis, desconto PIX, parcelas, dados da empresa e endereço |

> 💡 **As alterações valem em até 15 segundos, sem reiniciar o bot.**

---

## Como adicionar novas perguntas ao fluxo

As perguntas do checkout ficam na aba **Perguntas** do painel (ou em `src/catalog.json` → `questionnaires`).

Cada pergunta tem:

| Campo | O que é |
|---|---|
| **Chave** | Identificador interno (ex: `endereco`) |
| **Campo do lead** | Onde salvar no cliente (ex: `delivery_address` salva no endereço do lead) |
| **Pergunta** | O texto que o bot envia |
| **Opcional** | Se marcado, o cliente pode pular respondendo qualquer coisa |

**Exemplo atual (checkout):**
```json
"questionnaires": {
  "checkout": {
    "label": "Perguntas do pedido",
    "questions": [
      { "key": "endereco", "field": "delivery_address", "question": "Qual o endereço de entrega?", "optional": false },
      { "key": "observacao", "question": "Alguma observação sobre o pedido?", "optional": true }
    ]
  }
}
```

**Fluxo resultante:** Finalizar pedido → pergunta o nome → faz as perguntas em sequência → mostra o resumo com as respostas → confirma → formas de pagamento.

**Campos do lead disponíveis:** `delivery_address` (endereço), `email`, `full_name`. Se o campo estiver vazio, a resposta fica salva no registro do cliente e aparece na notificação ao vendedor.

Para criar um **novo questionário** (ex: orçamento), use o botão "➕ Novo questionário" na aba Perguntas — depois é só conectar o gatilho no fluxo (me avise se quiser adicionar um botão de menu para ele).

---

## Como adicionar um produto novo

**Pelo painel (recomendado):**
1. Acesse `/admin` → aba **Produtos**
2. Na categoria desejada, clique em **"+ Adicionar novo produto"**
3. Preencha: ID único (ex: `camiseta-preta`), nome, preço, descrições → **Criar produto**
4. Envie a foto em **"Enviar foto de produto"** → clique em "Copiar nome" da imagem
5. Edite o produto e cole o nome da imagem no campo **Imagem** → **Salvar alterações**

**Ou direto no arquivo** `src/catalog.json`: adicione o objeto na seção `products` da categoria:
```json
{
  "id": "camiseta-preta",
  "name": "Camiseta Preta",
  "short_description": "Camiseta 100% algodão, tamanhos P ao GG",
  "long_description": "Descrição completa para o bot mostrar nos Detalhes.",
  "price": 49.90,
  "image": "camiseta-preta.jpg",
  "available": true
}
```

## Como trocar mensagens do bot

Aba **Mensagens** do painel (ou `src/catalog.json` → seção `messages`).
Variáveis disponíveis (substituídas automaticamente):

| Variável | Significado |
|---|---|
| `{nome}` | Nome do cliente |
| `{empresa}` | Nome da empresa |
| `{produto}` | Nome do produto |
| `{total}` | Valor total |
| `{preco}` | Preço unitário |
| `{pedido}` | Número do pedido |
| `{qr}` | Código PIX copia e cola |
| `{link}` | Link de pagamento do cartão |
| `{tipo}` | Tipo de cartão (Crédito/Débito) |
| `{resumo}` | Resumo do pedido pago |

Use `\n` para quebrar linha dentro das mensagens.

---

## Estrutura do Projeto

```
respodzap/
├── src/
│   ├── index.js           # Servidor Express
│   ├── config.js           # Leitura do .env
│   ├── db.js               # SQLite (leads, conversas, pedidos, pagamentos)
│   ├── repository.js        # CRUD para todas as tabelas
│   ├── webhook.js           # WhatsApp webhook + Mercado Pago webhook
│   ├── whatsapp.js           # Envio: texto, botões, cards com imagem
│   ├── flow-engine.js       # Motor de estados da conversa (menu → checkout → pagamento)
│   ├── catalog.js           # Carregador do catálogo (recarrega sozinho a cada 15s)
│   ├── catalog.json          # Produtos, mensagens e config da loja (EDITAR AQUI ou no painel)
│   ├── payment.js            # Mercado Pago: PIX, cartão, consultar status
│   └── admin.js              # Painel administrativo web
├── public/
│   └── images/               # Fotos dos produtos (upload pelo painel)
├── .env
└── package.json
```

---

## Pré‑requisitos

- **Node.js 18+**
- **Conta Meta for Developers** com app tipo Business + produto WhatsApp configurado
- **Número de telefone registrado na WABA** (número de teste gratuito OU número de produção brasileiro)
- **Ngrok** ou **[cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/)** para túnel HTTPS (gratuito)
- **Conta Mercado Pago** — gratuita em [mercadopago.com.br](https://mercadopago.com.br)

---

## Instalação

```bash
cd D:\RespodZap
npm install
```

## Configuração (.env)

| Variável | Como obter |
|---|---|
| `APP_ID` | Meus aplicativos > RespVZap > Configurações > Básico |
| `APP_SECRET` | Configurações > Básico > Chave Secreta do App |
| `PHONE_NUMBER_ID` | WhatsApp > Configuração > API Setup |
| `ACCESS_TOKEN` | API Setup > Gerar token (temporário 24h) |
 | `VERIFY_TOKEN` | Qualquer string segura (ex: `minha-chave-verificacao-2026`) |
| `BUSINESS_PHONE` | Número do vendedor que recebe leads (sem + ou ()) |
| `MP_ACCESS_TOKEN` | Mercado Pago Developers > Credenciais > Access Token de produção |
| `WEBHOOK_URL` | URL pública HTTPS do túnel (ex: `https://xxx.trycloudflare.com`) |
| `ADMIN_PASSWORD` | Senha do painel admin (troque a padrão!) |

> 💡 O token temporário expira em 24h. **Renove-o para 60 dias** trocando o token do painel pelo de longa duração (o painel admin avisa quando ele estiver perto de expirar). Comando:
> ```bash
> node -e "require('dotenv').config(); const c=require('./src/config'); const axios=require('axios'); axios.get('https://graph.facebook.com/v26.0/oauth/access_token?grant_type=fb_exchange_token&client_id='+c.appId+'&client_secret='+c.appSecret+'&fb_exchange_token='+encodeURIComponent(c.accessToken)).then(r=>console.log(r.data.access_token))"
> ```
> Copie o token gerado para `ACCESS_TOKEN` no `.env` e reinicie o bot. Para produção definitiva, use um **token permanente de System User** no Business Manager.

---

## Rodando

```bash
npm start                # Roda o bot em http://localhost:3001
```

### Túnel público (necessário para o webhook da Meta)

```bash
cloudflared tunnel --url http://localhost:3001
# Copia a URL https://xxx.trycloudflare.com → cola como WEBHOOK_URL no .env
```

No painel Meta Developer Console (WhatsApp > Configuração):
- **Webhook URL**: `https://xxx.trycloudflare.com/webhook`
 - **Verify Token**: a mesma string definida no `.env` (`VERIFY_TOKEN`)

---

## Mercado Pago (PIX + cartões)

1. Conta gratuita em [mercadopago.com.br](https://mercadopago.com.br) — use a conta **real** (não a de teste, que retorna "TESTUSER")
2. Developers → Suas Integrações → crie o app e **complete o cadastro** (nome + descrição)
3. Copie o **Access Token de produção** (`APP_USR-...`) → `MP_ACCESS_TOKEN` no `.env`
4. No painel Mercado Pago → **Webhooks** → adicione: `https://SEU-TUNEL/mercadopago/webhook`

---

## Comandos úteis

```bash
npm run dev       # modo watch (reinicia automaticamente)
npm start         # iniciar em produção
npm run leads     # lista de leads no terminal
```

---

## Produção

1. Substitua o token temporário pelo **token permanente** (System User no Business Manager)
2. Verifique seu negócio **Verificação Comercial** (Meta Business)
3. Suba o app em Railway / Render / VPS
4. O `WEBHOOK_URL` será o domínio HTTPS real do servidor
5. Proteja `/leads` e `/orders` com autenticaçãoes

---

## Licença

Proprietário — RespVZap. Uso interno.