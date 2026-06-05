const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

dotenv.config();
const runtimeEnv = path.resolve(process.cwd(), '.env.runtime');
if (fs.existsSync(runtimeEnv)) {
  dotenv.config({ path: runtimeEnv, override: true });
}

module.exports = {
  port: Number(process.env.PORT || 3000),
  jwtSecret: process.env.JWT_SECRET || 'troque-esta-chave',
  corsOrigin: process.env.CORS_ORIGIN || '*',
  databaseUrl: process.env.DATABASE_URL || '',
  googleRefreshToken: process.env.GOOGLE_REFRESH_TOKEN || '',
  autoMigrate: String(process.env.AUTO_MIGRATE || 'true') !== 'false',
  runtimeEnv,
};
