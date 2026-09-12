/**
 * Demo dev proxy. The fina-olap API runs locally on 127.0.0.1:8787 (started by
 * `npm run dev`); the browser hits the same-origin paths below, which Next
 * rewrites to the API — no CORS needed.
 */
/** @type {import('next').NextConfig} */
const nextConfig = {
  typedRoutes: true,
  outputFileTracingRoot: new URL(".", import.meta.url).pathname,
  async rewrites() {
    return [
      { source: "/api/:path*", destination: "http://127.0.0.1:8787/api/:path*" },
    ];
  },
};

export default nextConfig;