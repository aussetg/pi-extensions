#!/usr/bin/env python3
import json
import importlib
import os
import secrets
import sys
import traceback

dbus = importlib.import_module("dbus")
dbus_glib = importlib.import_module("dbus.mainloop.glib")
gi = importlib.import_module("gi")
gi.require_version("GLib", "2.0")
gi.require_version("Gst", "1.0")
GLib = importlib.import_module("gi.repository.GLib")
Gst = importlib.import_module("gi.repository.Gst")


PORTAL_BUS = "org.freedesktop.portal.Desktop"
PORTAL_PATH = "/org/freedesktop/portal/desktop"
SCREENCAST_IFACE = "org.freedesktop.portal.ScreenCast"
REQUEST_IFACE = "org.freedesktop.portal.Request"
SESSION_IFACE = "org.freedesktop.portal.Session"
PROPERTIES_IFACE = "org.freedesktop.DBus.Properties"

SOURCE_MONITOR = 1
SOURCE_WINDOW = 2
CURSOR_HIDDEN = 1
CURSOR_EMBEDDED = 2


def eprint(message):
    print(message, file=sys.stderr, flush=True)


def clean(value):
    if isinstance(value, dbus.String):
        return str(value)
    if isinstance(value, dbus.ObjectPath):
        return str(value)
    if isinstance(value, (dbus.Boolean, bool)):
        return bool(value)
    if isinstance(value, (dbus.Byte, dbus.Int16, dbus.Int32, dbus.Int64, dbus.UInt16, dbus.UInt32, dbus.UInt64)):
        return int(value)
    if isinstance(value, dbus.Double):
        return float(value)
    if isinstance(value, (dbus.Array, list, tuple)):
        return [clean(v) for v in value]
    if isinstance(value, (dbus.Dictionary, dict)):
        return {str(k): clean(v) for k, v in value.items()}
    return value


def variant_string(value):
    return dbus.String(str(value), variant_level=1)


def variant_uint32(value):
    return dbus.UInt32(int(value), variant_level=1)


def variant_bool(value):
    return dbus.Boolean(bool(value), variant_level=1)


class PortalError(RuntimeError):
    pass


