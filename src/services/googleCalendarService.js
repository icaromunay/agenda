const { google } = require('googleapis');

const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'openid',
  'email',
  'profile',
];
const SAO_PAULO_TIMEZONE = 'America/Sao_Paulo';
const ISO8601_WITH_OFFSET_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$/;
const ALERTS_CALENDAR_SUMMARY = 'Munay Alertas';
const ALERT_EVENT_TITLE = '⏰ ALERTA MUNAY';
const ALERT_EVENT_DURATION_MINUTES = 5;
const ALERT_SPECS = {
  '3h': {
    key: '3h',
    offsetMinutes: 180,
    description: 'Fique atento.\nDaqui 3 horas você possui um atendimento agendado.',
  },
  '1h': {
    key: '1h',
    offsetMinutes: 60,
    description: 'Fique atento.\nDaqui 1 hora você possui um atendimento agendado.',
  },
};

function isConfigured(settings) {
  return Boolean(
    settings?.google_client_id &&
    settings?.google_client_secret &&
    settings?.google_redirect_uri
  );
}

function createOAuthClient(settings) {
  if (!isConfigured(settings)) {
    throw new Error('Configuração OAuth do Google incompleta.');
  }

  const client = new google.auth.OAuth2(
    settings.google_client_id,
    settings.google_client_secret,
    settings.google_redirect_uri
  );

  if (settings.google_refresh_token) {
    client.setCredentials({ refresh_token: settings.google_refresh_token });
  }

  return client;
}

function createAuthUrl(settings, state = '') {
  const client = createOAuthClient(settings);
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: GOOGLE_SCOPES,
    include_granted_scopes: true,
    state,
  });
}

function extractGoogleError(error) {
  const responseData = error?.response?.data || null;
  const inner = responseData?.error || responseData || null;
  const details = inner?.errors || error?.errors || [];
  const detailMessage = details?.[0]?.message || inner?.message || responseData?.error_description || null;
  return {
    message: detailMessage || error?.message || 'Erro desconhecido na Google API.',
    code: inner?.code || error?.code || error?.response?.status || null,
    status: inner?.status || error?.status || error?.response?.status || null,
    details,
    responseData,
    stack: error?.stack || null,
  };
}

function debugLog(label, payload) {
  console.log(`[GoogleCalendar:${label}]`, JSON.stringify(payload, null, 2));
}

function debugError(label, error, extra = {}) {
  const details = { ...extra, error: extractGoogleError(error) };
  console.error(`[GoogleCalendar:${label}]`, JSON.stringify(details, null, 2));
}

async function exchangeCodeForTokens(settings, code) {
  const client = createOAuthClient(settings);
  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);

  const oauth2 = google.oauth2({ version: 'v2', auth: client });
  const profile = await oauth2.userinfo.get();

  let calendarId = settings.google_calendar_id || 'primary';
  try {
    const calendarApi = google.calendar({ version: 'v3', auth: client });
    const calendars = await calendarApi.calendarList.list({ maxResults: 20 });
    const primary = (calendars.data.items || []).find((item) => item.primary) || calendars.data.items?.[0];
    if (primary?.id) {
      calendarId = primary.id;
    }
  } catch (error) {
    debugError('exchange:list-calendars', error, { fallbackCalendarId: calendarId });
  }

  return {
    accessToken: tokens.access_token || null,
    refreshToken: tokens.refresh_token || settings.google_refresh_token || null,
    email: profile?.data?.email || settings.google_email || null,
    calendarId,
    expiryDate: tokens.expiry_date || null,
    tokenType: tokens.token_type || null,
    scope: tokens.scope || null,
  };
}

function getAuthorizedClient(settings, extraCredentials = {}) {
  const client = createOAuthClient(settings);
  client.setCredentials({
    refresh_token: settings.google_refresh_token,
    ...extraCredentials,
  });
  return client;
}

function getCalendarApi(settings, extraCredentials = {}) {
  const auth = getAuthorizedClient(settings, extraCredentials);
  return {
    auth,
    calendar: google.calendar({ version: 'v3', auth }),
  };
}

