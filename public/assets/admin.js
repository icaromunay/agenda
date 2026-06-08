const state = {
  token: '',
  settings: null,
  appointments: [],
  dashboardAppointments: [],
  clients: [],
  clientDetails: {},
  modalAppointmentId: null,
  modalClientId: null,
  filters: { preset: '', status: '', payment: '' },
};

const viewMeta = {
  dashboard: ['Dashboard', 'Visão geral do sistema'],
  appointments: ['Agendamentos', 'Pesquisa, filtros e confirmação'],
  clients: ['Clientes', 'CRM premium e relacionamento'],
  services: ['Serviços', 'CRUD completo'],
  blocks: ['Bloqueios', 'Datas e horários indisponíveis'],
  reports: ['Relatórios', 'Resumo comercial e operacional'],
  settings: ['Configurações', 'Google Agenda, WhatsApp, horários e personalização'],
  security: ['Segurança', 'Senha administrativa e proteção'],
};

const $ = (id) => document.getElementById(id);
const authHeaders = (extra = {}) => ({ Authorization: `Bearer ${state.token}`, 'Content-Type': 'application/json', ...extra });
const money = (value) => Number(value || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const esc = (value) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

async function api(url, options = {}) {
  const res = await fetch(url, { ...options, headers: options.headers || authHeaders() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.friendlyError || data.error || 'Erro na operação.');
  return data;
}

async function apiBlob(url, filenameBase = 'download') {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${state.token}` } });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'Falha ao gerar arquivo.');
  }
  const blob = await res.blob();
  const disposition = res.headers.get('content-disposition') || '';
  const match = disposition.match(/filename="?([^";]+)"?/i);
  const filename = match?.[1] || filenameBase;
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = objectUrl;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(objectUrl);
}

const MONTHS_FULL = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const WEEKDAY_NAMES = ['Domingo', 'Segunda-feira', 'Terça-feira', 'Quarta-feira', 'Quinta-feira', 'Sexta-feira', 'Sábado'];
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

function normalizeTimeValue(value, fallback = '09:00') {
  const match = String(value || '').trim().match(/^(\d{2}):(\d{2})$/);
  if (!match) return fallback;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return fallback;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function normalizeRanges(ranges = []) {
  const normalized = [];
  for (const range of Array.isArray(ranges) ? ranges : []) {
    const start = normalizeTimeValue(range?.start, '09:00');
    const end = normalizeTimeValue(range?.end, '21:00');
    if (timeToMinutes(start) >= timeToMinutes(end)) continue;
    const key = `${start}-${end}`;
    if (!normalized.some((item) => `${item.start}-${item.end}` === key)) {
      normalized.push({ start, end });
    }
  }
  return normalized.sort((a, b) => timeToMinutes(a.start) - timeToMinutes(b.start));
}

function normalizeWeeklySchedule(schedule, settings = {}) {
  const fallbackAllowed = Array.isArray(settings.allowed_weekdays) ? settings.allowed_weekdays : [1, 2, 3, 4, 5];
  const fallbackStart = normalizeTimeValue(settings.work_start, '09:00');
  const fallbackEnd = normalizeTimeValue(settings.work_end, '21:00');
  const source = schedule && typeof schedule === 'object' ? schedule : {};
  const normalized = cloneDefaultWeeklySchedule();
  for (let day = 0; day < 7; day += 1) {
    const key = String(day);
    const rawDay = source[key] ?? source[day] ?? null;
    const ranges = normalizeRanges(Array.isArray(rawDay?.ranges) ? rawDay.ranges : (fallbackAllowed.includes(day) ? [{ start: fallbackStart, end: fallbackEnd }] : []));
    const enabled = typeof rawDay?.enabled === 'boolean' ? rawDay.enabled : fallbackAllowed.includes(day);
    normalized[key] = { enabled: Boolean(enabled), ranges };
  }
  return normalized;
}

function buildRangeRow(day, range = { start: '09:00', end: '18:00' }) {
  return `
    <div class="range-row" data-range-row>
      <input type="time" class="range-start" data-day="${day}" value="${esc(normalizeTimeValue(range.start, '09:00'))}">
      <span>até</span>
      <input type="time" class="range-end" data-day="${day}" value="${esc(normalizeTimeValue(range.end, '18:00'))}">
      <button type="button" class="ghost-btn small" data-remove-range="${day}">Remover</button>
    </div>`;
}

function renderWeeklyScheduleEditor(schedule, settings = {}) {
  const container = $('weeklyScheduleEditor');
  if (!container) return;
  const normalized = normalizeWeeklySchedule(schedule, settings);
  container.innerHTML = WEEKDAY_NAMES.map((name, day) => {
    const key = String(day);
    const item = normalized[key];
    const ranges = item.ranges.length ? item.ranges : [];
    return `
      <div class="weekday-card ${item.enabled ? '' : 'disabled-day'}" data-weekday-card="${day}">
        <div class="weekday-top">
          <strong>${name}</strong>
          <label class="day-toggle"><input type="checkbox" class="weekday-enabled" data-day="${day}" ${item.enabled ? 'checked' : ''}> Ativo</label>
        </div>
        <div class="ranges-list" data-ranges-list="${day}">
          ${ranges.map((range) => buildRangeRow(day, range)).join('') || '<div class="day-hint">Nenhum horário cadastrado.</div>'}
        </div>
        <div class="day-actions">
          <span class="day-hint">Adicione um ou mais períodos para este dia.</span>
          <button type="button" class="ghost-btn small add-range-btn" data-add-range="${day}">+ horário</button>
        </div>
      </div>`;
  }).join('');
}

function serializeWeeklySchedule() {
  const schedule = {};
  document.querySelectorAll('[data-weekday-card]').forEach((card) => {
    const day = String(card.dataset.weekdayCard);
    const enabled = card.querySelector('.weekday-enabled')?.checked || false;
    const ranges = normalizeRanges(Array.from(card.querySelectorAll('[data-range-row]')).map((row) => ({
      start: row.querySelector('.range-start')?.value || '09:00',
      end: row.querySelector('.range-end')?.value || '18:00',
    })));
    schedule[day] = { enabled, ranges };
  });
  return schedule;
}

function deriveLegacyScheduleFields(schedule) {
  const ranges = Object.values(schedule || {}).flatMap((day) => Array.isArray(day?.ranges) ? day.ranges : []);
  const allowed = Object.entries(schedule || {})
    .filter(([, day]) => day?.enabled && Array.isArray(day?.ranges) && day.ranges.length)
    .map(([day]) => Number(day));
  const starts = ranges.map((range) => timeToMinutes(range.start));
  const ends = ranges.map((range) => timeToMinutes(range.end));
  return {
    allowed_weekdays: allowed,
    work_start: starts.length ? minutesToTime(Math.min(...starts)) : '09:00',
    work_end: ends.length ? minutesToTime(Math.max(...ends)) : '21:00',
  };
}

function parseDateParts(value) {
  if (!value) return null;
  const raw = String(value).trim();
  const isoMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) {
    return { year: isoMatch[1], month: isoMatch[2], day: isoMatch[3] };
  }
  const brMatch = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (brMatch) {
    return { year: brMatch[3], month: brMatch[2], day: brMatch[1] };
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  return {
    year: String(parsed.getUTCFullYear()),
    month: String(parsed.getUTCMonth() + 1).padStart(2, '0'),
    day: String(parsed.getUTCDate()).padStart(2, '0'),
  };
}

function fmtDate(date) {
  const parts = parseDateParts(date);
  if (!parts) return '-';
  return `${parts.day}/${parts.month}/${parts.year}`;
}
function fmtAppointmentDate(date) {
  const parts = parseDateParts(date);
  if (!parts) return '-';
  const monthName = MONTHS_FULL[Number(parts.month) - 1] || parts.month;
  return `${parts.day}/${monthName}/${parts.year}`;
}
function toDateInputValue(date) {
  const parts = parseDateParts(date);
  if (!parts) return '';
  return `${parts.year}-${parts.month}-${parts.day}`;
}
function fmtDateTime(value) {
  if (!value) return '-';
  return new Date(value).toLocaleString('pt-BR');
}
function fmtTime(min) {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}
function timeToMinutes(value) {
  const [h, m] = String(value || '00:00').split(':').map(Number);
  return (h * 60) + m;
}
function minutesToTime(min) {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}
function fmtRange(item) {
  return `${fmtTime(item.start_minutes)} às ${fmtTime(item.end_minutes)}`;
}
function digitsOnly(value) {
  return String(value || '').replace(/\D/g, '');
}
function waLink(phone) {
  const digits = digitsOnly(phone);
  return digits ? `https://wa.me/${digits}` : '#';
}
function googleSyncLabel(item = {}) {
  if (item.google_sync_error) return `Erro Google: ${item.google_sync_error}`;
  if (item.google_event_id) return 'Google sincronizado';
  return 'Google não sincronizado';
}
function badge(status) {
  const css = String(status || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return `<span class="badge ${css}">${esc(status || '-')}</span>`;
}
function listOrEmpty(items, empty = 'Nenhum registro encontrado.') {
  return items.length ? `<div class="list">${items.join('')}</div>` : `<div class="item client-empty">${esc(empty)}</div>`;
}
function googleBadge(connected) {
  return connected ? '🟢 Google Conectado' : '🔴 Desconectado';
}
function qsParam(name) {
  return new URLSearchParams(window.location.search).get(name);
}
function debounce(fn, wait = 300) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

function buildSettingsBody() {
  const f = $('settingsForm');
  const weeklySchedule = serializeWeeklySchedule();
  const legacy = deriveLegacyScheduleFields(weeklySchedule);
  return {
    brand_name: f.brand_name.value,
    title: f.title.value,
    subtitle: f.subtitle.value,
    public_section_title_1: f.public_section_title_1.value,
    public_section_title_2: f.public_section_title_2.value,
    public_section_title_3: f.public_section_title_3.value,
    public_section_title_4: f.public_section_title_4.value,
    public_step_badge_1: f.public_step_badge_1.value,
    public_step_label_1: f.public_step_label_1.value,
    public_step_badge_2: f.public_step_badge_2.value,
    public_step_label_2: f.public_step_label_2.value,
    public_step_badge_3: f.public_step_badge_3.value,
    public_step_label_3: f.public_step_label_3.value,
    public_step_badge_4: f.public_step_badge_4.value,
    public_step_label_4: f.public_step_label_4.value,
    therapist_name: f.therapist_name.value,
    therapist_whatsapp: f.therapist_whatsapp.value,
    notifications_whatsapp: f.notifications_whatsapp.value,
    footer_link: f.footer_link.value,
    logo_url: f.logo_url.value,
    google_email: f.google_email.value,
    google_calendar_id: f.google_calendar_id.value,
    google_alerts_calendar_id: state.settings?.google_alerts_calendar_id || '',
    google_client_id: f.google_client_id.value,
    google_client_secret: f.google_client_secret.value,
    google_redirect_uri: f.google_redirect_uri.value,
    google_refresh_token: f.google_refresh_token.value,
    database_url: f.database_url.value,
    work_start: legacy.work_start,
    work_end: legacy.work_end,
    slot_interval: Number(f.slot_interval.value),
    confirmation_message: f.confirmation_message.value,
    reminder_message: f.reminder_message.value,
    notification_immediate: f.notification_immediate.checked,
    notification_24h: f.notification_24h.checked,
    notification_1h: f.notification_1h.checked,
    notification_15m: f.notification_15m.checked,
    notify_email: f.notify_email.checked,
    notify_push: f.notify_push.checked,
    allowed_weekdays: legacy.allowed_weekdays,
    weekly_schedule: weeklySchedule,
    vacations: Array.isArray(state.settings?.vacations) ? state.settings.vacations : [],
    holidays: Array.isArray(state.settings?.holidays) ? state.settings.holidays : [],
  };
}

function renderGoogleStatus(settings, status = null) {
  const connected = status?.connected ?? settings?.google_connected ?? false;
  const lastSync = status?.lastSyncAt ?? settings?.last_google_sync_at ?? null;
  const email = status?.email ?? settings?.google_email ?? '-';
  const calendarId = status?.calendarId ?? settings?.google_calendar_id ?? '-';
  const alertsCalendarId = status?.alertsCalendarId ?? settings?.google_alerts_calendar_id ?? '-';
  const lastError = status?.lastError ?? settings?.google_last_error ?? 'Nenhum erro registrado.';
  $('settingsStatus').innerHTML = `<strong>${googleBadge(connected)}</strong>\nEmail: ${esc(email || '-')}\nCalendar ID principal: ${esc(calendarId || '-')}\nCalendar ID alertas: ${esc(alertsCalendarId || '-')}\nÚltima sincronização: ${lastSync ? fmtDateTime(lastSync) : 'Nunca'}\nÚltimo erro: ${esc(lastError || 'Nenhum erro registrado.')}`;
}

function renderGoogleDebug(debug = {}) {
  $('googleDebugBox').innerHTML = `<strong>Diagnóstico Google</strong>\nRefresh token: ${debug.hasRefreshToken ? 'Sim' : 'Não'}\nAccess token ativo: ${debug.hasAccessToken ? 'Sim' : 'Não'}\nCalendar ID: ${esc(debug.calendarId || '-')}\nÚltima sincronização: ${debug.lastSyncAt ? fmtDateTime(debug.lastSyncAt) : 'Nunca'}\nÚltimo erro: ${esc(debug.lastError || 'Nenhum')}`;
}

async function login() {
  try {
    const result = await fetch('/api/admin/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: $('loginPassword').value }),
    });
    const data = await result.json();
    if (!result.ok) throw new Error(data.error || 'Falha no login.');
    state.token = data.token;
    $('loginScreen').classList.add('hidden');
    $('appShell').classList.remove('hidden');
    attachNavigation();
    setupQuickTimes();
    attachClientFilters();
    await loadCurrentView();
    if (qsParam('google') === 'connected') alert('Google conectado com sucesso.');
    if (qsParam('google') === 'error') alert('Falha ao concluir a conexão com o Google.');
    if (qsParam('google') === 'missing-config') alert('Preencha as credenciais Google antes de conectar.');
  } catch (error) {
    $('loginError').textContent = error.message;
  }
}

function attachNavigation() {
  document.querySelectorAll('.nav-btn').forEach((btn) => {
    btn.onclick = () => showView(btn.dataset.view);
  });
}

function showView(view) {
  document.querySelectorAll('.nav-btn').forEach((btn) => btn.classList.toggle('active', btn.dataset.view === view));
  document.querySelectorAll('.view').forEach((section) => section.classList.toggle('active', section.id === `view-${view}`));
  $('viewTitle').textContent = viewMeta[view][0];
  $('viewSubtitle').textContent = viewMeta[view][1];
  loadCurrentView(view).catch((error) => alert(error.message));
}

function renderAppointmentCard(item, source = 'appointments') {
  return `
    <div class="item appointment-card" data-appointment-id="${esc(item.id)}" data-source="${esc(source)}">
      <div class="item-top">
        <div>
          <div class="appointment-name">${esc(item.client_name)}</div>
          <div class="meta">
            <strong>${esc(item.service_name)}</strong><br>
            <div class="appointment-datetime-line">
              <span class="appointment-date">${esc(fmtAppointmentDate(item.appointment_date))}</span>
              <span class="appointment-separator">•</span>
              <span class="appointment-time">${esc(fmtRange(item))}</span>
            </div>
            ${esc(item.client_whatsapp || '-')}<br>
            Google Event ID: ${esc(item.google_event_id || 'não sincronizado')}<br>
            Alerta 3h ID: ${esc(item.google_alert_3h_event_id || 'não sincronizado')}<br>
            Alerta 1h ID: ${esc(item.google_alert_1h_event_id || 'não sincronizado')}<br>
            ${esc(googleSyncLabel(item))}
          </div>
        </div>
        ${badge(item.status)}
      </div>
      <div class="actions">
        <button class="list-btn ok" data-action="confirm" data-id="${esc(item.id)}">Confirmar atendimento</button>
        <button class="list-btn" data-action="edit" data-id="${esc(item.id)}">Editar / reagendar</button>
        <button class="list-btn" data-action="whatsapp" data-id="${esc(item.id)}">Abrir WhatsApp</button>
        <button class="list-btn danger" data-action="delete" data-id="${esc(item.id)}">Excluir</button>
      </div>
    </div>`;
}

function renderClientStats(items = []) {
  const total = items.length;
  const ativos = items.filter((item) => item.status === 'Ativo').length;
  const sem30 = items.filter((item) => item.status === 'Sem retorno há 30 dias').length;
  const sem90 = items.filter((item) => item.status === 'Sem retorno há 90 dias').length;
  const faturamento = items.reduce((sum, item) => sum + Number(item.total_invested || 0), 0);
  $('clientsStats').innerHTML = [
    ['Total de clientes', total],
    ['Clientes ativos', ativos],
    ['Sem retorno há 30 dias', sem30],
    ['Sem retorno há 90 dias', sem90],
    ['Faturamento acumulado', money(faturamento)],
  ].map(([label, value]) => `<div class="card premium-card"><strong>${esc(value)}</strong><span>${esc(label)}</span></div>`).join('');
}

function renderClientCard(item) {
  const services = item.services || 'Nenhum serviço associado';
  return `
    <div class="item client-card" data-client-id="${esc(item.id)}">
      <div class="item-top">
        <div class="client-main">
          <h4>${esc(item.name)}</h4>
          <div class="client-secondary">${esc(item.whatsapp || '-')} · ${esc(item.email || 'Sem e-mail cadastrado')}</div>
          <div class="meta">
            ${badge(item.status)}
            <div class="client-services"><strong>Serviços:</strong> ${esc(services)}</div>
          </div>
        </div>
      </div>
      <div class="metrics-grid">
        <div class="metric-box"><span>Atendimentos</span><strong>${esc(item.total_appointments || 0)}</strong></div>
        <div class="metric-box"><span>Primeiro atendimento</span><strong class="metric-date">${esc(fmtAppointmentDate(item.first_appointment))}</strong></div>
        <div class="metric-box"><span>Último atendimento</span><strong class="metric-date">${esc(fmtAppointmentDate(item.last_appointment))}</strong></div>
        <div class="metric-box"><span>Valor total investido</span><strong>${esc(money(item.total_invested || 0))}</strong></div>
      </div>
      <div class="actions">
        <button class="list-btn" data-client-action="history" data-id="${esc(item.id)}">Ver histórico</button>
        <button class="list-btn" data-client-action="edit" data-id="${esc(item.id)}">Editar</button>
        <button class="list-btn" data-client-action="whatsapp" data-id="${esc(item.id)}">Abrir WhatsApp</button>
        <button class="list-btn danger" data-client-action="delete" data-id="${esc(item.id)}">Excluir Cliente</button>
      </div>
    </div>`;
}

function renderHistoryEntries(detail = {}) {
  const appointments = detail.appointments || [];
  const logs = detail.logs || [];
  const appointmentEntries = appointments.map((item) => `
    <div class="history-item">
      <strong>${esc(item.service_name || 'Serviço')}</strong>
      <div class="appointment-datetime-line history-datetime-line">
        <span class="appointment-date">${esc(fmtAppointmentDate(item.appointment_date))}</span>
        <span class="appointment-separator">•</span>
        <span class="appointment-time">${esc(fmtTime(item.start_minutes))} às ${esc(fmtTime(item.end_minutes))}</span>
      </div>
      <span>${esc(item.status || '-')} · ${esc(item.payment_label || '-')}</span>
      <small>Google: ${esc(item.google_event_id || 'não sincronizado')}</small>
    </div>`);
  const logEntries = logs.map((item) => `
    <div class="history-item">
      <strong>Log: ${esc(item.action || item.context || 'Registro')}</strong>
      <small>${esc(fmtDateTime(item.created_at))}</small>
    </div>`);
  return listOrEmpty([...appointmentEntries, ...logEntries], 'Nenhum histórico encontrado para este cliente.');
}

function fillClientModal(detail) {
  state.clientDetails[detail.id] = detail;
  state.modalClientId = detail.id;
  $('clientModal').classList.remove('hidden');
  $('clientModalTitle').textContent = detail.name || 'Cliente';
  $('clientModalSubtitle').textContent = `${detail.whatsapp || '-'} · ${detail.email || 'Sem e-mail'}`;
  $('clientModalStats').innerHTML = [
    ['Atendimentos', detail.total_appointments || 0, ''],
    ['Primeiro atendimento', fmtAppointmentDate(detail.first_appointment), 'metric-date'],
    ['Último atendimento', fmtAppointmentDate(detail.last_appointment), 'metric-date'],
    ['Investimento', money(detail.total_invested || 0), ''],
  ].map(([label, value, cssClass]) => `<div class="metric-box"><span>${esc(label)}</span><strong class="${esc(cssClass || '')}">${esc(value)}</strong></div>`).join('');
  const form = $('clientEditForm');
  form.elements.name.value = detail.name || '';
  form.elements.whatsapp.value = detail.whatsapp || '';
  form.elements.email.value = detail.email || '';
  form.elements.notes.value = detail.notes || '';
  $('clientHistoryList').innerHTML = renderHistoryEntries(detail);
  $('clientModalStatus').textContent = `Registros vinculados: ${detail.linked_summary?.total_linked || 0}`;
}

async function loadDashboard() {
  const data = await api('/api/admin/dashboard');
  state.dashboardAppointments = data.calendar || [];
  $('dashboardCards').innerHTML = [
    ['Agendamentos de hoje', data.today],
    ['Próximos atendimentos', data.upcoming],
    ['Pendentes', data.pending],
    ['Confirmados', data.confirmed],
    ['Faturamento previsto', money(data.forecastRevenue || 0)],
    ['Faturamento confirmado', money(data.confirmedRevenue || 0)],
  ].map((card) => `<div class="card premium-card"><strong>${esc(card[1])}</strong><span>${esc(card[0])}</span></div>`).join('');
  $('dashboardCalendar').innerHTML = listOrEmpty((data.calendar || []).map((item) => renderAppointmentCard(item, 'dashboard')), 'Sem próximos atendimentos.');
  $('dashboardServices').innerHTML = listOrEmpty((data.topServices || []).map((item) => `<div class="item"><strong>${esc(item.service_name)}</strong><div class="meta">${esc(item.total)} venda(s)</div></div>`), 'Sem dados suficientes.');
}

async function loadAppointments() {
  const search = encodeURIComponent($('appointmentSearch').value || '');
  const status = encodeURIComponent(state.filters.status || $('appointmentStatus').value || '');
  const preset = encodeURIComponent(state.filters.preset || '');
  const payment = encodeURIComponent(state.filters.payment || $('appointmentPaymentFilter').value || '');
  const data = await api(`/api/admin/appointments?search=${search}&status=${status}&preset=${preset}&payment=${payment}`);
  state.appointments = data;
  $('appointmentsList').innerHTML = listOrEmpty(data.map((item) => renderAppointmentCard(item)), 'Nenhum agendamento encontrado com os filtros atuais.');
}

function getClientFilterParams() {
  const params = new URLSearchParams();
  const map = {
    name: $('clientSearchName')?.value || '',
    whatsapp: $('clientSearchWhatsapp')?.value || '',
    email: $('clientSearchEmail')?.value || '',
    service: $('clientSearchService')?.value || '',
    startDate: $('clientStartDate')?.value || '',
    endDate: $('clientEndDate')?.value || '',
  };
  Object.entries(map).forEach(([key, value]) => {
    if (String(value).trim()) params.set(key, value.trim());
  });
  return params;
}

async function loadClients() {
  const params = getClientFilterParams();
  const payload = await api(`/api/admin/clients${params.toString() ? `?${params.toString()}` : ''}`);
  const items = Array.isArray(payload) ? payload : (payload.items || []);
  state.clients = items;
  renderClientStats(items);
  $('clientsList').innerHTML = listOrEmpty(items.map((item) => renderClientCard(item)), 'Nenhum cliente encontrado com os filtros atuais.');
}

async function loadServices() {
  const data = await api('/api/admin/services');
  $('servicesList').innerHTML = listOrEmpty(data.map((item) => `
    <div class="item">
      <div class="item-top">
        <div>
          <h4>${esc(item.name)}</h4>
          <div class="meta">${esc(item.description)}<br><strong>Turno:</strong> ${esc(item.shift_label || 'DIURNO')} · <strong>Duração:</strong> ${esc(item.duration_minutes)} min<br>PIX ${esc(money(item.price_pix))} · Cartão ${esc(money(item.price_card))} · ${esc(item.price_installment)}<br>Faixa: ${esc(item.min_hour)} até ${esc(item.max_hour)}</div>
        </div>
        ${badge(item.active ? 'confirmado' : 'cancelado')}
      </div>
      <div class="actions">
        <button class="list-btn" data-service='${encodeURIComponent(JSON.stringify(item))}'>Editar</button>
        <button class="list-btn danger" data-delete-service="${esc(item.id)}">Excluir</button>
      </div>
    </div>`));
}

async function loadBlocks() {
  const data = await api('/api/admin/blocks');
  $('blocksList').innerHTML = listOrEmpty(data.map((item) => `
    <div class="item">
      <h4>${esc(fmtAppointmentDate(item.block_date))}</h4>
      <div class="meta"><strong>${esc(fmtTime(item.start_minutes))} às ${esc(fmtTime(item.end_minutes))}</strong><br>${esc(item.reason)}</div>
      <div class="actions"><button class="list-btn danger" data-delete-block="${esc(item.id)}">Excluir</button></div>
    </div>`));
}

async function loadReports() {
  const params = [];
  if ($('reportStart').value) params.push(`startDate=${$('reportStart').value}`);
  if ($('reportEnd').value) params.push(`endDate=${$('reportEnd').value}`);
  const data = await api(`/api/admin/reports${params.length ? `?${params.join('&')}` : ''}`);
  $('reportStatus').innerHTML = listOrEmpty((data.byStatus || []).map((item) => `<div class="item"><strong>${esc(item.status)}</strong><div class="meta">${esc(item.total)} registro(s)</div></div>`));
  $('reportServices').innerHTML = listOrEmpty((data.byService || []).map((item) => `<div class="item"><strong>${esc(item.name)}</strong><div class="meta">${esc(item.total)} venda(s)</div></div>`));
}

async function loadSettings() {
  const [settings, status, debug] = await Promise.all([
    api('/api/admin/settings'),
    api('/api/google/status').catch(() => ({ connected: false })),
    api('/api/google/debug').catch(() => ({ connected: false })),
  ]);
  state.settings = settings;
  const form = $('settingsForm');
  Object.entries(settings).forEach(([key, value]) => {
    if (form.elements[key]) {
      if (form.elements[key].type === 'checkbox') form.elements[key].checked = Boolean(value);
      else if (typeof value !== 'object') form.elements[key].value = value ?? '';
    }
  });
  renderWeeklyScheduleEditor(settings.weekly_schedule, settings);
  renderGoogleStatus(settings, status);
  renderGoogleDebug(debug);
}

async function loadCurrentView(view = document.querySelector('.nav-btn.active')?.dataset.view || 'dashboard') {
  const handlers = { dashboard: loadDashboard, appointments: loadAppointments, clients: loadClients, services: loadServices, blocks: loadBlocks, reports: loadReports, settings: loadSettings, security: async () => {} };
  return handlers[view]();
}

function setupQuickTimes() {
  const container = $('quickTimeButtons');
  if (!container || container.dataset.ready) return;
  container.dataset.ready = '1';
  const times = ['08:00', '09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00', '18:00', '19:00', '20:00'];
  container.innerHTML = times.map((time) => `<button type="button" class="quick-time-btn" data-time="${time}">${time}</button>`).join('');
  container.addEventListener('click', (event) => {
    const button = event.target.closest('.quick-time-btn');
    if (!button) return;
    $('blockForm').elements.start_time.value = button.dataset.time;
    const nextHour = `${String(Math.min(Number(button.dataset.time.split(':')[0]) + 1, 23)).padStart(2, '0')}:00`;
    $('blockForm').elements.end_time.value = nextHour;
  });
}

function attachClientFilters() {
  const rerender = debounce(() => loadClients().catch((error) => alert(error.message)), 250);
  ['clientSearchName', 'clientSearchWhatsapp', 'clientSearchEmail', 'clientSearchService', 'clientStartDate', 'clientEndDate'].forEach((id) => {
    const el = $(id);
    if (!el || el.dataset.bound) return;
    el.dataset.bound = '1';
    el.addEventListener('input', rerender);
    el.addEventListener('change', rerender);
  });
}

function getAppointmentFromState(id) {
  return state.appointments.find((item) => item.id === id) || state.dashboardAppointments.find((item) => item.id === id) || null;
}
function getClientFromState(id) {
  return state.clients.find((item) => item.id === id) || state.clientDetails[id] || null;
}

async function openAppointmentModal(id) {
  const appointment = await api(`/api/admin/appointments/${id}`);
  state.modalAppointmentId = id;
  $('appointmentModal').classList.remove('hidden');
  $('modalTitle').textContent = appointment.client_name;
  $('modalSubtitle').textContent = `${appointment.service_name} · ${fmtAppointmentDate(appointment.appointment_date)} · ${fmtRange(appointment)}`;
  $('modalBody').innerHTML = `
    <div class="meta">
      <strong>WhatsApp:</strong> ${esc(appointment.client_whatsapp)}<br>
      <strong>Status:</strong> ${esc(appointment.status)}<br>
      <strong>Pagamento:</strong> ${esc(appointment.payment_label)}<br>
      <strong>Pago:</strong> ${appointment.payment_received ? 'Sim' : 'Não'}<br>
      <strong>Google Event ID:</strong> ${esc(appointment.google_event_id || 'não sincronizado')}<br>
      <strong>Google Alerta 3h:</strong> ${esc(appointment.google_alert_3h_event_id || 'não sincronizado')}<br>
      <strong>Google Alerta 1h:</strong> ${esc(appointment.google_alert_1h_event_id || 'não sincronizado')}<br>
      <strong>Status Google:</strong> ${esc(googleSyncLabel(appointment))}
    </div>`;
  const form = $('appointmentEditForm');
  form.elements.appointment_date.value = toDateInputValue(appointment.appointment_date);
  form.elements.start_time.value = minutesToTime(appointment.start_minutes);
  form.elements.status.value = appointment.status;
  form.elements.payment_method.value = appointment.payment_method;
  form.elements.payment_received.checked = Boolean(appointment.payment_received);
  form.elements.notes.value = appointment.notes || '';
  $('modalStatus').textContent = googleSyncLabel(appointment);
}

function closeAppointmentModal() {
  state.modalAppointmentId = null;
  $('appointmentModal').classList.add('hidden');
}
function closeClientModal() {
  state.modalClientId = null;
  $('clientModal').classList.add('hidden');
}

async function refreshAppointmentsViews() {
  if (document.querySelector('#view-dashboard.view.active')) await loadDashboard();
  if (document.querySelector('#view-appointments.view.active')) await loadAppointments();
}

async function confirmAppointment(id) {
  try {
    const result = await api(`/api/admin/appointments/${id}/confirm`, { method: 'POST' });
    if (result.whatsappUrl) window.open(result.whatsappUrl, '_blank');
    if (result.friendlyGoogleError) $('modalStatus').textContent = `Atenção: ${result.friendlyGoogleError}`;
    await refreshAppointmentsViews();
    await loadSettings().catch(() => null);
    alert(result.friendlyGoogleError ? `Atendimento confirmado, porém Google retornou: ${result.friendlyGoogleError}` : 'Atendimento confirmado e WhatsApp aberto.');
  } catch (error) {
    alert(error.message);
  }
}

async function deleteAppointment(id) {
  if (!confirm('Excluir este agendamento?')) return;
  try {
    const result = await api(`/api/admin/appointments/${id}`, { method: 'DELETE' });
    await refreshAppointmentsViews();
    if (result.friendlyGoogleError) alert(`Agendamento excluído, porém o Google retornou: ${result.friendlyGoogleError}`);
    closeAppointmentModal();
  } catch (error) {
    alert(error.message || 'Falha ao excluir o agendamento.');
  }
}

function populateServiceForm(item) {
  const form = $('serviceForm');
  Object.entries(item).forEach(([key, value]) => {
    if (form.elements[key]) {
      if (form.elements[key].type === 'checkbox') form.elements[key].checked = Boolean(value);
      else form.elements[key].value = value ?? '';
    }
  });
  form.dataset.editId = item.id;
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function applyChipState(button) {
  document.querySelectorAll('#appointmentPresetFilters .chip').forEach((chip) => chip.classList.remove('active'));
  button.classList.add('active');
  state.filters.preset = button.dataset.preset || '';
  state.filters.status = button.dataset.status || '';
  state.filters.payment = button.dataset.payment || '';
  $('appointmentStatus').value = state.filters.status;
  $('appointmentPaymentFilter').value = state.filters.payment;
}

function showChoiceDialog({ title, message, actions = [] }) {
  return new Promise((resolve) => {
    $('choiceModalTitle').textContent = title || 'Confirmar ação';
    $('choiceModalMessage').innerHTML = String(message || '').replace(/\n/g, '<br>');
    $('choiceModalActions').innerHTML = actions.map((action) => `
      <button class="ghost-btn ${esc(action.className || '')}" data-choice-key="${esc(action.key)}">${esc(action.label)}</button>
    `).join('');
    $('choiceModal').classList.remove('hidden');
    const cleanup = () => {
      $('choiceModal').classList.add('hidden');
      $('choiceModalActions').innerHTML = '';
      $('choiceModal').onclick = null;
      $('choiceModalActions').onclick = null;
    };
    $('choiceModal').onclick = (event) => {
      if (event.target.id !== 'choiceModal') return;
      cleanup();
      resolve(null);
    };
    $('choiceModalActions').onclick = (event) => {
      const button = event.target.closest('[data-choice-key]');
      if (!button) return;
      const key = button.dataset.choiceKey;
      cleanup();
      resolve(key);
    };
  });
}

async function openClientModal(id) {
  const detail = await api(`/api/admin/clients/${id}/history`);
  fillClientModal(detail);
}

async function saveClient() {
  if (!state.modalClientId) return;
  const form = $('clientEditForm');
  const body = {
    name: form.elements.name.value,
    whatsapp: form.elements.whatsapp.value,
    email: form.elements.email.value,
    notes: form.elements.notes.value,
  };
  const result = await api(`/api/admin/clients/${state.modalClientId}`, { method: 'PUT', body: JSON.stringify(body) });
  $('clientModalStatus').textContent = 'Cliente atualizado com sucesso.';
  state.clientDetails[state.modalClientId] = { ...(state.clientDetails[state.modalClientId] || {}), ...result };
  await loadClients();
  await openClientModal(state.modalClientId);
}

async function exportClients(format) {
  const params = getClientFilterParams();
  params.set('format', format);
  await apiBlob(`/api/admin/clients/export?${params.toString()}`, `clientes.${format === 'xlsx' ? 'xlsx' : 'csv'}`);
}

async function deleteClient(id) {
  const detail = state.clientDetails[id] || await api(`/api/admin/clients/${id}`);
  const firstChoice = await showChoiceDialog({
    title: 'Excluir cliente',
    message: 'Tem certeza que deseja excluir este cliente?\nEsta ação não poderá ser desfeita.',
    actions: [
      { key: 'continue', label: 'Continuar', className: 'danger' },
      { key: 'cancel', label: 'Cancelar' },
    ],
  });
  if (firstChoice !== 'continue') return;

  const linkedTotal = Number(detail.linked_summary?.total_linked || 0);
  let mode = 'cascade';
  if (linkedTotal > 0) {
    const action = await showChoiceDialog({
      title: 'Cliente com registros vinculados',
      message: 'Este cliente possui registros vinculados.\n\nDeseja:\n• Excluir apenas o cliente\n• Excluir cliente e todos os registros relacionados\n• Cancelar',
      actions: [
        { key: 'client-only', label: 'Excluir apenas o cliente' },
        { key: 'cascade', label: 'Excluir cliente e todos os registros relacionados', className: 'danger' },
        { key: 'cancel', label: 'Cancelar' },
      ],
    });
    if (!action || action === 'cancel') return;
    mode = action;
  }

  const result = await api(`/api/admin/clients/${id}?mode=${encodeURIComponent(mode)}`, { method: 'DELETE' });
  if (state.modalClientId === id) closeClientModal();
  await loadClients();
  alert(result.message || 'Cliente excluído com sucesso.');
}

$('loginButton').onclick = login;
$('loginPassword').addEventListener('keydown', (e) => { if (e.key === 'Enter') login(); });
$('refreshButton').onclick = () => loadCurrentView().catch((error) => alert(error.message));
$('loadAppointmentsButton').onclick = () => loadAppointments().catch((error) => alert(error.message));
$('loadReportsButton').onclick = () => loadReports().catch((error) => alert(error.message));
$('appointmentSearch').addEventListener('input', debounce(() => loadAppointments().catch(() => null), 250));
$('appointmentStatus').addEventListener('change', () => { state.filters.status = $('appointmentStatus').value; loadAppointments().catch(() => null); });
$('appointmentPaymentFilter').addEventListener('change', () => { state.filters.payment = $('appointmentPaymentFilter').value; loadAppointments().catch(() => null); });
$('appointmentPresetFilters').addEventListener('click', (event) => {
  const button = event.target.closest('.chip');
  if (!button) return;
  applyChipState(button);
  loadAppointments().catch((error) => alert(error.message));
});

$('clearClientFiltersButton').onclick = () => {
  ['clientSearchName', 'clientSearchWhatsapp', 'clientSearchEmail', 'clientSearchService', 'clientStartDate', 'clientEndDate'].forEach((id) => {
    if ($(id)) $(id).value = '';
  });
  loadClients().catch((error) => alert(error.message));
};
$('exportClientsCsvButton').onclick = () => exportClients('csv').catch((error) => alert(error.message));
$('exportClientsXlsxButton').onclick = () => exportClients('xlsx').catch((error) => alert(error.message));

$('appointmentsList').addEventListener('click', async (event) => {
  const actionButton = event.target.closest('[data-action]');
  const card = event.target.closest('[data-appointment-id]');
  if (actionButton) {
    const id = actionButton.dataset.id;
    if (actionButton.dataset.action === 'confirm') return confirmAppointment(id);
    if (actionButton.dataset.action === 'delete') return deleteAppointment(id);
    if (actionButton.dataset.action === 'edit') return openAppointmentModal(id);
    if (actionButton.dataset.action === 'whatsapp') {
      const item = getAppointmentFromState(id);
      if (item?.client_whatsapp) window.open(waLink(item.client_whatsapp), '_blank');
    }
    return;
  }
  if (card) await openAppointmentModal(card.dataset.appointmentId);
});

$('dashboardCalendar').addEventListener('click', async (event) => {
  const actionButton = event.target.closest('[data-action]');
  const card = event.target.closest('[data-appointment-id]');
  if (actionButton) {
    const id = actionButton.dataset.id;
    if (actionButton.dataset.action === 'confirm') return confirmAppointment(id);
    if (actionButton.dataset.action === 'delete') return deleteAppointment(id);
    if (actionButton.dataset.action === 'edit') return openAppointmentModal(id);
    if (actionButton.dataset.action === 'whatsapp') {
      const item = getAppointmentFromState(id);
      if (item?.client_whatsapp) window.open(waLink(item.client_whatsapp), '_blank');
    }
    return;
  }
  if (card) await openAppointmentModal(card.dataset.appointmentId);
});

$('clientsList').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-client-action]');
  if (!button) return;
  const id = button.dataset.id;
  if (button.dataset.clientAction === 'history' || button.dataset.clientAction === 'edit') return openClientModal(id);
  if (button.dataset.clientAction === 'whatsapp') {
    const client = getClientFromState(id);
    if (client?.whatsapp) window.open(waLink(client.whatsapp), '_blank');
    return;
  }
  if (button.dataset.clientAction === 'delete') return deleteClient(id).catch((error) => alert(error.message));
});

