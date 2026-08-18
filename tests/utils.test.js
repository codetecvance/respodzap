const {
  minutos,
  estaAberto,
  calcularFrete,
  precisaBairro,
  normTxt,
  temAdicionais,
  opcaoPreco,
  formatarOpcoesSelecionadas,
  productImageUrl,
} = require('../src/utils');

describe('minutos', () => {
  test('converte "HH:MM" para minutos desde meia-noite', () => {
    expect(minutos('18:30')).toBe(1110);
    expect(minutos('0:00')).toBe(0);
    expect(minutos('23:59')).toBe(1439);
    expect(minutos('9:05')).toBe(545);
  });

  test('hora sem minutos - b retorna NaN (comportamento conhecido)', () => {
    // '18' -> split(':') = ['18'] -> a=18, b=undefined
    // a*60 + (NaN(undefined)?0:undefined) = 1080 + undefined = NaN
    expect(minutos('18')).toBeNaN();
  });

  test('string inválida retorna undefined', () => {
    expect(minutos('abc')).toBeUndefined();
    expect(minutos('abc:30')).toBeUndefined();
  });

  test('null/undefined/vazio retornam NaN', () => {
    expect(minutos(null)).toBeNaN();
    expect(minutos(undefined)).toBeNaN();
    expect(minutos('')).toBeNaN();
  });
});

describe('estaAberto', () => {
  test('sem hours retorna sempre aberto', () => {
    expect(estaAberto({})).toEqual({ aberto: true });
    expect(estaAberto({ hours: null })).toEqual({ aberto: true });
    expect(estaAberto({ hours: 'string' })).toEqual({ aberto: true });
  });

  test('dia sem configuração retorna aberto (não bloqueia se hours existe mas dia não configurado)', () => {
    // Store com apenas dia '1' (segunda) - se hoje não é segunda, deve retornar ABERTO
    // (não bloquear o funcionamento só porque o dia não foi explicitamente configurado)
    const store = { hours: { '1': { open: '09:00', close: '18:00' } } };
    const result = estaAberto(store);
    expect(result.aberto).toBe(true);
  });

  test('com hours configurados, retorna aberto ou fechado com horário', () => {
    const store = { hours: { [String(new Date().getDay())]: { open: '00:00', close: '23:59' } } };
    const result = estaAberto(store);
    expect(result.aberto).toBe(true);
    expect(result.open).toBe('00:00');
    expect(result.close).toBe('23:59');
  });

  test('horário que cruza meia-noite - retorna resultado com open/close', () => {
    const day = new Date().getDay();
    const store = { hours: { [String(day)]: { open: '22:00', close: '04:00' } } };
    const result = estaAberto(store);
    expect(typeof result.aberto).toBe('boolean');
    expect(result.open).toBe('22:00');
    expect(result.close).toBe('04:00');
  });

  test('retorna open e close no resultado quando aberto', () => {
    // Usa horário que com certeza está aberto (00:00 - 23:59)
    const day = new Date().getDay();
    const store = { hours: { [String(day)]: { open: '00:00', close: '23:59' } } };
    const result = estaAberto(store);
    expect(result.open).toBe('00:00');
    expect(result.close).toBe('23:59');
  });
});

describe('calcularFrete', () => {
  const storeBase = { delivery_fee: 10, delivery_areas: [{ bairro: 'Centro', taxa: 5 }] };

  test('itens digitais não têm frete', () => {
    const items = [{ digital: true, unit_price: 100, quantity: 1 }];
    expect(calcularFrete(items, storeBase)).toBe(0);
  });

  test('subtotal >= delivery_free_full retorna frete grátis', () => {
    const items = [{ unit_price: 200, quantity: 1 }];
    const store = { ...storeBase, delivery_free_full: 150 };
    expect(calcularFrete(items, store)).toBe(0);
  });

  test('delivery_free_full não definido usa 9999999', () => {
    const items = [{ unit_price: 100, quantity: 1 }];
    expect(calcularFrete(items, storeBase)).toBe(10);
  });

  test('bairro encontrado usa taxa do bairro', () => {
    const items = [{ unit_price: 50, quantity: 1 }];
    expect(calcularFrete(items, storeBase, 'Centro')).toBe(5);
  });

  test('bairro não encontrado usa frete padrão', () => {
    const items = [{ unit_price: 50, quantity: 1 }];
    expect(calcularFrete(items, storeBase, 'BairroInexistente')).toBe(10);
  });

  test('bairro null usa frete padrão', () => {
    const items = [{ unit_price: 50, quantity: 1 }];
    expect(calcularFrete(items, storeBase, null)).toBe(10);
  });

  test('sem delivery_fee retorna 0', () => {
    const items = [{ unit_price: 50, quantity: 1 }];
    expect(calcularFrete(items, {})).toBe(0);
  });

  test('item com preço como string', () => {
    const items = [{ unit_price: '50.50', quantity: 2 }];
    expect(calcularFrete(items, storeBase)).toBe(10);
  });

  test('itens mistos digital/não-digital não são tratados como digitais', () => {
    const items = [
      { digital: true, unit_price: 100, quantity: 1 },
      { unit_price: 50, quantity: 1 },
    ];
    expect(calcularFrete(items, storeBase)).toBe(10);
  });
});

