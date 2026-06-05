const express = require('express');
const path = require('path');
const fs = require('fs/promises');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { z } = require('zod');
const config = require('./config');
const { query, withTransaction } = require('./db');
const { bootstrap } = require('./bootstrap');
const googleCalendarService = require('./services/googleCalendarService');

const app = express();
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: config.corsOrigin === '*' ? true : config.corsOrigin }));
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.resolve(process.cwd(), 'public')));

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false });
const apiLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 300, standardHeaders: true, legacyHeaders: false });
app.use('/api', apiLimiter);

const appointmentStatus = ['pendente', 'aguardando pagamento', 'confirmado', 'cancelado', 'concluido'];

function parseTimeToMinutes(value = '00:00') {
  const [h, m] = String(value).split(':').map(Number);
  return (h * 60) + m;
}

function minutesToTime(minutes) {
  const h = String(Math.floor(minutes / 60)).padStart(2, '0');
  const m = String(minutes % 60).padStart(2, '0');
  return `${h}:${m}`;
}

function minutesToRange(start, end) {
  return `${minutesToTime(start)} às ${minutesToTime(end)}`;
}

function formatDateBr(dateString) {
  const [y, m, d] = String(dateString).split('-');
  return `${d}/${m}/${y}`;
}

function normalizePhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return '';
  return digits.startsWith('55') ? digits : `55${digits}`;
}

function fillTemplate(template, values) {
  return Object.entries(values).reduce((acc, [key, value]) => acc.replaceAll(`{{${key}}}`, value ?? ''), template);
}

function moneyBRL(value) {
  return `R$ ${Number(value).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function toIso(dateString, minutes) {
  return `${dateString}T${minutesToTime(minutes)}:00-03:00`;
}

async function getSettings(client = null) {
  const executor = client || { query };
  const result = await executor.query('SELECT * FROM app_settings WHERE id = 1');
  return result.rows[0];
}

async function writeSystemLog(level, context, message, payload = {}, client = null) {
  const executor = client || { query };
  await executor.query(
    'INSERT INTO logs_sistema (level, context, message, payload) VALUES ($1,$2,$3,$4::jsonb)',
    [level, context, message, JSON.stringify(payload)]
  );
}

async function markGoogleSync(client = null) {
  const executor = client || { query };
  await executor.query('UPDATE app_settings SET google_connected = true, last_google_sync_at = NOW(), updated_at = NOW() WHERE id = 1');
}

async function logAction(client, appointmentId, action, payload = {}) {
  await client.query(
    'INSERT INTO appointment_logs (appointment_id, action, payload) VALUES ($1, $2, $3::jsonb)',
    [appointmentId, action, JSON.stringify(payload)]
  );
}

async function getServiceById(serviceId, client = null) {
  const executor = client || { query };
  const result = await executor.query('SELECT * FROM services WHERE id = $1', [serviceId]);
  return result.rows[0];
}

async function fetchAppointmentById(appointmentId, client = null) {
  const executor = client || { query };
  const result = await executor.query(
    `SELECT a.*, c.name AS client_name, c.whatsapp AS client_whatsapp, s.name AS service_name, s.duration_minutes, s.price_installment
     FROM appointments a
     JOIN clients c ON c.id = a.client_id
     JOIN services s ON s.id = a.service_id
     WHERE a.id = $1`,
    [appointmentId]
  );
  return result.rows[0];
}

function appointmentToGoogleModel(appointment) {
  return {
    service_name: appointment.service_name,
    client_name: appointment.client_name,
    client_whatsapp: appointment.client_whatsapp,
    payment_label: appointment.payment_label,
    notes: appointment.notes || '',
    start_iso: toIso(appointment.appointment_date, appointment.start_minutes),
    end_iso: toIso(appointment.appointment_date, appointment.end_minutes),
  };
}

async function fetchDayContext(date) {
  const [appointments, blocks, settings] = await Promise.all([
    query(
      `SELECT a.*, c.name AS client_name, c.whatsapp AS client_whatsapp, s.name AS service_name
       FROM appointments a
       JOIN clients c ON c.id = a.client_id
       JOIN services s ON s.id = a.service_id
       WHERE a.appointment_date = $1 AND a.status <> 'cancelado'`,
      [date]
    ),
    query('SELECT * FROM blocked_slots WHERE block_date = $1', [date]),
    getSettings(),
  ]);
  return { appointments: appointments.rows, blocks: blocks.rows, settings };
}

function overlaps(startA, endA, startB, endB) {
  return startA < endB && endA > startB;
}

function isVacationOrHoliday(date, settings) {
  const holidays = Array.isArray(settings.holidays) ? settings.holidays : [];
  const vacations = Array.isArray(settings.vacations) ? settings.vacations : [];
  if (holidays.includes(date)) return true;
  return vacations.some((period) => date >= period.start && date <= period.end);
}

function buildPaymentLabel(method, service) {
  if (method === 'pix') return 'PIX';
  if (method === 'cartao') return 'Cartão';
  return `Parcelado — ${service.price_installment}`;
}

function buildPaymentAmount(method, service) {
  if (method === 'pix') return moneyBRL(service.price_pix);
  if (method === 'cartao') return moneyBRL(service.price_card);
  return service.price_installment;
}

function buildWhatsappUrl(phone, message) {
  return `https://wa.me/${normalizePhone(phone)}?text=${encodeURIComponent(message)}`;
}