$('servicesList').addEventListener('click', async (event) => {
  const edit = event.target.closest('[data-service]');
  const del = event.target.closest('[data-delete-service]');
  if (edit) return populateServiceForm(JSON.parse(decodeURIComponent(edit.dataset.service)));
  if (del) {
    if (!confirm('Excluir este serviço?')) return;
    await api(`/api/admin/services/${del.dataset.deleteService}`, { method: 'DELETE' });
    await loadServices();
  }
});

$('blocksList').addEventListener('click', async (event) => {
  const del = event.target.closest('[data-delete-block]');
  if (!del) return;
  if (!confirm('Excluir este bloqueio?')) return;
  await api(`/api/admin/blocks/${del.dataset.deleteBlock}`, { method: 'DELETE' });
  await loadBlocks();
});

$('serviceForm').onsubmit = async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const body = Object.fromEntries(fd.entries());
  body.duration_minutes = Number(body.duration_minutes);
  body.price_pix = Number(body.price_pix);
  body.price_card = Number(body.price_card);
  body.sort_order = Number(body.sort_order);
  body.active = e.target.elements.active.checked;
  const editId = e.target.dataset.editId;
  if (editId) {
    await api(`/api/admin/services/${editId}`, { method: 'PUT', body: JSON.stringify(body) });
    delete e.target.dataset.editId;
  } else {
    await api('/api/admin/services', { method: 'POST', body: JSON.stringify(body) });
  }
  e.target.reset();
  e.target.elements.active.checked = true;
  await loadServices();
};

