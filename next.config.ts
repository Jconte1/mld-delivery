import type { NextConfig } from "next";

const rawBasePath = process.env.NEXT_PUBLIC_APP_BASE_PATH?.trim() || "/delivery";
const basePath = rawBasePath === "/" ? "" : `/${rawBasePath.replace(/^\/+|\/+$/g, "")}`;
const canonicalDeliveryUrl = "https://www.mld.com/delivery";
const legacyHost = "mld-delivery.vercel.app";
const canonicalRedirectEnabled =
  process.env.DELIVERY_CANONICAL_REDIRECT_ENABLED?.trim().toLowerCase() === "true";

const nextConfig: NextConfig = {
  ...(basePath ? { basePath } : {}),

  async redirects() {
    if (!canonicalRedirectEnabled) return [];

    const legacyHostRule = [{ type: "host" as const, value: legacyHost }];
    return [
      {
        source: "/delivery",
        has: legacyHostRule,
        destination: canonicalDeliveryUrl,
        permanent: false,
        basePath: false,
      },
      {
        source: "/delivery/:path*",
        has: legacyHostRule,
        destination: `${canonicalDeliveryUrl}/:path*`,
        permanent: false,
        basePath: false,
      },
      {
        source: "/c/:token",
        has: legacyHostRule,
        destination: `${canonicalDeliveryUrl}/c/:token`,
        permanent: false,
        basePath: false,
      },
    ];
  },
};

export default nextConfig;
