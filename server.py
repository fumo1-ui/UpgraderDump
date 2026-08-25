# -*- coding: utf-8 -*-
"""
Локальный сервер для дампа upgrader.vip.
- Отдаёт статические файлы из папки дампа.
- /api/* проксирует на реальный бэкенд https://upgrader.vip/api/*,
  чтобы магазин скинов и live-drops показывали настоящие данные.
- Ответы реального API с 401/403 заменяются на 200 + пустое тело,
  чтобы у приложения не срабатывал logout при фейковом токене.
- Аутентификация/пользователь мокается в браузере (mock-login.js).
"""
import json
import os
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

API_BASE = "https://upgrader.vip"
ASSET_CDN = "https://s3.upgrader.vip/cdn/fa"
DIRECTORY = os.path.dirname(os.path.abspath(__file__))

FORWARD_HEADERS = {
    "accept", "accept-language", "authorization", "content-type",
    "x-client-version", "x-client-library", "x-client-url",
    "x-client-sample-rate", "x-yandex-client-id", "x-google-client-id",
    "x-link", "x-requested-with",
    "user-agent", "referer", "origin",
    "sec-ch-ua", "sec-ch-ua-mobile", "sec-ch-ua-platform",
    "sec-fetch-dest", "sec-fetch-mode", "sec-fetch-site", "sec-fetch-user",
    "upgrade-insecure-requests",
}

FALLBACK_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "ru-RU,ru;q=0.9,en;q=0.8",
}
SKIP_RESPONSE_HEADERS = {
    "transfer-encoding", "connection", "keep-alive", "content-length",
    "content-encoding", "content-security-policy",
}


class ProxyHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIRECTORY, **kwargs)

    def log_message(self, fmt, *args):
        sys.stderr.write("[%s] %s\n" % (self.address_string(), fmt % args))

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "content-type, authorization, accept, x-*")
        self.end_headers()

    def end_headers(self):
        if self.path and not self.path.startswith("/api/"):
            self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
            self.send_header("Pragma", "no-cache")
            self.send_header("Expires", "0")
        super().end_headers()

    def do_GET(self):
        if self.path.startswith("/api/"):
            self._proxy()
            return
        translated = self.translate_path(self.path)
        if not os.path.isfile(translated):
            # SPA-fallback только для маршрутов (без расширения файла).
            # Пропавшие ассеты — догружаем с реального CDN (s3.upgrader.vip/cdn/fa).
            ext = os.path.splitext(self.path)[1]
            if self.path.startswith("/assets/") and ext:
                if self._proxy_asset():
                    return
            if ext:
                self.send_error(404, "Not Found")
                return
            self.path = "/index.html"
        super().do_GET()

    def do_POST(self):
        if self.path.startswith("/api/"):
            self._proxy()
        else:
            super().do_POST()

    def do_PUT(self):
        if self.path.startswith("/api/"):
            self._proxy()
        else:
            super().do_PUT()

    def do_PATCH(self):
        if self.path.startswith("/api/"):
            self._proxy()
        else:
            super().do_PATCH()

    def do_DELETE(self):
        if self.path.startswith("/api/"):
            self._proxy()
        else:
            super().do_DELETE()

    def _proxy(self):
        url = API_BASE + self.path
        headers = {}
        for key, value in self.headers.items():
            if key.lower() in FORWARD_HEADERS:
                headers[key] = value
        for key, value in FALLBACK_HEADERS.items():
            if key.lower() not in headers:
                headers[key] = value
        body = None
        content_length = self.headers.get("Content-Length")
        if content_length:
            try:
                body = self.rfile.read(int(content_length))
            except Exception:
                body = None
        req = Request(url, data=body, headers=headers, method=self.command)
        try:
            with urlopen(req, timeout=30) as resp:
                data = resp.read()
                self.send_response(resp.status)
                for key, value in resp.headers.items():
                    if key.lower() not in SKIP_RESPONSE_HEADERS:
                        self.send_header(key, value)
                self.end_headers()
                self.wfile.write(data)
        except HTTPError as err:
            if err.code in (401, 403):
                self._send_empty(err.code)
            else:
                self._send_error(502, "proxy upstream error %s" % err.code)
        except (URLError, OSError, Exception) as err:
            self._send_error(502, "proxy error: %s" % err)

    def _proxy_asset(self):
        # Пропавший ассет в дампе: /assets/<sub> -> https://s3.upgrader.vip/cdn/fa/<sub>
        try:
            rel = self.path[len("/assets/"):]
        except Exception:
            return False
        if not rel:
            return False
        url = ASSET_CDN + "/" + rel
        ua = FALLBACK_HEADERS.get("User-Agent")
        try:
            req = Request(url, headers={"User-Agent": ua or FALLBACK_HEADERS["User-Agent"]})
            with urlopen(req, timeout=30) as resp:
                data = resp.read()
                content_type = resp.headers.get("Content-Type") or "application/octet-stream"
                self.send_response(200)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(len(data)))
                self.send_header("Cache-Control", "public, max-age=86400")
                self.end_headers()
                self.wfile.write(data)
                self.log_message("cdn asset %s -> %d bytes", self.path, len(data))
                return True
        except Exception:
            return False

    def _send_empty(self, upstream_status):
        payload = "[]" if self.command == "GET" else "{}"
        data = payload.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)
        self.log_message("upstream %s -> 200 empty (%s)", upstream_status, self.path)

    def _send_error(self, status, msg):
        data = msg.encode("utf-8", "replace")
        self.send_response(status)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def main():
    port = 8080
    if len(sys.argv) > 1:
        try:
            port = int(sys.argv[1])
        except ValueError:
            port = 8080
    server = ThreadingHTTPServer(("127.0.0.1", port), ProxyHandler)
    print("upgrader-dump server on http://127.0.0.1:%d (api -> %s)" % (port, API_BASE))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
