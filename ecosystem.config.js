/**
 * PM2 Ecosystem Config — ARVO Frontend Server
 *
 * Start:   pm2 start ecosystem.config.js
 * Restart: pm2 restart arvo-frontend
 * Logs:    pm2 logs arvo-frontend
 * Stop:    pm2 stop arvo-frontend
 * Save:    pm2 save  (persist across reboots)
 */
module.exports = {
  apps: [
    {
      name:        "arvo-frontend",
      script:      "./frontend/server.js",
      cwd:         __dirname,
      instances:   1,
      autorestart: true,
      watch:       false,
      max_memory_restart: "256M",
      env: {
        NODE_ENV:  "production",
        PORT:      "5173",
        // HOST defaults to 0.0.0.0 when NODE_ENV=production (see server.js)
      },
      env_development: {
        NODE_ENV: "development",
        PORT:     "5173",
      },
      error_file: "./logs/arvo-frontend-err.log",
      out_file:   "./logs/arvo-frontend-out.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss",
    },
  ],
};