async function computeAvailability(serviceId, date) {
  const service = await getServiceById(serviceId);
  if (!service || !service.active) throw new Error('Serviço não encontrado ou inativo.');

  const { appointments, blocks, settings } = await fetchDayContext(date);
  const weekday = new Date(`${date}T12:00:00`).getDay();
  const allowed = Array.isArray(settings.allowed_weekdays) ? settings.allowed_weekdays : [1, 2, 3, 4, 5];
  if (!allowed.includes(weekday) || isVacationOrHoliday(date, settings)) {
    return { service, slots: [] };
  }

  const interval = Number(settings.slot_interval || 30);
  const start = Math.max(parseTimeToMinutes(settings.work_start), parseTimeToMinutes(service.min_hour));
  const end = Math.min(parseTimeToMinutes(settings.work_end), parseTimeToMinutes(service.max_hour));
  const slots = [];

  for (let cursor = start; cursor + service.duration_minutes <= end; cursor += interval) {
    const slotEnd = cursor + service.duration_minutes;
    const busyByAppointment = appointments.some((appointment) => overlaps(cursor, slotEnd, appointment.start_minutes, appointment.end_minutes + interval));
    const busyByBlock = blocks.some((block) => overlaps(cursor, slotEnd, block.start_minutes, block.end_minutes));
    if (!busyByAppointment && !busyByBlock) {
      slots.push({ startMinutes: cursor, endMinutes: slotEnd, label: minutesToRange(cursor, slotEnd) });
    }
  }

  return { service, slots, settings };
}

function signToken(user) {
  return jwt.sign({ sub: user.id, username: user.username }, config.jwtSecret, { expiresIn: '12h' });
}

function authRequired(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Não autenticado.' });
  try {
    req.user = jwt.verify(token, config.jwtSecret);
    next();
  } catch {
    return res.status(401).json({ error: 'Token inválido.' });
  }
}

async function syncAppointmentWithGoogle(appointmentId, action = 'upsert') {
  console.log('[GoogleSync:start]', JSON.stringify({ appointmentId, action }));

  const settings = await getSettings();
  if (!settings?.google_refresh_token || !googleCalendarService.isConfigured(settings)) {
    console.warn('[GoogleSync:skip]', JSON.stringify({ appointmentId, action, reason: 'Google não conectado.' }));
    return { synced: false, reason: 'Google não conectado.' };
  }

  const appointment = await fetchAppointmentById(appointmentId);
  if (!appointment) {
    console.warn('[GoogleSync:skip]', JSON.stringify({ appointmentId, action, reason: 'Agendamento não encontrado.' }));
    return { synced: false, reason: 'Agendamento não encontrado.' };
  }

  try {
    if (action === 'delete' || appointment.status === 'cancelado') {
      console.log('[GoogleSync:delete-check]', JSON.stringify({ appointmentId: appointment.id, googleEventId: appointment.google_event_id || null }));
      if (appointment.google_event_id) {
        await googleCalendarService.deleteCalendarEvent(settings, appointment.google_event_id);
        await query('UPDATE appointments SET google_event_id = NULL, updated_at = NOW() WHERE id = $1', [appointment.id]);
      }
      await markGoogleSync();
      await writeSystemLog('info', 'google_calendar', 'Evento removido do Google Calendar.', { appointmentId: appointment.id, action, googleEventId: appointment.google_event_id || null });
      console.log('[GoogleSync:delete-success]', JSON.stringify({ appointmentId: appointment.id, removedEventId: appointment.google_event_id || null }));
      return { synced: true, action: 'deleted' };
    }

    const googlePayload = appointmentToGoogleModel(appointment);
    console.log('[GoogleSync:payload]', JSON.stringify({
      appointmentId: appointment.id,
      status: appointment.status,
      hasGoogleEventId: Boolean(appointment.google_event_id),
      summary: `[${googlePayload.service_name}] - ${googlePayload.client_name}`,
      start: googlePayload.start_iso,
      end: googlePayload.end_iso,
    }));

    if (appointment.google_event_id) {
      const updatedEvent = await googleCalendarService.updateCalendarEvent(settings, googlePayload, appointment.google_event_id);
      if (!updatedEvent?.id) {
        throw new Error('Google Calendar retornou atualização sem eventId.');
      }
      await markGoogleSync();
      await writeSystemLog('info', 'google_calendar', 'Evento atualizado no Google Calendar.', { appointmentId: appointment.id, eventId: updatedEvent.id });
      console.log('[GoogleSync:update-success]', JSON.stringify({ appointmentId: appointment.id, eventId: updatedEvent.id }));
      return { synced: true, action: 'updated', eventId: updatedEvent.id };
    }

    const createdEvent = await googleCalendarService.createCalendarEvent(settings, googlePayload);
    if (!createdEvent?.id) {
      throw new Error('Google Calendar retornou criação sem eventId.');
    }
    const updateResult = await query('UPDATE appointments SET google_event_id = $1, updated_at = NOW() WHERE id = $2 RETURNING id, google_event_id', [createdEvent.id, appointment.id]);
    console.log('[GoogleSync:db-update]', JSON.stringify({ appointmentId: appointment.id, rowCount: updateResult.rowCount, googleEventId: updateResult.rows[0]?.google_event_id || null }));
    if (!updateResult.rowCount || !updateResult.rows[0]?.google_event_id) {
      throw new Error('Evento criado no Google, mas falhou ao salvar google_event_id no banco.');
    }
    await markGoogleSync();
    await writeSystemLog('info', 'google_calendar', 'Evento criado no Google Calendar.', { appointmentId: appointment.id, eventId: createdEvent.id });
    console.log('[GoogleSync:create-success]', JSON.stringify({ appointmentId: appointment.id, eventId: createdEvent.id }));
    return { synced: true, action: 'created', eventId: createdEvent.id };
  } catch (error) {
    const googleError = typeof googleCalendarService.extractGoogleError === 'function'
      ? googleCalendarService.extractGoogleError(error)
      : { message: error.message };
    console.error('[GoogleSync:error]', JSON.stringify({ appointmentId, action, googleError }, null, 2));
    await writeSystemLog('error', 'google_calendar', 'Falha ao sincronizar agendamento com Google Calendar.', {
      appointmentId,
      action,
      error: googleError,
    });
    return { synced: false, reason: googleError.message, error: googleError };
  }
}