class ScreenCastSession:
    def __init__(self):
        dbus_glib.DBusGMainLoop(set_as_default=True)
        Gst.init(None)

        self.bus = dbus.SessionBus()
        self.portal = self.bus.get_object(PORTAL_BUS, PORTAL_PATH)
        self.screencast = dbus.Interface(self.portal, SCREENCAST_IFACE)
        self.properties = dbus.Interface(self.portal, PROPERTIES_IFACE)

        self.sender = self.bus.get_unique_name()[1:].replace(".", "_")
        self.session_handle = None
        self.streams = []
        self.restore_token = None
        self.closed_match = None
        self.version = self._get_uint_property("version", 0)
        self.available_sources = self._get_uint_property("AvailableSourceTypes", SOURCE_MONITOR | SOURCE_WINDOW)
        self.available_cursors = self._get_uint_property("AvailableCursorModes", CURSOR_HIDDEN)

    def _get_uint_property(self, name, fallback):
        try:
            return int(self.properties.Get(SCREENCAST_IFACE, name))
        except Exception:
            return fallback

    def _token(self, prefix):
        return f"pi_{prefix}_{secrets.token_hex(8)}"

    def _request_path(self, token):
        return f"{PORTAL_PATH}/request/{self.sender}/{token}"

    def _session_path(self, token):
        return f"{PORTAL_PATH}/session/{self.sender}/{token}"

    def _request(self, call, options=None, timeout_seconds=300):
        token = self._token("request")
        payload = dict(options or {})
        payload["handle_token"] = variant_string(token)
        vardict = dbus.Dictionary(payload, signature="sv")

        expected_path = self._request_path(token)
        result = {}
        loop = GLib.MainLoop()

        def done(response, results):
            result["response"] = int(response)
            result["results"] = clean(results)
            loop.quit()

        request_object = self.bus.get_object(PORTAL_BUS, expected_path)
        match = request_object.connect_to_signal("Response", done, dbus_interface=REQUEST_IFACE)

        def timeout():
            result["timeout"] = True
            loop.quit()
            return False

        timeout_id = GLib.timeout_add_seconds(timeout_seconds, timeout) if timeout_seconds else None

        try:
            handle = str(call(vardict))
            if handle != expected_path:
                match.remove()
                request_object = self.bus.get_object(PORTAL_BUS, handle)
                match = request_object.connect_to_signal("Response", done, dbus_interface=REQUEST_IFACE)

            loop.run()
        finally:
            try:
                match.remove()
            except Exception:
                pass
            if timeout_id is not None and not result.get("timeout"):
                GLib.source_remove(timeout_id)

        if result.get("timeout"):
            raise PortalError("portal request timed out")

        response = result.get("response")
        if response == 1:
            raise PortalError("portal request cancelled")
        if response not in (0, None):
            raise PortalError(f"portal request failed with response {response}")
        if "results" not in result:
            raise PortalError("portal request finished without a response")
        return result["results"]

    def _close_current(self, keep_restore_token=False):
        restore_token = self.restore_token
        if not self.session_handle:
            return
        try:
            obj = self.bus.get_object(PORTAL_BUS, self.session_handle)
            dbus.Interface(obj, SESSION_IFACE).Close()
        except Exception:
            pass
        self.session_handle = None
        self.streams = []
        self.restore_token = restore_token if keep_restore_token else None
        if self.closed_match:
            try:
                self.closed_match.remove()
            except Exception:
                pass
            self.closed_match = None

    def _on_closed(self, _details):
        self.session_handle = None
        self.streams = []
        self.restore_token = None

    def start(self, source_types=SOURCE_MONITOR | SOURCE_WINDOW, cursor_mode=None, persist_mode=0):
        persist_mode = int(persist_mode or 0)
        self._close_current(keep_restore_token=bool(persist_mode))

        source_types = int(source_types or (SOURCE_MONITOR | SOURCE_WINDOW)) & int(self.available_sources or 0xFFFFFFFF)
        if source_types == 0:
            source_types = int(self.available_sources or SOURCE_MONITOR)

        if cursor_mode is None:
            cursor_mode = CURSOR_EMBEDDED if (int(self.available_cursors) & CURSOR_EMBEDDED) else CURSOR_HIDDEN
        cursor_mode = int(cursor_mode)
        if not (int(self.available_cursors) & cursor_mode):
            cursor_mode = CURSOR_EMBEDDED if (int(self.available_cursors) & CURSOR_EMBEDDED) else CURSOR_HIDDEN

        session_token = self._token("session")
        create_results = self._request(
            lambda options: self.screencast.CreateSession(options),
            {"session_handle_token": variant_string(session_token)},
            timeout_seconds=30,
        )
        session_handle = create_results.get("session_handle") or self._session_path(session_token)
        self.session_handle = str(session_handle)

        session_object = self.bus.get_object(PORTAL_BUS, self.session_handle)
        self.closed_match = session_object.connect_to_signal("Closed", self._on_closed, dbus_interface=SESSION_IFACE)

        select_options = {
            "types": variant_uint32(source_types),
            "multiple": variant_bool(False),
            "cursor_mode": variant_uint32(cursor_mode),
        }
        if persist_mode and self.version >= 4:
            select_options["persist_mode"] = variant_uint32(persist_mode)
            if self.restore_token:
                select_options["restore_token"] = variant_string(self.restore_token)

        self._request(
            lambda options: self.screencast.SelectSources(dbus.ObjectPath(self.session_handle), options),
            select_options,
            timeout_seconds=300,
        )

        start_results = self._request(
            lambda options: self.screencast.Start(dbus.ObjectPath(self.session_handle), "", options),
            {},
            timeout_seconds=300,
        )

        self.streams = list(start_results.get("streams") or [])
        self.restore_token = start_results.get("restore_token")
        if not self.restore_token and self.streams:
            props = self.streams[0][1] if len(self.streams[0]) > 1 else {}
            if isinstance(props, dict):
                self.restore_token = props.get("restore_token")

        if not self.streams:
            raise PortalError("portal returned no PipeWire streams")

        return self.status()

    def status(self):
        return {
            "active": bool(self.session_handle and self.streams),
            "sessionHandle": self.session_handle,
            "streamLabel": self.stream_label(),
            "streams": self.streams,
            "portalVersion": self.version,
            "availableSources": self.available_sources,
            "availableCursors": self.available_cursors,
        }

    def stream_label(self):
        if not self.streams:
            return None
        node_id, props = self.streams[0]
        props = props or {}
        size = props.get("size")
        source_type = int(props.get("source_type", 0) or 0)
        if source_type == SOURCE_MONITOR:
            kind = "monitor"
        elif source_type == SOURCE_WINDOW:
            kind = "window"
        else:
            kind = "surface"
        if isinstance(size, (list, tuple)) and len(size) == 2:
            return f"{kind} node {int(node_id)} ({int(size[0])}×{int(size[1])})"
        return f"{kind} node {int(node_id)}"

    def _open_pipewire_remote_fd(self):
        if not self.session_handle:
            raise PortalError("no active portal session; run /surface-share first")
        unix_fd = self.screencast.OpenPipeWireRemote(dbus.ObjectPath(self.session_handle), dbus.Dictionary({}, signature="sv"))
        return unix_fd.take() if hasattr(unix_fd, "take") else int(unix_fd)

    def capture(self, path):
        if not self.streams:
            raise PortalError("no shared stream; run /surface-share first")

        node_id, props = self.streams[0]
        props = props or {}
        fd = self._open_pipewire_remote_fd()

        os.makedirs(os.path.dirname(path), exist_ok=True)

        pipeline = None
        try:
            pipeline = Gst.Pipeline.new("pi-wayland-surface-shot")
            src = Gst.ElementFactory.make("pipewiresrc", "src")
            queue = Gst.ElementFactory.make("queue", "queue")
            convert = Gst.ElementFactory.make("videoconvert", "convert")
            caps = Gst.ElementFactory.make("capsfilter", "caps")
            enc = Gst.ElementFactory.make("pngenc", "png")
            sink = Gst.ElementFactory.make("filesink", "sink")

            elements = [src, queue, convert, caps, enc, sink]
            if any(element is None for element in elements):
                raise PortalError("missing GStreamer elements for PipeWire PNG capture")

            src.set_property("fd", fd)
            src.set_property("path", str(int(node_id)))
            src.set_property("client-name", "pi-wayland-surface")
            src.set_property("num-buffers", 1)
            if src.find_property("always-copy"):
                src.set_property("always-copy", True)
            enc.set_property("snapshot", True)
            caps.set_property("caps", Gst.Caps.from_string("video/x-raw,format=RGBA"))
            sink.set_property("location", path)

            for element in elements:
                pipeline.add(element)

            for left, right in zip(elements, elements[1:]):
                if left.link(right):
                    continue
                raise PortalError(f"failed to link GStreamer screenshot pipeline at {left.name} → {right.name}")

            pipeline.set_state(Gst.State.PLAYING)
            bus = pipeline.get_bus()
            message = bus.timed_pop_filtered(30 * Gst.SECOND, Gst.MessageType.ERROR | Gst.MessageType.EOS)
        finally:
            if pipeline is not None:
                pipeline.set_state(Gst.State.NULL)
            try:
                os.close(fd)
            except OSError:
                pass

        if message is None:
            raise PortalError("GStreamer screenshot capture timed out")
        if message.type == Gst.MessageType.ERROR:
            error, debug = message.parse_error()
            raise PortalError(f"GStreamer capture failed: {error.message}; {debug or ''}".strip())

        stat = os.stat(path)
        if stat.st_size <= 0:
            raise PortalError("GStreamer produced an empty screenshot")

        size = props.get("size")
        result = {"path": path, "bytes": stat.st_size, "streamLabel": self.stream_label()}
        if isinstance(size, (list, tuple)) and len(size) == 2:
            result["width"] = int(size[0])
            result["height"] = int(size[1])
        return result

    def stop(self):
        self._close_current()
        return {"active": False}


def main():
    session = ScreenCastSession()

    for line in sys.stdin:
        if not line.strip():
            continue

        request_id = None
        try:
            request = json.loads(line)
            request_id = int(request.get("id"))
            method = request.get("method")
            params = request.get("params") or {}

            if method == "start":
                result = session.start(
                    source_types=params.get("sourceTypes", SOURCE_MONITOR | SOURCE_WINDOW),
                    cursor_mode=params.get("cursorMode"),
                    persist_mode=params.get("persistMode", 0),
                )
            elif method == "status":
                result = session.status()
            elif method == "capture":
                result = session.capture(str(params.get("path")))
            elif method == "stop":
                result = session.stop()
            elif method == "shutdown":
                result = session.stop()
                print(json.dumps({"id": request_id, "ok": True, "result": result}), flush=True)
                return
            else:
                raise PortalError(f"unknown method: {method}")

            print(json.dumps({"id": request_id, "ok": True, "result": clean(result)}), flush=True)
        except Exception as exc:
            eprint(traceback.format_exc())
            print(json.dumps({"id": request_id, "ok": False, "error": str(exc)}), flush=True)


if __name__ == "__main__":
    main()
