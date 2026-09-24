// For GitHub Pages we build a static export served from a project subpath
// (https://<user>.github.io/EdgeRunner/). The workflow sets GITHUB_PAGES=true;
// local `next dev` / `next build` stay at the root with no export.
const isPages = process.env.GITHUB_PAGES === "true";
const basePath = isPages ? "/EdgeRunner" : "";

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  ...(isPages ? { output: "export", trailingSlash: true } : {}),
  basePath,
  images: { unoptimized: true },
  // Expose the base path to client code (e.g. for building asset URLs).
  env: { NEXT_PUBLIC_BASE_PATH: basePath },
  ...(!isPages
    ? {
        // Same isolation GitHub Pages gets from public/coi-serviceworker.js, sent directly in local dev.
        async headers() {
          // Everything except the preview-connect page (it must keep its opener, which COOP would cut).
          return [{ source: "/((?!webcontainer/connect).*)", headers: [
            { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
            { key: "Cross-Origin-Embedder-Policy", value: "credentialless" },
          ] }];
        },
        async rewrites() {
          const backendUrl =
            process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";
          return [
            { source: "/webcontainer/connect/:token", destination: "/webcontainer-connect.html" },
            {
              source: "/api/:path*",
              destination: `${backendUrl.replace(/\/$/, "")}/api/:path*`,
            },
          ];
        },
      }
    : {}),
};

export default nextConfig;
