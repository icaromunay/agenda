const { google } = require('googleapis');

function isConfigured(settings) {
  return Boolean(
    settings.google_client_id &&
    settings.google_client_secret &&
    settings.google_redirect_uri &&
    settings.google_calendar_id
  );
}

function createOAuthClient(settings) {
  const oauth2Client = new google.auth.OAuth2(
    settings.google_client_id,
    settings.google_client_secret,
    settings.google_redirect_uri
  );

  if (settings.google_refresh_token) {
    oauth2Client.setCredentials({ refresh_token: settings.google_refresh_token });
  }

  return oauth2Client;
}

function buildEventPayload({ appointment, settings }) {
  return {
    summary: `${appointment.service_name} — ${appointment.client_name}`,
    description: `Cliente: ${appointment.client_name}\nWhatsApp: ${appointment.client_whatsapp}\nPagamento: ${appointment.payment_label}`,
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

async function createEvent({ appointment, settings }) {
  if (!isConfigured(settings) || !settings.google_refresh_token) return null;
  const auth = createOAuthClient(settings);
  const calendar = google.calendar({ version: 'v3', auth });
  const response = await calendar.events.insert({
    calendarId: settings.google_calendar_id,
    requestBody: buildEventPayload({ appointment, settings }),
  });
  return response.data.id || null;
}

async function updateEvent({ appointment, settings, eventId }) {
  if (!eventId || !isConfigured(settings) || !settings.google_refresh_token) return null;
  const auth = createOAuthClient(settings);
  const calendar = google.calendar({ version: 'v3', auth });
  await calendar.events.update({
    calendarId: settings.google_calendar_id,
    eventId,
    requestBody: buildEventPayload({ appointment, settings }),
  });
  return eventId;
}

async function deleteEvent({ settings, eventId }) {
  if (!eventId || !isConfigured(settings) || !settings.google_refresh_token) return;
  const auth = createOAuthClient(settings);
  const calendar = google.calendar({ version: 'v3', auth });
  await calendar.events.delete({
    calendarId: settings.google_calendar_id,
    eventId,
  });
}

async function testConnection(settings) {
  if (!isConfigured(settings)) {
    return { connected: false, reason: 'Configuração incompleta.' };
  }
  if (!settings.google_refresh_token) {
    const auth = createOAuthClient(settings);
    const url = auth.generateAuthUrl({
      access_type: 'offline',
      scope: ['https://www.googleapis.com/auth/calendar'],
      prompt: 'consent',
    });
    return { connected: false, reason: 'Autorize a conta Google.', authUrl: url };
  }
  const auth = createOAuthClient(settings);
  const calendar = google.calendar({ version: 'v3', auth });
  await calendar.calendarList.list({ maxResults: 1 });
  return { connected: true };
}

async function exchangeCodeForToken(settings, code) {
  const auth = createOAuthClient(settings);
  const { tokens } = await auth.getToken(code);
  return tokens.refresh_token || null;
}

module.exports = {
  createEvent,
  updateEvent,
  deleteEvent,
  testConnection,
  exchangeCodeForToken,
};