$('weeklyScheduleEditor').addEventListener('click', (event) => {
  const addButton = event.target.closest('[data-add-range]');
  if (addButton) {
    const day = String(addButton.dataset.addRange);
    const list = document.querySelector(`[data-ranges-list="${day}"]`);
    if (!list) return;
    const hint = list.querySelector('.day-hint');
    if (hint) hint.remove();
    list.insertAdjacentHTML('beforeend', buildRangeRow(day));
    const card = addButton.closest('[data-weekday-card]');
    const checkbox = card?.querySelector('.weekday-enabled');
    if (checkbox) checkbox.checked = true;
    card?.classList.remove('disabled-day');
    return;
  }
  const removeButton = event.target.closest('[data-remove-range]');
  if (removeButton) {
    const card = removeButton.closest('[data-weekday-card]');
    removeButton.closest('[data-range-row]')?.remove();
    const list = card?.querySelector('[data-ranges-list]');
    if (list && !list.querySelector('[data-range-row]')) {
      list.innerHTML = '<div class="day-hint">Nenhum horário cadastrado.</div>';
    }
  }
});

$('weeklyScheduleEditor').addEventListener('change', (event) => {
  const checkbox = event.target.closest('.weekday-enabled');
  if (!checkbox) return;
  checkbox.closest('[data-weekday-card]')?.classList.toggle('disabled-day', !checkbox.checked);
});

