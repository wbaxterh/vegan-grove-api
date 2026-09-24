// PM2 process definition. Secrets come from the .env file on the box, never from here.
module.exports = {
  apps: [
    {
      name: 'vegan-grove-api',
      script: 'dist/server.js',
      exec_mode: 'fork',
      instances: 1,
      max_memory_restart: '400M',
      kill_timeout: 12000,
      wait_ready: false,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
