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
const XLSX = require('xlsx');

const app = express();
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: config.corsOrigin === '*' ? true : config.corsOrigin }));
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.resolve(process.cwd(), 'public')));

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false });
const apiLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 300, standardHeaders: true, legacyHeaders: false });
app.use('/api', apiLimiter);

const appointmentStatus = ['pendente', 'aguardando pagamento', 'confirmado', 'cancelado', 'concluido'];
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

const DEFAULT_WEEKLY_SCHEDULE = Object.freeze({
  '0': { enabled: false, ranges: [] },
  '1': { enabled: true, ranges: [{ start: '09:00', end: '21:00' }] },
  '2': { enabled: true, ranges: [{ start: '09:00', end: '21:00' }] },
  '3': { enabled: true, ranges: [{ start: '09:00', end: '21:00' }] },
  '4': { enabled: true, ranges: [{ start: '09:00', end: '21:00' }] },
  '5': { enabled: true, ranges: [{ start: '09:00', end: '21:00' }] },
  '6': { enabled: false, ranges: [] },
});

function cloneDefaultWeeklySchedule() {
  return JSON.parse(JSON.stringify(DEFAULT_WEEKLY_SCHEDULE));
}

function sanitizeTimeValue(value, fallback = '09:00') {
  const match = String(value || '').trim().match(/^(\d{2}):(\d{2})$/);
  if (!match) return fallback;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return fallback;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function sanitizeTimeRanges(ranges = []) {
  const normalized = [];
  for (const range of Array.isArray(ranges) ? ranges : []) {
    const start = sanitizeTimeValue(range?.start, '09:00');
    const end = sanitizeTimeValue(range?.end, '21:00');
    if (parseTimeToMinutes(start) >= parseTimeToMinutes(end)) continue;
    const key = `${start}-${end}`;
    if (!normalized.some((item) => `${item.start}-${item.end}` === key)) {
      normalized.push({ start, end });
    }
  }
  return normalized.sort((a, b) => parseTimeToMinutes(a.start) - parseTimeToMinutes(b.start));
}

function buildLegacyWeeklySchedule(settings = {}) {
  const allowed = Array.isArray(settings.allowed_weekdays) ? settings.allowed_weekdays : [1, 2, 3, 4, 5];
  const start = sanitizeTimeValue(settings.work_start, '09:00');
  const end = sanitizeTimeValue(settings.work_end, '21:00');
  const schedule = cloneDefaultWeeklySchedule();
  for (let day = 0; day < 7; day += 1) {
    schedule[String(day)] = {
      enabled: allowed.includes(day),
      ranges: allowed.includes(day) && parseTimeToMinutes(start) < parseTimeToMinutes(end)
        ? [{ start, end }]
        : [],
    };
  }
  return schedule;
}

function normalizeWeeklySchedule(rawSchedule, settings = {}) {
  const legacy = buildLegacyWeeklySchedule(settings);
  const normalized = {};
  const source = rawSchedule && typeof rawSchedule === 'object' ? rawSchedule : {};
  for (let day = 0; day < 7; day += 1) {
    const key = String(day);
    const rawDay = source[key] ?? source[day] ?? null;
    const fallback = legacy[key];
    const ranges = sanitizeTimeRanges(Array.isArray(rawDay?.ranges) ? rawDay.ranges : fallback.ranges);
    const enabled = typeof rawDay?.enabled === 'boolean' ? rawDay.enabled : fallback.enabled;
    normalized[key] = { enabled: Boolean(enabled), ranges };
  }
  return normalized;
}

function getWorkingWindowsForDate(service, settings, date) {
  if (isVacationOrHoliday(date, settings)) return [];
  const weekday = new Date(`${date}T12:00:00`).getDay();
  const schedule = normalizeWeeklySchedule(settings.weekly_schedule, settings);
  const daySchedule = schedule[String(weekday)] || { enabled: false, ranges: [] };
  if (!daySchedule.enabled || !Array.isArray(daySchedule.ranges) || !daySchedule.ranges.length) return [];
  return daySchedule.ranges.map((range) => {
    const start = Math.max(parseTimeToMinutes(range.start), parseTimeToMinutes(service.min_hour));
    const end = Math.min(parseTimeToMinutes(range.end), parseTimeToMinutes(service.max_hour));
    if (start + service.duration_minutes > end) return null;
    return { start, end };
  }).filter(Boolean);
}

function computeAvailableSlots({ service, settings, date, appointments = [], blocks = [] }) {
  const interval = Number(settings.slot_interval || 30);
  const windows = getWorkingWindowsForDate(service, settings, date);
  const slots = [];
  for (const window of windows) {
    for (let cursor = window.start; cursor + service.duration_minutes <= window.end; cursor += interval) {
      const slotEnd = cursor + service.duration_minutes;
      const busyByAppointment = appointments.some((appointment) => overlaps(cursor, slotEnd, appointment.start_minutes, appointment.end_minutes + interval));
      const busyByBlock = blocks.some((block) => overlaps(cursor, slotEnd, block.start_minutes, block.end_minutes));
      if (!busyByAppointment && !busyByBlock) {
        slots.push({ startMinutes: cursor, endMinutes: slotEnd, label: minutesToRange(cursor, slotEnd) });
      }
    }
  }
  return slots;
}

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

function toDateOnlyString(value) {
  if (!value) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const raw = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const isoMatch = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  if (isoMatch) return isoMatch[1];
  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  return raw;
}

function formatDateBr(dateString) {
  const normalized = toDateOnlyString(dateString);
  const [y, m, d] = String(normalized).split('-');
  if (!y || !m || !d) return String(dateString || '-');
  return `${d}/${m}/${y}`;
}

function normalizePhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return '';
  return digits.startsWith('55') ? digits : `55${digits}`;
}

function formatWhatsappDisplay(phone) {
  const digits = normalizePhone(phone).replace(/^55/, '');
  if (digits.length === 11) {
    return `(${digits.slice(0, 2)}) ${digits.slice(2, 7)}-${digits.slice(7)}`;
  }
  if (digits.length === 10) {
    return `(${digits.slice(0, 2)}) ${digits.slice(2, 6)}-${digits.slice(6)}`;
  }
  return phone || '';
}

