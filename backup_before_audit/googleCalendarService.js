const { google } = require('googleapis');

const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'openid',
  'email',
  'profile',
];

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
  return {
    message: error?.message || 'Erro desconhecido na Google API.',
    code: error?.code || error?.response?.status || null,
    status: error?.status || error?.response?.status || null,
    details: error?.errors || error?.response?.data?.error?.errors || null,
    responseData: error?.response?.data || null,
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
  } catch {
    calendarId = settings.google_calendar_id || 'primary';
  }

  return {
    accessToken: tokens.access_token || null,
    refreshToken: tokens.refresh_token || settings.google_refresh_token || null,
    email: profile?.data?.email || settings.google_email || null,
    calendarId,
    expiryDate: tokens.expiry_date || null,
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

function buildEventPayload(appointment) {
  return {
    summary: `[${appointment.service_name}] - ${appointment.client_name}`,
    description: [
      `Cliente: ${appointment.client_name}`,
      `WhatsApp: ${appointment.client_whatsapp}`,
      `Pagamento: ${appointment.payment_label}`,
      `Observações: ${appointment.notes || 'Sem observações.'}`,
    ].join('\n'),
    start: {
      dateTime: appointment.start_iso,
      timeZone: 'America/Sao_Paulo',
    },
    end: {
      dateTime: appointment.end_iso,
      timeZone: 'America/Sao_Paulo',
    },
  };
}

async function createCalendarEvent(settings, appointment) {
  if (!settings.google_refresh_token || !isConfigured(settings)) {
    throw new Error('Google Calendar não está conectado.');
  }

  const requestBody = buildEventPayload(appointment);
  debugLog('create:start', {
    calendarId: settings.google_calendar_id || 'primary',
    summary: requestBody.summary,
    start: requestBody.start,
    end: requestBody.end,
  });

  try {
    const auth = getAuthorizedClient(settings);
    const calendar = google.calendar({ version: 'v3', auth });
    const response = await calendar.events.insert({
      calendarId: settings.google_calendar_id || 'primary',
      requestBody,
    });

    debugLog('create:success', {
      eventId: response?.data?.id || null,
      htmlLink: response?.data?.htmlLink || null,
      status: response?.status || null,
    });

    if (!response?.data?.id) {
      throw new Error('Google Calendar retornou sucesso sem ID de evento.');
    }

    return response.data;
  } catch (error) {
    debugError('create:error', error, {
      calendarId: settings.google_calendar_id || 'primary',
      summary: requestBody.summary,
    });
    throw error;
  }
}

async function updateCalendarEvent(settings, appointment, eventId) {
  if (!eventId) {
    throw new Error('Evento Google não informado.');
  }
  if (!settings.google_refresh_token || !isConfigured(settings)) {
    throw new Error('Google Calendar não está conectado.');
  }

  const requestBody = buildEventPayload(appointment);
  debugLog('update:start', {
    calendarId: settings.google_calendar_id || 'primary',
    eventId,
    summary: requestBody.summary,
  });

  try {
    const auth = getAuthorizedClient(settings);
    const calendar = google.calendar({ version: 'v3', auth });
    const response = await calendar.events.update({
      calendarId: settings.google_calendar_id || 'primary',
      eventId,
      requestBody,
    });

    debugLog('update:success', {
      eventId: response?.data?.id || eventId,
      status: response?.status || null,
      htmlLink: response?.data?.htmlLink || null,
    });

    if (!response?.data?.id) {
      throw new Error('Google Calendar atualizou o evento sem retornar ID.');
    }

    return response.data;
  } catch (error) {
    debugError('update:error', error, {
      calendarId: settings.google_calendar_id || 'primary',
      eventId,
      summary: requestBody.summary,
    });
    throw error;
  }
}

async function deleteCalendarEvent(settings, eventId) {
  if (!eventId || !settings.google_refresh_token || !isConfigured(settings)) {
    return null;
  }

  debugLog('delete:start', {
    calendarId: settings.google_calendar_id || 'primary',
    eventId,
  });

  try {
    const auth = getAuthorizedClient(settings);
    const calendar = google.calendar({ version: 'v3', auth });
    const response = await calendar.events.delete({
      calendarId: settings.google_calendar_id || 'primary',
      eventId,
    });

    debugLog('delete:success', {
      eventId,
      status: response?.status || 204,
    });

    return true;
  } catch (error) {
    debugError('delete:error', error, {
      calendarId: settings.google_calendar_id || 'primary',
      eventId,
    });
    throw error;
  }
}

async function getConnectionStatus(settings) {
  if (!isConfigured(settings) || !settings.google_refresh_token) {
    return { connected: false };
  }
  const auth = getAuthorizedClient(settings);
  const calendar = google.calendar({ version: 'v3', auth });
  await calendar.calendarList.list({ maxResults: 1 });
  return {
    connected: true,
    email: settings.google_email || null,
    calendarId: settings.google_calendar_id || 'primary',
    lastSyncAt: settings.last_google_sync_at || null,
  };
}

module.exports = {
  GOOGLE_SCOPES,
  isConfigured,
  createAuthUrl,
  exchangeCodeForTokens,
  createCalendarEvent,
  updateCalendarEvent,
  deleteCalendarEvent,
  getConnectionStatus,
  extractGoogleError,
};
