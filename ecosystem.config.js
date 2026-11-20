module.exports = {
  apps: [
    {
      name: 'patente-b-simulator',
      script: 'src/server.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '256M',
      env: {
        NODE_ENV: 'production',
        PORT: 3080,
      },
    },
  ],
};
