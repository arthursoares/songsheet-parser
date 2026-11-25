"""Fail if an anonymous client can read a GHCR repository or image tag."""

import json
import sys
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


def check_privacy(image: str, tag: str | None = None) -> None:
    name = image.removeprefix("ghcr.io/")
    scope = urlencode({"service": "ghcr.io", "scope": f"repository:{name}:pull"})
    resource = f"manifests/{tag}" if tag else "tags/list?n=1"
    try:
        with urlopen(f"https://ghcr.io/token?{scope}", timeout=30) as response:
            token = json.load(response)["token"]
        request = Request(
            f"https://ghcr.io/v2/{name}/{resource}",
            headers={
                "Authorization": f"Bearer {token}",
                "Accept": "application/vnd.oci.image.index.v1+json, "
                "application/vnd.oci.image.manifest.v1+json, "
                "application/vnd.docker.distribution.manifest.list.v2+json, "
                "application/vnd.docker.distribution.manifest.v2+json",
            },
        )
        with urlopen(request, timeout=30):
            raise SystemExit(f"Anonymous access to {image}/{resource} is enabled.")
    except HTTPError as error:
        if error.code not in {401, 403}:
            raise
        codes = {item["code"] for item in json.load(error)["errors"]}
        if not codes.intersection({"DENIED", "UNAUTHORIZED"}):
            raise
        print(f"Anonymous access to {image}/{resource} denied (HTTP {error.code}).")


if __name__ == "__main__":
    check_privacy(*sys.argv[1:])
