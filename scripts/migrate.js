/**
 * Sistema de migrações numeradas para RespodZap.
 *
 * Uso:
 *   node scripts/migrate.js              # Aplica migrações pendentes
 *   node scripts/migrate.js --status     # Mostra status das migrações
 *
 * Cada arquivo SQL na pasta migrations/ é nomeado: NNN_descricao.sql
 * O número (NNN) é a versão da migração.
 */

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

async function createMigrationsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
}

function getMigrationFiles() {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => {
      const version = parseInt(f.split('_')[0], 10);
      return { version, name: f, path: path.join(MIGRATIONS_DIR, f) };
    });
}

async function getAppliedMigrations(client) {
  const result = await client.query('SELECT version FROM schema_migrations ORDER BY version');
  return new Set(result.rows.map((r) => r.version));
}

async function runMigrations() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL não definida. Defina a variável de ambiente.');
    process.exit(1);
  }

  const showStatus = process.argv.includes('--status');

  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined,
  });

  const client = await pool.connect();

  try {
    await createMigrationsTable(client);
    const applied = await getAppliedMigrations(client);
    const files = getMigrationFiles();

    if (showStatus) {
      console.log('\n=== Status das Migrações ===\n');
      for (const file of files) {
        const status = applied.has(file.version) ? '✅ Aplicada' : '⏳ Pendente';
        console.log(`  ${file.name} — ${status}`);
      }
      console.log(`\nTotal: ${files.length} | Aplicadas: ${applied.size} | Pendentes: ${files.length - applied.size}\n`);
      return;
    }

    let appliedCount = 0;
    for (const file of files) {
      if (applied.has(file.version)) continue;

      console.log(`Aplicando: ${file.name}...`);
      const sql = fs.readFileSync(file.path, 'utf8');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (version, name) VALUES ($1, $2)', [file.version, file.name]);
      appliedCount++;
      console.log(`  ✅ Versão ${file.version} aplicada.`);
    }

    if (appliedCount === 0) {
      console.log('Nenhuma migração pendente. Banco está atualizado.');
    } else {
      console.log(`\n${appliedCount} migração(ões) aplicada(s) com sucesso.`);
    }
  } finally {
    client.release();
    await pool.end();
  }
}

// Exportar para uso em src/db.js
module.exports = { runMigrations };

// Executar diretamente
if (require.main === module) {
  runMigrations().catch((err) => {
    console.error('Erro nas migrações:', err.message);
    process.exit(1);
  });
}
