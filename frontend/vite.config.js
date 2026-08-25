import { defineConfig } from 'vite'

export default defineConfig({
  server: {
    proxy: {
      // Forward /api/* to the Rust backend during development
      '/api': 'http://localhost:8080'
    }
  },
  plugins: [
    {
      // Dev-server-only rewrite: /user/<username> serves user.html's content
      // while the browser keeps showing the pretty URL. user-profile-page.js
      // reads the username straight back out of location.pathname, so no
      // query string is needed. A static/production host would need an
      // equivalent rewrite rule (e.g. nginx try_files) to keep this working
      // outside of `vite dev`.
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
