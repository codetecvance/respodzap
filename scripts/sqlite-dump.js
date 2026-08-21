const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('data/respodzap.db');
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
console.log('TABELAS:');
for (const t of tables) console.log('  -', t.name);
for (const t of tables) {
  const rows = db.prepare(`SELECT * FROM ${t.name}`).all();
  console.log(`\n=== ${t.name} (${rows.length}) ===`);
  for (const r of rows) console.log(JSON.stringify(r).slice(0, 4000));
}