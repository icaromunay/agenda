const { query, pool } = require('./src/db');
const googleCalendarService = require('./src/services/googleCalendarService');

const BASE_URL = 'http://localhost:3000';
const ADMIN_PASSWORD = '3001';

async function api(path, options = {}) {
  const response = await fetch(`${BASE_URL}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`${path} => ${response.status} ${data.error || JSON.stringify(data)}`);
  }
  return data;
}

function plusDays(date, days) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function dateOnly(date) {
  return date.toISOString().slice(0, 10);
}

function assert(condition, message, details = {}) {
  if (!condition) {
    const error = new Error(message);
    error.details = details;
    throw error;
  }
}

async function findSlot(serviceId) {
  const today = new Date('2026-06-02T12:00:00Z');
  for (let i = 2; i <= 45; i += 1) {
    const date = dateOnly(plusDays(today, i));
    const availability = await api(`/api/public/availability?serviceId=${serviceId}&date=${date}`);
    if (availability.slots?.length >= 2) {
      return { date, primary: availability.slots[0], secondary: availability.slots[1], availability };
    }
    if (availability.slots?.length === 1) {
      // continue searching for a second slot to use update with the same day if possible
      for (let j = i + 1; j <= 50; j += 1) {
        const nextDate = dateOnly(plusDays(today, j));
        const nextAvailability = await api(`/api/public/availability?serviceId=${serviceId}&date=${nextDate}`);
        if (nextAvailability.slots?.length) {
          return { date, primary: availability.slots[0], secondary: nextAvailability.slots[0], secondaryDate: nextDate, availability, nextAvailability };
        }
      }
    }
  }
  throw new Error('Nenhum horário disponível encontrado para os testes.');
}

async function fetchAppointmentRow(id) {
  const result = await query('SELECT * FROM appointments WHERE id = $1', [id]);
  return result.rows[0] || null;
}

async function fetchSettings() {
  const result = await query('SELECT * FROM app_settings WHERE id = 1');
  return result.rows[0];
}

async function safeGetGoogleEvent(settings, eventId, calendarId) {
  try {
    const result = await googleCalendarService.getCalendarEvent(settings, eventId, { calendarId });
    return { found: true, result };
  } catch (error) {
    return { found: false, error: googleCalendarService.extractGoogleError(error) };
  }
}

(async () => {
  const report = {
    version: '3.0.6',
    startedAt: new Date().toISOString(),
    steps: {},
  };

  let appointmentId = null;
  let token = null;
  let mainEventId = null;
  let alert3hEventId = null;
  let alert1hEventId = null;
  let mainCalendarId = null;
  let alertsCalendarId = null;

  try {
    const login = await api('/api/admin/auth/login', {
      method: 'POST',
      body: JSON.stringify({ password: ADMIN_PASSWORD }),
    });
    token = login.token;
    assert(Boolean(token), 'Token de autenticação não retornado.');
    report.steps.login = { ok: true };

    const services = await api('/api/public/services');
    const service = services.find((item) => item.active !== false) || services[0];
    assert(service?.id, 'Nenhum serviço ativo disponível.');
    report.steps.service = { id: service.id, name: service.name, duration: service.duration_minutes };

    const slotInfo = await findSlot(service.id);
    const testClientName = `Teste Alertas 306 ${Date.now()}`;
    const testWhatsapp = '47988006092';

    const createResponse = await api('/api/public/appointments', {
      method: 'POST',
      body: JSON.stringify({
        serviceId: service.id,
        paymentMethod: 'pix',
        date: slotInfo.date,
        startMinutes: slotInfo.primary.startMinutes,
        name: testClientName,
        whatsapp: testWhatsapp,
      }),
    });
    appointmentId = createResponse.appointmentId;
    assert(Boolean(appointmentId), 'Appointment ID não retornado na criação.');
    report.steps.publicCreate = createResponse;

    const createdRow = await fetchAppointmentRow(appointmentId);
    assert(createdRow, 'Agendamento criado não encontrado no banco.');
    assert(!createdRow.google_event_id, 'Evento principal não deveria ser criado antes da confirmação.', createdRow);
    assert(!createdRow.google_alert_3h_event_id, 'Alerta 3h não deveria existir antes da confirmação.', createdRow);
    assert(!createdRow.google_alert_1h_event_id, 'Alerta 1h não deveria existir antes da confirmação.', createdRow);
    report.steps.preConfirmDb = {
      google_event_id: createdRow.google_event_id,
      google_alert_3h_event_id: createdRow.google_alert_3h_event_id,
      google_alert_1h_event_id: createdRow.google_alert_1h_event_id,
      google_sync_status: createdRow.google_sync_status,
    };

    const confirmResponse = await api(`/api/admin/appointments/${appointmentId}/confirm`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    report.steps.confirm = confirmResponse;

    const confirmedRow = await fetchAppointmentRow(appointmentId);
    const settingsAfterConfirm = await fetchSettings();
    mainEventId = confirmedRow.google_event_id;
    alert3hEventId = confirmedRow.google_alert_3h_event_id;
    alert1hEventId = confirmedRow.google_alert_1h_event_id;
    mainCalendarId = settingsAfterConfirm.google_calendar_id || 'primary';
    alertsCalendarId = settingsAfterConfirm.google_alerts_calendar_id || mainCalendarId;

    assert(Boolean(mainEventId), 'Evento principal não foi persistido.');
    assert(Boolean(alert3hEventId), 'ID do alerta 3h não foi persistido.');
    assert(Boolean(alert1hEventId), 'ID do alerta 1h não foi persistido.');
    report.steps.postConfirmDb = {
      google_event_id: mainEventId,
      google_alert_3h_event_id: alert3hEventId,
      google_alert_1h_event_id: alert1hEventId,
      google_alerts_calendar_id: alertsCalendarId,
      google_sync_status: confirmedRow.google_sync_status,
    };

    const mainEvent = await safeGetGoogleEvent(settingsAfterConfirm, mainEventId, mainCalendarId);
    const alert3hEvent = await safeGetGoogleEvent(settingsAfterConfirm, alert3hEventId, alertsCalendarId);
    const alert1hEvent = await safeGetGoogleEvent(settingsAfterConfirm, alert1hEventId, alertsCalendarId);

    assert(mainEvent.found, 'Evento principal não encontrado no Google Calendar.', mainEvent);
    assert(alert3hEvent.found, 'Alerta 3h não encontrado no Google Calendar.', alert3hEvent);
    assert(alert1hEvent.found, 'Alerta 1h não encontrado no Google Calendar.', alert1hEvent);

    const mainData = mainEvent.result.data;
    const alert3hData = alert3hEvent.result.data;
    const alert1hData = alert1hEvent.result.data;

    assert(alert3hData.summary === '⏰ ALERTA MUNAY', 'Título do alerta 3h divergente.', alert3hData);
    assert(alert1hData.summary === '⏰ ALERTA MUNAY', 'Título do alerta 1h divergente.', alert1hData);
    assert(alert3hData.description === 'Fique atento.\nDaqui 3 horas você possui um atendimento agendado.', 'Descrição do alerta 3h divergente.', alert3hData);
    assert(alert1hData.description === 'Fique atento.\nDaqui 1 hora você possui um atendimento agendado.', 'Descrição do alerta 1h divergente.', alert1hData);
    assert(JSON.stringify(alert3hData.reminders) === JSON.stringify({ useDefault: false, overrides: [{ method: 'popup', minutes: 0 }] }), 'Reminders do alerta 3h divergentes.', alert3hData.reminders);
    assert(JSON.stringify(alert1hData.reminders) === JSON.stringify({ useDefault: false, overrides: [{ method: 'popup', minutes: 0 }] }), 'Reminders do alerta 1h divergentes.', alert1hData.reminders);
    report.steps.googleAfterConfirm = {
      main: mainData,
      alert3h: alert3hData,
      alert1h: alert1hData,
      alertsCalendarId,
      alertsCalendarMatchesMain: alertsCalendarId === mainCalendarId,
    };

    const updatedDate = slotInfo.secondaryDate || slotInfo.date;
    const updatedStartMinutes = slotInfo.secondary.startMinutes;
    const updateResponse = await api(`/api/admin/appointments/${appointmentId}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        appointment_date: updatedDate,
        start_minutes: updatedStartMinutes,
        status: 'confirmado',
        payment_method: 'pix',
        payment_received: false,
        notes: 'Teste de atualização dos alertas 3.0.6',
      }),
    });
    report.steps.update = updateResponse;

    const updatedRow = await fetchAppointmentRow(appointmentId);
    assert(updatedRow.google_event_id === mainEventId, 'ID do evento principal deveria permanecer o mesmo após atualização.', updatedRow);
    assert(updatedRow.google_alert_3h_event_id === alert3hEventId, 'ID do alerta 3h deveria permanecer o mesmo após atualização.', updatedRow);
    assert(updatedRow.google_alert_1h_event_id === alert1hEventId, 'ID do alerta 1h deveria permanecer o mesmo após atualização.', updatedRow);

    const settingsAfterUpdate = await fetchSettings();
    const updatedMainEvent = await safeGetGoogleEvent(settingsAfterUpdate, mainEventId, mainCalendarId);
    const updatedAlert3hEvent = await safeGetGoogleEvent(settingsAfterUpdate, alert3hEventId, alertsCalendarId);
    const updatedAlert1hEvent = await safeGetGoogleEvent(settingsAfterUpdate, alert1hEventId, alertsCalendarId);
    assert(updatedMainEvent.found && updatedAlert3hEvent.found && updatedAlert1hEvent.found, 'Eventos não foram encontrados após atualização.');
    report.steps.googleAfterUpdate = {
      main: updatedMainEvent.result.data,
      alert3h: updatedAlert3hEvent.result.data,
      alert1h: updatedAlert1hEvent.result.data,
    };

    const deleteResponse = await api(`/api/admin/appointments/${appointmentId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    report.steps.delete = deleteResponse;

    const deletedRow = await fetchAppointmentRow(appointmentId);
    assert(!deletedRow, 'Agendamento não foi removido do banco após exclusão.');

    const settingsAfterDelete = await fetchSettings();
    const deletedMainEvent = await safeGetGoogleEvent(settingsAfterDelete, mainEventId, mainCalendarId);
    const deletedAlert3hEvent = await safeGetGoogleEvent(settingsAfterDelete, alert3hEventId, alertsCalendarId);
    const deletedAlert1hEvent = await safeGetGoogleEvent(settingsAfterDelete, alert1hEventId, alertsCalendarId);
    assert(!deletedMainEvent.found, 'Evento principal ainda existe após exclusão.', deletedMainEvent);
    assert(!deletedAlert3hEvent.found, 'Alerta 3h ainda existe após exclusão.', deletedAlert3hEvent);
    assert(!deletedAlert1hEvent.found, 'Alerta 1h ainda existe após exclusão.', deletedAlert1hEvent);
    report.steps.googleAfterDelete = {
      main: deletedMainEvent,
      alert3h: deletedAlert3hEvent,
      alert1h: deletedAlert1hEvent,
    };

    report.success = true;
    report.finishedAt = new Date().toISOString();
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    report.success = false;
    report.finishedAt = new Date().toISOString();
    report.error = {
      message: error.message,
      details: error.details || null,
      stack: error.stack,
    };
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = 1;
  } finally {
    await pool.end().catch(() => null);
  }
})();