function normalizeWhatsappMessage(value) {
  return String(value ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\u([0-9a-fA-F]{4})/g, (_match, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/\uFFFD/g, '')
    .replace(/�/g, '')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .normalize('NFC')
    .trim();
}

function fillTemplate(template, values) {
  const compiled = Object.entries(values).reduce((acc, [key, value]) => acc.replaceAll(`{{${key}}}`, value == null ? '' : String(value)), String(template ?? ''));
  return normalizeWhatsappMessage(compiled);
}

function resolveMessageTemplate(template, fallback) {
  const normalizedTemplate = normalizeWhatsappMessage(template);
  return normalizedTemplate || normalizeWhatsappMessage(fallback);
}

function moneyBRL(value) {
  return `R$ ${Number(value).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function toIso(dateString, minutes) {
  const normalizedDate = toDateOnlyString(dateString);
  return `${normalizedDate}T${minutesToTime(minutes)}:00-03:00`;
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

function normalizeNameKey(name = '') {
  return String(name || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function parseMoneyValue(value) {
  if (value == null) return 0;
  const cleaned = String(value)
    .replace(/[^\d,.-]/g, '')
    .replace(/\.(?=\d{3}(\D|$))/g, '')
    .replace(',', '.');
  const numeric = Number(cleaned);
  return Number.isFinite(numeric) ? numeric : 0;
}

function buildFriendlyGoogleError(error) {
  const message = error?.details?.[0]?.message
    || error?.responseData?.error?.errors?.[0]?.message
    || error?.responseData?.error?.message
    || error?.error?.message
    || error?.message
    || 'Falha ao sincronizar com Google Agenda.';
  if (/invalid_grant/i.test(message)) return 'A conexão com o Google expirou. Reconecte a conta.';
  if (/insufficient permissions|forbidden|permission/i.test(message)) return 'A conta Google não tem permissão suficiente para criar eventos neste calendário.';
  if (/not found/i.test(message)) return 'O calendário configurado não foi encontrado. Revise o Calendar ID.';
  return message;
}

function safeDbText(value, { allowNull = true } = {}) {
  if (value === undefined) return allowNull ? null : '';
  if (value === null) return allowNull ? null : '';
  return String(value);
}

function safeDbJson(value, fallback = {}) {
  return JSON.stringify(value === undefined ? fallback : (value ?? fallback));
}

function logGoogleDbParams(params) {
  console.log('[GOOGLE DB PARAMS]', params);
}

async function setGoogleState({ connected = true, lastError = null, lastResponse = null, client = null } = {}) {
  const executor = client || { query };
  await executor.query(
    `UPDATE app_settings
     SET google_connected = $1,
         last_google_sync_at = CASE WHEN $1 THEN NOW() ELSE last_google_sync_at END,
         google_last_error = $2,
         google_last_response = $3::jsonb,
         updated_at = NOW()
     WHERE id = 1`,
    [connected, lastError, JSON.stringify(lastResponse || {})]
  );
}

async function storeAppointmentGoogleState(appointmentId, payload = {}, client = null) {
  const executor = client || { query };
  const params = [
    safeDbText(appointmentId, { allowNull: false }),
    safeDbText(payload.status || 'desconhecido', { allowNull: false }),
    safeDbText(payload.error),
    payload.errorDetails == null ? null : safeDbText(typeof payload.errorDetails === 'string' ? payload.errorDetails : JSON.stringify(payload.errorDetails, null, 2)),
    safeDbJson(payload.payload, {}),
    safeDbJson(payload.response, {}),
  ];
  logGoogleDbParams({
    scope: 'storeAppointmentGoogleState',
    p1: params[0],
    p2: params[1],
    p3: params[2],
    p4: params[3],
    p5: params[4],
    p6: params[5],
  });
  await executor.query(
    `UPDATE appointments
     SET google_sync_status = $2,
         google_sync_error = $3,
         google_error_details = $4,
         google_payload_json = $5::jsonb,
         google_response_json = $6::jsonb,
         google_last_sync_at = NOW(),
         google_last_response = $6::jsonb,
         updated_at = NOW()
     WHERE id = $1`,
    params
  );
}

async function fetchLastGoogleError() {
  const settings = await getSettings();
  if (settings?.google_last_error) {
    return settings.google_last_error;
  }
  const result = await query(
    `SELECT message, payload, created_at
     FROM logs_sistema
     WHERE context IN ('google_calendar', 'google_oauth') AND level = 'error'
     ORDER BY created_at DESC
     LIMIT 1`
  );
  const row = result.rows[0];
  if (!row) return null;
  return row.payload?.error?.message || row.payload?.error || row.message;
}

function flattenObjectKeys(input, prefix = '') {
  if (input == null || typeof input !== 'object') return [];
  return Object.entries(input).flatMap(([key, value]) => {
    const nextKey = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return [nextKey, ...flattenObjectKeys(value, nextKey)];
    }
    return [nextKey];
  });
}

function buildPayloadComparison(testPayload, appointmentPayload) {
  const testFields = [...new Set(flattenObjectKeys(testPayload))].sort();
  const appointmentFields = [...new Set(flattenObjectKeys(appointmentPayload))].sort();
  const onlyInTest = testFields.filter((field) => !appointmentFields.includes(field));
  const onlyInAppointment = appointmentFields.filter((field) => !testFields.includes(field));
  const changedValues = [];
  const sharedFields = testFields.filter((field) => appointmentFields.includes(field));

  for (const field of sharedFields) {
    const testValue = field.split('.').reduce((acc, key) => acc?.[key], testPayload);
    const appointmentValue = field.split('.').reduce((acc, key) => acc?.[key], appointmentPayload);
    if (JSON.stringify(testValue) !== JSON.stringify(appointmentValue)) {
      changedValues.push({ field, testValue, appointmentValue });
    }
  }

  return { testFields, appointmentFields, onlyInTest, onlyInAppointment, changedValues };
}

function buildDateRangeFromPreset(preset) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const iso = (date) => date.toISOString().slice(0, 10);
  if (preset === 'today') {
    return { startDate: iso(today), endDate: iso(today) };
  }
  if (preset === 'tomorrow') {
    const tomorrow = new Date(today);
    tomorrow.setDate(today.getDate() + 1);
    return { startDate: iso(tomorrow), endDate: iso(tomorrow) };
  }
  if (preset === 'week') {
    const end = new Date(today);
    end.setDate(today.getDate() + 6);
    return { startDate: iso(today), endDate: iso(end) };
  }
  return null;
}

function generateBlockDates({ date, repeat_mode = 'none', repeat_until = null, repeat_count = null }) {
  const dates = [];
  const start = new Date(`${date}T12:00:00`);
  const limitCount = Math.max(1, Number(repeat_count || 1));
  const until = repeat_until ? new Date(`${repeat_until}T12:00:00`) : null;
  let cursor = new Date(start);

  for (let index = 0; index < limitCount; index += 1) {
    if (until && cursor > until) break;
    dates.push(cursor.toISOString().slice(0, 10));
    if (repeat_mode === 'daily') cursor.setDate(cursor.getDate() + 1);
    else if (repeat_mode === 'weekly') cursor.setDate(cursor.getDate() + 7);
    else if (repeat_mode === 'monthly') cursor.setMonth(cursor.getMonth() + 1);
    else break;
  }

  return [...new Set(dates)];
}

async function resolveClientRecord(client, { name, whatsapp, forceNewClient = false }) {
  const normalizedWhatsapp = normalizePhone(whatsapp);
  const normalizedName = normalizeNameKey(name);

  if (!forceNewClient) {
    const exactMatch = await client.query(
      `SELECT id, name, whatsapp
       FROM clients
       WHERE whatsapp = $1 AND LOWER(regexp_replace(unaccent(name), '\\s+', ' ', 'g')) = $2
       ORDER BY updated_at DESC
       LIMIT 1`,
      [normalizedWhatsapp, normalizedName]
    ).catch(async () => client.query(
      `SELECT id, name, whatsapp
       FROM clients
       WHERE whatsapp = $1
       ORDER BY updated_at DESC
       LIMIT 10`,
      [normalizedWhatsapp]
    ));

    const exactRow = exactMatch.rows.find((row) => normalizeNameKey(row.name) == normalizedName);
    if (exactRow) {
      await client.query('UPDATE clients SET name = $1, whatsapp = $2, updated_at = NOW() WHERE id = $3', [name, normalizedWhatsapp, exactRow.id]);
      return { clientId: exactRow.id, reused: true, message: 'Cliente já existente.' };
    }
  }

  const insertedClient = await client.query(
    'INSERT INTO clients (name, whatsapp) VALUES ($1, $2) RETURNING id',
    [name, normalizedWhatsapp]
  );
  return { clientId: insertedClient.rows[0].id, reused: false, message: 'Novo cliente criado.' };
}

async function previewClientIdentity(name, whatsapp) {
  const normalizedWhatsapp = normalizePhone(whatsapp);
  const result = await query(
    `SELECT id, name, whatsapp
     FROM clients
     WHERE whatsapp = $1
     ORDER BY updated_at DESC
     LIMIT 10`,
    [normalizedWhatsapp]
  );
  const normalizedName = normalizeNameKey(name);
  const exactMatch = result.rows.find((row) => normalizeNameKey(row.name) === normalizedName) || null;
  const whatsappMatch = result.rows[0] || null;
  return {
    exactMatch,
    whatsappMatch,
    normalizedWhatsapp,
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
  return `https://wa.me/${normalizePhone(phone)}?text=${encodeURIComponent(normalizeWhatsappMessage(message))}`;
}

function buildPaymentInstructions(method, settings) {
  const pixKey = normalizePhone(settings?.therapist_whatsapp || settings?.notifications_whatsapp || '').replace(/^55/, '') || '47988006092';
  if (method === 'pix') {
    return {
      forma_pagamento: 'PIX ✅',
      instrucoes_pagamento: `Chave PIX: ${pixKey}\n\nApós o pagamento, envie o comprovante aqui neste chat.`,
    };
  }
  if (method === 'cartao') {
    return {
      forma_pagamento: 'Cartão 💳',
      instrucoes_pagamento: 'Pagamento realizado no atendimento.',
    };
  }
  return {
    forma_pagamento: 'Parcelado 💳',
    instrucoes_pagamento: 'Pagamento realizado no atendimento.',
  };
}

function buildSchedulingWhatsappMessage({ payload, service, settings }) {
  const payment = buildPaymentInstructions(payload.paymentMethod, settings);
  return normalizeWhatsappMessage([
    'Olá Ícarõ! 🙏',
    '',
    'Reserva de Horário — Munay',
    '',
    `👤 Nome: ${payload.name}`,
    `📱 WhatsApp: ${formatWhatsappDisplay(payload.whatsapp) || payload.whatsapp}`,
    '',
    `🌿 Serviço: ${service.name}`,
    `📋 Modalidade: ${service.duration_minutes} min`,
    '',
    `📅 Data: ${formatDateBr(payload.date)}`,
    `🕐 Horário: ${minutesToRange(payload.startMinutes, payload.startMinutes + service.duration_minutes)}`,
    '',
    '💳 Forma de pagamento:',
    '',
    payment.forma_pagamento,
    '',
    payment.instrucoes_pagamento,
    '',
    'Aguardo a confirmação! ✨',
  ].join('\n'));
}

async function computeAvailability(serviceId, date) {
  const service = await getServiceById(serviceId);
  if (!service || !service.active) throw new Error('Serviço não encontrado ou inativo.');

  const { appointments, blocks, settings } = await fetchDayContext(date);
  const slots = computeAvailableSlots({ service, settings, date, appointments, blocks });
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


function buildClientFilters(queryParams = {}) {
  const name = String(queryParams.name || '').trim();
  const whatsapp = normalizePhone(queryParams.whatsapp || '');
  const email = String(queryParams.email || '').trim();
  const service = String(queryParams.service || '').trim();
  const startDate = String(queryParams.startDate || '').trim() || '1900-01-01';
  const endDate = String(queryParams.endDate || '').trim() || '2999-12-31';
  return {
    nameLike: `%${name}%`,
    whatsappLike: `%${whatsapp}%`,
    emailLike: `%${email}%`,
    serviceRaw: service,
    serviceLike: `%${service}%`,
    startDate,
    endDate,
  };
}

const CLIENTS_COLLECTION_SQL = `
  WITH base AS (
    SELECT
      c.id,
      c.name,
      c.whatsapp,
      c.email,
      c.notes,
      c.created_at,
      c.updated_at,
      a.id AS appointment_id,
      a.appointment_date,
      a.start_minutes,
      a.end_minutes,
      a.status AS appointment_status,
      a.payment_label,
      a.payment_amount,
      a.google_event_id,
      s.name AS service_name,
      COALESCE(NULLIF(replace(regexp_replace(a.payment_amount, '[^0-9,.-]', '', 'g'), ',', '.'), ''), '0')::numeric AS payment_amount_num
    FROM clients c
    LEFT JOIN appointments a ON a.client_id = c.id
    LEFT JOIN services s ON s.id = a.service_id
    WHERE c.name ILIKE $1
      AND c.whatsapp ILIKE $2
      AND COALESCE(c.email, '') ILIKE $3
      AND ($4 = '' OR EXISTS (
        SELECT 1
        FROM appointments a2
        JOIN services s2 ON s2.id = a2.service_id
        WHERE a2.client_id = c.id
          AND s2.name ILIKE $5
          AND a2.appointment_date BETWEEN $6 AND $7
      ))
      AND (a.id IS NULL OR a.appointment_date BETWEEN $6 AND $7)
  )
  SELECT
    id,
    name,
    whatsapp,
    email,
    notes,
    created_at,
    updated_at,
    COUNT(appointment_id)::int AS total_appointments,
    MIN(appointment_date) AS first_appointment,
    MAX(appointment_date) AS last_appointment,
    COALESCE(SUM(payment_amount_num), 0)::numeric AS total_invested,
    COALESCE(string_agg(DISTINCT service_name, ', ' ORDER BY service_name), '') AS services,
    CASE
      WHEN COUNT(appointment_id) = 0 THEN 'Sem atendimentos'
      WHEN MAX(appointment_date) >= CURRENT_DATE - INTERVAL '30 days' THEN 'Ativo'
      WHEN MAX(appointment_date) >= CURRENT_DATE - INTERVAL '90 days' THEN 'Sem retorno há 30 dias'
      ELSE 'Sem retorno há 90 dias'
    END AS status
  FROM base
  GROUP BY id, name, whatsapp, email, notes, created_at, updated_at
  ORDER BY COALESCE(MAX(appointment_date), DATE '1900-01-01') DESC, updated_at DESC
`;

async function fetchClientsCollection(filters = {}) {
  const normalized = buildClientFilters(filters);
  const result = await query(CLIENTS_COLLECTION_SQL, [
    normalized.nameLike,
    normalized.whatsappLike,
    normalized.emailLike,
    normalized.serviceRaw,
    normalized.serviceLike,
    normalized.startDate,
    normalized.endDate,
  ]);
  return result.rows.map((row) => ({
    ...row,
    total_appointments: Number(row.total_appointments || 0),
    total_invested: Number(row.total_invested || 0),
  }));
}

async function fetchClientLinkedSummary(clientId, executor = { query }) {
  const [appointmentsCount, appointmentLogsCount, systemLogsCount] = await Promise.all([
    executor.query('SELECT COUNT(*)::int AS total FROM appointments WHERE client_id = $1', [clientId]),
    executor.query(`
      SELECT COUNT(*)::int AS total
      FROM appointment_logs al
      JOIN appointments a ON a.id = al.appointment_id
      WHERE a.client_id = $1
    `, [clientId]),
    executor.query(`
      SELECT COUNT(*)::int AS total
      FROM logs_sistema
      WHERE COALESCE(payload->>'clientId', payload->>'client_id', '') = $1
    `, [clientId]),
  ]);
  const appointments = appointmentsCount.rows[0]?.total || 0;
  const appointmentLogs = appointmentLogsCount.rows[0]?.total || 0;
  const systemLogs = systemLogsCount.rows[0]?.total || 0;
  return {
    appointments,
    appointment_logs: appointmentLogs,
    system_logs: systemLogs,
    total_linked: Number(appointments) + Number(appointmentLogs) + Number(systemLogs),
  };
}

async function fetchClientBaseById(clientId, executor = { query }) {
  const result = await executor.query(`
    WITH base AS (
      SELECT
        c.id,
        c.name,
        c.whatsapp,
        c.email,
        c.notes,
        c.created_at,
        c.updated_at,
        a.id AS appointment_id,
        a.appointment_date,
        s.name AS service_name,
        COALESCE(NULLIF(replace(regexp_replace(a.payment_amount, '[^0-9,.-]', '', 'g'), ',', '.'), ''), '0')::numeric AS payment_amount_num
      FROM clients c
      LEFT JOIN appointments a ON a.client_id = c.id
      LEFT JOIN services s ON s.id = a.service_id
      WHERE c.id = $1
    )
    SELECT
      id,
      name,
      whatsapp,
      email,
      notes,
      created_at,
      updated_at,
      COUNT(appointment_id)::int AS total_appointments,
      MIN(appointment_date) AS first_appointment,
      MAX(appointment_date) AS last_appointment,
      COALESCE(SUM(payment_amount_num), 0)::numeric AS total_invested,
      COALESCE(string_agg(DISTINCT service_name, ', ' ORDER BY service_name), '') AS services,
      CASE
        WHEN COUNT(appointment_id) = 0 THEN 'Sem atendimentos'
        WHEN MAX(appointment_date) >= CURRENT_DATE - INTERVAL '30 days' THEN 'Ativo'
        WHEN MAX(appointment_date) >= CURRENT_DATE - INTERVAL '90 days' THEN 'Sem retorno há 30 dias'
        ELSE 'Sem retorno há 90 dias'
      END AS status
    FROM base
    GROUP BY id, name, whatsapp, email, notes, created_at, updated_at
  `, [clientId]);
  const row = result.rows[0];
  if (!row) return null;
  return {
    ...row,
    total_appointments: Number(row.total_appointments || 0),
    total_invested: Number(row.total_invested || 0),
  };
}

async function fetchClientDetail(clientId, executor = { query }) {
  const client = await fetchClientBaseById(clientId, executor);
  if (!client) return null;
  const linked_summary = await fetchClientLinkedSummary(clientId, executor);
  return { ...client, linked_summary };
}

async function fetchClientHistory(clientId) {
  const client = await fetchClientDetail(clientId);
  if (!client) return null;
  const [appointmentsResult, appointmentLogsResult, systemLogsResult] = await Promise.all([
    query(`
      SELECT a.id, a.appointment_date, a.start_minutes, a.end_minutes, a.status, a.payment_label, a.payment_amount,
             a.google_event_id, a.google_alert_3h_event_id, a.google_alert_1h_event_id, s.name AS service_name
      FROM appointments a
      JOIN services s ON s.id = a.service_id
      WHERE a.client_id = $1
      ORDER BY a.appointment_date DESC, a.start_minutes DESC
    `, [clientId]),
    query(`
      SELECT al.id, al.action, al.payload, al.created_at
      FROM appointment_logs al
      JOIN appointments a ON a.id = al.appointment_id
      WHERE a.client_id = $1
      ORDER BY al.created_at DESC
      LIMIT 50
    `, [clientId]),
    query(`
      SELECT id, context, message, payload, created_at
      FROM logs_sistema
      WHERE COALESCE(payload->>'clientId', payload->>'client_id', '') = $1
      ORDER BY created_at DESC
      LIMIT 50
    `, [clientId]),
  ]);
  return {
    ...client,
    appointments: appointmentsResult.rows,
    logs: [
      ...appointmentLogsResult.rows.map((row) => ({ ...row, source: 'appointment_log' })),
      ...systemLogsResult.rows.map((row) => ({ ...row, action: row.message, source: 'system_log' })),
    ].sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || ''))),
  };
}

