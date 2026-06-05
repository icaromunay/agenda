CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS unaccent;


CREATE TABLE IF NOT EXISTS admin_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username TEXT NOT NULL UNIQUE DEFAULT 'admin',
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS app_settings (
  id INT PRIMARY KEY DEFAULT 1,
  brand_name TEXT NOT NULL DEFAULT 'Ícarõ Munay',
  title TEXT NOT NULL DEFAULT 'Agende sua sessão',
  subtitle TEXT NOT NULL DEFAULT 'Escolha o atendimento, horário e forma de pagamento',
  public_section_title_1 TEXT NOT NULL DEFAULT 'Escolha o serviço',
  public_section_title_2 TEXT NOT NULL DEFAULT 'Forma de pagamento',
  public_section_title_3 TEXT NOT NULL DEFAULT 'Escolha a data e o horário',
  public_section_title_4 TEXT NOT NULL DEFAULT 'Seus dados',
  public_step_badge_1 TEXT NOT NULL DEFAULT 'Passo 1',
  public_step_label_1 TEXT NOT NULL DEFAULT 'Serviço',
  public_step_badge_2 TEXT NOT NULL DEFAULT 'Passo 2',
  public_step_label_2 TEXT NOT NULL DEFAULT 'Pagamento',
  public_step_badge_3 TEXT NOT NULL DEFAULT 'Passo 3',
  public_step_label_3 TEXT NOT NULL DEFAULT 'Data & Horário',
  public_step_badge_4 TEXT NOT NULL DEFAULT 'Passo 4',
  public_step_label_4 TEXT NOT NULL DEFAULT 'Confirmação',
  therapist_name TEXT NOT NULL DEFAULT 'Ícarõ Munay',
  therapist_whatsapp TEXT NOT NULL DEFAULT '5547988006092',
  notifications_whatsapp TEXT NOT NULL DEFAULT '5547988006092',
  footer_link TEXT NOT NULL DEFAULT 'https://munay.com.br',
  logo_url TEXT,
  confirmation_message TEXT NOT NULL DEFAULT '🌟 Olá, {{nome}}!\n\nSeu atendimento foi confirmado com sucesso. ✅\n\n🌿 Serviço: {{servico}}\n📅 Data: {{data}}\n🕐 Horário: {{horario}}\n\n💬 Caso tenha dúvidas, estou à disposição.\n\n🙏 Ícarõ Munay\nTerapeuta Metafísico\n📲 WhatsApp: (47) 98800-6092',
  reminder_message TEXT NOT NULL DEFAULT '🌟 Olá, {{nome}}!\n\nLembrete do seu atendimento.\n\n🌿 Serviço: {{servico}}\n📅 Data: {{data}}\n🕐 Horário: {{horario}}\n\n💬 Em caso de dúvida, responda esta mensagem.',
  google_email TEXT,
  google_calendar_id TEXT,
  google_alerts_calendar_id TEXT,
  google_client_id TEXT,
  google_client_secret TEXT,
  google_redirect_uri TEXT,
  google_refresh_token TEXT,
  google_connected BOOLEAN NOT NULL DEFAULT FALSE,
  last_google_sync_at TIMESTAMPTZ,
  google_last_error TEXT,
  google_last_response JSONB NOT NULL DEFAULT '{}'::jsonb,
  notification_immediate BOOLEAN NOT NULL DEFAULT TRUE,
  notification_24h BOOLEAN NOT NULL DEFAULT TRUE,
  notification_1h BOOLEAN NOT NULL DEFAULT TRUE,
  notification_15m BOOLEAN NOT NULL DEFAULT FALSE,
  notify_email BOOLEAN NOT NULL DEFAULT FALSE,
  notify_push BOOLEAN NOT NULL DEFAULT FALSE,
  work_start TEXT NOT NULL DEFAULT '09:00',
  work_end TEXT NOT NULL DEFAULT '21:00',
  slot_interval INT NOT NULL DEFAULT 30,
  allowed_weekdays JSONB NOT NULL DEFAULT '[1,2,3,4,5]'::jsonb,
  weekly_schedule JSONB NOT NULL DEFAULT '{"0": {"enabled": false, "ranges": []}, "1": {"enabled": true, "ranges": [{"start": "09:00", "end": "21:00"}]}, "2": {"enabled": true, "ranges": [{"start": "09:00", "end": "21:00"}]}, "3": {"enabled": true, "ranges": [{"start": "09:00", "end": "21:00"}]}, "4": {"enabled": true, "ranges": [{"start": "09:00", "end": "21:00"}]}, "5": {"enabled": true, "ranges": [{"start": "09:00", "end": "21:00"}]}, "6": {"enabled": false, "ranges": []}}'::jsonb,
  vacations JSONB NOT NULL DEFAULT '[]'::jsonb,
  holidays JSONB NOT NULL DEFAULT '[]'::jsonb,
  database_url TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT app_settings_singleton CHECK (id = 1)
);

ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS public_section_title_1 TEXT NOT NULL DEFAULT 'Escolha o serviço';
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS public_section_title_2 TEXT NOT NULL DEFAULT 'Forma de pagamento';
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS public_section_title_3 TEXT NOT NULL DEFAULT 'Escolha a data e o horário';
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS public_section_title_4 TEXT NOT NULL DEFAULT 'Seus dados';
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS public_step_badge_1 TEXT NOT NULL DEFAULT 'Passo 1';
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS public_step_label_1 TEXT NOT NULL DEFAULT 'Serviço';
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS public_step_badge_2 TEXT NOT NULL DEFAULT 'Passo 2';
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS public_step_label_2 TEXT NOT NULL DEFAULT 'Pagamento';
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS public_step_badge_3 TEXT NOT NULL DEFAULT 'Passo 3';
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS public_step_label_3 TEXT NOT NULL DEFAULT 'Data & Horário';
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS public_step_badge_4 TEXT NOT NULL DEFAULT 'Passo 4';
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS public_step_label_4 TEXT NOT NULL DEFAULT 'Confirmação';
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS google_email TEXT;
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS google_calendar_id TEXT;
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS google_alerts_calendar_id TEXT;
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS google_client_id TEXT;
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS google_client_secret TEXT;
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS google_redirect_uri TEXT;
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS google_refresh_token TEXT;
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS google_connected BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS last_google_sync_at TIMESTAMPTZ;
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS google_last_error TEXT;
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS google_last_response JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS database_url TEXT;
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS weekly_schedule JSONB NOT NULL DEFAULT '{"0": {"enabled": false, "ranges": []}, "1": {"enabled": true, "ranges": [{"start": "09:00", "end": "21:00"}]}, "2": {"enabled": true, "ranges": [{"start": "09:00", "end": "21:00"}]}, "3": {"enabled": true, "ranges": [{"start": "09:00", "end": "21:00"}]}, "4": {"enabled": true, "ranges": [{"start": "09:00", "end": "21:00"}]}, "5": {"enabled": true, "ranges": [{"start": "09:00", "end": "21:00"}]}, "6": {"enabled": false, "ranges": []}}'::jsonb;