describe('precisaBairro', () => {
  test('itens digitais não precisam de bairro', () => {
    const items = [{ digital: true }];
    const store = { delivery_areas: [{ bairro: 'Centro' }] };
    expect(precisaBairro(store, items)).toBe(false);
  });

  test('sem delivery_areas não precisa de bairro', () => {
    const items = [{ unit_price: 10 }];
    expect(precisaBairro({}, items)).toBe(false);
  });

  test('delivery_areas vazio não precisa de bairro', () => {
    const items = [{ unit_price: 10 }];
    expect(precisaBairro({ delivery_areas: [] }, items)).toBe(false);
  });

  test('itens não-digitais com áreas de entrega precisa de bairro', () => {
    const items = [{ unit_price: 10 }];
    const store = { delivery_areas: [{ bairro: 'Centro' }] };
    expect(precisaBairro(store, items)).toBe(true);
  });

  test('itens mistos precisam de bairro', () => {
    const items = [
      { digital: true, unit_price: 100 },
      { unit_price: 50 },
    ];
    const store = { delivery_areas: [{ bairro: 'Centro' }] };
    expect(precisaBairro(store, items)).toBe(true);
  });
});

describe('normTxt', () => {
  test('normaliza para minúsculas e remove acentos', () => {
    expect(normTxt('São Paulo')).toBe('sao paulo');
    expect(normTxt('CAFE')).toBe('cafe');
    expect(normTxt('ÜBER')).toBe('uber');
  });

  test('null/undefined retorna string vazia', () => {
    expect(normTxt(null)).toBe('');
    expect(normTxt(undefined)).toBe('');
  });

  test('remove espaços extras', () => {
    expect(normTxt('  teste  ')).toBe('teste');
  });
});

describe('temAdicionais', () => {
  test('produto com adicionais retorna true', () => {
    expect(temAdicionais({ adicionais: [{ grupo: 'G' }] })).toBe(true);
  });

  test('produto sem adicionais retorna false', () => {
    expect(temAdicionais({ adicionais: [] })).toBe(false);
    expect(temAdicionais({})).toBe(false);
    expect(temAdicionais({ adicionais: null })).toBe(false);
  });
});

describe('opcaoPreco', () => {
  test('preço maior que 0 formata corretamente', () => {
    expect(opcaoPreco({ preco: 5.5 })).toBe(' (+R$ 5.50)');
  });

  test('preço 0 retorna string vazia', () => {
    expect(opcaoPreco({ preco: 0 })).toBe('');
  });

  test('preço não definido retorna string vazia', () => {
    expect(opcaoPreco({})).toBe('');
    expect(opcaoPreco({ preco: null })).toBe('');
  });
});

describe('formatarOpcoesSelecionadas', () => {
  test('null/undefined retorna array vazio', () => {
    expect(formatarOpcoesSelecionadas(null)).toEqual([]);
    expect(formatarOpcoesSelecionadas(undefined)).toEqual([]);
  });

  test('normaliza opções com preço', () => {
    const selections = [
      { grupo: 'Extras', opcoes: [{ nome: 'Bacon', preco: '5' }, { nome: 'Cheddar', preco: 3 }] },
    ];
    const result = formatarOpcoesSelecionadas(selections);
    expect(result).toEqual([
      { grupo: 'Extras', opcoes: [{ nome: 'Bacon', preco: 5 }, { nome: 'Cheddar', preco: 3 }] },
    ]);
  });

  test('opções sem preço recebem 0', () => {
    const selections = [{ grupo: 'G', opcoes: [{ nome: 'X' }] }];
    const result = formatarOpcoesSelecionadas(selections);
    expect(result[0].opcoes[0].preco).toBe(0);
  });
});

describe('productImageUrl', () => {
  test('URL http/https é retornada diretamente', () => {
    expect(productImageUrl({ image: 'https://example.com/img.jpg' }, 'http://local')).toBe('https://example.com/img.jpg');
    expect(productImageUrl({ image: 'http://example.com/img.jpg' }, 'http://local')).toBe('http://example.com/img.jpg');
  });

  test('imagem local concatena com webhookUrl', () => {
    expect(productImageUrl({ image: 'foto.jpg' }, 'https://site.com')).toBe('https://site.com/images/foto.jpg');
  });

  test('sem imagem usa placeholder', () => {
    expect(productImageUrl({}, 'https://site.com')).toBe('https://site.com/images/placeholder.png');
  });

  test('webhookUrl vazio resulta em /images/', () => {
    expect(productImageUrl({ image: 'foto.jpg' }, '')).toBe('/images/foto.jpg');
  });
});
