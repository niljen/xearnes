#!/usr/bin/env python3
"""Xearnes Workspace : stockage des projets (fichiers et historiques de runs) sur le serveur Oracle.

Python 3 standard uniquement (aucune dépendance). Écoute seulement sur 127.0.0.1 ; l'accès de l'extérieur passe par
nginx (clé d'accès) puis par le Worker (connexion + liste d'adresses autorisées).
Aucune commande n'est exécutée ici : ce service lit et écrit des fichiers texte, rien d'autre.
"""
import json
import os
import re
import shutil
import sys
import tempfile
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

DATA = os.environ.get("XW_DATA", os.path.join(os.path.dirname(os.path.abspath(__file__)), "data"))
HOST = "127.0.0.1"
PORT = int(os.environ.get("XW_PORT", "8082"))

MAX_FILE = 200 * 1024        # taille max d'un fichier
MAX_FILES = 200              # fichiers max par projet
MAX_PROJECT = 5 * 1024 * 1024  # taille max d'un projet
MAX_PROJECTS = 30
MAX_RUN = 200 * 1024
MAX_RUNS = 200               # historiques gardés par projet
MAX_BODY = 400 * 1024

PROJECT_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,39}$")
SEG_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$")
RUN_RE = re.compile(r"^[A-Za-z0-9_-]{1,40}$")


class Bad(Exception):
    def __init__(self, status, msg):
        super().__init__(msg)
        self.status = status
        self.msg = msg


def project_dir(name):
    if not PROJECT_RE.match(name or ""):
        raise Bad(400, "bad_project_name")
    return os.path.join(DATA, name)


def clean_path(p):
    """Chemin relatif sûr : segments simples, pas de « .. », pas de chemin absolu, profondeur limitée."""
    if not p or len(p) > 200 or "\\" in p or p.startswith("/") or "\x00" in p:
        raise Bad(400, "bad_path")
    segs = p.split("/")
    if len(segs) > 4 or any((not SEG_RE.match(s)) or s in (".", "..") or s.endswith(".") for s in segs):
        raise Bad(400, "bad_path")
    return "/".join(segs)


def safe_join(root, rel):
    full = os.path.realpath(os.path.join(root, *rel.split("/")))
    if os.path.commonpath([os.path.realpath(root), full]) != os.path.realpath(root):
        raise Bad(400, "bad_path")
    return full


def tree(root):
    out = []
    total = 0
    for base, _dirs, files in os.walk(root):
        if os.path.relpath(base, root).split(os.sep)[0] == ".runs":
            continue
        for f in files:
            full = os.path.join(base, f)
            if os.path.islink(full):
                continue
            rel = os.path.relpath(full, root).replace(os.sep, "/")
            size = os.path.getsize(full)
            total += size
            out.append({"path": rel, "size": size, "mtime": int(os.path.getmtime(full))})
    out.sort(key=lambda x: x["path"])
    return out, total


def write_atomic(full, data):
    os.makedirs(os.path.dirname(full), exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(full), prefix=".tmp-")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        os.replace(tmp, full)
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)