const publicAppointmentSchema = z.object({
  serviceId: z.string().uuid(),
  paymentMethod: z.enum(['pix', 'cartao', 'parcelado']),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  startMinutes: z.number().int().min(0).max(1439),
  name: z.string().min(3),
  whatsapp: z.string().min(8),
  notes: z.string().optional().default(''),
});

const settingsSchema = z.object({
  brand_name: z.string().min(2),
  title: z.string().min(2),
  subtitle: z.string().min(2),
  therapist_name: z.string().min(2),
  therapist_whatsapp: z.string().min(8),
  notifications_whatsapp: z.string().min(8),
  footer_link: z.string().min(2),
  logo_url: z.string().optional().nullable(),
  confirmation_message: z.string().min(10),
  reminder_message: z.string().min(10),
  google_email: z.string().optional().nullable(),
  google_calendar_id: z.string().optional().nullable(),
  google_client_id: z.string().optional().nullable(),
  google_client_secret: z.string().optional().nullable(),
  google_redirect_uri: z.string().optional().nullable(),
  google_refresh_token: z.string().optional().nullable(),
  notification_immediate: z.boolean(),
  notification_24h: z.boolean(),
  notification_1h: z.boolean(),
  notification_15m: z.boolean(),
  notify_email: z.boolean(),
  notify_push: z.boolean(),
  work_start: z.string(),
  work_end: z.string(),
  slot_interval: z.number().int().min(5),
  allowed_weekdays: z.array(z.number().int().min(0).max(6)),
  vacations: z.array(z.object({ start: z.string(), end: z.string() })),
  holidays: z.array(z.string()),
  database_url: z.string().optional().nullable(),
});

app.get('/api/public/settings', async (_req, res) => {
  const settings = await getSettings();
  res.json({
    brandName: settings.brand_name,
    title: settings.title,
    subtitle: settings.subtitle,
    therapistName: settings.therapist_name,
    therapistWhatsapp: settings.therapist_whatsapp,
    footerLink: settings.footer_link,
    logoUrl: settings.logo_url,
  });
});

app.get('/api/public/services', async (_req, res) => {
  const result = await query('SELECT * FROM services WHERE active = true ORDER BY sort_order, created_at');
  res.json(result.rows);
});