$('blockForm').onsubmit = async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const body = Object.fromEntries(fd.entries());
  body.repeat_count = Number(body.repeat_count || 1);
  const result = await api('/api/admin/blocks', { method: 'POST', body: JSON.stringify(body) });
  e.target.reset();
  e.target.elements.repeat_count.value = 1;
  alert(`${result.created.length} bloqueio(s) criado(s) com sucesso.`);
  await loadBlocks();
};

$('settingsForm').onsubmit = async (e) => {
  e.preventDefault();
  const result = await api('/api/admin/settings', { method: 'PUT', body: JSON.stringify(buildSettingsBody()) });
  state.settings = result;
  renderGoogleStatus(result);
  $('settingsStatus').innerHTML += `${result.requiresRestartForDatabaseChange ? '\nAlteração de banco salva. Reinicie a aplicação para assumir a nova conexão.' : ''}`;
};

$('connectGoogleButton').onclick = async () => {
  try {
    await api('/api/admin/settings', { method: 'PUT', body: JSON.stringify(buildSettingsBody()) });
    const result = await api('/api/google/connect-url', { method: 'POST' });
    window.location.href = result.url;
  } catch (error) {
    alert(error.message);
  }
};

$('disconnectGoogleButton').onclick = async () => {
  if (!confirm('Desconectar a conta Google atual?')) return;
  await api('/api/google/disconnect', { method: 'POST' });
  const settings = await api('/api/admin/settings');
  renderGoogleStatus(settings, { connected: false, lastError: null });
  renderGoogleDebug({ connected: false, hasRefreshToken: false, hasAccessToken: false, calendarId: null, lastSyncAt: null, lastError: null });
  alert('Google desconectado com sucesso.');
};