class H(BaseHTTPRequestHandler):
    server_version = "XearnesWorkspace/0.1"

    def log_message(self, fmt, *args):  # pas de contenu dans les journaux : seulement méthode, chemin court et code
        sys.stderr.write("%s %s\n" % (self.command, urlparse(self.path).path[:80]))

    def send_json(self, status, obj):
        b = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(b)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(b)

    def body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n > MAX_BODY:
            raise Bad(413, "too_large")
        return self.rfile.read(n) if n else b""

    def route(self, method):
        u = urlparse(self.path)
        parts = [p for p in u.path.split("/") if p]
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        os.makedirs(DATA, exist_ok=True)

        if parts == ["health"] and method == "GET":
            return 200, {"ok": True, "time": int(time.time())}
        if parts == ["projects"]:
            if method == "GET":
                names = sorted(d for d in os.listdir(DATA) if PROJECT_RE.match(d) and os.path.isdir(os.path.join(DATA, d)))
                out = []
                for n in names:
                    t, total = tree(os.path.join(DATA, n))
                    out.append({"name": n, "files": len(t), "bytes": total})
                return 200, {"projects": out}
            if method == "POST":
                try:
                    name = str(json.loads(self.body() or b"{}").get("name", "")).strip().lower()
                except ValueError:
                    raise Bad(400, "bad_json")
                d = project_dir(name)
                if os.path.exists(d):
                    raise Bad(409, "exists")
                if len([x for x in os.listdir(DATA) if PROJECT_RE.match(x)]) >= MAX_PROJECTS:
                    raise Bad(409, "too_many_projects")
                os.makedirs(d)
                return 201, {"name": name}
        if len(parts) >= 2 and parts[0] == "projects":
            d = project_dir(parts[1])
            if len(parts) == 2 and method == "DELETE":
                if not os.path.isdir(d):
                    raise Bad(404, "not_found")
                shutil.rmtree(d)
                return 200, {"deleted": parts[1]}
            if not os.path.isdir(d):
                raise Bad(404, "not_found")
            if len(parts) == 3 and parts[2] == "tree" and method == "GET":
                t, total = tree(d)
                return 200, {"files": t, "bytes": total}
            if len(parts) == 3 and parts[2] == "file":
                rel = clean_path(q.get("path", ""))
                full = safe_join(d, rel)
                if method == "GET":
                    if not os.path.isfile(full) or os.path.islink(full):
                        raise Bad(404, "not_found")
                    with open(full, "rb") as f:
                        raw = f.read()
                    try:
                        return 200, {"path": rel, "content": raw.decode("utf-8")}
                    except UnicodeDecodeError:
                        raise Bad(415, "not_text")
                if method == "PUT":
                    raw = self.body()
                    if len(raw) > MAX_FILE:
                        raise Bad(413, "file_too_large")
                    try:
                        raw.decode("utf-8")
                    except UnicodeDecodeError:
                        raise Bad(415, "not_text")
                    t, total = tree(d)
                    existing = next((x["size"] for x in t if x["path"] == rel), None)
                    if existing is None and len(t) >= MAX_FILES:
                        raise Bad(409, "too_many_files")
                    if total - (existing or 0) + len(raw) > MAX_PROJECT:
                        raise Bad(413, "project_too_large")
                    if os.path.isdir(full):
                        raise Bad(409, "is_directory")
                    write_atomic(full, raw)
                    return 200, {"path": rel, "size": len(raw)}
                if method == "DELETE":
                    if not os.path.isfile(full):
                        raise Bad(404, "not_found")
                    os.remove(full)
                    return 200, {"deleted": rel}
            if len(parts) >= 3 and parts[2] == "runs":
                rd = os.path.join(d, ".runs")
                if len(parts) == 3 and method == "GET":
                    items = []
                    if os.path.isdir(rd):
                        for f in sorted(os.listdir(rd), reverse=True):
                            if f.endswith(".json") and RUN_RE.match(f[:-5]):
                                full = os.path.join(rd, f)
                                try:
                                    with open(full, "r", encoding="utf-8") as fh:
                                        j = json.load(fh)
                                    items.append({"id": f[:-5], "goal": str(j.get("goal", ""))[:120], "team": j.get("team", ""), "time": j.get("time", 0)})
                                except Exception:
                                    pass
                    return 200, {"runs": items[:50]}
                if len(parts) == 4:
                    if not RUN_RE.match(parts[3]):
                        raise Bad(400, "bad_run_id")
                    full = os.path.join(rd, parts[3] + ".json")
                    if method == "GET":
                        if not os.path.isfile(full):
                            raise Bad(404, "not_found")
                        with open(full, "r", encoding="utf-8") as fh:
                            return 200, json.load(fh)
                    if method == "PUT":
                        raw = self.body()
                        if len(raw) > MAX_RUN:
                            raise Bad(413, "run_too_large")
                        try:
                            json.loads(raw.decode("utf-8"))
                        except ValueError:
                            raise Bad(400, "bad_json")
                        os.makedirs(rd, exist_ok=True)
                        existing = sorted(f for f in os.listdir(rd) if f.endswith(".json"))
                        if len(existing) >= MAX_RUNS and (parts[3] + ".json") not in existing:
                            os.remove(os.path.join(rd, existing[0]))  # on garde les plus récents
                        write_atomic(full, raw)
                        return 200, {"id": parts[3]}
        raise Bad(404, "not_found")

    def dispatch(self, method):
        try:
            status, obj = self.route(method)
        except Bad as e:
            status, obj = e.status, {"error": e.msg}
        except Exception as e:  # ne jamais renvoyer de détail interne
            sys.stderr.write("error: %r\n" % (e,))
            status, obj = 500, {"error": "server_error"}
        self.send_json(status, obj)

    def do_GET(self): self.dispatch("GET")
    def do_POST(self): self.dispatch("POST")
    def do_PUT(self): self.dispatch("PUT")
    def do_DELETE(self): self.dispatch("DELETE")


if __name__ == "__main__":
    os.makedirs(DATA, exist_ok=True)
    srv = ThreadingHTTPServer((HOST, PORT), H)
    sys.stderr.write("workspace server on %s:%d, data %s\n" % (HOST, PORT, DATA))
    srv.serve_forever()
