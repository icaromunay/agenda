const assert = require('assert');
const googleapisPath = require.resolve('googleapis');

class FakeOAuth2 {
  constructor() {
    this.credentials = {};
  }
  setCredentials(credentials) {
    this.credentials = credentials;
  }
  generateAuthUrl() { return 'https://accounts.google.com/mock'; }
  async getToken() { return { tokens: { access_token: 'access1234567890', refresh_token: 'refresh-token', expiry_date: 1234567890 } }; }
  async getAccessToken() { return { token: 'access1234567890' }; }
}

let mode = 'success';
let captured = [];

require.cache[googleapisPath] = {
  exports: {
    google: {
      auth: { OAuth2: FakeOAuth2 },
      oauth2: () => ({ userinfo: { get: async () => ({ data: { email: 'demo@example.com' } }) } }),
      calendar: () => ({
        calendarList: { list: async () => ({ data: { items: [{ primary: true, id: 'primary' }] } }) },
        events: {
          insert: async (payload) => {
            captured.push({ op: 'insert', payload });
            if (mode === 'missing-id') return { status: 200, data: {} };
            return { status: 200, statusText: 'OK', data: { id: 'evt_123', htmlLink: 'https://calendar.google.com/e/evt_123' } };
          },
          update: async (payload) => {
            captured.push({ op: 'update', payload });
            return { status: 200, statusText: 'OK', data: { id: payload.eventId, htmlLink: 'https://calendar.google.com/e/' + payload.eventId } };
          },
          delete: async (payload) => {
            captured.push({ op: 'delete', payload });
            return { status: 204, statusText: 'No Content', data: {} };
          },
        },
      }),
    },
  },
};

const service = require('./src/services/googleCalendarService');

const settings = {
  google_client_id: 'client',
  google_client_secret: 'secret',
  google_redirect_uri: 'http://localhost:3000/api/google/callback',
  google_refresh_token: 'refresh',
  google_calendar_id: 'primary',
  google_email: 'demo@example.com',
};

const appointment = {
  service_name: 'Constelação',
  client_name: 'Cliente Teste',
  client_whatsapp: '5547999999999',
  payment_label: 'PIX',
  notes: 'Observação de teste',
  start_iso: '2026-06-10T10:00:00-03:00',
  end_iso: '2026-06-10T11:00:00-03:00',
};

(async () => {
  const status = await service.getConnectionStatus(settings);
  assert.strictEqual(status.connected, true);
  assert.strictEqual(status.hasAccessToken, true);

  const created = await service.createCalendarEvent(settings, appointment);
  assert.strictEqual(created.data.id, 'evt_123');

  const updated = await service.updateCalendarEvent(settings, appointment, 'evt_123');
  assert.strictEqual(updated.data.id, 'evt_123');

  const deleted = await service.deleteCalendarEvent(settings, 'evt_123');
  assert.strictEqual(deleted.eventId, 'evt_123');

  const testEvent = await service.createTestEvent(settings);
  assert.strictEqual(testEvent.data.id, 'evt_123');

  mode = 'missing-id';
  let failed = false;
  try {
    await service.createCalendarEvent(settings, appointment);
  } catch (error) {
    failed = true;
    assert.ok(error.message.includes('ID'));
  }
  assert.strictEqual(failed, true);
  assert.deepStrictEqual(captured.map((item) => item.op), ['insert', 'update', 'delete', 'insert', 'insert']);
  console.log('OK: googleCalendarService tests passed');
})().catch((error) => {
  console.error('FAIL:', error);
  process.exit(1);
});
