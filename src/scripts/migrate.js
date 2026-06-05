const { bootstrap } = require('../bootstrap');

bootstrap()
  .then(() => {
    console.log('Migrações executadas com sucesso.');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Falha ao executar migrações:', error);
    process.exit(1);
  });
