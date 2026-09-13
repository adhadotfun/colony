"""Static file server for COLONY.

The site is plain HTML, CSS and JSON. No build step, no framework, no runtime
fetching. This exists only so a host that expects a process has one to run.
"""
import os
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
PORT = int(os.environ.get("PORT", "8080"))


class Handler(SimpleHTTPRequestHandler):
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".mjs": "text/javascript",
        ".js": "text/javascript",
        ".json": "application/json",
        ".css": "text/css",
        ".md": "text/markdown; charset=utf-8",
    }

    def end_headers(self):
        # The data files are content addressed by the hashes verify.html checks,
        # so a stale cached copy would fail verification confusingly. Keep them fresh.
        path = self.path.split("?")[0]
        if path.endswith((".json", ".md")):
            self.send_header("Cache-Control", "no-cache")
        else:
            self.send_header("Cache-Control", "public, max-age=300")
        self.send_header("X-Content-Type-Options", "nosniff")
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
        if "." not in segment and p != "/":
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
