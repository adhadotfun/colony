"""Static file server for COLONY.

The site is plain HTML, CSS and JSON. No build step, no framework, no runtime
fetching. This exists only so a host that expects a process has one to run.
"""
import os
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
PORT = int(os.environ.get("PORT", "8080"))

# Sent on every response. Only same-origin assets plus the two CDNs the pages
# actually load are allowed (jsdelivr for marked.js, Google Fonts via the
# @import in css/site.css).
CSP = (
    "default-src 'self'; "
    "script-src 'self' https://cdn.jsdelivr.net 'unsafe-inline'; "
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
    "font-src 'self' https://fonts.gstatic.com data:; "
    "img-src 'self' data:; "
    "connect-src 'self'; "
    "frame-ancestors 'none'; "
    "base-uri 'self'"
)

SECURITY_HEADERS = (
    ("Strict-Transport-Security", "max-age=31536000; includeSubDomains"),
    ("Referrer-Policy", "strict-origin-when-cross-origin"),
    ("Permissions-Policy", "camera=(), microphone=(), geolocation=()"),
    ("Content-Security-Policy", CSP),
)


class Handler(SimpleHTTPRequestHandler):
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".mjs": "text/javascript",
        ".js": "text/javascript",
        ".json": "application/json",
        ".css": "text/css",
        ".md": "text/markdown; charset=utf-8",
    }

    def send_response(self, code, message=None):
        self._status = code
        super().send_response(code, message)

    def send_error(self, code, message=None, explain=None):
        # Base class behaviour only; end_headers below swaps the cache header
        # for 404s so a miss is never stored.
        super().send_error(code, message, explain)

    def end_headers(self):
        path = self.path.split("?")[0]
        # The data files are content addressed by the hashes verify.html checks,
        # so a stale cached copy would fail verification confusingly. Keep them fresh.
        if self._status == 404:
            self.send_header("Cache-Control", "no-store")
        elif path.endswith((".json", ".md")):
            self.send_header("Cache-Control", "no-cache")
        else:
            self.send_header("Cache-Control", "public, max-age=300")
        self.send_header("X-Content-Type-Options", "nosniff")
        for name, value in SECURITY_HEADERS:
            self.send_header(name, value)
        super().end_headers()

    def log_message(self, fmt, *args):
        if self.path.split("?")[0] not in ("/health",):
            super().log_message(fmt, *args)

    def _resolve(self):
        # Clean URLs. Returns True when a redirect has already been sent.
        if "?" in self.path:
            p, q = self.path.split("?", 1)
            q = "?" + q
        else:
            p, q = self.path, ""
        if p == "/favicon.ico":
            self.path = "/assets/favicon.ico" + q
        elif p == "/sitemap.xml":
            # Only served when the file exists; never generated here.
            if not os.path.isfile(os.path.join(ROOT, "sitemap.xml")):
                self.send_error(404, "Not Found")
                return True
        if p.endswith(".html"):
            clean = p[:-5]
            if clean.endswith("/index"):
                clean = clean[:-5]
            if clean == "":
                clean = "/"
            self.send_response(301)
            self.send_header("Location", clean + q)
            self.end_headers()
            return True
        segment = p.rsplit("/", 1)[-1]
        if "." not in segment and p != "/" and p != "/favicon.ico":
            candidate = os.path.join(ROOT, p.lstrip("/") + ".html")
            if os.path.isfile(candidate):
                self.path = p + ".html" + q
        return False

    def do_GET(self):
        if self.path.split("?")[0] == "/health":
            body = b"ok"
            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if self._resolve():
            return
        super().do_GET()

    def do_HEAD(self):
        if self._resolve():
            return
        super().do_HEAD()


if __name__ == "__main__":
    handler = partial(Handler, directory=ROOT)
    print(f"COLONY serving {ROOT} on :{PORT}", flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), handler).serve_forever()