function serializeClientsForExport(items = []) {
  return items.map((item) => ({
    Nome: item.name || '',
    WhatsApp: formatWhatsappDisplay(item.whatsapp || ''),
    Email: item.email || '',
    'Serviços contratados': item.services || '',
    'Quantidade de atendimentos': Number(item.total_appointments || 0),
    'Primeiro atendimento': item.first_appointment ? formatDateBr(item.first_appointment) : '',
    'Último atendimento': item.last_appointment ? formatDateBr(item.last_appointment) : '',
    Status: item.status || '',
  }));
}

function buildClientsCsv(items = []) {
  const rows = serializeClientsForExport(items);
  const headers = Object.keys(rows[0] || {
    Nome: '',
    WhatsApp: '',
    Email: '',
    'Serviços contratados': '',
    'Quantidade de atendimentos': '',
    'Primeiro atendimento': '',
    'Último atendimento': '',
    Status: '',
  });
  const csvLines = [headers.join(';')].concat(rows.map((row) => headers.map((header) => {
    const value = String(row[header] ?? '').replace(/"/g, '""');
    return `"${value}"`;
  }).join(';')));
  return `\uFEFF${csvLines.join('\n')}`;
}

async function ensureDeletedClientPlaceholder(executor, originalClient) {
  const placeholderWhatsapp = `deleted-${String(originalClient.id).replace(/[^a-zA-Z0-9]/g, '').slice(0, 16)}`;
  const inserted = await executor.query(
    `INSERT INTO clients (name, whatsapp, email, notes, created_at, updated_at)
     VALUES ($1, $2, NULL, $3, NOW(), NOW())
     RETURNING *`,
    [
      'Cliente removido',
      placeholderWhatsapp,
      `Registro preservado após exclusão do cliente ${originalClient.name || originalClient.id}`,
    ]
  );
  return inserted.rows[0];
}

async function persistAlertsCalendarId(calendarId) {
  const normalized = String(calendarId || '').trim();
  if (!normalized) return;
  await query(
    `UPDATE app_settings
     SET google_alerts_calendar_id = $1, updated_at = NOW()
     WHERE id = 1`,
    [normalized]
  ).catch(() => null);
}

async function syncAppointmentWithGoogle(appointmentId, action = 'upsert') {
  console.log('[GoogleSync:start]', JSON.stringify({ appointmentId, action }));

  const settings = await getSettings();
  if (!settings?.google_refresh_token || !googleCalendarService.isConfigured(settings)) {
    const reason = 'Google não conectado.';
    await storeAppointmentGoogleState(appointmentId, {
      status: 'desconectado',
      error: reason,
      errorDetails: { reason, action },
      payload: {},
      response: { action },
    }).catch(() => null);
    console.warn('[GoogleSync:skip]', JSON.stringify({ appointmentId, action, reason }));
    return { synced: false, reason, friendlyError: reason };
  }

  const appointment = await fetchAppointmentById(appointmentId);
  if (!appointment) {
    const reason = 'Agendamento não encontrado.';
    console.warn('[GoogleSync:skip]', JSON.stringify({ appointmentId, action, reason }));
    return { synced: false, reason, friendlyError: reason };
  }

  const hasGoogleArtifacts = Boolean(appointment.google_event_id || appointment.google_alert_3h_event_id || appointment.google_alert_1h_event_id);
  if (action !== 'delete' && appointment.status !== 'confirmado' && !hasGoogleArtifacts) {
    const reason = 'Agendamento ainda não confirmado.';
    await storeAppointmentGoogleState(appointmentId, {
      status: 'pendente_confirmacao',
      error: null,
      errorDetails: { reason, action, status: appointment.status },
      payload: {},
      response: { action, status: appointment.status },
    }).catch(() => null);
    console.warn('[GoogleSync:skip]', JSON.stringify({ appointmentId, action, reason, status: appointment.status }));
    return { synced: false, reason, friendlyError: null };
  }

  const googlePayload = appointmentToGoogleModel(appointment);
  const mainCalendarId = String(settings.google_calendar_id || 'primary').trim() || 'primary';
  const alertsCalendarInfo = await googleCalendarService.ensureAlertsCalendar(settings, { fallbackCalendarId: mainCalendarId });
  const alertsCalendarId = String(alertsCalendarInfo?.calendarId || mainCalendarId).trim() || mainCalendarId;

  if (alertsCalendarId && alertsCalendarId !== String(settings.google_alerts_calendar_id || '').trim()) {
    await persistAlertsCalendarId(alertsCalendarId);
  }

  const appointmentEventPayload = googleCalendarService.buildEventPayload(googlePayload, settings);
  const alert3hPayload = googleCalendarService.buildAlertPayload(googlePayload, '3h');
  const alert1hPayload = googleCalendarService.buildAlertPayload(googlePayload, '1h');

  const validation = {
    main: googleCalendarService.validateEventPayload(appointmentEventPayload, mainCalendarId),
    alert3h: googleCalendarService.validateEventPayload(alert3hPayload, alertsCalendarId),
    alert1h: googleCalendarService.validateEventPayload(alert1hPayload, alertsCalendarId),
    alertsCalendar: alertsCalendarInfo,
  };

  const payloadBundle = {
    main: { calendarId: mainCalendarId, payload: appointmentEventPayload },
    alertsCalendar: alertsCalendarInfo,
    alert3h: { calendarId: alertsCalendarId, payload: alert3hPayload },
    alert1h: { calendarId: alertsCalendarId, payload: alert1hPayload },
  };

  console.log('[GoogleSync:payload]', JSON.stringify({
    appointmentId: appointment.id,
    status: appointment.status,
    action,
    hasGoogleEventId: Boolean(appointment.google_event_id),
    hasAlert3hEventId: Boolean(appointment.google_alert_3h_event_id),
    hasAlert1hEventId: Boolean(appointment.google_alert_1h_event_id),
    payloadBundle,
    validation,
  }, null, 2));

  const cleanupTargets = [];

  try {
    if (action === 'delete' || appointment.status === 'cancelado') {
      const deletePayload = {
        action: 'delete',
        mainCalendarId,
        alertsCalendarId,
        googleEventId: appointment.google_event_id || null,
        googleAlert3hEventId: appointment.google_alert_3h_event_id || null,
        googleAlert1hEventId: appointment.google_alert_1h_event_id || null,
      };

      const deleteResponse = {
        main: appointment.google_event_id
          ? await googleCalendarService.deleteCalendarEvent(settings, appointment.google_event_id, { calendarId: mainCalendarId })
          : { skipped: true, reason: 'Sem google_event_id.' },
        alert3h: appointment.google_alert_3h_event_id
          ? await googleCalendarService.deleteCalendarEvent(settings, appointment.google_alert_3h_event_id, { calendarId: alertsCalendarId })
          : { skipped: true, reason: 'Sem google_alert_3h_event_id.' },
        alert1h: appointment.google_alert_1h_event_id
          ? await googleCalendarService.deleteCalendarEvent(settings, appointment.google_alert_1h_event_id, { calendarId: alertsCalendarId })
          : { skipped: true, reason: 'Sem google_alert_1h_event_id.' },
        alertsCalendar: alertsCalendarInfo,
      };

      const deleteParams = [
        safeDbText(appointment.id, { allowNull: false }),
        safeDbJson({ ...payloadBundle, delete: deletePayload }, {}),
        safeDbJson(deleteResponse, {}),
      ];
      logGoogleDbParams({
        scope: 'syncAppointmentWithGoogle.delete',
        p1: deleteParams[0],
        p2: deleteParams[1],
        p3: deleteParams[2],
      });
      await query(
        `UPDATE appointments
         SET google_event_id = NULL,
             google_alert_3h_event_id = NULL,
             google_alert_1h_event_id = NULL,
             google_sync_status = 'deleted',
             google_sync_error = NULL,
             google_error_details = NULL,
             google_payload_json = $2::jsonb,
             google_response_json = $3::jsonb,
             google_last_sync_at = NOW(),
             google_last_response = $3::jsonb,
             updated_at = NOW()
         WHERE id = $1`,
        deleteParams
      );
      await setGoogleState({ connected: true, lastError: null, lastResponse: deleteResponse || {} });
      await writeSystemLog('info', 'google_calendar', 'Evento principal e alertas removidos do Google Calendar.', {
        appointmentId: appointment.id,
        action,
        deleteResponse,
      });
      return {
        synced: true,
        action: 'deleted',
        eventId: null,
        alert3hEventId: null,
        alert1hEventId: null,
        alertsCalendarId,
        response: deleteResponse,
      };
    }

    const mainResult = appointment.google_event_id
      ? await googleCalendarService.updateCalendarEvent(settings, googlePayload, appointment.google_event_id, {
        calendarId: mainCalendarId,
        payloadLabel: 'GOOGLE APPOINTMENT PAYLOAD',
      })
      : await googleCalendarService.createCalendarEvent(settings, googlePayload, {
        calendarId: mainCalendarId,
        payloadLabel: 'GOOGLE APPOINTMENT PAYLOAD',
      });
    const mainEventId = mainResult?.data?.id || appointment.google_event_id;
    if (!mainEventId) throw new Error('Google Calendar não retornou o ID do evento principal.');
    if (!appointment.google_event_id) cleanupTargets.push({ label: 'main', eventId: mainEventId, calendarId: mainCalendarId });

    const alert3hResult = appointment.google_alert_3h_event_id
      ? await googleCalendarService.updateCalendarEvent(settings, null, appointment.google_alert_3h_event_id, {
        eventData: alert3hPayload,
        calendarId: alertsCalendarId,
        payloadLabel: 'GOOGLE ALERT 3H PAYLOAD',
      })
      : await googleCalendarService.createCalendarEvent(settings, null, {
        eventData: alert3hPayload,
        calendarId: alertsCalendarId,
        payloadLabel: 'GOOGLE ALERT 3H PAYLOAD',
      });
    const alert3hEventId = alert3hResult?.data?.id || appointment.google_alert_3h_event_id;
    if (!alert3hEventId) throw new Error('Google Calendar não retornou o ID do alerta 3h.');
    if (!appointment.google_alert_3h_event_id) cleanupTargets.push({ label: 'alert3h', eventId: alert3hEventId, calendarId: alertsCalendarId });

    const alert1hResult = appointment.google_alert_1h_event_id
      ? await googleCalendarService.updateCalendarEvent(settings, null, appointment.google_alert_1h_event_id, {
        eventData: alert1hPayload,
        calendarId: alertsCalendarId,
        payloadLabel: 'GOOGLE ALERT 1H PAYLOAD',
      })
      : await googleCalendarService.createCalendarEvent(settings, null, {
        eventData: alert1hPayload,
        calendarId: alertsCalendarId,
        payloadLabel: 'GOOGLE ALERT 1H PAYLOAD',
      });
    const alert1hEventId = alert1hResult?.data?.id || appointment.google_alert_1h_event_id;
    if (!alert1hEventId) throw new Error('Google Calendar não retornou o ID do alerta 1h.');
    if (!appointment.google_alert_1h_event_id) cleanupTargets.push({ label: 'alert1h', eventId: alert1hEventId, calendarId: alertsCalendarId });

    const syncStatus = appointment.google_event_id ? 'updated' : 'created';
    const responseBundle = {
      main: mainResult,
      alert3h: alert3hResult,
      alert1h: alert1hResult,
      alertsCalendar: alertsCalendarInfo,
    };

    const upsertParams = [
      safeDbText(appointment.id, { allowNull: false }),
      safeDbText(mainEventId, { allowNull: false }),
      safeDbText(alert3hEventId, { allowNull: false }),
      safeDbText(alert1hEventId, { allowNull: false }),
      safeDbText(syncStatus, { allowNull: false }),
      safeDbJson(payloadBundle, {}),
      safeDbJson(responseBundle, {}),
    ];
    logGoogleDbParams({
      scope: `syncAppointmentWithGoogle.${syncStatus}`,
      p1: upsertParams[0],
      p2: upsertParams[1],
      p3: upsertParams[2],
      p4: upsertParams[3],
      p5: upsertParams[4],
      p6: upsertParams[5],
      p7: upsertParams[6],
    });

    await query(
      `UPDATE appointments
       SET google_event_id = $2,
           google_alert_3h_event_id = $3,
           google_alert_1h_event_id = $4,
           google_sync_status = $5,
           google_sync_error = NULL,
           google_error_details = NULL,
           google_payload_json = $6::jsonb,
           google_response_json = $7::jsonb,
           google_last_sync_at = NOW(),
           google_last_response = $7::jsonb,
           updated_at = NOW()
       WHERE id = $1`,
      upsertParams
    );

    await setGoogleState({ connected: true, lastError: null, lastResponse: responseBundle || {} });
    await writeSystemLog('info', 'google_calendar', 'Evento principal e alertas sincronizados com Google Calendar.', {
      appointmentId: appointment.id,
      syncStatus,
      mainEventId,
      alert3hEventId,
      alert1hEventId,
      alertsCalendarId,
      payloadBundle,
      validation,
      responseBundle,
    });

    console.log(`[GoogleSync:${syncStatus}-success]`, JSON.stringify({
      appointmentId: appointment.id,
      mainEventId,
      alert3hEventId,
      alert1hEventId,
      alertsCalendarId,
    }));

    return {
      synced: true,
      action: syncStatus,
      eventId: mainEventId,
      alert3hEventId,
      alert1hEventId,
      alertsCalendarId,
      alertsCalendar: alertsCalendarInfo,
      response: responseBundle,
    };
  } catch (error) {
    const googleError = typeof googleCalendarService.extractGoogleError === 'function'
      ? googleCalendarService.extractGoogleError(error)
      : { message: error.message };
    const friendlyError = buildFriendlyGoogleError(googleError);

    const cleanupResults = [];
    for (const item of cleanupTargets.reverse()) {
      try {
        const removed = await googleCalendarService.deleteCalendarEvent(settings, item.eventId, { calendarId: item.calendarId });
        cleanupResults.push({ ...item, removed });
      } catch (cleanupError) {
        cleanupResults.push({ ...item, cleanupError: googleCalendarService.extractGoogleError(cleanupError) });
      }
    }

    console.error('[GoogleSync:error]', JSON.stringify({
      appointmentId,
      action,
      googleError,
      payloadBundle,
      validation,
      cleanupResults,
    }, null, 2));

    await storeAppointmentGoogleState(appointmentId, {
      status: 'error',
      error: friendlyError,
      errorDetails: { googleError, cleanupResults, alertsCalendarInfo },
      payload: payloadBundle,
      response: { googleError, cleanupResults, alertsCalendarInfo },
    }).catch(() => null);
    await setGoogleState({ connected: true, lastError: friendlyError, lastResponse: { googleError, cleanupResults, alertsCalendarInfo } }).catch(() => null);
    await writeSystemLog('error', 'google_calendar', 'Falha ao sincronizar agendamento e alertas com Google Calendar.', {
      appointmentId,
      action,
      payloadBundle,
      validation,
      error: googleError,
      cleanupResults,
      friendlyError,
    }).catch(() => null);
    return {
      synced: false,
      reason: googleError.message,
      friendlyError,
      error: googleError,
      payload: payloadBundle,
      validation,
      cleanupResults,
      alertsCalendarId,
      alertsCalendar: alertsCalendarInfo,
    };
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
  public_section_title_1: z.string().min(2),
  public_section_title_2: z.string().min(2),
  public_section_title_3: z.string().min(2),
  public_section_title_4: z.string().min(2),
  public_step_badge_1: z.string().min(2),
  public_step_label_1: z.string().min(2),
  public_step_badge_2: z.string().min(2),
  public_step_label_2: z.string().min(2),
  public_step_badge_3: z.string().min(2),
  public_step_label_3: z.string().min(2),
  public_step_badge_4: z.string().min(2),
  public_step_label_4: z.string().min(2),
  therapist_name: z.string().min(2),
  therapist_whatsapp: z.string().min(8),
  notifications_whatsapp: z.string().min(8),
  footer_link: z.string().min(2),
  logo_url: z.string().optional().nullable(),
  confirmation_message: z.string().min(10),
  reminder_message: z.string().min(10),
  google_email: z.string().optional().nullable(),
  google_calendar_id: z.string().optional().nullable(),
  google_alerts_calendar_id: z.string().optional().nullable(),
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
  weekly_schedule: z.object({
    '0': z.object({ enabled: z.boolean(), ranges: z.array(z.object({ start: z.string(), end: z.string() })) }),
    '1': z.object({ enabled: z.boolean(), ranges: z.array(z.object({ start: z.string(), end: z.string() })) }),
    '2': z.object({ enabled: z.boolean(), ranges: z.array(z.object({ start: z.string(), end: z.string() })) }),
    '3': z.object({ enabled: z.boolean(), ranges: z.array(z.object({ start: z.string(), end: z.string() })) }),
    '4': z.object({ enabled: z.boolean(), ranges: z.array(z.object({ start: z.string(), end: z.string() })) }),
    '5': z.object({ enabled: z.boolean(), ranges: z.array(z.object({ start: z.string(), end: z.string() })) }),
    '6': z.object({ enabled: z.boolean(), ranges: z.array(z.object({ start: z.string(), end: z.string() })) }),
  }),
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
    stepBadge1: settings.public_step_badge_1,
    stepLabel1: settings.public_step_label_1,
    stepBadge2: settings.public_step_badge_2,
    stepLabel2: settings.public_step_label_2,
    stepBadge3: settings.public_step_badge_3,
    stepLabel3: settings.public_step_label_3,
    stepBadge4: settings.public_step_badge_4,
    stepLabel4: settings.public_step_label_4,
    sectionTitle1: settings.public_section_title_1,
    sectionTitle2: settings.public_section_title_2,
    sectionTitle3: settings.public_section_title_3,
    sectionTitle4: settings.public_section_title_4,
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

app.get('/api/public/month-availability', async (req, res) => {
  try {
    const serviceId = String(req.query.serviceId || '').trim();
    const year = Number(req.query.year);
    const month = Number(req.query.month);
    if (!serviceId) throw new Error('Serviço inválido.');
    if (!Number.isInteger(year) || year < 2000 || year > 2100) throw new Error('Ano inválido.');
    if (!Number.isInteger(month) || month < 1 || month > 12) throw new Error('Mês inválido.');

    const service = await getServiceById(serviceId);
    if (!service || !service.active) throw new Error('Serviço indisponível.');

    const totalDays = new Date(year, month, 0).getDate();
    const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
    const endDate = `${year}-${String(month).padStart(2, '0')}-${String(totalDays).padStart(2, '0')}`;

    const [settings, appointmentsResult, blocksResult] = await Promise.all([
      getSettings(),
      query(
        `SELECT * FROM appointments WHERE appointment_date BETWEEN $1 AND $2 AND status <> 'cancelado'`,
        [startDate, endDate]
      ),
      query(
        `SELECT * FROM blocked_slots WHERE block_date BETWEEN $1 AND $2`,
        [startDate, endDate]
      ),
    ]);

    const appointmentsByDate = appointmentsResult.rows.reduce((acc, row) => {
      const key = toDateOnlyString(row.appointment_date);
      acc[key] = acc[key] || [];
      acc[key].push(row);
      return acc;
    }, {});

    const blocksByDate = blocksResult.rows.reduce((acc, row) => {
      const key = toDateOnlyString(row.block_date);
      acc[key] = acc[key] || [];
      acc[key].push(row);
      return acc;
    }, {});

    const availability = {};
    for (let day = 1; day <= totalDays; day += 1) {
      const date = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const slots = computeAvailableSlots({
        service,
        settings,
        date,
        appointments: appointmentsByDate[date] || [],
        blocks: blocksByDate[date] || [],
      });
      availability[date] = { available: slots.length > 0, slotCount: slots.length };
    }

    res.json({ availability });
  } catch (error) {
    res.status(400).json({ error: error.message || 'Falha ao consultar disponibilidade do mês.' });
  }
});

app.get('/api/public/client-check', async (req, res) => {
  try {
    const name = String(req.query.name || '').trim();
    const whatsapp = String(req.query.whatsapp || '').trim();
    if (!name || !whatsapp) {
      return res.json({ exactMatch: false, whatsappMatch: false, message: '' });
    }
    const preview = await previewClientIdentity(name, whatsapp);
    if (preview.exactMatch) {
      return res.json({
        exactMatch: true,
        whatsappMatch: true,
        actionLabel: '',
        message: '',
        client: preview.exactMatch,
      });
    }
    if (preview.whatsappMatch) {
      return res.json({
        exactMatch: false,
        whatsappMatch: true,
        actionLabel: '',
        message: '',
        client: preview.whatsappMatch,
      });
    }
    return res.json({
      exactMatch: false,
      whatsappMatch: false,
      actionLabel: '',
      message: '',
      client: null,
    });
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
      const clientInfo = await resolveClientRecord(client, payload);
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
          (client_id, service_id, appointment_date, start_minutes, end_minutes, payment_method, payment_label, payment_amount, status, notes, payment_received)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         RETURNING *`,
        [
          clientInfo.clientId,
          payload.serviceId,
          payload.date,
          payload.startMinutes,
          payload.startMinutes + service.duration_minutes,
          payload.paymentMethod,
          buildPaymentLabel(payload.paymentMethod, service),
          buildPaymentAmount(payload.paymentMethod, service),
          'aguardando pagamento',
          payload.notes || '',
          false,
        ]
      );

      await logAction(client, appointment.rows[0].id, 'created', payload);
      await writeSystemLog('info', 'appointments', 'Agendamento criado pelo cliente.', { appointmentId: appointment.rows[0].id, clientMode: clientInfo.message }, client);
      return { appointment: appointment.rows[0], settings, clientInfo };
    });

    const googleSync = { synced: false, reason: 'Agendamento criado aguardando confirmação.' };

    const therapistMessage = buildSchedulingWhatsappMessage({ payload, service, settings: result.settings });

    res.status(201).json({
      success: true,
      appointmentId: result.appointment.id,
      googleEventId: googleSync.eventId || null,
      google: googleSync,
      clientMessage: '',
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
      SELECT a.*, s.name AS service_name, c.name AS client_name, c.whatsapp AS client_whatsapp
      FROM appointments a
      JOIN services s ON s.id = a.service_id
      JOIN clients c ON c.id = a.client_id
    )
    SELECT json_build_object(
      'today', (SELECT COUNT(*) FROM base WHERE appointment_date = CURRENT_DATE),
      'upcoming', (SELECT COUNT(*) FROM base WHERE appointment_date >= CURRENT_DATE AND status IN ('pendente','aguardando pagamento','confirmado')),
      'pending', (SELECT COUNT(*) FROM base WHERE status IN ('pendente','aguardando pagamento')),
      'confirmed', (SELECT COUNT(*) FROM base WHERE status = 'confirmado'),
      'forecastRevenue', (SELECT COALESCE(SUM(CASE WHEN status IN ('pendente','aguardando pagamento','confirmado') THEN COALESCE(NULLIF(replace(regexp_replace(payment_amount, '[^0-9,.-]', '', 'g'), ',', '.'), ''), '0')::numeric ELSE 0 END), 0) FROM base),
      'confirmedRevenue', (SELECT COALESCE(SUM(CASE WHEN status = 'confirmado' THEN COALESCE(NULLIF(replace(regexp_replace(payment_amount, '[^0-9,.-]', '', 'g'), ',', '.'), ''), '0')::numeric ELSE 0 END), 0) FROM base),
      'topServices', (SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json) FROM (SELECT service_name, COUNT(*) AS total FROM base GROUP BY service_name ORDER BY total DESC LIMIT 5) t),
      'calendar', (SELECT COALESCE(json_agg(row_to_json(c)), '[]'::json) FROM (
        SELECT id, appointment_date, start_minutes, end_minutes, status, client_name, client_whatsapp, service_name, google_event_id, google_sync_error
        FROM base WHERE appointment_date >= CURRENT_DATE ORDER BY appointment_date ASC, start_minutes ASC LIMIT 10
      ) c)
    ) AS data
  `);
  const data = result.rows[0].data;
  data.forecastRevenue = parseMoneyValue(data.forecastRevenue);
  data.confirmedRevenue = parseMoneyValue(data.confirmedRevenue);
  res.json(data);
});

app.get('/api/admin/appointments', authRequired, async (req, res) => {
  const status = req.query.status && appointmentStatus.includes(req.query.status) ? req.query.status : null;
  const search = `%${String(req.query.search || '').trim()}%`;
  const presetRange = buildDateRangeFromPreset(String(req.query.preset || '').trim());
  const startDate = req.query.startDate || presetRange?.startDate || '1900-01-01';
  const endDate = req.query.endDate || presetRange?.endDate || '2999-12-31';
  const paymentFilter = ['paid', 'unpaid'].includes(String(req.query.payment || '')) ? String(req.query.payment) : null;
  const params = [search, startDate, endDate];
  let where = 'WHERE a.appointment_date BETWEEN $2 AND $3 AND (c.name ILIKE $1 OR c.whatsapp ILIKE $1 OR s.name ILIKE $1)';
  if (status) {
    params.push(status);
    where += ` AND a.status = $${params.length}`;
  }
  if (paymentFilter) {
    params.push(paymentFilter === 'paid');
    where += ` AND a.payment_received = $${params.length}`;
  }
  const result = await query(
    `SELECT a.*, c.name AS client_name, c.whatsapp AS client_whatsapp, s.name AS service_name
     FROM appointments a
     JOIN clients c ON c.id = a.client_id
     JOIN services s ON s.id = a.service_id
     ${where}
     ORDER BY a.appointment_date ASC, a.start_minutes ASC`,
    params
  );
  res.json(result.rows);
});

app.get('/api/admin/appointments/:id', authRequired, async (req, res) => {
  const appointment = await fetchAppointmentById(req.params.id);
  if (!appointment) return res.status(404).json({ error: 'Agendamento não encontrado.' });
  res.json(appointment);
});

app.get('/api/admin/clients', authRequired, async (req, res) => {
  const items = await fetchClientsCollection(req.query || {});
  res.json({ items });
});

app.get('/api/admin/clients/export', authRequired, async (req, res) => {
  const format = String(req.query.format || 'csv').toLowerCase();
  const items = await fetchClientsCollection(req.query || {});
  const exported = serializeClientsForExport(items);

  if (format === 'xlsx') {
    const workbook = XLSX.utils.book_new();
    const worksheet = XLSX.utils.json_to_sheet(exported);
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Clientes');
    const buffer = XLSX.write(workbook, { bookType: 'xlsx', type: 'buffer' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="clientes.xlsx"');
    return res.send(buffer);
  }

  const csv = buildClientsCsv(items);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="clientes.csv"');
  return res.send(csv);
});

app.get('/api/admin/clients/:id', authRequired, async (req, res) => {
  const item = await fetchClientDetail(req.params.id);
  if (!item) return res.status(404).json({ error: 'Cliente não encontrado.' });
  res.json(item);
});

app.get('/api/admin/clients/:id/history', authRequired, async (req, res) => {
  const item = await fetchClientHistory(req.params.id);
  if (!item) return res.status(404).json({ error: 'Cliente não encontrado.' });
  res.json(item);
});

app.put('/api/admin/clients/:id', authRequired, async (req, res) => {
  const schema = z.object({
    name: z.string().trim().min(2),
    whatsapp: z.string().trim().min(8),
    email: z.string().trim().email().optional().or(z.literal('')),
    notes: z.string().optional().or(z.literal('')),
  });
  try {
    const body = schema.parse(req.body);
    const result = await query(
      `UPDATE clients
       SET name = $1,
           whatsapp = $2,
           email = NULLIF($3, ''),
           notes = NULLIF($4, ''),
           updated_at = NOW()
       WHERE id = $5
       RETURNING *`,
      [body.name, normalizePhone(body.whatsapp), body.email || '', body.notes || '', req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Cliente não encontrado.' });
    const detail = await fetchClientDetail(req.params.id);
    res.json(detail);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.delete('/api/admin/clients/:id', authRequired, async (req, res) => {
  const mode = String(req.query.mode || 'cascade').trim();
  if (!['cascade', 'client-only'].includes(mode)) {
    return res.status(400).json({ error: 'Modo de exclusão inválido.' });
  }

  try {
    const result = await withTransaction(async (client) => {
      const existing = await fetchClientDetail(req.params.id, client);
      if (!existing) {
        const error = new Error('Cliente não encontrado.');
        error.status = 404;
        throw error;
      }

      let reassignedClientId = null;
      let deletedAppointments = 0;
      if (mode === 'client-only' && Number(existing.linked_summary?.appointments || 0) > 0) {
        const placeholder = await ensureDeletedClientPlaceholder(client, existing);
        await client.query(
          `UPDATE appointments
           SET client_id = $1
           WHERE client_id = $2`,
          [placeholder.id, req.params.id]
        );
        reassignedClientId = placeholder.id;
      }

      if (mode === 'cascade') {
        const appointmentsToDelete = await client.query('SELECT id FROM appointments WHERE client_id = $1', [req.params.id]);
        deletedAppointments = appointmentsToDelete.rows.length;
        await client.query(
          `DELETE FROM logs_sistema
           WHERE COALESCE(payload->>'clientId', payload->>'client_id', '') = $1`,
          [req.params.id]
        );
        await client.query('DELETE FROM appointments WHERE client_id = $1', [req.params.id]);
      }

      await client.query('DELETE FROM clients WHERE id = $1', [req.params.id]);
      await logAction(client, null, 'cliente_excluido', {
        clientId: req.params.id,
        mode,
        reassignedClientId,
        deletedAppointments,
      }).catch(() => null);
      await writeSystemLog('info', 'clients', 'Cliente excluído', {
        clientId: req.params.id,
        mode,
        reassignedClientId,
        deletedAppointments,
      }, client).catch(() => null);
      return {
        success: true,
        mode,
        reassignedClientId,
        deletedAppointments,
        message: mode === 'client-only'
          ? 'Cliente excluído com sucesso. Os registros foram preservados em um cliente técnico.'
          : 'Cliente e registros relacionados excluídos com sucesso.',
      };
    });
    res.json(result);
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
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
    shift_label: z.string().min(3),
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
    shift_label: z.string().min(3),
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
  const result = await query('SELECT * FROM blocked_slots ORDER BY block_date ASC, start_minutes ASC');
  res.json(result.rows);
});

app.post('/api/admin/blocks', authRequired, async (req, res) => {
  const schema = z.object({
    date: z.string(),
    start_time: z.string().regex(/^\d{2}:\d{2}$/),
    end_time: z.string().regex(/^\d{2}:\d{2}$/),
    reason: z.string().min(2),
    category: z.string().optional().default('Bloqueio'),
    repeat_mode: z.enum(['none', 'daily', 'weekly', 'monthly']).optional().default('none'),
    repeat_until: z.string().optional().nullable(),
    repeat_count: z.number().int().min(1).max(365).optional().default(1),
  });
  try {
    const body = schema.parse(req.body);
    const startMinutes = parseTimeToMinutes(body.start_time);
    const endMinutes = parseTimeToMinutes(body.end_time);
    if (endMinutes <= startMinutes) {
      return res.status(400).json({ error: 'A hora final deve ser maior que a hora inicial.' });
    }
    const dates = generateBlockDates(body);
    const created = await withTransaction(async (client) => {
      const rows = [];
      for (const date of dates) {
        const inserted = await client.query(
          'INSERT INTO blocked_slots (block_date, start_minutes, end_minutes, reason) VALUES ($1,$2,$3,$4) RETURNING *',
          [date, startMinutes, endMinutes, `${body.category}: ${body.reason}`]
        );
        rows.push(inserted.rows[0]);
      }
      await writeSystemLog('info', 'blocks', 'Bloqueios criados pelo painel.', { total: rows.length, repeatMode: body.repeat_mode }, client);
      return rows;
    });
    res.status(201).json({ success: true, created });
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
        brand_name=$1,title=$2,subtitle=$3,public_section_title_1=$4,public_section_title_2=$5,public_section_title_3=$6,public_section_title_4=$7,
        public_step_badge_1=$8,public_step_label_1=$9,public_step_badge_2=$10,public_step_label_2=$11,public_step_badge_3=$12,public_step_label_3=$13,
        public_step_badge_4=$14,public_step_label_4=$15,therapist_name=$16,therapist_whatsapp=$17,notifications_whatsapp=$18,footer_link=$19,logo_url=$20,
        confirmation_message=$21,reminder_message=$22,google_email=$23,google_calendar_id=$24,google_alerts_calendar_id=$25,google_client_id=$26,google_client_secret=$27,
        google_redirect_uri=$28,google_refresh_token=$29,google_connected=$30,notification_immediate=$31,notification_24h=$32,
        notification_1h=$33,notification_15m=$34,notify_email=$35,notify_push=$36,work_start=$37,work_end=$38,slot_interval=$39,
        allowed_weekdays=$40::jsonb,weekly_schedule=$41::jsonb,vacations=$42::jsonb,holidays=$43::jsonb,database_url=$44,updated_at=NOW()
       WHERE id=1 RETURNING *`,
      [
        body.brand_name,
        body.title,
        body.subtitle,
        body.public_section_title_1,
        body.public_section_title_2,
        body.public_section_title_3,
        body.public_section_title_4,
        body.public_step_badge_1,
        body.public_step_label_1,
        body.public_step_badge_2,
        body.public_step_label_2,
        body.public_step_badge_3,
        body.public_step_label_3,
        body.public_step_badge_4,
        body.public_step_label_4,
        body.therapist_name,
        body.therapist_whatsapp,
        body.notifications_whatsapp,
        body.footer_link,
        body.logo_url,
        body.confirmation_message,
        body.reminder_message,
        body.google_email || null,
        body.google_calendar_id || null,
        body.google_alerts_calendar_id || current.google_alerts_calendar_id || null,
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
        JSON.stringify(normalizeWeeklySchedule(body.weekly_schedule, body)),
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

app.get('/api/google/status', authRequired, async (_req, res) => {
  try {
    const settings = await getSettings();
    const status = await googleCalendarService.getConnectionStatus(settings);
    await query('UPDATE app_settings SET google_connected = $1, updated_at = NOW() WHERE id = 1', [Boolean(status.connected)]);
    res.json({
      ...status,
      lastError: await fetchLastGoogleError(),
    });
  } catch (error) {
    const friendlyError = buildFriendlyGoogleError(error);
    await query('UPDATE app_settings SET google_connected = false, google_last_error = $1, updated_at = NOW() WHERE id = 1', [friendlyError]).catch(() => null);
    await writeSystemLog('error', 'google_oauth', 'Falha ao consultar status do Google.', { error: error.message }).catch(() => null);
    res.json({ connected: false, lastError: friendlyError });
  }
});

app.get('/api/google/debug', authRequired, async (_req, res) => {
  try {
    const settings = await getSettings();
    const debug = await googleCalendarService.getDebugStatus(settings);
    res.json({
      ...debug,
      calendarId: settings.google_calendar_id || debug.calendarId || null,
      alertsCalendarId: settings.google_alerts_calendar_id || debug.alertsCalendarId || null,
      lastError: await fetchLastGoogleError(),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/google/debug-appointment/:id', authRequired, async (req, res) => {
  try {
    const settings = await getSettings();
    const appointment = await fetchAppointmentById(req.params.id);
    if (!appointment) return res.status(404).json({ error: 'Agendamento não encontrado.' });

    const appointmentModel = appointmentToGoogleModel(appointment);
    const payload = googleCalendarService.buildEventPayload(appointmentModel, settings);
    const alertsCalendar = await googleCalendarService.ensureAlertsCalendar(settings, { fallbackCalendarId: settings.google_calendar_id || 'primary' });
    const alert3hPayload = googleCalendarService.buildAlertPayload(appointmentModel, '3h');
    const alert1hPayload = googleCalendarService.buildAlertPayload(appointmentModel, '1h');
    const validation = {
      main: googleCalendarService.validateEventPayload(payload, settings.google_calendar_id || 'primary'),
      alert3h: googleCalendarService.validateEventPayload(alert3hPayload, alertsCalendar.calendarId || settings.google_calendar_id || 'primary'),
      alert1h: googleCalendarService.validateEventPayload(alert1hPayload, alertsCalendar.calendarId || settings.google_calendar_id || 'primary'),
    };
    const testPayload = googleCalendarService.buildEventPayload(googleCalendarService.buildTestAppointmentModel(settings), settings);
    const comparison = {
      main: buildPayloadComparison(testPayload, payload),
      alert3h: buildPayloadComparison(testPayload, alert3hPayload),
      alert1h: buildPayloadComparison(testPayload, alert1hPayload),
    };

    if (!validation.main.valid || !validation.alert3h.valid || !validation.alert1h.valid) {
      return res.status(400).json({
        appointment,
        payload: { main: payload, alert3h: alert3hPayload, alert1h: alert1hPayload, alertsCalendar },
        validation,
        comparison,
        googleError: {
          message: validation.main.errors[0] || validation.alert3h.errors[0] || validation.alert1h.errors[0] || 'Payload inválido para Google Calendar.',
          details: [
            ...validation.main.errors.map((message) => ({ scope: 'main', message })),
            ...validation.alert3h.errors.map((message) => ({ scope: 'alert3h', message })),
            ...validation.alert1h.errors.map((message) => ({ scope: 'alert1h', message })),
          ],
        },
      });
    }

    try {
      const created = await googleCalendarService.createCalendarEvent(settings, appointmentModel, { payloadLabel: 'GOOGLE APPOINTMENT PAYLOAD' });
      const createdAlert3h = await googleCalendarService.createCalendarEvent(settings, null, { eventData: alert3hPayload, calendarId: alertsCalendar.calendarId, payloadLabel: 'GOOGLE ALERT 3H PAYLOAD' });
      const createdAlert1h = await googleCalendarService.createCalendarEvent(settings, null, { eventData: alert1hPayload, calendarId: alertsCalendar.calendarId, payloadLabel: 'GOOGLE ALERT 1H PAYLOAD' });
      let removed = null;
      let removedAlert3h = null;
      let removedAlert1h = null;
      if (created?.data?.id) {
        removed = await googleCalendarService.deleteCalendarEvent(settings, created.data.id, { calendarId: settings.google_calendar_id || 'primary' });
      }
      if (createdAlert3h?.data?.id) {
        removedAlert3h = await googleCalendarService.deleteCalendarEvent(settings, createdAlert3h.data.id, { calendarId: alertsCalendar.calendarId });
      }
      if (createdAlert1h?.data?.id) {
        removedAlert1h = await googleCalendarService.deleteCalendarEvent(settings, createdAlert1h.data.id, { calendarId: alertsCalendar.calendarId });
      }
      return res.json({
        appointment,
        payload: { main: payload, alert3h: alert3hPayload, alert1h: alert1hPayload, alertsCalendar },
        validation,
        comparison,
        googleResponse: { created, createdAlert3h, createdAlert1h, removed, removedAlert3h, removedAlert1h },
      });
    } catch (error) {
      return res.status(400).json({
        appointment,
        payload: { main: payload, alert3h: alert3hPayload, alert1h: alert1hPayload, alertsCalendar },
        validation,
        comparison,
        googleError: googleCalendarService.extractGoogleError(error),
      });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/google/test-create-event', authRequired, async (_req, res) => {
  try {
    const settings = await getSettings();
    const created = await googleCalendarService.createTestEvent(settings);
    let removed = null;
    if (created?.data?.id) {
      removed = await googleCalendarService.deleteCalendarEvent(settings, created.data.id);
    }
    await setGoogleState({ connected: true, lastError: null, lastResponse: { created, removed } }).catch(() => null);
    await writeSystemLog('info', 'google_calendar', 'Teste manual de criação de evento executado.', { created, removed }).catch(() => null);
    res.json({ success: true, connected: true, created, removed });
  } catch (error) {
    const googleError = googleCalendarService.extractGoogleError(error);
    const friendlyError = buildFriendlyGoogleError(googleError);
    await setGoogleState({ connected: true, lastError: friendlyError, lastResponse: googleError }).catch(() => null);
    await writeSystemLog('error', 'google_calendar', 'Falha no teste manual de criação de evento.', { error: googleError, friendlyError }).catch(() => null);
    res.status(400).json({ success: false, connected: false, error: googleError, friendlyError });
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
     SET google_refresh_token = NULL,
         google_alerts_calendar_id = NULL,
         google_connected = false,
         google_last_error = NULL,
         google_last_response = '{}'::jsonb,
         last_google_sync_at = NULL,
         updated_at = NOW()
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
         google_last_error = NULL,
         google_last_response = $6::jsonb,
         google_email = COALESCE(NULLIF(google_email, ''), $2),
         google_calendar_id = COALESCE(NULLIF(google_calendar_id, ''), $3),
         google_alerts_calendar_id = COALESCE(google_alerts_calendar_id, NULL),
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
        JSON.stringify(tokens),
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
    const friendlyError = buildFriendlyGoogleError(error);
    await query('UPDATE app_settings SET google_connected = false, google_last_error = $1, updated_at = NOW() WHERE id = 1', [friendlyError]).catch(() => null);
    await writeSystemLog('error', 'google_oauth', 'Falha no callback OAuth do Google.', { error: error.message, friendlyError }).catch(() => null);
    return res.redirect('/admin.html?google=error');
  }
});

app.post('/api/admin/settings/google/test', authRequired, async (_req, res) => {
  try {
    const settings = await getSettings();
    const status = await googleCalendarService.getConnectionStatus(settings);
    const created = status.connected ? await googleCalendarService.createTestEvent(settings) : null;
    let removed = null;
    if (created?.data?.id) {
      removed = await googleCalendarService.deleteCalendarEvent(settings, created.data.id);
    }
    await query('UPDATE app_settings SET google_connected = $1, google_last_error = NULL, google_last_response = $2::jsonb, updated_at = NOW() WHERE id = 1', [Boolean(status.connected), JSON.stringify({ status, created, removed })]);
    res.json({ ...status, testEvent: created, cleanup: removed, connected: true });
  } catch (error) {
    const googleError = googleCalendarService.extractGoogleError(error);
    const friendlyError = buildFriendlyGoogleError(googleError);
    await writeSystemLog('error', 'google_oauth', 'Falha ao testar conexão Google.', { error: googleError, friendlyError }).catch(() => null);
    await query('UPDATE app_settings SET google_last_error = $1, google_last_response = $2::jsonb, updated_at = NOW() WHERE id = 1', [friendlyError, JSON.stringify(googleError)]).catch(() => null);
    res.status(400).json({ connected: false, reason: friendlyError, error: googleError });
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
    payment_received: z.boolean().optional().default(false),
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
         payment_received = $10,
         updated_at = NOW()
       WHERE id = $11 RETURNING *`,
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
        body.payment_received,
        req.params.id,
      ]
    );

    await writeSystemLog('info', 'appointments', 'Agendamento atualizado pelo painel.', { appointmentId: req.params.id, status: body.status }).catch(() => null);

    console.log('[Appointment:update] sincronização Google iniciada', JSON.stringify({ appointmentId: req.params.id, status: body.status }));
    const hasGoogleArtifacts = Boolean(appointment.google_event_id || appointment.google_alert_3h_event_id || appointment.google_alert_1h_event_id);
    const syncResult = body.status === 'cancelado' || (body.status !== 'confirmado' && hasGoogleArtifacts)
      ? await syncAppointmentWithGoogle(req.params.id, 'delete')
      : body.status === 'confirmado'
        ? await syncAppointmentWithGoogle(req.params.id, 'update')
        : { synced: false, reason: 'Agendamento ainda não confirmado.' };
    console.log('[Appointment:update] sincronização Google finalizada', JSON.stringify({ appointmentId: req.params.id, syncResult }));

    res.json({ ...result.rows[0], google: syncResult, friendlyGoogleError: syncResult?.friendlyError || null });
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

    const confirmationTemplate = resolveMessageTemplate(result.settings.confirmation_message, DEFAULT_CONFIRMATION_TEMPLATE);
    const message = normalizeWhatsappMessage(fillTemplate(confirmationTemplate, {
      nome: result.appointment.client_name,
      servico: result.appointment.service_name,
      data: formatDateBr(result.appointment.appointment_date),
      horario: minutesToRange(result.appointment.start_minutes, result.appointment.end_minutes),
      terapeuta: result.settings.therapist_name,
    }));

    res.json({
      success: true,
      whatsappUrl: buildWhatsappUrl(result.appointment.client_whatsapp, message),
      message,
      appointment: confirmedAppointment,
      google: syncResult,
      friendlyGoogleError: syncResult?.friendlyError || null,
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
      await client.query('DELETE FROM appointment_logs WHERE appointment_id = $1', [req.params.id]);
      await client.query('DELETE FROM appointments WHERE id = $1', [req.params.id]);
      await writeSystemLog('info', 'appointments', 'Agendamento excluído do painel.', {
        appointmentId: req.params.id,
        deletedBy: req.user.username,
        hadGoogleEventId: Boolean(appointment.google_event_id),
      }, client);
    });

    res.json({ success: true, google: syncResult, friendlyGoogleError: syncResult?.friendlyError || null });
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
