const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('data/respodzap.db');
const tables = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='table'").all();
console.log('=== SCHEMA ===');
for (const t of tables) {
  console.log('---', t.name, '---');
  console.log(t.sql);
}
console.log('\n=== PESQUISA RespodZap/RespZap/RespVZap/respzap ===');
const term = /resp/i;
for (const t of tables) {
  const cols = db.prepare(`PRAGMA table_info(${t.name})`).all();
  for (const c of cols) {
    if (['TEXT','VARCHAR','CHAR'].includes(c.type)) {
      try {
        const rows = db.prepare(`SELECT rowid, * FROM ${t.name} WHERE ${c.name} LIKE '%esp%'`).all();
        for (const r of rows) {
          console.log(`[${t.name}.${c.name}]`, JSON.stringify(r).slice(0, 600));
        }
      } catch (e) { console.log(`erro ${t.name}.${c.name}: ${e.message}`); }
    }
  }
}
console.log('\n=== TABELAS DE CATALOGO/PRODUTOS ===');
for (const t of tables) {
  if (/catalog|product|tenant|segment|categoria|categor/i.test(t.name)) {
    const rows = db.prepare(`SELECT * FROM ${t.name}`).all();
    console.log(`--- ${t.name} (${rows.length}) ---`);
    for (const r of rows) console.log(JSON.stringify(r).slice(0, 3000));
  }
}