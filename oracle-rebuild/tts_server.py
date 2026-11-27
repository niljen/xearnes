"""Service de voix Kokoro pour Xearnes (serveur Oracle).
Écoute seulement sur 127.0.0.1:8083 ; le portail nginx (clé X-Xearnes-Key) le rend accessible au Worker via /tts.
POST /tts  {"text": "...", "lang": "fr", "speed": 1.0}  ->  audio/wav (une phrase ou deux, 400 caractères au plus)
GET  /health
Une seule synthèse à la fois (le serveur n'a que 2 cœurs) ; les autres demandes attendent leur tour.
"""
import io, json, os, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import soundfile as sf
from kokoro_onnx import Kokoro

HERE = os.path.dirname(os.path.abspath(__file__))
MODEL = os.environ.get("KOKORO_MODEL", os.path.join(HERE, "kokoro-v1.0.onnx"))
VOICES = os.environ.get("KOKORO_VOICES", os.path.join(HERE, "voices-v1.0.bin"))
PORT = int(os.environ.get("TTS_PORT", "8083"))
MAX_CHARS = 400

# Langue de Xearnes -> (voix Kokoro, langue du phonétiseur)
LANGS = {
    "en": ("af_heart", "en-us"),
    "fr": ("ff_siwis", "fr-fr"),
    "es": ("ef_dora", "es"),
    "it": ("if_sara", "it"),
    "pt": ("pf_dora", "pt-br"),
}

kokoro = Kokoro(MODEL, VOICES)
lock = threading.Lock()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):  # pas de journal des textes
        pass

    def _send(self, code, body, ctype="application/json"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            return self._send(200, json.dumps({"ok": True, "langs": sorted(LANGS)}).encode())
        return self._send(404, b'{"error":"not_found"}')

    def do_POST(self):
        if self.path != "/tts":
            return self._send(404, b'{"error":"not_found"}')
        try:
            n = int(self.headers.get("Content-Length") or 0)
            if n <= 0 or n > 8192:
                return self._send(413, b'{"error":"too_large"}')
            req = json.loads(self.rfile.read(n).decode("utf-8"))
            text = str(req.get("text") or "").strip()
            lang = str(req.get("lang") or "")
            speed = float(req.get("speed") or 1.0)
        except Exception:
            return self._send(400, b'{"error":"bad_request"}')
        if lang not in LANGS:
            return self._send(400, b'{"error":"lang_not_supported"}')
        if not text or len(text) > MAX_CHARS:
            return self._send(400, b'{"error":"bad_text"}')
        speed = min(1.5, max(0.6, speed))
        voice, plang = LANGS[lang]
        try:
            with lock:
                samples, sr = kokoro.create(text, voice=voice, speed=speed, lang=plang)
            buf = io.BytesIO()
            sf.write(buf, samples, sr, format="WAV", subtype="PCM_16")
            return self._send(200, buf.getvalue(), "audio/wav")
        except Exception:
            return self._send(500, b'{"error":"tts_failed"}')


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