async function getRuntimeTokenInfo(settings) {
  if (!isConfigured(settings) || !settings?.google_refresh_token) {
    return { hasAccessToken: false, accessToken: null, expiryDate: null };
  }

  try {
    const auth = getAuthorizedClient(settings);
    const accessTokenResponse = await auth.getAccessToken();
    const accessToken = typeof accessTokenResponse === 'string'
      ? accessTokenResponse
      : accessTokenResponse?.token || null;

    return {
      hasAccessToken: Boolean(accessToken),
      accessToken,
      expiryDate: auth.credentials?.expiry_date || null,
    };
  } catch (error) {
    debugError('token:getAccessToken', error, {});
    return {
      hasAccessToken: false,
      accessToken: null,
      expiryDate: null,
      tokenError: extractGoogleError(error),
    };
  }
}

function buildGoogleReminders(settings = {}) {
  const overrides = [];
  if (settings.notification_24h) overrides.push({ method: 'popup', minutes: 1440 });
  if (settings.notification_1h) overrides.push({ method: 'popup', minutes: 60 });
  if (settings.notification_15m) overrides.push({ method: 'popup', minutes: 15 });
  return {
    useDefault: false,
    overrides,
  };
}

function buildImmediateAlertReminder() {
  return {
    useDefault: false,
    overrides: [
      { method: 'popup', minutes: 0 },
    ],
  };
}

function buildEventPayload(appointment, settings = {}) {
  const summary = `[${appointment?.service_name || ''}] - ${appointment?.client_name || ''}`.replace(/\s+/g, ' ').trim();
  const description = [
    `Cliente: ${appointment?.client_name || 'Não informado'}`,
    `WhatsApp: ${appointment?.client_whatsapp || 'Não informado'}`,
    `Pagamento: ${appointment?.payment_label || 'Não informado'}`,
    `Observações: ${appointment?.notes || 'Sem observações.'}`,
  ].join('\n');

  return {
    summary,
    description: String(description || ''),
    start: {
      dateTime: appointment?.start_iso || '',
      timeZone: SAO_PAULO_TIMEZONE,
    },
    end: {
      dateTime: appointment?.end_iso || '',
      timeZone: SAO_PAULO_TIMEZONE,
    },
    reminders: buildGoogleReminders(settings),
  };
}

