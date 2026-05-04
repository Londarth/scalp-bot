module.exports = {
  apps: [
    {
      name: 'helios-bot',
      script: 'scripts/helios-bot.js',
      cwd: __dirname,
      env: {
        NODE_ENV: 'production',
      },
      max_restarts: 3,
      autorestart: false,
      watch: false,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: 'logs/helios-bot-error.log',
      out_file: 'logs/helios-bot-out.log',
      merge_logs: true,
    },
  ],
};