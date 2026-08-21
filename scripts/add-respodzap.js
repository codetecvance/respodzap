require('dotenv').config();
const repo = require('../src/repository');

async function main() {
  const tenant = (await repo.getTenants()).find(t => t.name === 'CodetecVance');
  if (!tenant) throw new Error('Tenant CodetecVance não encontrado');
  
  const catalog = await repo.getTenantCatalog(tenant.id);
  
  // Encontra categoria "sistemas" ou cria
  let catSistemas = catalog.categories.find(c => c.id === 'sistemas');
  if (!catSistemas) {
    catSistemas = { id: 'sistemas', name: 'Sistemas', products: [] };
    catalog.categories.push(catSistemas);
  }
  
  // Remove RespodZap se já existir (para recriar limpo)
  catSistemas.products = catSistemas.products.filter(p => p.id !== 'respodzap');
  
  // Produto RespodZap com 4 planos
  const respodzap = {
    id: 'respodzap',
    name: 'RespodZap',
    description: 'Chatbot profissional de vendas para WhatsApp. Venda 24/7 com cardápio, adicionais, entrega por bairro, PIX e cartão automáticos — tudo dentro da conversa.',
    image: 'respodzap.jpg',
    price: 1299,
    plans: [
      {
        id: 'starter',
        name: 'Plano Starter',
        price: 1299,
        period: 'único',
        description: 'Criação do seu bot com até 20 produtos ou itens no cardápio. Inclui configuração completa (Meta + Mercado Pago), cardápio com imagem e cores da marca, mensalidade do 1º mês inclusa, painel administrativo liberado, suporte na ativação.',
        features: 'Até 20 produtos ou itens no cardápio\nConfiguração completa (Meta + Mercado Pago)\nCardápio com imagem e cores da marca\nMensalidade do 1º mês inclusa\nPainel administrativo liberado\nSuporte na ativação'
      },
      {
        id: 'pro',
        name: 'Plano PRO',
        price: 1599,
        period: 'único',
        description: 'Criação do seu bot com até 30 produtos ou itens no cardápio. Inclui tudo do Starter + adicionais por grupos com preço por opção, áreas de entrega por bairro, impressora de pedidos (ticket 80mm), mensalidade do 1º mês inclusa.',
        features: 'Até 30 produtos ou itens no cardápio\nTudo do plano de 20 itens\nAdicionais por grupos com preço por opção\nÁreas de entrega por bairro\nImpressora de pedidos (ticket 80mm)\nMensalidade do 1º mês inclusa'
      },
      {
        id: 'mensalidade-starter',
        name: 'Mensalidade Starter',
        price: 179,
        period: 'mês',
        description: 'Servidor, manutenção e suporte técnico contínuos para o seu bot.',
        features: 'Servidor hospedado e monitorado\nAté 7 alterações por semana\nSuporte técnico\nAtualizações do sistema inclusas\nRenovação automática da licença'
      },
      {
        id: 'mensalidade-pro',
        name: 'Mensalidade PRO',
        price: 219,
        period: 'mês',
        description: 'Servidor, manutenção e suporte prioritário contínuos para o seu bot.',
        features: 'Servidor hospedado e monitorado\nAté 15 alterações por semana\nSuporte prioritário\nAtualizações do sistema inclusas\nRenovação automática da licença'
      }
    ]
  };
  
  catSistemas.products.push(respodzap);
  
  await repo.saveTenantCatalog(tenant.id, catalog);
  console.log('✅ RespodZap inserido no catálogo do CodetecVance');
  console.log('⚠️ LEMBRE-SE: Atualize os paymentLink de cada plano no painel admin ou edite este script e rode novamente');
}

main().catch(e => { console.error(e); process.exit(1); });