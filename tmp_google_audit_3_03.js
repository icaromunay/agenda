const fs = require('fs');
const path = require('path');
const { query } = require('./src/db');
const googleCalendarService = require('./src/services/googleCalendarService');

function minutesToTime(minutes) {
  const h = String(Math.floor(minutes / 60)).padStart(2, '0');
  const m = String(minutes % 60).padStart(2, '0');
  return `${h}:${m}`;
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

function buildFixedModel(appointment) {
  const date = toDateOnlyString(appointment.appointment_date);
  return {
    service_name: appointment.service_name,
    client_name: appointment.client_name,
    client_whatsapp: appointment.client_whatsapp,
    payment_label: appointment.payment_label,
    notes: appointment.notes || '',
    start_iso: `${date}T${minutesToTime(appointment.start_minutes)}:00-03:00`,
    end_iso: `${date}T${minutesToTime(appointment.end_minutes)}:00-03:00`,
  };
}

function buildLegacyBrokenModel(appointment) {
  return {
    service_name: appointment.service_name,
    client_name: appointment.client_name,
    client_whatsapp: appointment.client_whatsapp,
    payment_label: appointment.payment_label,
    notes: appointment.notes || '',
    start_iso: `${appointment.appointment_date}T${minutesToTime(appointment.start_minutes)}:00-03:00`,
    end_iso: `${appointment.appointment_date}T${minutesToTime(appointment.end_minutes)}:00-03:00`,
  };
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

function comparePayloads(a, b) {
  const aFields = [...new Set(flattenObjectKeys(a))].sort();
  const bFields = [...new Set(flattenObjectKeys(b))].sort();
  const onlyInA = aFields.filter((field) => !bFields.includes(field));
  const onlyInB = bFields.filter((field) => !aFields.includes(field));
  const changed = [];
  for (const field of aFields.filter((field) => bFields.includes(field))) {
    const aValue = field.split('.').reduce((acc, key) => acc?.[key], a);
    const bValue = field.split('.').reduce((acc, key) => acc?.[key], b);
    if (JSON.stringify(aValue) !== JSON.stringify(bValue)) {
      changed.push({ field, aValue, bValue });
    }
  }
  return { onlyInA, onlyInB, changed };
}

(async () => {
  const settingsResult = await query('SELECT * FROM app_settings WHERE id = 1');
  const settings = settingsResult.rows[0];
  const appointmentResult = await query(`
    SELECT a.*, c.name AS client_name, c.whatsapp AS client_whatsapp, s.name AS service_name
    FROM appointments a
    JOIN clients c ON c.id = a.client_id
    JOIN services s ON s.id = a.service_id
    WHERE a.google_sync_error IS NOT NULL
    ORDER BY a.updated_at DESC
    LIMIT 1
  `);

  if (!appointmentResult.rows.length) {
    throw new Error('Nenhum agendamento com falha Google encontrado para auditoria.');
  }

  const appointment = appointmentResult.rows[0];
  const fixedModel = buildFixedModel(appointment);
  const legacyModel = buildLegacyBrokenModel(appointment);
  const testModel = googleCalendarService.buildTestAppointmentModel(settings);

  const fixedPayload = googleCalendarService.buildEventPayload(fixedModel);
  const legacyPayload = googleCalendarService.buildEventPayload(legacyModel);
  const testPayload = googleCalendarService.buildEventPayload(testModel);
  const calendarId = settings.google_calendar_id || 'primary';
  const fixedValidation = googleCalendarService.validateEventPayload(fixedPayload, calendarId);
  const legacyValidation = googleCalendarService.validateEventPayload(legacyPayload, calendarId);
  const testValidation = googleCalendarService.validateEventPayload(testPayload, calendarId);
  const compareTestVsFixed = comparePayloads(testPayload, fixedPayload);
  const compareLegacyVsFixed = comparePayloads(legacyPayload, fixedPayload);

  let googleCreateDeleteProbe = null;
  let googleProbeError = null;
  try {
    const created = await googleCalendarService.createCalendarEvent(settings, fixedModel, { payloadLabel: 'GOOGLE APPOINTMENT PAYLOAD' });
    let removed = null;
    if (created?.data?.id) {
      removed = await googleCalendarService.deleteCalendarEvent(settings, created.data.id);
    }
    googleCreateDeleteProbe = { created, removed };
  } catch (error) {
    googleProbeError = googleCalendarService.extractGoogleError(error);
  }

  const rootCause = {
    field: ['start.dateTime', 'end.dateTime'],
    description: 'O payload real antigo concatenava um objeto Date diretamente na string ISO, gerando valores inválidos como "Wed Jun 03 2026 ...T09:00:00-03:00". O Google rejeita esse formato com Bad Request.',
    legacyStart: legacyPayload.start.dateTime,
    fixedStart: fixedPayload.start.dateTime,
    legacyEnd: legacyPayload.end.dateTime,
    fixedEnd: fixedPayload.end.dateTime,
  };

  const report = {
    auditedAppointmentId: appointment.id,
    appointmentDateRaw: appointment.appointment_date,
    appointmentDateType: typeof appointment.appointment_date,
    calendarId,
    fixedValidation,
    legacyValidation,
    testValidation,
    compareTestVsFixed,
    compareLegacyVsFixed,
    rootCause,
    fixedPayload,
    testPayload,
    googleCreateDeleteProbe,
    googleProbeError,
  };

  const reportPath = path.resolve(process.cwd(), 'RELATORIO_AUDITORIA_GOOGLE_SYNC_3.03.txt');
  const lines = [
    'RELATÓRIO AUDITORIA GOOGLE SYNC 3.03',
    '',
    `Agendamento auditado: ${appointment.id}`,
    `Tipo bruto de appointment_date: ${typeof appointment.appointment_date}`,
    `Valor bruto de appointment_date: ${appointment.appointment_date}`,
    `Calendar ID: ${calendarId}`,
    '',
    'CAUSA RAIZ IDENTIFICADA',
    rootCause.description,
    '',
    'VALIDAÇÃO PAYLOAD TESTE',
    JSON.stringify(testValidation, null, 2),
    '',
    'VALIDAÇÃO PAYLOAD REAL CORRIGIDO',
    JSON.stringify(fixedValidation, null, 2),
    '',
    'VALIDAÇÃO PAYLOAD REAL LEGADO (QUEBRADO)',
    JSON.stringify(legacyValidation, null, 2),
    '',
    'DIFERENÇAS TESTE VS REAL CORRIGIDO',
    JSON.stringify(compareTestVsFixed, null, 2),
    '',
    'DIFERENÇAS LEGADO VS CORRIGIDO',
    JSON.stringify(compareLegacyVsFixed, null, 2),
    '',
    'PAYLOAD TESTE',
    JSON.stringify(testPayload, null, 2),
    '',
    'PAYLOAD REAL CORRIGIDO',
    JSON.stringify(fixedPayload, null, 2),
    '',
    'PROVA DE CRIAÇÃO/REMOÇÃO COM PAYLOAD REAL CORRIGIDO',
    JSON.stringify(googleCreateDeleteProbe || googleProbeError, null, 2),
  ];
  fs.writeFileSync(reportPath, `${lines.join('\n')}\n`, 'utf8');

  console.log(JSON.stringify({
    reportPath,
    rootCause,
    fixedValidation,
    legacyValidation,
    testValidation,
    googleCreateDeleteProbe,
    googleProbeError,
  }, null, 2));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
