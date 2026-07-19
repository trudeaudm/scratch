/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Allow importing shared `site/tokens.json` from outside the dashboard package.
  experimental: {
    externalDir: true,
  },
};

export default nextConfig;
