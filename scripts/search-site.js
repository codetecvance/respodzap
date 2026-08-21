const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('data/respodzap.db');
const rows = db.prepare("SELECT * FROM conversations WHERE message LIKE '%site%' OR message LIKE '%landing%' OR message LIKE '%Site%' OR message LIKE '%Landing%' OR message LIKE '%criacao%' OR message LIKE '%Criacao%'").all();
for(const r of rows) console.log(JSON.stringify(r).slice(0, 400));