$('testGoogleButton').onclick = async () => {
  try {
    const result = await api('/api/google/test-create-event', { method: 'POST' });
    const debug = await api('/api/google/debug');
    const settings = await api('/api/admin/settings');
    renderGoogleStatus(settings, { connected: true, calendarId: debug.calendarId, lastSyncAt: debug.lastSyncAt, lastError: null });
    renderGoogleDebug(debug);
    alert(`Teste concluído com sucesso. Evento criado${result.created?.data?.id ? ` (${result.created.data.id})` : ''} e removido em seguida.`);
  } catch (error) {
    const debug = await api('/api/google/debug').catch(() => ({ lastError: error.message }));
    renderGoogleDebug(debug);
    alert(`Falha no teste Google: ${debug.lastError || error.message}`);
  }
};

$('passwordForm').onsubmit = async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const body = Object.fromEntries(fd.entries());
  await api('/api/admin/auth/change-password', { method: 'POST', body: JSON.stringify(body) });
  $('passwordStatus').className = 'status-box';
  $('passwordStatus').textContent = 'Senha alterada com sucesso.';
  e.target.reset();
};

$('closeModalButton').onclick = closeAppointmentModal;
$('appointmentModal').addEventListener('click', (event) => {
  if (event.target.id === 'appointmentModal') closeAppointmentModal();
});
$('appointmentEditForm').onsubmit = async (event) => {
  event.preventDefault();
  if (!state.modalAppointmentId) return;
  const form = event.target;
  const body = {
    appointment_date: form.elements.appointment_date.value,
    start_minutes: timeToMinutes(form.elements.start_time.value),
    status: form.elements.status.value,
    payment_method: form.elements.payment_method.value,
    payment_received: form.elements.payment_received.checked,
    notes: form.elements.notes.value,
  };
  const result = await api(`/api/admin/appointments/${state.modalAppointmentId}`, { method: 'PUT', body: JSON.stringify(body) });
  $('modalStatus').textContent = result.friendlyGoogleError ? `Atenção: ${result.friendlyGoogleError}` : 'Agendamento atualizado com sucesso.';
  await refreshAppointmentsViews();
  await openAppointmentModal(state.modalAppointmentId);
};
$('appointmentModal').addEventListener('click', async (event) => {
  const action = event.target.closest('[data-modal-action]');
  if (!action || !state.modalAppointmentId) return;
  if (action.dataset.modalAction === 'confirm') return confirmAppointment(state.modalAppointmentId);
  if (action.dataset.modalAction === 'done') {
    $('appointmentEditForm').elements.status.value = 'concluido';
    $('appointmentEditForm').requestSubmit();
    return;
  }
  if (action.dataset.modalAction === 'whatsapp') {
    const appointment = await api(`/api/admin/appointments/${state.modalAppointmentId}`);
    window.open(waLink(appointment.client_whatsapp), '_blank');
    return;
  }
  if (action.dataset.modalAction === 'delete') return deleteAppointment(state.modalAppointmentId);
});