function dateToGoogleLocalIso(date) {
  const parts = new Intl.DateTimeFormat('sv-SE', {
    timeZone: SAO_PAULO_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date).reduce((acc, part) => {
    if (part.type !== 'literal') acc[part.type] = part.value;
    return acc;
  }, {});

  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}-03:00`;
}

function buildAlertPayload(appointment, alertKey) {
  const spec = ALERT_SPECS[alertKey];
  if (!spec) {
    throw new Error(`Tipo de alerta inválido: ${alertKey}`);
  }

  const appointmentStart = new Date(String(appointment?.start_iso || ''));
  if (Number.isNaN(appointmentStart.getTime())) {
    throw new Error(`Não foi possível gerar o alerta ${alertKey}: horário inicial inválido.`);
  }

  const alertStart = new Date(appointmentStart.getTime() - (spec.offsetMinutes * 60 * 1000));
  const alertEnd = new Date(alertStart.getTime() + (ALERT_EVENT_DURATION_MINUTES * 60 * 1000));

  return {
    summary: ALERT_EVENT_TITLE,
    description: spec.description,
    start: {
      dateTime: dateToGoogleLocalIso(alertStart),
      timeZone: SAO_PAULO_TIMEZONE,
    },
    end: {
      dateTime: dateToGoogleLocalIso(alertEnd),
      timeZone: SAO_PAULO_TIMEZONE,
    },
    reminders: buildImmediateAlertReminder(),
  };
}

function validateEventPayload(eventData, calendarId) {
  const errors = [];

  if (!String(eventData?.summary || '').trim()) {
    errors.push('Missing required field summary');
  }
  if (typeof eventData?.description !== 'string') {
    errors.push('Missing required field description');
  }
  if (!ISO8601_WITH_OFFSET_REGEX.test(String(eventData?.start?.dateTime || ''))) {
    errors.push('Invalid start time');
  }
  if (!ISO8601_WITH_OFFSET_REGEX.test(String(eventData?.end?.dateTime || ''))) {
    errors.push('Invalid end time');
  }
  if (String(eventData?.start?.timeZone || '') !== SAO_PAULO_TIMEZONE || String(eventData?.end?.timeZone || '') !== SAO_PAULO_TIMEZONE) {
    errors.push('Invalid timeZone');
  }
  if (!String(calendarId || '').trim()) {
    errors.push('Missing calendarId');
  }

  return {
    valid: errors.length === 0,
    errors,
    calendarId: calendarId || null,
    requiredFields: {
      summary: eventData?.summary || null,
      description: eventData?.description || null,
      startDateTime: eventData?.start?.dateTime || null,
      endDateTime: eventData?.end?.dateTime || null,
      timeZone: eventData?.start?.timeZone || eventData?.end?.timeZone || null,
      calendarId: calendarId || null,
      reminders: eventData?.reminders || null,
    },
  };
}

function prepareEventRequest(settings, appointment, options = {}) {
  const eventData = options.eventData || buildEventPayload(appointment, settings);
  const calendarId = String(options.calendarId || settings?.google_calendar_id || 'primary').trim() || 'primary';
  const validation = validateEventPayload(eventData, calendarId);
  const payloadLabel = options.payloadLabel || 'GOOGLE APPOINTMENT PAYLOAD';
  console.log(`[${payloadLabel}]`, JSON.stringify(eventData, null, 2));
  return { calendarId, eventData, validation };
}

function buildTestAppointmentModel(settings) {
  const now = new Date(Date.now() + (10 * 60 * 1000));
  const end = new Date(now.getTime() + (5 * 60 * 1000));
  return {
    service_name: 'Teste de Integração',
    client_name: 'Munay Agenda Pro',
    client_whatsapp: settings.google_email || 'N/D',
    payment_label: 'Teste',
    notes: 'Evento temporário criado pelo botão Testar conexão Google.',
    start_iso: dateToGoogleLocalIso(now),
    end_iso: dateToGoogleLocalIso(end),
  };
}

function extractEventResponse(response) {
  return {
    status: response?.status || null,
    statusText: response?.statusText || null,
    headers: response?.headers || null,
    data: response?.data || null,
  };
}

async function ensureAlertsCalendar(settings, options = {}) {
  const fallbackCalendarId = String(options.fallbackCalendarId || settings?.google_calendar_id || 'primary').trim() || 'primary';
  if (!settings.google_refresh_token || !isConfigured(settings)) {
    return {
      calendarId: fallbackCalendarId,
      created: false,
      source: 'fallback:not-connected',
      summary: ALERTS_CALENDAR_SUMMARY,
    };
  }

  try {
    const { calendar } = getCalendarApi(settings);
    const configuredId = String(settings.google_alerts_calendar_id || '').trim();
    if (configuredId) {
      try {
        const calendarInfo = await calendar.calendarList.get({ calendarId: configuredId });
        return {
          calendarId: configuredId,
          created: false,
          source: 'configured',
          summary: calendarInfo?.data?.summary || ALERTS_CALENDAR_SUMMARY,
        };
      } catch (error) {
        debugError('alerts-calendar:get-configured', error, { configuredId });
      }
    }

    const calendars = await calendar.calendarList.list({ maxResults: 250 });
    const existing = (calendars.data.items || []).find((item) => item.id === configuredId)
      || (calendars.data.items || []).find((item) => String(item.summary || '').trim() === ALERTS_CALENDAR_SUMMARY);

    if (existing?.id) {
      return {
        calendarId: existing.id,
        created: false,
        source: 'existing',
        summary: existing.summary || ALERTS_CALENDAR_SUMMARY,
      };
    }

    const created = await calendar.calendars.insert({
      requestBody: {
        summary: ALERTS_CALENDAR_SUMMARY,
        timeZone: SAO_PAULO_TIMEZONE,
      },
    });

    return {
      calendarId: created?.data?.id || fallbackCalendarId,
      created: Boolean(created?.data?.id),
      source: created?.data?.id ? 'created' : 'fallback:no-id',
      summary: created?.data?.summary || ALERTS_CALENDAR_SUMMARY,
      response: extractEventResponse(created),
    };
  } catch (error) {
    debugError('alerts-calendar:ensure', error, { fallbackCalendarId });
    return {
      calendarId: fallbackCalendarId,
      created: false,
      source: 'fallback:main-calendar',
      summary: ALERTS_CALENDAR_SUMMARY,
      error: extractGoogleError(error),
    };
  }
}

async function createCalendarEvent(settings, appointment, options = {}) {
  if (!settings.google_refresh_token || !isConfigured(settings)) {
    throw new Error('Google Calendar não está conectado.');
  }

  const { calendarId, eventData, validation } = prepareEventRequest(settings, appointment, {
    payloadLabel: options.payloadLabel || 'GOOGLE APPOINTMENT PAYLOAD',
    eventData: options.eventData,
    calendarId: options.calendarId,
  });
  debugLog('create:start', {
    calendarId,
    requestBody: eventData,
    validation,
  });

  if (!validation.valid) {
    const validationError = new Error(validation.errors[0] || 'Payload inválido para Google Calendar.');
    validationError.response = {
      status: 400,
      data: {
        error: {
          code: 400,
          status: 'VALIDATION_FAILED',
          message: validation.errors[0] || 'Payload inválido para Google Calendar.',
          errors: validation.errors.map((message) => ({ message })),
        },
      },
    };
    console.error('[GOOGLE FULL ERROR]', JSON.stringify(validationError.response.data, null, 2));
    throw validationError;
  }

  try {
    const { calendar } = getCalendarApi(settings);
    const response = await calendar.events.insert({
      calendarId,
      requestBody: eventData,
      sendUpdates: 'none',
    });

    const result = extractEventResponse(response);
    debugLog('create:success', result);

    if (!response?.data?.id) {
      throw new Error('Google Calendar retornou sucesso sem ID de evento.');
    }

    return result;
  } catch (error) {
    console.error('[GOOGLE FULL ERROR]', JSON.stringify(error.response?.data || error, null, 2));
    debugError('create:error', error, { calendarId, requestBody: eventData, validation });
    throw error;
  }
}

async function updateCalendarEvent(settings, appointment, eventId, options = {}) {
  if (!eventId) {
    throw new Error('Evento Google não informado.');
  }
  if (!settings.google_refresh_token || !isConfigured(settings)) {
    throw new Error('Google Calendar não está conectado.');
  }

  const { calendarId, eventData, validation } = prepareEventRequest(settings, appointment, {
    payloadLabel: options.payloadLabel || 'GOOGLE APPOINTMENT PAYLOAD',
    eventData: options.eventData,
    calendarId: options.calendarId,
  });
  debugLog('update:start', { calendarId, eventId, requestBody: eventData, validation });

  if (!validation.valid) {
    const validationError = new Error(validation.errors[0] || 'Payload inválido para Google Calendar.');
    validationError.response = {
      status: 400,
      data: {
        error: {
          code: 400,
          status: 'VALIDATION_FAILED',
          message: validation.errors[0] || 'Payload inválido para Google Calendar.',
          errors: validation.errors.map((message) => ({ message })),
        },
      },
    };
    console.error('[GOOGLE FULL ERROR]', JSON.stringify(validationError.response.data, null, 2));
    throw validationError;
  }

  try {
    const { calendar } = getCalendarApi(settings);
    const response = await calendar.events.update({
      calendarId,
      eventId,
      requestBody: eventData,
      sendUpdates: 'none',
    });

    const result = extractEventResponse(response);
    debugLog('update:success', result);

    if (!response?.data?.id) {
      throw new Error('Google Calendar atualizou o evento sem retornar ID.');
    }

    return result;
  } catch (error) {
    console.error('[GOOGLE FULL ERROR]', JSON.stringify(error.response?.data || error, null, 2));
    debugError('update:error', error, { calendarId, eventId, requestBody: eventData, validation });
    throw error;
  }
}

async function deleteCalendarEvent(settings, eventId, options = {}) {
  if (!eventId || !settings.google_refresh_token || !isConfigured(settings)) {
    return null;
  }

  const calendarId = String(options.calendarId || settings.google_calendar_id || 'primary').trim() || 'primary';
  debugLog('delete:start', { calendarId, eventId });

  try {
    const { calendar } = getCalendarApi(settings);
    const response = await calendar.events.delete({
      calendarId,
      eventId,
      sendUpdates: 'none',
    });

    const result = {
      status: response?.status || 204,
      statusText: response?.statusText || 'No Content',
      data: response?.data || {},
      eventId,
      calendarId,
    };
    debugLog('delete:success', result);

    return result;
  } catch (error) {
    debugError('delete:error', error, { calendarId, eventId });
    throw error;
  }
}

async function getCalendarEvent(settings, eventId, options = {}) {
  if (!eventId || !settings.google_refresh_token || !isConfigured(settings)) {
    return null;
  }
  const calendarId = String(options.calendarId || settings.google_calendar_id || 'primary').trim() || 'primary';
  try {
    const { calendar } = getCalendarApi(settings);
    const response = await calendar.events.get({ calendarId, eventId });
    return extractEventResponse(response);
  } catch (error) {
    debugError('get-event:error', error, { calendarId, eventId });
    throw error;
  }
}

async function getConnectionStatus(settings) {
  if (!isConfigured(settings) || !settings.google_refresh_token) {
    return {
      connected: false,
      calendarId: settings?.google_calendar_id || null,
      alertsCalendarId: settings?.google_alerts_calendar_id || null,
      hasRefreshToken: Boolean(settings?.google_refresh_token),
      hasAccessToken: false,
      lastSyncAt: settings?.last_google_sync_at || null,
    };
  }

  const { calendar } = getCalendarApi(settings);
  const listResponse = await calendar.calendarList.list({ maxResults: 1 });
  const tokenInfo = await getRuntimeTokenInfo(settings);

  return {
    connected: true,
    email: settings.google_email || null,
    calendarId: settings.google_calendar_id || 'primary',
    alertsCalendarId: settings.google_alerts_calendar_id || null,
    hasRefreshToken: Boolean(settings.google_refresh_token),
    hasAccessToken: tokenInfo.hasAccessToken,
    accessTokenPreview: tokenInfo.accessToken ? `${String(tokenInfo.accessToken).slice(0, 10)}...` : null,
    expiryDate: tokenInfo.expiryDate || null,
    lastSyncAt: settings.last_google_sync_at || null,
    calendarsChecked: listResponse?.data?.items?.length || 0,
  };
}

async function getDebugStatus(settings) {
  const base = {
    connected: false,
    calendarId: settings?.google_calendar_id || null,
    alertsCalendarId: settings?.google_alerts_calendar_id || null,
    hasRefreshToken: Boolean(settings?.google_refresh_token),
    hasAccessToken: false,
    lastSyncAt: settings?.last_google_sync_at || null,
  };

  if (!isConfigured(settings) || !settings?.google_refresh_token) {
    return base;
  }

  try {
    const status = await getConnectionStatus(settings);
    return {
      connected: Boolean(status.connected),
      calendarId: status.calendarId || null,
      alertsCalendarId: status.alertsCalendarId || null,
      hasRefreshToken: Boolean(status.hasRefreshToken),
      hasAccessToken: Boolean(status.hasAccessToken),
      lastSyncAt: status.lastSyncAt || null,
    };
  } catch (error) {
    debugError('debug-status:error', error, base);
    return base;
  }
}

async function createTestEvent(settings) {
  const appointment = buildTestAppointmentModel(settings);
  return createCalendarEvent(settings, appointment, { payloadLabel: 'GOOGLE TEST PAYLOAD' });
}

module.exports = {
  GOOGLE_SCOPES,
  ALERTS_CALENDAR_SUMMARY,
  ALERT_EVENT_TITLE,
  ALERT_SPECS,
  SAO_PAULO_TIMEZONE,
  isConfigured,
  createAuthUrl,
  exchangeCodeForTokens,
  createCalendarEvent,
  updateCalendarEvent,
  deleteCalendarEvent,
  getCalendarEvent,
  getConnectionStatus,
  getDebugStatus,
  getRuntimeTokenInfo,
  createTestEvent,
  extractGoogleError,
  buildEventPayload,
  buildAlertPayload,
  buildGoogleReminders,
  buildImmediateAlertReminder,
  validateEventPayload,
  prepareEventRequest,
  buildTestAppointmentModel,
  ensureAlertsCalendar,
  dateToGoogleLocalIso,
};
