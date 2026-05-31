from email.mime import application
import os
from jupyter_server.extension.application import ExtensionApp
from jupyter_server.utils import url_path_join
import tornado
from tornado.web import StaticFileHandler, HTTPError, RedirectHandler, RequestHandler
from tornado.httpclient import AsyncHTTPClient, HTTPRequest, HTTPResponse
from traitlets import Unicode, default
import uuid
import json
import logging

# Constants
BASE_DIR = os.path.abspath(os.path.dirname(__file__))
HERE = os.path.join(BASE_DIR, 'static')
app_version = "0.0.1"
app_log = logging.getLogger("tornado.application")


class StaticIndexHandler(StaticFileHandler):
    async def get(self, path=None, include_body=True):
        if not path or path == "/":
            path = "index.html"
        try:
            await super().get(path, include_body)
        except HTTPError as e:
            if e.status_code == 404:
                self.set_status(404)
                self.finish(f"File {path} not found")
            else:
                raise e


class UniqueIdHandler(tornado.web.RequestHandler):
    def initialize(self, display_url):
        app_log.info(f"display_url: {display_url}")
        self.display_url = display_url
        self.allowed_origins = ["http://localhost:3000",
                                "http://localhost:3000", self.display_url]

    async def get(self):
        self.set_cors_headers()
        mac_address = self.get_mac_address()
        self.write(mac_address)

    def set_cors_headers(self):
        origin = self.request.headers.get("Origin")
        if origin in self.allowed_origins:
            self.set_header("Access-Control-Allow-Origin", origin)
        # Optionally, you might want to handle the case where origin is not in allowed_origins
        # with a different response, depending on your application's requirements.

    def get_mac_address(self):
        mac = uuid.UUID(int=uuid.getnode()).hex[-12:]
        return ":".join(mac[i:i+2] for i in range(0, 12, 2))


class ExtractDepsHandler(tornado.web.RequestHandler):
    """Static cell dependency extraction.

    POST { "source": "<cell code>" } -> { defines, reads, imports, deletes,
    mutates, errors }. This is pure ast analysis (no execution) and runs in the
    server's Python rather than the user's kernel, so it works regardless of the
    kernel's environment and never touches kernel namespace or the run queue.
    """

    def initialize(self, display_url):
        self.allowed_origins = ["http://localhost:3000", display_url]

    def check_xsrf_cookie(self):
        # This endpoint is reached by cross-origin XHR from the dev front-end,
        # which cannot carry Jupyter's xsrf cookie. It performs read-only static
        # analysis (no execution, no filesystem, no kernel), so we skip the
        # cookie check and rely on the server token for access control.
        return

    def _set_cors_headers(self):
        # Called from request methods, not set_default_headers: tornado runs
        # set_default_headers in __init__ before initialize(), so
        # self.allowed_origins would not exist yet.
        origin = self.request.headers.get("Origin")
        if origin in self.allowed_origins:
            self.set_header("Access-Control-Allow-Origin", origin)
        self.set_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.set_header(
            "Access-Control-Allow-Headers", "Content-Type, Authorization")

    def options(self):
        self._set_cors_headers()
        self.set_status(204)
        self.finish()

    async def post(self):
        # Imported lazily so a parse-time error in the extractor can't break
        # the rest of the extension at load.
        from .dependency_extractor import extract_dependencies

        self._set_cors_headers()
        try:
            payload = json.loads(self.request.body or b"{}")
        except json.JSONDecodeError:
            self.set_status(400)
            self.write(json.dumps({"error": "invalid JSON body"}))
            return

        source = payload.get("source", "")
        result = extract_dependencies(source)
        self.set_header("Content-Type", "application/json")
        self.write(json.dumps(result))


class ThreadNotebookApp(ExtensionApp):
    version = app_version
    extension_url = "/thread-notebook"
    name = "thread-notebook"
    app_name = "ThreadNotebook"
    app_version = app_version
    load_other_extensions = False

    default_url = Unicode("/thread-notebook", config=True,
                          help="The default URL redirecting to `/`")
    app_dir = Unicode(None, config=True,
                      help="The app directory to launch the app from.")
    static_dir = Unicode(
        None, config=True, help="Directory with static files for this extension.")
    static_url_prefix = Unicode(
        "/static/thread-notebook/", config=True, help="URL prefix for static files.")
    templates_dir = Unicode(
        None, config=True, help="Templates directory for the extension.")

    @default("app_dir")
    def _default_app_dir(self):
        return BASE_DIR

    @default("static_dir")
    def _default_static_dir(self):
        return HERE

    @default("static_url_prefix")
    def _default_static_url_prefix(self):
        static_url = f"/static/{self.name}/"
        return url_path_join(self.serverapp.base_url, static_url)

    @default("templates_dir")
    def _default_templates_dir(self):
        return HERE

    def initialize_handlers(self):
        self.log.info("Initializing ThreadNotebookApp handlers")
        self.log.info(
            f"self.display_url: {str(self.serverapp.display_url)}")

        static_path = self.static_dir
        self.log.info(f"Static path: {static_path}")

        handlers = [
            (url_path_join(self.serverapp.base_url,
             "/thread-notebook/uniqueId"), UniqueIdHandler, {"display_url": self.serverapp.display_url}),
            (url_path_join(self.serverapp.base_url,
             "/thread-notebook/api/extract-deps"), ExtractDepsHandler, {"display_url": self.serverapp.display_url}),
            (url_path_join(self.serverapp.base_url, "/favicon.ico"), RedirectHandler,
             {"url": self.serverapp.base_url + "thread-notebook/favicon.ico"}),
            (url_path_join(self.serverapp.base_url, "/thread-notebook/?(.*)"),
             StaticIndexHandler, {"path": static_path}),
        ]
        self.handlers.extend(handlers)

    def initialize_settings(self):
        super().initialize_settings()
        app_log.info(f"settings: {str(self.settings)}")
        self.settings["contents_manager"].allow_hidden = True


# Entry point to launch the extension app
main = ThreadNotebookApp.launch_instance

if __name__ == "__main__":
    main()