CREATE TABLE IF NOT EXISTS services (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  duration_minutes INT NOT NULL,
  price_pix NUMERIC(10,2) NOT NULL,
  price_card NUMERIC(10,2) NOT NULL,
  price_installment TEXT NOT NULL DEFAULT '',
  min_hour TEXT NOT NULL DEFAULT '09:00',
  max_hour TEXT NOT NULL DEFAULT '21:00',
  active BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS clients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  whatsapp TEXT NOT NULL,
  email TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS appointments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  service_id UUID NOT NULL REFERENCES services(id) ON DELETE RESTRICT,
  appointment_date DATE NOT NULL,
  start_minutes INT NOT NULL,
  end_minutes INT NOT NULL,
  payment_method TEXT NOT NULL,
  payment_label TEXT NOT NULL,
  payment_amount TEXT NOT NULL,
  payment_received BOOLEAN NOT NULL DEFAULT FALSE,
  status TEXT NOT NULL DEFAULT 'aguardando pagamento',
  notes TEXT,
  google_event_id TEXT,
  google_alert_3h_event_id TEXT,
  google_alert_1h_event_id TEXT,
  google_sync_status TEXT NOT NULL DEFAULT 'pendente',
  google_sync_error TEXT,
  google_error_details TEXT,
  google_payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  google_response_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  google_last_sync_at TIMESTAMPTZ,
  google_last_response JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  confirmed_at TIMESTAMPTZ,
  canceled_at TIMESTAMPTZ
);

ALTER TABLE appointments ADD COLUMN IF NOT EXISTS payment_received BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS google_event_id TEXT;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS google_alert_3h_event_id TEXT;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS google_alert_1h_event_id TEXT;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS notes TEXT;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS canceled_at TIMESTAMPTZ;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS google_sync_status TEXT NOT NULL DEFAULT 'pendente';
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS google_sync_error TEXT;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS google_error_details TEXT;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS google_payload_json JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS google_response_json JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS google_last_sync_at TIMESTAMPTZ;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS google_last_response JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS blocked_slots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  block_date DATE NOT NULL,
  start_minutes INT NOT NULL,
  end_minutes INT NOT NULL,
  reason TEXT NOT NULL DEFAULT 'Bloqueio manual',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS appointment_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id UUID REFERENCES appointments(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS logs_sistema (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  level TEXT NOT NULL DEFAULT 'info',
  context TEXT NOT NULL,
  message TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_appointments_date ON appointments(appointment_date);
CREATE INDEX IF NOT EXISTS idx_appointments_status ON appointments(status);
CREATE INDEX IF NOT EXISTS idx_appointments_payment_received ON appointments(payment_received);
CREATE INDEX IF NOT EXISTS idx_clients_whatsapp ON clients(whatsapp);
CREATE INDEX IF NOT EXISTS idx_clients_name_whatsapp ON clients((lower(name)), whatsapp);
CREATE INDEX IF NOT EXISTS idx_blocked_slots_date ON blocked_slots(block_date);
CREATE INDEX IF NOT EXISTS idx_logs_sistema_context ON logs_sistema(context);

CREATE INDEX IF NOT EXISTS idx_appointments_client_date ON appointments(client_id, appointment_date DESC);
CREATE INDEX IF NOT EXISTS idx_appointments_service_date ON appointments(service_id, appointment_date DESC);
CREATE INDEX IF NOT EXISTS idx_appointment_logs_appointment_id ON appointment_logs(appointment_id);
CREATE INDEX IF NOT EXISTS idx_clients_email ON clients(email);
