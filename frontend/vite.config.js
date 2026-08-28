import { defineConfig } from 'vite'

export default defineConfig({
  server: {
    proxy: {

      '/api': 'http://localhost:8080'
    }
  },
  plugins: [
    {

      name: 'pretty-user-profile-urls',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          const path = (req.url || '').split('?')[0]
          if (/^\/user\/[^/]+\/?$/.test(path)) {
            req.url = '/user.html'
          }
          next()
        })
      }
    }
  ]
})
