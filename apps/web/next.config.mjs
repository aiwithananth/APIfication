/** @type {import('next').NextConfig} */
const API_URL = process.env.APF_API_URL || "http://127.0.0.1:8000";

const nextConfig = {
  reactStrictMode: true,
  // The browser talks only to the Next.js origin; the control plane stays private.
  async rewrites() {
    return [
      { source: "/api/:path*", destination: `${API_URL}/:path*` },
      { source: "/gw/:path*", destination: `${API_URL}/gw/:path*` },
    ];
  },
};

export default nextConfig;
