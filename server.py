import http.server
import socketserver
import functools
import os

# Serve this script's own directory, without ever calling os.getcwd().
DIR = os.path.dirname(os.path.abspath(__file__))
PORT = 8000

Handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=DIR)
socketserver.TCPServer.allow_reuse_address = True

print(f"Serving {DIR} at http://localhost:{PORT}  (Ctrl-C to stop)")
with socketserver.TCPServer(("127.0.0.1", PORT), Handler) as httpd:
    httpd.serve_forever()
