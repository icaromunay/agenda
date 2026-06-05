# Guia de Deploy — HostGator VPS Ubuntu

## Escopo
Este guia prepara o sistema para execução em VPS Ubuntu com:
- Node.js LTS
- PM2
- Nginx
- SSL Let's Encrypt
- variáveis `.env`
- restart automático
- logs PM2
- logs Nginx
- backup automático

---

## 1) Pré-requisitos
- VPS Ubuntu com acesso SSH
- domínio apontando para o IP do servidor
- PostgreSQL acessível
- credenciais Google Calendar válidas, se desejar sincronização

---

## 2) Upload do projeto
Envie o pacote do projeto para o servidor e extraia em um diretório temporário.

Exemplo:
```bash
mkdir -p /tmp/munay-agenda-pro
cd /tmp/munay-agenda-pro
unzip munay-agenda-pro-3.1.0.zip
```

---

## 3) Ajustar ambiente
Edite o arquivo `.env` com base em `.env.example`.

Campos críticos:
- `JWT_SECRET`
- `CORS_ORIGIN`
- `DATABASE_URL`
- `GOOGLE_REFRESH_TOKEN` (se aplicável)

---

## 4) Rodar deploy
Como root:
```bash
sudo bash deploy.sh seu-dominio.com seu-email@dominio.com
```

O script fará:
- instalação de dependências do sistema;
- instalação do Node.js LTS se necessário;
- instalação do PM2;
- cópia do projeto para `/var/www/munay-agenda-pro`;
- instalação de dependências npm;
- configuração do Nginx;
- tentativa de emissão do SSL via Certbot;
- criação de rotina de backup;
- ativação do restart automático.

---

## 5) Verificações pós-deploy
### PM2
```bash
pm2 status
pm2 logs munay-agenda-pro
```

### Nginx
```bash
nginx -t
systemctl status nginx
```

### Health check
```bash
curl http://127.0.0.1:3000/api/health
```

### Logs
```bash
tail -f /var/log/nginx/munay-agenda-pro.error.log
```

---

## 6) Reinício da aplicação
```bash
pm2 restart munay-agenda-pro
pm2 save
```

---

## 7) Backup automático
O deploy cria um script de backup diário em:
- `/usr/local/bin/munay-agenda-pro-backup.sh`

E agenda execução via cron às 03:00.

---

## 8) Observação importante de homologação
Mesmo com os arquivos de deploy prontos, a liberação para produção deve ocorrer **somente após**:
- validação do Google Calendar em ambiente real;
- validação dos fluxos WhatsApp;
- validação completa do painel em responsividade.

---

## 9) Status recomendado
**Homologação assistida antes do go-live.**