$('closeClientModalButton').onclick = closeClientModal;
$('clientModal').addEventListener('click', (event) => {
  if (event.target.id === 'clientModal') closeClientModal();
});
$('clientEditForm').onsubmit = async (event) => {
  event.preventDefault();
  try {
    await saveClient();
  } catch (error) {
    $('clientModalStatus').textContent = error.message;
  }
};
$('clientHistoryRefreshButton').onclick = async () => {
  if (!state.modalClientId) return;
  try {
    await openClientModal(state.modalClientId);
  } catch (error) {
    $('clientModalStatus').textContent = error.message;
  }
};
$('clientModalWhatsappButton').onclick = () => {
  const client = getClientFromState(state.modalClientId);
  if (client?.whatsapp) window.open(waLink(client.whatsapp), '_blank');
};
$('clientModalDeleteButton').onclick = () => {
  if (!state.modalClientId) return;
  deleteClient(state.modalClientId).catch((error) => { $('clientModalStatus').textContent = error.message; });
};


(() => {
  const BLOCK_PRESETS_UI = Object.freeze({
    day_full: { label: '📅 Dia Inteiro', category: 'Dia Inteiro', reason: 'Bloqueio de dia inteiro', start: '08:00', end: '23:00' },
    morning: { label: '☀️ Manhã', category: 'Manhã', reason: 'Bloqueio manhã', start: '08:00', end: '12:00' },
    afternoon: { label: '🌤️ Tarde', category: 'Tarde', reason: 'Bloqueio tarde', start: '12:00', end: '18:00' },
    night: { label: '🌙 Noite', category: 'Noite', reason: 'Bloqueio noturno', start: '18:00', end: '23:00' },
    vacation: { label: '🏖️ Férias', category: 'Férias', reason: 'Férias', start: '08:00', end: '23:00' },
    holiday: { label: '🎉 Feriado', category: 'Feriado', reason: 'Feriado', start: '08:00', end: '23:00' },
    business_meeting: { label: '🏢 Reunião', category: 'Reunião Empresarial', reason: 'Reunião Empresarial', start: '14:00', end: '18:00' },
    displacement: { label: '🚗 Deslocamento', category: 'Deslocamento', reason: 'Deslocamento', start: '08:00', end: '10:00' },
  });

  const TURN_WINDOWS_UI = Object.freeze({
    DIURNO: { label: 'Diurno', start: '08:00', end: '18:00' },
    NOTURNO: { label: 'Noturno', start: '18:00', end: '23:00' },
    DIA_INTEIRO: { label: 'Dia Inteiro', start: '08:00', end: '23:00' },
  });

  const blockUiState = {
    year: new Date().getFullYear(),
    month: new Date().getMonth() + 1,
    items: [],
  };

  function ensureBlocksModuleLayout() {
    const view = $('view-blocks');
    if (!view || view.dataset.enhancedBlocks === '1') return;
    view.dataset.enhancedBlocks = '1';
    view.innerHTML = `
      <div class="blocks-layout">
        <div class="panel premium-card blocks-quick-panel">
          <div class="panel-head blocks-headline">
            <div>
              <h3>⚡ Bloqueio Rápido</h3>
              <span class="panel-tip">Presets prontos, bloqueio por turno, feriados, repetição avançada e bloqueio em massa.</span>
            </div>
          </div>
          <div class="preset-grid" id="blockPresetGrid"></div>
          <div class="turn-grid" id="blockTurnGrid"></div>
          <form id="blockForm" class="form-grid block-form-enhanced">
            <input name="quick_preset" type="hidden" value="">
            <input name="block_turn" type="hidden" value="">
            <label class="stacked-field">
              <span>Data inicial</span>
              <input name="date" type="date" required>
            </label>
            <label class="stacked-field">
              <span>Data final</span>
              <input name="end_date" type="date">
            </label>
            <label class="stacked-field">
              <span>Hora inicial</span>
              <input name="start_time" type="time" required>
            </label>
            <label class="stacked-field">
              <span>Hora final</span>
              <input name="end_time" type="time" required>
            </label>
            <label class="stacked-field">
              <span>Tipo</span>
              <select name="category">
                <option value="Bloqueio">Bloqueio</option>
                <option value="Dia Inteiro">Dia Inteiro</option>
                <option value="Manhã">Manhã</option>
                <option value="Tarde">Tarde</option>
                <option value="Noite">Noite</option>
                <option value="Férias">Férias</option>
                <option value="Feriado">Feriado</option>
                <option value="Reunião Empresarial">Reunião Empresarial</option>
                <option value="Deslocamento">Deslocamento</option>
              </select>
            </label>
            <label class="stacked-field">
              <span>Repetição</span>
              <select name="repeat_mode">
                <option value="none">Não repetir</option>
                <option value="daily">Todos os dias</option>
                <option value="weekdays">Segunda-Sexta</option>
                <option value="saturdays">Todos os sábados</option>
                <option value="sundays">Todos os domingos</option>
                <option value="weekly">Toda semana</option>
                <option value="monthly">Todo mês</option>
              </select>
            </label>
            <label class="stacked-field form-span">
              <span>Motivo</span>
              <input name="reason" placeholder="Ex.: reunião externa, feriado municipal, férias, indisponibilidade pessoal" required>
            </label>
            <label class="stacked-field form-span">
              <span>Repetir até</span>
              <input name="repeat_until" type="date">
            </label>
            <div class="form-span blocks-mass-wrap">
              <div class="panel-head compact-head">
                <div>
                  <strong>Bloqueio em massa por horário</strong>
                  <p class="panel-tip">Selecione vários horários com um clique para bloquear janelas múltiplas no mesmo dia.</p>
                </div>
                <label class="stacked-field small-field">
                  <span>Duração de cada bloco</span>
                  <select name="slot_minutes">
                    <option value="30">30 min</option>
                    <option value="60" selected>60 min</option>
                    <option value="90">90 min</option>
                    <option value="120">120 min</option>
                  </select>
                </label>
              </div>
              <div class="mass-slots-grid" id="massSlotsGrid"></div>
            </div>
            <div class="form-span form-actions-inline">
              <button type="submit" id="blockSubmitButton">Criar bloqueio</button>
              <button type="button" class="ghost-btn" id="blockCancelEditButton">Cancelar edição</button>
            </div>
          </form>
        </div>

        <div class="panel premium-card blocks-calendar-panel">
          <div class="panel-head blocks-headline">
            <div>
              <h3>Calendário mensal de bloqueios</h3>
              <span class="panel-tip">🟢 Livre · 🟡 Parcialmente ocupado · 🔴 Bloqueado</span>
            </div>
            <div class="calendar-nav-inline">
              <button type="button" class="ghost-btn small" id="blockCalendarPrev">‹</button>
              <strong id="blockCalendarLabel"></strong>
              <button type="button" class="ghost-btn small" id="blockCalendarNext">›</button>
            </div>
          </div>
          <div class="block-legend">
            <span class="legend-chip free">🟢 Livre</span>
            <span class="legend-chip partial">🟡 Parcialmente ocupado</span>
            <span class="legend-chip blocked">🔴 Bloqueado</span>
          </div>
          <div id="blockCalendarGrid" class="block-calendar-grid"></div>
        </div>

        <div class="panel premium-card blocks-list-panel">
          <div class="panel-head blocks-headline">
            <div>
              <h3>Bloqueios cadastrados</h3>
              <span class="panel-tip">Edite, exclua ou apague vários registros selecionados de uma vez.</span>
            </div>
            <div class="bulk-actions-inline">
              <button type="button" class="ghost-btn" id="blockDeleteSelectedButton">Excluir selecionados</button>
            </div>
          </div>
          <div class="blocks-table-head">
            <label class="select-all-wrap"><input type="checkbox" id="blocksSelectAll"> Todos</label>
            <span>Data</span>
            <span>Horário</span>
            <span>Tipo</span>
            <span>Motivo</span>
            <span>Repetição</span>
            <span>Ações</span>
          </div>
          <div id="blocksList" class="blocks-table-body"></div>
        </div>
      </div>`;
  }

  function renderPresetButtons() {
    const grid = $('blockPresetGrid');
    if (!grid) return;
    grid.innerHTML = Object.entries(BLOCK_PRESETS_UI).map(([key, item]) => `
      <button type="button" class="quick-preset-btn" data-preset-key="${key}">${item.label}</button>
    `).join('');
    const turnGrid = $('blockTurnGrid');
    if (turnGrid) {
      turnGrid.innerHTML = Object.entries(TURN_WINDOWS_UI).map(([key, item]) => `
        <button type="button" class="turn-preset-btn" data-turn-key="${key}">Bloqueio por Turno: ${item.label} (${item.start}–${item.end})</button>
      `).join('');
    }
  }

  function renderMassSlots() {
    const container = $('massSlotsGrid');
    if (!container) return;
    const slots = [];
    for (let hour = 8; hour <= 22; hour += 1) {
      slots.push(`${String(hour).padStart(2, '0')}:00`);
    }
    container.innerHTML = slots.map((time) => `<button type="button" class="mass-slot-chip" data-slot-time="${time}">${time}</button>`).join('');
  }

  function setActiveButtons(selector, value, attr) {
    document.querySelectorAll(selector).forEach((button) => {
      button.classList.toggle('active', button.dataset[attr] === value);
    });
  }

  function applyQuickPreset(key) {
    const preset = BLOCK_PRESETS_UI[key];
    const form = $('blockForm');
    if (!preset || !form) return;
    form.elements.quick_preset.value = key;
    form.elements.block_turn.value = '';
    form.elements.category.value = preset.category;
    form.elements.reason.value = preset.reason;
    form.elements.start_time.value = preset.start;
    form.elements.end_time.value = preset.end;
    if ((key === 'vacation' || key === 'holiday') && !form.elements.end_date.value) {
      form.elements.end_date.value = form.elements.date.value || '';
    }
    setActiveButtons('.quick-preset-btn', key, 'presetKey');
    setActiveButtons('.turn-preset-btn', '', 'turnKey');
  }

  function applyTurnPreset(key) {
    const turn = TURN_WINDOWS_UI[key];
    const form = $('blockForm');
    if (!turn || !form) return;
    form.elements.block_turn.value = key;
    form.elements.quick_preset.value = '';
    form.elements.start_time.value = turn.start;
    form.elements.end_time.value = turn.end;
    form.elements.category.value = key === 'DIURNO' ? 'Diurno' : key === 'NOTURNO' ? 'Noturno' : 'Dia Inteiro';
    form.elements.reason.value = `Bloqueio por turno ${turn.label.toLowerCase()}`;
    setActiveButtons('.turn-preset-btn', key, 'turnKey');
    setActiveButtons('.quick-preset-btn', '', 'presetKey');
  }

  function normalizeRepeatMode(mode) {
    const allowed = ['none', 'daily', 'weekdays', 'saturdays', 'sundays', 'weekly', 'monthly'];
    return allowed.includes(mode) ? mode : 'none';
  }

  function toggleMassSlot(button) {
    if (!button) return;
    button.classList.toggle('active');
  }

  function collectSelectedSlots() {
    return Array.from(document.querySelectorAll('.mass-slot-chip.active')).map((button) => button.dataset.slotTime);
  }

  function clearSelectedSlots() {
    document.querySelectorAll('.mass-slot-chip.active').forEach((button) => button.classList.remove('active'));
  }

  function resetBlockFormState() {
    const form = $('blockForm');
    if (!form) return;
    form.reset();
    form.dataset.editId = '';
    form.elements.quick_preset.value = '';
    form.elements.block_turn.value = '';
    form.elements.slot_minutes.value = '60';
    clearSelectedSlots();
    setActiveButtons('.quick-preset-btn', '', 'presetKey');
    setActiveButtons('.turn-preset-btn', '', 'turnKey');
    $('blockSubmitButton').textContent = 'Criar bloqueio';
  }

  function bodyFromBlockForm(form) {
    const body = {
      date: form.elements.date.value,
      end_date: form.elements.end_date.value || null,
      start_time: form.elements.start_time.value,
      end_time: form.elements.end_time.value,
      category: form.elements.category.value,
      reason: form.elements.reason.value,
      quick_preset: form.elements.quick_preset.value || null,
      block_turn: form.elements.block_turn.value || null,
      repeat_mode: normalizeRepeatMode(form.elements.repeat_mode.value || 'none'),
      repeat_until: form.elements.repeat_until.value || null,
      selected_slots: collectSelectedSlots(),
      slot_minutes: Number(form.elements.slot_minutes.value || 60),
    };
    if (body.selected_slots.length) {
      body.start_time = body.selected_slots[0];
      const startHour = Number(body.selected_slots[0].split(':')[0]);
      const endHour = Math.min(startHour + Math.max(1, Math.round(body.slot_minutes / 60)), 23);
      body.end_time = `${String(endHour).padStart(2, '0')}:00`;
    }
    return body;
  }

  function parseReasonText(item) {
    const text = item.display_reason || item.reason || '';
    const idx = text.indexOf(':');
    return idx >= 0 ? text.slice(idx + 1).trim() : text;
  }

  function fillBlockForm(item) {
    const form = $('blockForm');
    if (!form) return;
    form.dataset.editId = item.id;
    form.elements.date.value = toDateInputValue(item.block_date);
    form.elements.end_date.value = '';
    form.elements.start_time.value = minutesToTime(item.start_minutes);
    form.elements.end_time.value = minutesToTime(item.end_minutes);
    form.elements.category.value = item.category || 'Bloqueio';
    form.elements.reason.value = parseReasonText(item);
    form.elements.repeat_mode.value = normalizeRepeatMode(item.repeat_meta?.mode || 'none');
    form.elements.repeat_until.value = '';
    form.elements.quick_preset.value = '';
    form.elements.block_turn.value = '';
    clearSelectedSlots();
    setActiveButtons('.quick-preset-btn', '', 'presetKey');
    setActiveButtons('.turn-preset-btn', '', 'turnKey');
    $('blockSubmitButton').textContent = 'Salvar alterações';
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function blockCalendarMonthLabel() {
    return `${MONTHS_FULL[blockUiState.month - 1]} de ${blockUiState.year}`;
  }

  function renderBlockCalendar(calendar = {}) {
    const label = $('blockCalendarLabel');
    const grid = $('blockCalendarGrid');
    if (!label || !grid) return;
    label.textContent = blockCalendarMonthLabel();
    const first = new Date(blockUiState.year, blockUiState.month - 1, 1).getDay();
    const totalDays = new Date(blockUiState.year, blockUiState.month, 0).getDate();
    let html = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'].map((day) => `<div class="block-cal-dow">${day}</div>`).join('');
    for (let i = 0; i < first; i += 1) html += '<div class="block-cal-day empty"></div>';
    for (let day = 1; day <= totalDays; day += 1) {
      const date = `${blockUiState.year}-${String(blockUiState.month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const item = calendar[date] || { status: 'free', label: 'Livre', total: 0 };
      html += `
        <div class="block-cal-day ${item.status}">
          <strong>${day}</strong>
          <span>${item.label || 'Livre'}</span>
          <small>${item.total || 0} bloco(s)</small>
        </div>`;
    }
    grid.innerHTML = html;
  }

  async function loadBlockCalendar() {
    ensureBlocksModuleLayout();
    const data = await api(`/api/admin/blocks/calendar?year=${blockUiState.year}&month=${blockUiState.month}`);
    renderBlockCalendar(data.calendar || {});
  }

  function renderBlocksTable(items = []) {
    const container = $('blocksList');
    if (!container) return;
    if (!items.length) {
      container.innerHTML = '<div class="item client-empty">Nenhum bloqueio cadastrado.</div>';
      return;
    }
    container.innerHTML = items.map((item) => `
      <div class="blocks-row" data-block-id="${esc(item.id)}">
        <label class="row-check"><input type="checkbox" data-block-select="${esc(item.id)}"></label>
        <div>${esc(fmtAppointmentDate(item.block_date))}</div>
        <div>${esc(fmtTime(item.start_minutes))} às ${esc(fmtTime(item.end_minutes))}</div>
        <div>${esc(item.category || 'Bloqueio')}</div>
        <div>${esc(parseReasonText(item))}</div>
        <div>${esc(item.repeat_meta?.label || 'Não repetir')}</div>
        <div class="row-actions">
          <button type="button" class="list-btn" data-edit-block="${esc(item.id)}">✏️</button>
          <button type="button" class="list-btn danger" data-delete-block="${esc(item.id)}">🗑️</button>
        </div>
      </div>`).join('');
  }

  async function loadBlocks() {
    ensureBlocksModuleLayout();
    bindBlocksModule();
    const data = await api('/api/admin/blocks');
    blockUiState.items = Array.isArray(data) ? data : [];
    renderBlocksTable(blockUiState.items);
    await loadBlockCalendar();
  }

  async function deleteSelectedBlocks(ids) {
    if (!ids.length) return;
    if (!confirm(`Excluir ${ids.length} bloqueio(s) selecionado(s)?`)) return;
    await api('/api/admin/blocks/bulk-delete', { method: 'POST', body: JSON.stringify({ ids }) });
    await loadBlocks();
  }

  function selectedBlockIds() {
    return Array.from(document.querySelectorAll('[data-block-select]:checked')).map((input) => input.dataset.blockSelect);
  }

  function bindBlocksModule() {
    const view = $('view-blocks');
    if (!view || view.dataset.blocksBound === '1') return;
    view.dataset.blocksBound = '1';
    renderPresetButtons();
    renderMassSlots();

    $('blockPresetGrid').addEventListener('click', (event) => {
      const button = event.target.closest('[data-preset-key]');
      if (!button) return;
      applyQuickPreset(button.dataset.presetKey);
    });

    $('blockTurnGrid').addEventListener('click', (event) => {
      const button = event.target.closest('[data-turn-key]');
      if (!button) return;
      applyTurnPreset(button.dataset.turnKey);
    });

    $('massSlotsGrid').addEventListener('click', (event) => {
      const button = event.target.closest('[data-slot-time]');
      if (!button) return;
      toggleMassSlot(button);
    });

    $('blockCalendarPrev').onclick = () => {
      blockUiState.month -= 1;
      if (blockUiState.month < 1) {
        blockUiState.month = 12;
        blockUiState.year -= 1;
      }
      loadBlockCalendar().catch((error) => alert(error.message));
    };

    $('blockCalendarNext').onclick = () => {
      blockUiState.month += 1;
      if (blockUiState.month > 12) {
        blockUiState.month = 1;
        blockUiState.year += 1;
      }
      loadBlockCalendar().catch((error) => alert(error.message));
    };

    $('blockCancelEditButton').onclick = () => resetBlockFormState();

    $('blockDeleteSelectedButton').onclick = () => {
      deleteSelectedBlocks(selectedBlockIds()).catch((error) => alert(error.message));
    };

    $('blocksSelectAll').addEventListener('change', (event) => {
      document.querySelectorAll('[data-block-select]').forEach((input) => {
        input.checked = event.target.checked;
      });
    });

    $('blocksList').addEventListener('click', async (event) => {
      const editButton = event.target.closest('[data-edit-block]');
      if (editButton) {
        const item = blockUiState.items.find((entry) => entry.id === editButton.dataset.editBlock);
        if (item) fillBlockForm(item);
        return;
      }
      const deleteButton = event.target.closest('[data-delete-block]');
      if (deleteButton) {
        if (!confirm('Excluir este bloqueio?')) return;
        await api(`/api/admin/blocks/${deleteButton.dataset.deleteBlock}`, { method: 'DELETE' });
        await loadBlocks();
      }
    });

    $('blockForm').onsubmit = async (event) => {
      event.preventDefault();
      const form = event.target;
      const body = bodyFromBlockForm(form);
      const editId = form.dataset.editId;
      if (editId) {
        await api(`/api/admin/blocks/${editId}`, { method: 'PUT', body: JSON.stringify(body) });
      } else {
        const result = await api('/api/admin/blocks', { method: 'POST', body: JSON.stringify(body) });
        alert(`${result.created.length} bloqueio(s) criado(s) com sucesso.`);
      }
      resetBlockFormState();
      await loadBlocks();
    };
  }

  const originalSetupQuickTimes = setupQuickTimes;
  setupQuickTimes = function setupQuickTimesEnhanced() {
    if (typeof originalSetupQuickTimes === 'function') {
      try { originalSetupQuickTimes(); } catch (_error) {}
    }
    ensureBlocksModuleLayout();
    bindBlocksModule();
  };

  window.loadBlocks = loadBlocks;
})();

loadBlocks = window.loadBlocks;
