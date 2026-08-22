const SECURITY_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "*",
  "Cross-Origin-Resource-Policy": "cross-origin",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "X-Content-Type-Options": "nosniff",
  "X-Permitted-Cross-Domain-Policies": "none",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=(), display-capture=()",
  "Content-Security-Policy": "default-src 'self'; base-uri 'none'; object-src 'none'; script-src 'self' https://www.youtube.com https://s.ytimg.com https://static.cloudflareinsights.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; media-src 'self' data: blob: https:; frame-src https://www.youtube.com https://www.youtube-nocookie.com; connect-src 'self' https:; frame-ancestors https://owlbear.rodeo https://*.owlbear.rodeo http://localhost:* http://127.0.0.1:*"
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.protocol === "http:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
      url.protocol = "https:";
      return Response.redirect(url.toString(), 308);
    }

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: SECURITY_HEADERS });
    }

    const response = await env.ASSETS.fetch(request);
    const headers = new Headers(response.headers);
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  },
};
