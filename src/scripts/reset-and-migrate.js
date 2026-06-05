const { pool } = require('../db');
const { bootstrap } = require('../bootstrap');

async function main() {
  const client = await pool.connect();
  try {
    await client.query('DROP SCHEMA public CASCADE');
    await client.query('CREATE SCHEMA public');
    await client.query('GRANT ALL ON SCHEMA public TO public');
    await client.query('GRANT ALL ON SCHEMA public TO neondb_owner');
  } finally {
    client.release();
  }

  await bootstrap();
  await pool.end();
  console.log('Banco resetado e migrado com sucesso.');
}

main().catch(async (error) => {
  console.error('Falha ao resetar/migrar banco:', error);
  await pool.end();
  process.exit(1);
});
