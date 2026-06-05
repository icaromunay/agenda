const fs = require('fs/promises');
const path = require('path');
const bcrypt = require('bcryptjs');
const config = require('./config');
const { pool } = require('./db');

const DEFAULT_CONFIRMATION_TEMPLATE = `🌟 Olá, {{nome}}!

Seu atendimento foi confirmado com sucesso. ✅

🌿 Serviço: {{servico}}
📅 Data: {{data}}
🕐 Horário: {{horario}}

💬 Caso tenha dúvidas, estou à disposição.

🙏 Ícarõ Munay
Terapeuta Metafísico
📲 WhatsApp: (47) 98800-6092`;
const DEFAULT_REMINDER_TEMPLATE = `🌟 Olá, {{nome}}!

Lembrete do seu atendimento.

🌿 Serviço: {{servico}}
📅 Data: {{data}}
🕐 Horário: {{horario}}

💬 Em caso de dúvida, responda esta mensagem.`;

async function seedServices(client) {
  const count = await client.query('SELECT COUNT(*)::int AS total FROM services');
  if (count.rows[0].total > 0) return;

  const services = [
    ['Conversa Terapêutica', 'Atendimento acolhedor com foco terapêutico.', 90, 97, 107, '3x R$37,00', '09:00', '18:00', 1],
    ['Conversa Terapêutica Noite', 'Versão noturna do atendimento terapêutico.', 90, 137, 145, '3x R$53,00', '18:00', '21:00', 2],
    ['Constelação Familiar', 'Sessão de constelação familiar.', 90, 197, 210, '3x R$77,00', '09:00', '18:00', 3],
    ['Constelação Familiar PRIME', 'Sessão premium em horário especial.', 90, 257, 277, '3x R$98,00', '18:00', '21:00', 4],
    ['Constelação Familiar GOLD', 'Sessão GOLD com condução aprofundada.', 90, 350, 370, '3x R$135,00', '09:00', '21:00', 5],
    ['Ativação', 'Atendimento de ativação energética.', 60, 97, 107, '3x R$37,00', '09:00', '21:00', 6],
    ['Reiki Quântico Xamânico', 'Sessão energética e terapêutica.', 90, 130, 139.9, '3x R$49,90', '09:00', '18:00', 7],
    ['Divórcio Energético', 'Conversa inicial de 30 minutos + trabalho energético.', 30, 259, 275, '3x R$98,00', '09:00', '21:00', 8]
  ];

  for (const service of services) {
    await client.query(
      `INSERT INTO services (name, description, duration_minutes, price_pix, price_card, price_installment, min_hour, max_hour, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      service
    );
  }
}

async function bootstrap() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const sql = await fs.readFile(path.resolve(process.cwd(), 'migrations/001_init.sql'), 'utf8');
    await client.query(sql);

    await client.query(`
      INSERT INTO app_settings (id, database_url)
      VALUES (1, $1)
      ON CONFLICT (id) DO UPDATE SET database_url = EXCLUDED.database_url, updated_at = NOW()
    `, [config.databaseUrl || null]);

    await client.query(
      `UPDATE app_settings
       SET confirmation_message = CASE
             WHEN confirmation_message IS NULL
               OR btrim(confirmation_message) = ''
               OR confirmation_message LIKE 'Olá, {{nome}}!%Seu atendimento foi confirmado com sucesso.%'
             THEN $1
             ELSE confirmation_message
           END,
           reminder_message = CASE
             WHEN reminder_message IS NULL
               OR btrim(reminder_message) = ''
               OR reminder_message LIKE 'Olá, {{nome}}! Passando para lembrar do seu atendimento de {{servico}} em {{data}} às {{horario}}.%'
             THEN $2
             ELSE reminder_message
           END,
           weekly_schedule = CASE
             WHEN weekly_schedule IS NULL THEN '{"0": {"enabled": false, "ranges": []}, "1": {"enabled": true, "ranges": [{"start": "09:00", "end": "21:00"}]}, "2": {"enabled": true, "ranges": [{"start": "09:00", "end": "21:00"}]}, "3": {"enabled": true, "ranges": [{"start": "09:00", "end": "21:00"}]}, "4": {"enabled": true, "ranges": [{"start": "09:00", "end": "21:00"}]}, "5": {"enabled": true, "ranges": [{"start": "09:00", "end": "21:00"}]}, "6": {"enabled": false, "ranges": []}}'::jsonb
             ELSE weekly_schedule
           END,
           updated_at = NOW()
       WHERE id = 1`,
      [DEFAULT_CONFIRMATION_TEMPLATE, DEFAULT_REMINDER_TEMPLATE]
    );

    const admin = await client.query('SELECT id FROM admin_users WHERE username = $1', ['admin']);
    if (!admin.rowCount) {
      const passwordHash = await bcrypt.hash('3001', 10);
      await client.query(
        'INSERT INTO admin_users (username, password_hash) VALUES ($1, $2)',
        ['admin', passwordHash]
      );
    }

    await seedServices(client);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { bootstrap };
