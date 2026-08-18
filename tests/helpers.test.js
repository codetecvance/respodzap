const {
  normalizePhone,
  normalizePhoneBr,
  hashPassword,
  verifyPassword,
  num,
  addonsTotal,
  formatAddons,
  addonsKey,
  parseAddons,
} = require('../src/repository');

describe('normalizePhone', () => {
  test('remove todos os caracteres não-numéricos', () => {
    expect(normalizePhone('+55 (11) 99999-1234')).toBe('5511999991234');
  });

  test('retorna string vazia para null/undefined', () => {
    expect(normalizePhone(null)).toBe('');
    expect(normalizePhone(undefined)).toBe('');
  });

  test('converte número para string', () => {
    expect(normalizePhone(1234567890)).toBe('1234567890');
  });

  test('já digitais permanecem iguais', () => {
    expect(normalizePhone('11999991234')).toBe('11999991234');
  });

  test('string vazia retorna vazia', () => {
    expect(normalizePhone('')).toBe('');
  });
});

describe('normalizePhoneBr', () => {
  test('adiciona DDI 55 a telefone BR sem DDI', () => {
    expect(normalizePhoneBr('11999991234')).toBe('5511999991234');
  });

  test('não duplica DDI 55 se já presente', () => {
    expect(normalizePhoneBr('5511999991234')).toBe('5511999991234');
  });

  test('normaliza caracteres especiais', () => {
    expect(normalizePhoneBr('+55 (11) 99999-1234')).toBe('5511999991234');
  });
});

describe('hashPassword e verifyPassword', () => {
  test('hash e verify funcionam juntos', () => {
    const hashed = hashPassword('minhaSenh4!');
    expect(verifyPassword('minhaSenh4!', hashed)).toBe(true);
  });

  test('senha incorreta retorna false', () => {
    const hashed = hashPassword('minhaSenh4!');
    expect(verifyPassword('senhaErrada', hashed)).toBe(false);
  });

  test('formato do hash é salt:hash', () => {
    const hashed = hashPassword('teste');
    const parts = hashed.split(':');
    expect(parts).toHaveLength(2);
    expect(parts[0]).toHaveLength(32); // 16 bytes hex
    expect(parts[1]).toHaveLength(64); // 32 bytes hex
  });

  test('duas chamadas geram hashes diferentes (salt aleatório)', () => {
    const h1 = hashPassword('mesma_senha');
    const h2 = hashPassword('mesma_senha');
    expect(h1).not.toBe(h2);
    // Mas ambas verificam corretamente
    expect(verifyPassword('mesma_senha', h1)).toBe(true);
    expect(verifyPassword('mesma_senha', h2)).toBe(true);
  });

  test('stored inválido retorna false', () => {
    expect(verifyPassword('senha', null)).toBe(false);
    expect(verifyPassword('senha', '')).toBe(false);
    expect(verifyPassword('senha', 'sem_dois_pontos')).toBe(false);
  });
});

describe('num', () => {
  test('null e undefined retornam null', () => {
    expect(num(null)).toBeNull();
    expect(num(undefined)).toBeNull();
  });

  test('números passam direto', () => {
    expect(num(0)).toBe(0);
    expect(num(42)).toBe(42);
    expect(num(-3.14)).toBe(-3.14);
  });

  test('strings numéricas são convertidas', () => {
    expect(num('123')).toBe(123);
    expect(num('3.14')).toBe(3.14);
  });

  test('string vazia resulta em 0', () => {
    expect(num('')).toBe(0);
  });

  test('strings não-numéricas resultam em NaN', () => {
    expect(num('abc')).toBeNaN();
  });

  test('booleanos são convertidos', () => {
    expect(num(false)).toBe(0);
    expect(num(true)).toBe(1);
  });
});

describe('addonsTotal', () => {
  test('null/undefined/vazio retorna 0', () => {
    expect(addonsTotal(null)).toBe(0);
    expect(addonsTotal(undefined)).toBe(0);
    expect(addonsTotal([])).toBe(0);
  });

  test('soma preço de um grupo com uma opção', () => {
    const addons = [{ grupo: 'Extras', opcoes: [{ nome: 'Bacon', preco: 5.5 }] }];
    expect(addonsTotal(addons)).toBe(5.5);
  });

  test('soma múltiplos grupos e opções', () => {
    const addons = [
      { grupo: 'Extras', opcoes: [{ nome: 'Bacon', preco: 5 }, { nome: 'Cheddar', preco: 3 }] },
      { grupo: 'Molho', opcoes: [{ nome: 'BBQ', preco: 2 }] },
    ];
    expect(addonsTotal(addons)).toBe(10);
  });

  test('preço como string é convertido', () => {
    const addons = [{ grupo: 'G', opcoes: [{ nome: 'X', preco: '3.50' }] }];
    expect(addonsTotal(addons)).toBe(3.5);
  });

  test('preço null/0/missing resulta em 0', () => {
    const addons = [
      { grupo: 'G', opcoes: [{ nome: 'X', preco: null }] },
      { grupo: 'G', opcoes: [{ nome: 'Y' }] },
      { grupo: 'G', opcoes: [{ nome: 'Z', preco: 0 }] },
    ];
    expect(addonsTotal(addons)).toBe(0);
  });

  test('grupo sem opcoes não quebra', () => {
    const addons = [{ grupo: 'G' }];
    expect(addonsTotal(addons)).toBe(0);
  });
});

