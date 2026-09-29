"""TLS trust for the backend's outgoing HTTPS requests (image archives, catalogue services, ...).

On Windows Python trusts only the roots already in the Windows certificate store, and Windows adds
a root there lazily the first time something needs it. A machine that has never visited a site
signed by one of them fails with "unable to get local issuer certificate". Adding the bundled
certifi roots on top of the system store fixes that without trusting anything less than before.
"""

import ssl

_installed = False


def install() -> None:
    """Make urllib's default HTTPS context trust certifi's roots as well as the system's."""
    global _installed
    if _installed:
        return
    _installed = True
    try:
        import certifi
    except ImportError:
        return
    original = ssl.create_default_context

    def create_default_context(purpose=ssl.Purpose.SERVER_AUTH, *, cafile=None, capath=None, cadata=None):
        ctx = original(purpose, cafile=cafile, capath=capath, cadata=cadata)
        if purpose == ssl.Purpose.SERVER_AUTH and cafile is None and capath is None and cadata is None:
            try:
                ctx.load_verify_locations(cafile=certifi.where())
            except (OSError, ssl.SSLError):
                pass
        return ctx

    ssl.create_default_context = create_default_context
    ssl._create_default_https_context = create_default_context
