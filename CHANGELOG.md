# Changelog

Todas as mudanças notáveis neste projeto serão documentadas neste arquivo.

O formato é baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.0.0/),
e este projeto adere ao [Semantic Versioning](https://semver.org/lang/pt-BR/).

## [Unreleased]

### Added
- CI/CD com GitHub Actions (lint, testes, deploy preview em PRs, deploy produção)
- Testes unitários para 12 funções críticas (79 testes)
- Sistema de migrações numeradas com tabela `schema_migrations`
- Funções utilitárias extraídas para `src/utils.js` (facilita testes)
- ESLint e Prettier para padronização de código
- Scripts npm: `lint`, `lint:fix`, `format`, `test`, `test:coverage`, `test:watch`, `migrate:neon`
- Documentação de setup de branch protection obrigatória

### Changed
- Migrações do banco movidas de `initDb()` para arquivos SQL numerados em `migrations/`
- Funções `minutos`, `estaAberto`, `calcularFrete`, `precisaBairro`, `normTxt`, `temAdicionais`, `opcaoPreco`, `formatarOpcoesSelecionadas`, `productImageUrl` extraídas de `flow-engine.js` para `src/utils.js`
- Funções `normalizePhone`, `num`, `addonsKey`, `parseAddons` exportadas de `repository.js` para testes

## [3.0.0] - 2026-08-18

### Added
- **SaaS multi-tenant**: sistema completo para múltiplos negócios em um único deploy
- **Painel do cliente**: login por WhatsApp+senha, gestão própria de produtos e pedidos
- **Upload de imagens**: Vercel Blob em produção, disco local em desenvolvimento
- **Segmentos de negócio**: vendas, restaurante, delivery, padaria, estética com templates
- **Relatórios por período**: hoje, 7, 30, 60, 90 dias com dashboard por segmento
- **Adicionais por grupos**: toppings/extras com preço individual (restaurante/delivery)
- **Áreas de entrega**: frete por bairro, retirada no local, bloqueio fora da área
- **Identidade visual por ramo**: temas coloridos (azul/vermelho/amarelo/marrom/rosa)
- **Impressora de pedidos**: Bluetooth ESC/POS, ticket 80mm/58mm, reconexão automática
- **Horário de funcionamento**: bloqueio automático de pedidos fora do horário
- **Mercado Pago OAuth por cliente**: conecta/desconecta conta própria, refresh automático
- **PIX com QR Code**: envio automático de imagem escaneável + cópia e cola
- **Planos Starter (20 produtos) e Pro (30 produtos)**: limites por assinatura
- **Lixeira + seleção múltipla**: em todas as listas do admin e painel
- **Confirmação PIX robusta**: verificação de pagamentos pendentes no cron diário
- **Cardápio com fotos**: cards por categoria com botão adicionar ao carrinho
- **Banners de produto**: imagem 16:9 via opentype.js (sem dependência de fontconfig)
- **Cache de imagens**: banners em memória, uploads em paralelo, keep-warm
- **Perguntas no checkout**: questionário configurável (bairro, observações, etc.)
- **Editor de botões**: personalização de todos os textos do fluxo do bot
- **Notificação do atendente**: configuração de título/corpo com variáveis

### Fixed
- Upload no Vercel: memory storage + Blob (disco é read-only)
- Loop de redirect no painel com sessão de cliente excluído
- ReferenceError ao salvar configurações (checkboxVal antes da declaracao)
- Tag script não fechada no layout (SyntaxError em todas as páginas)
- Scripts de impressão no layout (fecha 1o script e abre o 2o)
- Bugs da varredura: last_notified_day, updateCartItemQuantity, desconto PIX
- Nome da empresa no boas-vindas do bot
- Upload de imagem com tenant correto
- Confirmação manual notifica dono do tenant

### Security
- Webhook cron: aceita apenas agendador Vercel ou `CRON_SECRET`
- Remove valores reais dos documentos (placeholders)
- Credenciais `.env` ignoradas do git via `.gitignore`

## [2.0.0] - 2026-08-14

### Added
- Versão inicial multi-tenant
- Tenants, assinaturas com PIX de renovação
- Painel admin completo
- Webhook roteador por `phone_number_id`
- Integração Meta WhatsApp Cloud API
- Integração Mercado Pago (PIX e cartão)
