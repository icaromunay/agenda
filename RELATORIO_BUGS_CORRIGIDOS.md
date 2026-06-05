# Relatório de Bugs Corrigidos — versão 3.1.0

## Quantitativo desta entrega
- **Bugs / lacunas funcionais mapeados:** 8
- **Bugs / lacunas corrigidos nesta entrega:** 8

---

## Lista de correções implementadas

### 1) Área de clientes simples demais para uso como CRM
**Problema anterior:** a área de clientes mostrava apenas listagem básica.

**Correção aplicada:**
- criação de visão CRM com cards ricos;
- inclusão de estatísticas no topo;
- modal de histórico e edição.

### 2) Ausência de filtros de clientes
**Problema anterior:** não havia filtros por nome, WhatsApp, e-mail, serviço e período.

**Correção aplicada:**
- inclusão de filtros completos;
- atualização em tempo real.

### 3) Ausência de exportação de clientes
**Problema anterior:** não existia exportação CSV/XLSX.

**Correção aplicada:**
- criação da rota de exportação;
- geração CSV;
- geração XLSX com `xlsx`.

### 4) Ausência de exclusão segura de cliente
**Problema anterior:** não existia fluxo seguro de exclusão de cliente com vínculos.

**Correção aplicada:**
- fluxo de confirmação;
- exclusão com modo `client-only`;
- exclusão com modo `cascade`.

### 5) Falta de detalhe individual do cliente
**Problema anterior:** não existia endpoint/admin view de detalhe do cliente.

**Correção aplicada:**
- inclusão de rotas de detalhe e histórico;
- resumo de registros vinculados.

### 6) Visual administrativo desalinhado do padrão premium solicitado
**Problema anterior:** o visual anterior usava tema mais antigo e não seguia exatamente o padrão definido.

**Correção aplicada:**
- padronização global para fundo `#111827`;
- cards `#1F2937`;
- títulos dourados `#F5D06F`;
- reforço de contraste e hover premium.

### 7) Falta de preparação formal para deploy em VPS
**Problema anterior:** não havia pacote mínimo de deploy completo entregue.

**Correção aplicada:**
- criação de `deploy.sh`;
- criação de `nginx.conf`;
- criação de `ecosystem.config.js`;
- criação de `.env.example`.

### 8) Índices insuficientes para algumas consultas do novo CRM
**Problema anterior:** a camada CRM exigia consultas adicionais sem todos os índices auxiliares desejáveis.

**Correção aplicada:**
- adição de índices para client/date, service/date, appointment_logs e email.

---

## Bugs ainda possíveis / pendências não encerradas
Esses itens **não foram considerados corrigidos definitivamente** nesta rodada porque exigem homologação completa:
- regressão manual completa do Google Calendar na versão 3.1.0;
- exportação XLSX validada por download real ponta a ponta;
- responsividade manual em múltiplos dispositivos;
- bateria de segurança e performance completa.

---

## Conclusão
As correções desta entrega focaram em **CRM, exportação, exclusão segura, visual premium e deploy**. A base está significativamente melhor e mais profissional, porém a aprovação final para produção continua dependente da auditoria integral restante.