describe('formatAddons', () => {
  test('null/undefined retorna string vazia', () => {
    expect(formatAddons(null)).toBe('');
    expect(formatAddons(undefined)).toBe('');
  });

  test('um grupo com opções', () => {
    const addons = [{ grupo: 'G', opcoes: [{ nome: 'Bacon' }, { nome: 'Cheddar' }] }];
    expect(formatAddons(addons)).toBe('Bacon, Cheddar');
  });

  test('dois grupos separados por ponto e vírgula', () => {
    const addons = [
      { grupo: 'G1', opcoes: [{ nome: 'Bacon' }, { nome: 'Cheddar' }] },
      { grupo: 'G2', opcoes: [{ nome: 'Molho' }] },
    ];
    expect(formatAddons(addons)).toBe('Bacon, Cheddar; Molho');
  });

  test('opções com nome null/vazio são filtradas', () => {
    const addons = [{ grupo: 'G', opcoes: [{ nome: 'Bacon' }, { nome: null }, { nome: '' }] }];
    expect(formatAddons(addons)).toBe('Bacon');
  });

  test('grupo vazio não contribui', () => {
    const addons = [{ grupo: 'G', opcoes: [] }];
    expect(formatAddons(addons)).toBe('');
  });
});

describe('addonsKey', () => {
  test('null/undefined retorna JSON de array vazio', () => {
    expect(addonsKey(null)).toBe('[]');
    expect(addonsKey(undefined)).toBe('[]');
  });

  test('gera chave baseada em grupo + nomes (ignora preço)', () => {
    const a1 = [{ grupo: 'G', opcoes: [{ nome: 'Bacon', preco: 5 }] }];
    const a2 = [{ grupo: 'G', opcoes: [{ nome: 'Bacon', preco: 10 }] }];
    expect(addonsKey(a1)).toBe(addonsKey(a2));
  });

  test('nomes diferentes geram chaves diferentes', () => {
    const a1 = [{ grupo: 'G', opcoes: [{ nome: 'Bacon' }] }];
    const a2 = [{ grupo: 'G', opcoes: [{ nome: 'Cheddar' }] }];
    expect(addonsKey(a1)).not.toBe(addonsKey(a2));
  });

  test('ordem dos grupos importa', () => {
    const a1 = [
      { grupo: 'G1', opcoes: [{ nome: 'A' }] },
      { grupo: 'G2', opcoes: [{ nome: 'B' }] },
    ];
    const a2 = [
      { grupo: 'G2', opcoes: [{ nome: 'B' }] },
      { grupo: 'G1', opcoes: [{ nome: 'A' }] },
    ];
    expect(addonsKey(a1)).not.toBe(addonsKey(a2));
  });
});

describe('parseAddons', () => {
  test('null/undefined retorna null', () => {
    expect(parseAddons(null)).toBeNull();
    expect(parseAddons(undefined)).toBeNull();
  });

  test('string vazia retorna null', () => {
    expect(parseAddons('')).toBeNull();
  });

  test('array vazio retorna null', () => {
    expect(parseAddons([])).toBeNull();
  });

  test('array não-vazio é retornado', () => {
    const data = [{ grupo: 'G', opcoes: [{ nome: 'X' }] }];
    expect(parseAddons(data)).toEqual(data);
  });

  test('JSON string válido é parseado', () => {
    const json = JSON.stringify([{ grupo: 'G', opcoes: [{ nome: 'X' }] }]);
    expect(parseAddons(json)).toEqual([{ grupo: 'G', opcoes: [{ nome: 'X' }] }]);
  });

  test('JSON inválido retorna null', () => {
    expect(parseAddons('invalid json')).toBeNull();
  });

  test('objeto não-array retorna null', () => {
    expect(parseAddons({})).toBeNull();
  });
});
