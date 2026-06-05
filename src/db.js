const { Pool } = require('pg');
const config = require('./config');

if (!config.databaseUrl) {
  console.warn('DATABASE_URL não definido. Configure o .env antes de iniciar o sistema.');
}

const pool = new Pool({
  connectionString: config.databaseUrl || undefined,
  ssl: config.databaseUrl ? { rejectUnauthorized: false } : false,
});

async function query(text, params = []) {
  return pool.query(text, params);
}

async function withTransaction(handler) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await handler(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { pool, query, withTransaction };