app.get('/api/public/availability', async (req, res) => {
  try {
    const { serviceId, date } = req.query;
    const availability = await computeAvailability(serviceId, date);
    res.json(availability);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/public/appointments', async (req, res) => {
  try {
    const payload = publicAppointmentSchema.parse(req.body);
    const service = await getServiceById(payload.serviceId);
    if (!service || !service.active) return res.status(404).json({ error: 'Serviço indisponível.' });

    const availability = await computeAvailability(payload.serviceId, payload.date);
    const validSlot = availability.slots.find((slot) => slot.startMinutes === payload.startMinutes);
    if (!validSlot) return res.status(409).json({ error: 'Horário indisponível. Escolha outro horário.' });

    const result = await withTransaction(async (client) => {
      const normalizedWhatsapp = normalizePhone(payload.whatsapp);
      const existingClient = await client.query('SELECT id FROM clients WHERE whatsapp = $1 ORDER BY updated_at DESC LIMIT 1', [normalizedWhatsapp]);
      let clientId = existingClient.rows[0]?.id;

      if (!clientId) {
        const insertedClient = await client.query(
          'INSERT INTO clients (name, whatsapp) VALUES ($1, $2) RETURNING id',
          [payload.name, normalizedWhatsapp]
        );
        clientId = insertedClient.rows[0].id;
      } else {
        await client.query('UPDATE clients SET name = $1, whatsapp = $2, updated_at = NOW() WHERE id = $3', [payload.name, normalizedWhatsapp, clientId]);
      }

      const settings = await getSettings(client);
      const slotInterval = Number(settings.slot_interval || 30);
      const conflict = await client.query(
        `SELECT id FROM appointments
         WHERE appointment_date = $1
           AND status <> 'cancelado'
           AND $2 < (end_minutes + $4)
           AND $3 > start_minutes
         LIMIT 1`,
        [payload.date, payload.startMinutes, payload.startMinutes + service.duration_minutes, slotInterval]
      );
      if (conflict.rowCount) {
        throw new Error('Já existe um agendamento nesse período.');
      }

      const appointment = await client.query(
        `INSERT INTO appointments
          (client_id, service_id, appointment_date, start_minutes, end_minutes, payment_method, payment_label, payment_amount, status, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         RETURNING *`,
        [
          clientId,
          payload.serviceId,
          payload.date,
          payload.startMinutes,
          payload.startMinutes + service.duration_minutes,
          payload.paymentMethod,
          buildPaymentLabel(payload.paymentMethod, service),
          buildPaymentAmount(payload.paymentMethod, service),
          'aguardando pagamento',
          payload.notes || '',
        ]
      );

      await logAction(client, appointment.rows[0].id, 'created', payload);
      await writeSystemLog('info', 'appointments', 'Agendamento criado pelo cliente.', { appointmentId: appointment.rows[0].id }, client);
      return { appointment: appointment.rows[0], settings };
    });

    console.log('[Appointment:create] sincronização Google iniciada', JSON.stringify({ appointmentId: result.appointment.id, status: result.appointment.status }));
    const googleSync = await syncAppointmentWithGoogle(result.appointment.id, 'create');
    console.log('[Appointment:create] sincronização Google finalizada', JSON.stringify({ appointmentId: result.appointment.id, googleSync }));

    const therapistMessage = [
      `Novo agendamento — ${payload.name}`,
      `Serviço: ${service.name}`,
      `Data: ${formatDateBr(payload.date)}`,
      `Horário: ${minutesToRange(payload.startMinutes, payload.startMinutes + service.duration_minutes)}`,
      `Pagamento: ${buildPaymentLabel(payload.paymentMethod, service)} (${buildPaymentAmount(payload.paymentMethod, service)})`,
      `WhatsApp do cliente: ${normalizePhone(payload.whatsapp)}`,
    ].join('\n');

    res.status(201).json({
      success: true,
      appointmentId: result.appointment.id,
      googleEventId: googleSync.eventId || null,
      google: googleSync,
      therapistWhatsappUrl: buildWhatsappUrl(result.settings.notifications_whatsapp, therapistMessage),
      confirmation: {
        service: service.name,
        date: formatDateBr(payload.date),
        time: minutesToRange(payload.startMinutes, payload.startMinutes + service.duration_minutes),
        status: 'aguardando pagamento',
      },
    });
  } catch (error) {
    await writeSystemLog('error', 'appointments', 'Falha ao criar agendamento público.', { error: error.message, body: req.body }).catch(() => null);
    res.status(400).json({ error: error.message || 'Não foi possível concluir o agendamento.' });
  }
});

app.post('/api/admin/auth/login', authLimiter, async (req, res) => {
  const schema = z.object({ password: z.string().min(4) });
  try {
    const { password } = schema.parse(req.body);
    const result = await query('SELECT * FROM admin_users WHERE username = $1 LIMIT 1', ['admin']);
    const user = result.rows[0];
    if (!user) return res.status(401).json({ error: 'Usuário não encontrado.' });
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Senha inválida.' });
    res.json({ token: signToken(user) });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/admin/dashboard', authRequired, async (_req, res) => {
  const result = await query(`
    WITH base AS (
      SELECT a.*, s.name AS service_name
      FROM appointments a
      JOIN services s ON s.id = a.service_id
    )
    SELECT json_build_object(
      'today', (SELECT COUNT(*) FROM base WHERE appointment_date = CURRENT_DATE),
      'upcoming', (SELECT COUNT(*) FROM base WHERE appointment_date >= CURRENT_DATE AND status IN ('pendente','aguardando pagamento','confirmado')),
      'pending', (SELECT COUNT(*) FROM base WHERE status IN ('pendente','aguardando pagamento')),
      'confirmed', (SELECT COUNT(*) FROM base WHERE status = 'confirmado'),
      'forecastRevenue', (SELECT COUNT(*) FROM base WHERE status IN ('pendente','aguardando pagamento','confirmado')),
      'confirmedRevenue', (SELECT COUNT(*) FROM base WHERE status = 'confirmado'),
      'topServices', (SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json) FROM (SELECT service_name, COUNT(*) AS total FROM base GROUP BY service_name ORDER BY total DESC LIMIT 5) t),
      'calendar', (SELECT COALESCE(json_agg(row_to_json(c)), '[]'::json) FROM (SELECT id, appointment_date, start_minutes, end_minutes, status FROM base WHERE appointment_date >= CURRENT_DATE ORDER BY appointment_date, start_minutes LIMIT 10) c)
    ) AS data
  `);
  res.json(result.rows[0].data);
});

app.get('/api/admin/appointments', authRequired, async (req, res) => {
  const status = req.query.status && appointmentStatus.includes(req.query.status) ? req.query.status : null;
  const search = `%${String(req.query.search || '').trim()}%`;
  const startDate = req.query.startDate || '1900-01-01';
  const endDate = req.query.endDate || '2999-12-31';
  const params = [search, startDate, endDate];
  let where = 'WHERE a.appointment_date BETWEEN $2 AND $3 AND (c.name ILIKE $1 OR c.whatsapp ILIKE $1 OR s.name ILIKE $1)';
  if (status) {
    params.push(status);
    where += ` AND a.status = $${params.length}`;
  }
  const result = await query(
    `SELECT a.*, c.name AS client_name, c.whatsapp AS client_whatsapp, s.name AS service_name
     FROM appointments a
     JOIN clients c ON c.id = a.client_id
     JOIN services s ON s.id = a.service_id
     ${where}
     ORDER BY a.appointment_date DESC, a.start_minutes DESC`,
    params
  );
  res.json(result.rows);
});

app.get('/api/admin/clients', authRequired, async (_req, res) => {
  const result = await query(`
    SELECT c.*, COUNT(a.id)::int AS total_appointments, MAX(a.appointment_date) AS last_appointment
    FROM clients c
    LEFT JOIN appointments a ON a.client_id = c.id
    GROUP BY c.id
    ORDER BY c.updated_at DESC
  `);
  res.json(result.rows);
});

app.get('/api/admin/services', authRequired, async (_req, res) => {
  const result = await query('SELECT * FROM services ORDER BY sort_order, created_at');
  res.json(result.rows);
});

app.post('/api/admin/services', authRequired, async (req, res) => {
  const schema = z.object({
    name: z.string().min(3),
    description: z.string().default(''),
    duration_minutes: z.number().int().min(15),
    price_pix: z.number().min(0),
    price_card: z.number().min(0),
    price_installment: z.string().min(1),
    min_hour: z.string().min(5),
    max_hour: z.string().min(5),
    active: z.boolean().default(true),
    sort_order: z.number().int().default(0),
  });
  try {
    const body = schema.parse(req.body);
    const result = await query(
      `INSERT INTO services (name, description, duration_minutes, price_pix, price_card, price_installment, min_hour, max_hour, active, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [body.name, body.description, body.duration_minutes, body.price_pix, body.price_card, body.price_installment, body.min_hour, body.max_hour, body.active, body.sort_order]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.put('/api/admin/services/:id', authRequired, async (req, res) => {
  const schema = z.object({
    name: z.string().min(3),
    description: z.string().default(''),
    duration_minutes: z.number().int().min(15),
    price_pix: z.number().min(0),
    price_card: z.number().min(0),
    price_installment: z.string().min(1),
    min_hour: z.string().min(5),
    max_hour: z.string().min(5),
    active: z.boolean().default(true),
    sort_order: z.number().int().default(0),
  });
  try {
    const body = schema.parse(req.body);
    const result = await query(
      `UPDATE services SET
          name=$1, description=$2, duration_minutes=$3, price_pix=$4, price_card=$5, price_installment=$6,
          min_hour=$7, max_hour=$8, active=$9, sort_order=$10, updated_at=NOW()
       WHERE id=$11 RETURNING *`,
      [body.name, body.description, body.duration_minutes, body.price_pix, body.price_card, body.price_installment, body.min_hour, body.max_hour, body.active, body.sort_order, req.params.id]
    );
    res.json(result.rows[0]);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.delete('/api/admin/services/:id', authRequired, async (req, res) => {
  await query('DELETE FROM services WHERE id = $1', [req.params.id]);
  res.json({ success: true });
});

app.get('/api/admin/blocks', authRequired, async (_req, res) => {
  const result = await query('SELECT * FROM blocked_slots ORDER BY block_date DESC, start_minutes DESC');
  res.json(result.rows);
});

app.post('/api/admin/blocks', authRequired, async (req, res) => {
  const schema = z.object({ date: z.string(), start_minutes: z.number().int(), end_minutes: z.number().int(), reason: z.string().min(2) });
  try {
    const body = schema.parse(req.body);
    const result = await query(
      'INSERT INTO blocked_slots (block_date, start_minutes, end_minutes, reason) VALUES ($1,$2,$3,$4) RETURNING *',
      [body.date, body.start_minutes, body.end_minutes, body.reason]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.delete('/api/admin/blocks/:id', authRequired, async (req, res) => {
  await query('DELETE FROM blocked_slots WHERE id = $1', [req.params.id]);
  res.json({ success: true });
});

app.get('/api/admin/reports', authRequired, async (req, res) => {
  const startDate = req.query.startDate || '1900-01-01';
  const endDate = req.query.endDate || '2999-12-31';
  const result = await query(`
    SELECT json_build_object(
      'byStatus', (SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json) FROM (SELECT status, COUNT(*)::int AS total FROM appointments WHERE appointment_date BETWEEN $1 AND $2 GROUP BY status ORDER BY total DESC) t),
      'byService', (SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json) FROM (SELECT s.name, COUNT(*)::int AS total FROM appointments a JOIN services s ON s.id = a.service_id WHERE a.appointment_date BETWEEN $1 AND $2 GROUP BY s.name ORDER BY total DESC) t),
      'clients', (SELECT COUNT(DISTINCT client_id)::int FROM appointments WHERE appointment_date BETWEEN $1 AND $2)
    ) AS data
  `, [startDate, endDate]);
  res.json(result.rows[0].data);
});

app.get('/api/admin/settings', authRequired, async (_req, res) => {
  const settings = await getSettings();
  res.json(settings);
});

app.put('/api/admin/settings', authRequired, async (req, res) => {
  try {
    const body = settingsSchema.parse(req.body);
    const current = await getSettings();
    const googleConnected = Boolean(
      (body.google_refresh_token || current.google_refresh_token) &&
      (body.google_client_id || current.google_client_id) &&
      (body.google_client_secret || current.google_client_secret) &&
      (body.google_redirect_uri || current.google_redirect_uri)
    );

    const result = await query(
      `UPDATE app_settings SET
        brand_name=$1,title=$2,subtitle=$3,therapist_name=$4,therapist_whatsapp=$5,notifications_whatsapp=$6,footer_link=$7,logo_url=$8,
        confirmation_message=$9,reminder_message=$10,google_email=$11,google_calendar_id=$12,google_client_id=$13,google_client_secret=$14,
        google_redirect_uri=$15,google_refresh_token=$16,google_connected=$17,notification_immediate=$18,notification_24h=$19,
        notification_1h=$20,notification_15m=$21,notify_email=$22,notify_push=$23,work_start=$24,work_end=$25,slot_interval=$26,
        allowed_weekdays=$27::jsonb,vacations=$28::jsonb,holidays=$29::jsonb,database_url=$30,updated_at=NOW()
       WHERE id=1 RETURNING *`,
      [
        body.brand_name,
        body.title,
        body.subtitle,
        body.therapist_name,
        body.therapist_whatsapp,
        body.notifications_whatsapp,
        body.footer_link,
        body.logo_url,
        body.confirmation_message,
        body.reminder_message,
        body.google_email || null,
        body.google_calendar_id || null,
        body.google_client_id || null,
        body.google_client_secret || null,
        body.google_redirect_uri || null,
        body.google_refresh_token || null,
        googleConnected,
        body.notification_immediate,
        body.notification_24h,
        body.notification_1h,
        body.notification_15m,
        body.notify_email,
        body.notify_push,
        body.work_start,
        body.work_end,
        body.slot_interval,
        JSON.stringify(body.allowed_weekdays),
        JSON.stringify(body.vacations),
        JSON.stringify(body.holidays),
        body.database_url || null,
      ]
    );

    if (body.database_url) {
      await fs.writeFile(config.runtimeEnv, `DATABASE_URL=${body.database_url}\n`, 'utf8');
    }

    res.json({ ...result.rows[0], requiresRestartForDatabaseChange: Boolean(body.database_url) });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/google/status', async (_req, res) => {
  try {
    const settings = await getSettings();
    if (!settings?.google_refresh_token || !googleCalendarService.isConfigured(settings)) {
      return res.json({ connected: false, lastSyncAt: settings?.last_google_sync_at || null });
    }
    const status = await googleCalendarService.getConnectionStatus(settings);
    await query('UPDATE app_settings SET google_connected = $1, updated_at = NOW() WHERE id = 1', [Boolean(status.connected)]);
    res.json(status);
  } catch (error) {
    await query('UPDATE app_settings SET google_connected = false, updated_at = NOW() WHERE id = 1');
    await writeSystemLog('error', 'google_oauth', 'Falha ao consultar status do Google.', { error: error.message }).catch(() => null);
    res.json({ connected: false });
  }
});

app.post('/api/google/connect-url', authRequired, async (_req, res) => {
  try {
    const settings = await getSettings();
    if (!googleCalendarService.isConfigured(settings)) {
      return res.status(400).json({ error: 'Preencha Google Client ID, Client Secret e Redirect URI antes de conectar.' });
    }
    const url = googleCalendarService.createAuthUrl(settings, `google-oauth-${Date.now()}`);
    res.json({ url });
  } catch (error) {
    await writeSystemLog('error', 'google_oauth', 'Falha ao gerar URL de conexão Google.', { error: error.message }).catch(() => null);
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/google/disconnect', authRequired, async (_req, res) => {
  await query(
    `UPDATE app_settings
     SET google_refresh_token = NULL, google_connected = false, last_google_sync_at = NULL, updated_at = NOW()
     WHERE id = 1`
  );
  await writeSystemLog('info', 'google_oauth', 'Conta Google desconectada manualmente.', {}).catch(() => null);
  res.json({ success: true, connected: false });
});

app.get('/api/google/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) {
    await writeSystemLog('error', 'google_oauth', 'Callback do Google recebido sem code.', { query: req.query }).catch(() => null);
    return res.redirect('/admin.html?google=error');
  }

  try {
    const settings = await getSettings();
    if (!googleCalendarService.isConfigured(settings)) {
      await writeSystemLog('error', 'google_oauth', 'Configuração OAuth incompleta antes do callback.', {}).catch(() => null);
      return res.redirect('/admin.html?google=missing-config');
    }

    const tokens = await googleCalendarService.exchangeCodeForTokens(settings, code);
    await query(
      `UPDATE app_settings SET
         google_refresh_token = $1,
         google_connected = true,
         google_email = COALESCE(NULLIF(google_email, ''), $2),
         google_calendar_id = COALESCE(NULLIF(google_calendar_id, ''), $3),
         google_client_id = COALESCE(NULLIF(google_client_id, ''), $4),
         google_client_secret = COALESCE(NULLIF(google_client_secret, ''), $5),
         last_google_sync_at = NOW(),
         updated_at = NOW()
       WHERE id = 1`,
      [
        tokens.refreshToken,
        tokens.email,
        tokens.calendarId || 'primary',
        settings.google_client_id,
        settings.google_client_secret,
      ]
    );

    await writeSystemLog('info', 'google_oauth', 'Conta Google conectada com sucesso.', {
      email: tokens.email,
      calendarId: tokens.calendarId,
      hasAccessToken: Boolean(tokens.accessToken),
      hasRefreshToken: Boolean(tokens.refreshToken),
    }).catch(() => null);

    return res.redirect('/admin.html?google=connected');
  } catch (error) {
    await query('UPDATE app_settings SET google_connected = false, updated_at = NOW() WHERE id = 1').catch(() => null);
    await writeSystemLog('error', 'google_oauth', 'Falha no callback OAuth do Google.', { error: error.message }).catch(() => null);
    return res.redirect('/admin.html?google=error');
  }
});

app.post('/api/admin/settings/google/test', authRequired, async (_req, res) => {
  try {
    const settings = await getSettings();
    const status = await googleCalendarService.getConnectionStatus(settings);
    await query('UPDATE app_settings SET google_connected = $1, updated_at = NOW() WHERE id = 1', [Boolean(status.connected)]);
    res.json(status);
  } catch (error) {
    await writeSystemLog('error', 'google_oauth', 'Falha ao testar conexão Google.', { error: error.message }).catch(() => null);
    res.json({ connected: false, reason: error.message });
  }
});

app.post('/api/admin/auth/change-password', authRequired, async (req, res) => {
  const schema = z.object({ currentPassword: z.string().min(4), newPassword: z.string().min(4) });
  try {
    const body = schema.parse(req.body);
    const userResult = await query('SELECT * FROM admin_users WHERE id = $1', [req.user.sub]);
    const user = userResult.rows[0];
    if (!user) return res.status(404).json({ error: 'Usuário não encontrado.' });
    const valid = await bcrypt.compare(body.currentPassword, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Senha atual inválida.' });
    const hash = await bcrypt.hash(body.newPassword, 10);
    await query('UPDATE admin_users SET password_hash = $1, updated_at = NOW() WHERE id = $2', [hash, user.id]);
    res.json({ success: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.put('/api/admin/appointments/:id', authRequired, async (req, res) => {
  const schema = z.object({
    appointment_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    start_minutes: z.number().int(),
    status: z.enum(appointmentStatus),
    payment_method: z.enum(['pix', 'cartao', 'parcelado']),
    notes: z.string().optional().default(''),
  });

  try {
    const body = schema.parse(req.body);
    const appointment = await fetchAppointmentById(req.params.id);
    if (!appointment) return res.status(404).json({ error: 'Agendamento não encontrado.' });

    const availability = await computeAvailability(appointment.service_id, body.appointment_date);
    const sameSlot = appointment.appointment_date === body.appointment_date && appointment.start_minutes === body.start_minutes;
    const allowed = sameSlot || availability.slots.some((slot) => slot.startMinutes === body.start_minutes);
    if (!allowed) return res.status(409).json({ error: 'Novo horário indisponível.' });

    const service = await getServiceById(appointment.service_id);
    const paymentLabel = buildPaymentLabel(body.payment_method, service);
    const paymentAmount = buildPaymentAmount(body.payment_method, service);
    const canceledAt = body.status === 'cancelado' ? new Date().toISOString() : null;

    const result = await query(
      `UPDATE appointments SET
         appointment_date = $1,
         start_minutes = $2,
         end_minutes = $3,
         status = $4,
         payment_method = $5,
         payment_label = $6,
         payment_amount = $7,
         notes = $8,
         canceled_at = $9,
         updated_at = NOW()
       WHERE id = $10 RETURNING *`,
      [
        body.appointment_date,
        body.start_minutes,
        body.start_minutes + service.duration_minutes,
        body.status,
        body.payment_method,
        paymentLabel,
        paymentAmount,
        body.notes,
        canceledAt,
        req.params.id,
      ]
    );

    await writeSystemLog('info', 'appointments', 'Agendamento atualizado pelo painel.', { appointmentId: req.params.id, status: body.status }).catch(() => null);

    console.log('[Appointment:update] sincronização Google iniciada', JSON.stringify({ appointmentId: req.params.id, status: body.status }));
    let syncResult;
    if (body.status === 'cancelado') {
      syncResult = await syncAppointmentWithGoogle(req.params.id, 'delete');
    } else {
      syncResult = await syncAppointmentWithGoogle(req.params.id, 'update');
    }
    console.log('[Appointment:update] sincronização Google finalizada', JSON.stringify({ appointmentId: req.params.id, syncResult }));

    res.json({ ...result.rows[0], google: syncResult });
  } catch (error) {
    await writeSystemLog('error', 'appointments', 'Falha ao atualizar agendamento.', { error: error.message, appointmentId: req.params.id }).catch(() => null);
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/admin/appointments/:id/confirm', authRequired, async (req, res) => {
  try {
    const result = await withTransaction(async (client) => {
      const appointment = await fetchAppointmentById(req.params.id, client);
      if (!appointment) throw new Error('Agendamento não encontrado.');

      const updated = await client.query(
        `UPDATE appointments
         SET status = 'confirmado', confirmed_at = NOW(), canceled_at = NULL, updated_at = NOW()
         WHERE id = $1 RETURNING *`,
        [req.params.id]
      );
      await logAction(client, req.params.id, 'confirmed', { by: req.user.username });
      await writeSystemLog('info', 'appointments', 'Atendimento confirmado pelo painel.', { appointmentId: req.params.id }, client);
      const settings = await getSettings(client);
      return { appointment, updated: updated.rows[0], settings };
    });

    console.log('[Appointment:confirm] sincronização Google iniciada', JSON.stringify({ appointmentId: req.params.id }));
    const syncResult = await syncAppointmentWithGoogle(req.params.id, 'confirm');
    console.log('[Appointment:confirm] sincronização Google finalizada', JSON.stringify({ appointmentId: req.params.id, syncResult }));
    const confirmedAppointment = await fetchAppointmentById(req.params.id);

    const message = fillTemplate(result.settings.confirmation_message, {
      nome: result.appointment.client_name,
      servico: result.appointment.service_name,
      data: formatDateBr(result.appointment.appointment_date),
      horario: minutesToRange(result.appointment.start_minutes, result.appointment.end_minutes),
      terapeuta: result.settings.therapist_name,
    });

    res.json({
      success: true,
      whatsappUrl: buildWhatsappUrl(result.appointment.client_whatsapp, message),
      message,
      appointment: confirmedAppointment,
      google: syncResult,
    });
  } catch (error) {
    await writeSystemLog('error', 'appointments', 'Falha ao confirmar atendimento.', { error: error.message, appointmentId: req.params.id }).catch(() => null);
    res.status(400).json({ error: error.message });
  }
});

app.delete('/api/admin/appointments/:id', authRequired, async (req, res) => {
  try {
    const appointment = await fetchAppointmentById(req.params.id);
    if (!appointment) return res.status(404).json({ error: 'Agendamento não encontrado.' });

    console.log('[Appointment:delete] sincronização Google iniciada', JSON.stringify({ appointmentId: req.params.id, googleEventId: appointment.google_event_id || null }));
    const syncResult = await syncAppointmentWithGoogle(req.params.id, 'delete');
    console.log('[Appointment:delete] sincronização Google finalizada', JSON.stringify({ appointmentId: req.params.id, syncResult }));

    await withTransaction(async (client) => {
      await client.query('DELETE FROM appointments WHERE id = $1', [req.params.id]);
      await logAction(client, req.params.id, 'deleted', { by: req.user.username });
      await writeSystemLog('info', 'appointments', 'Agendamento excluído do painel.', { appointmentId: req.params.id }, client);
    });

    res.json({ success: true, google: syncResult });
  } catch (error) {
    await writeSystemLog('error', 'appointments', 'Falha ao excluir agendamento.', { error: error.message, appointmentId: req.params.id }).catch(() => null);
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/health', (_req, res) => res.json({ ok: true }));

async function start() {
  if (config.autoMigrate && config.databaseUrl) {
    await bootstrap();
  }
  app.listen(config.port, () => {
    console.log(`Servidor iniciado em http://localhost:${config.port}`);
  });
}

start().catch((error) => {
  console.error('Falha ao iniciar a aplicação:', error);
  process.exit(1);
});
