# Changelog — munay-agenda-pro 3.1.0

## 3.1.0

### CRM de Clientes
- Nova área de clientes com filtros por nome, WhatsApp, e-mail, serviço e período.
- Atualização em tempo real dos filtros no painel administrativo.
- Cards premium de clientes com:
  - nome
  - WhatsApp
  - e-mail
  - quantidade de atendimentos
  - primeiro atendimento
  - último atendimento
  - valor total investido
  - serviços realizados
- Modal completo de cliente com edição de cadastro e histórico consolidado.
- Botões por cliente:
  - Ver histórico
  - Editar
  - Abrir WhatsApp
  - Excluir Cliente
- Exclusão segura com dois modos:
  - excluir apenas o cliente, preservando vínculos em cliente técnico
  - excluir cliente e registros relacionados
- Novas rotas administrativas:
  - `GET /api/admin/clients`
  - `GET /api/admin/clients/export`
  - `GET /api/admin/clients/:id`
  - `GET /api/admin/clients/:id/history`
  - `PUT /api/admin/clients/:id`
  - `DELETE /api/admin/clients/:id`

### Exportação
- Exportação de clientes em CSV.
- Exportação de clientes em Excel (.xlsx).
- Inclusão dos campos:
  - Nome
  - WhatsApp
  - Email
  - Serviços contratados
  - Quantidade de atendimentos
  - Primeiro atendimento
  - Último atendimento
  - Status
- Inclusão da dependência `xlsx` no projeto.

### Visual premium global
- Padronização do painel administrativo com identidade visual premium baseada em:
  - fundo `#111827`
  - cards `#1F2937`
  - bordas douradas discretas
  - títulos `#F5D06F`
  - textos claros `#F9FAFB`
  - textos secundários `#D1D5DB`
- Aplicação do novo padrão em:
  - Dashboard
  - Clientes
  - Agendamentos
  - Serviços
  - Bloqueios
  - Relatórios
  - Configurações
  - Segurança
- Melhoria de responsividade para desktop, notebook, tablet e celular.

### Banco de dados e performance
- Novos índices adicionados na migration principal:
  - `idx_appointments_client_date`
  - `idx_appointments_service_date`
  - `idx_appointment_logs_appointment_id`
  - `idx_clients_email`

### Deploy e produção
- Adicionados arquivos de deploy para HostGator VPS Ubuntu:
  - `deploy.sh`
  - `nginx.conf`
  - `ecosystem.config.js`
  - `.env.example`
- Deploy preparado para:
  - Node.js LTS
  - PM2
  - Nginx
  - SSL Let's Encrypt
  - restart automático
  - logs do PM2
  - logs do Nginx
  - backup automático via cron

### Observação de auditoria
- Esta versão foi preparada para continuação de homologação.
- O status final de produção permanece condicionado à execução integral da bateria completa de testes solicitada pelo cliente.
