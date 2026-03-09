module.exports = {
  apps: [
    {
      name: "iceflower-backend",
      cwd: "./backend",
      script: "src/index.js",
      interpreter: "node",
      autorestart: true,
      watch: false,
      max_memory_restart: "500M",
      env: {
        NODE_ENV: "production",
        PORT: "4000"
      }
    },
    {
      name: "iceflower-tunnel",
      cwd: "./backend",
      script: "C:\\Program Files (x86)\\cloudflared\\cloudflared.exe",
      args: "tunnel --url http://localhost:4000 --no-autoupdate",
      interpreter: "none",
      autorestart: true,
      watch: false
    }
  ]
}
