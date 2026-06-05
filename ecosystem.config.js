module.exports = {
  apps: [
    {
      name: 'munay-agenda-pro',
      script: 'src/server.js',
      cwd: '/var/www/munay-agenda-pro',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
        AUTO_MIGRATE: 'true'
      }
    }
  ]
};
