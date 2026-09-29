# Third-party notices

Night Identifier is licensed under the AGPL-3.0 (see [LICENSE](LICENSE)). It uses the following third-party
software and data, which keep their own licences. The in-app **About → Credits** page lists every data source in full.

## Software

| Component | Licence | Notes |
|---|---|---|
| Ultralytics (YOLO), ultralytics-thop | AGPL-3.0 | Why this project is AGPL-3.0 |
| pi_heif / libheif | BSD-3-Clause / LGPL-3.0 | HEIC image support, used as a library |
| certifi | MPL-2.0 | Unmodified |
| PyTorch, torchvision | BSD-3-Clause | The PyTorch CUDA wheel includes NVIDIA cudart, cuBLAS and cuDNN, which NVIDIA licenses for redistribution inside applications under the CUDA Toolkit EULA and cuDNN SLA. They stay under NVIDIA's terms, not the AGPL |
| rawpy / LibRaw | MIT / LGPL-2.1 or CDDL-1.0 | RAW image decoding |
| OpenCV, NumPy, psutil, FastAPI, SQLAlchemy, Pillow and the other Python packages | BSD / MIT / Apache-2.0 | Permissive |
| Electron, React, Three.js and the other npm packages | MIT / BSD / Apache-2.0 | No GPL-family licences found |

## Data and artwork

| Data | Licence |
|---|---|
| OpenNGC (deep-sky objects) | CC BY-SA 4.0 |
| Stellarium "modern" sky culture (constellation art and data) | Free Art License 1.3 (art), CC BY-SA 4.0 (data) |
| Hipparcos / d3-celestial (star catalogue) | ESA / BSD-style, attributed |
| Solar System Scope planet maps | CC BY 4.0 |
| DB-IP Lite (IP geolocation, downloaded at build time, not stored in the repo) | CC BY 4.0 |
| NASA, NOAA, USGS, JPL data feeds | Public domain |
| Natural Earth | Public domain |
| Sentinel-2 cloudless by EOX (streamed, not bundled) | CC BY-NC-SA 4.0, **non-commercial use only** |
| Wikipedia / Wikimedia Commons photographs | Fetched live, never bundled. Each image's author and licence are read from Commons and shown beside it in the app |
| Sky survey images (DSS and similar) | Fetched live, never bundled. Free for education and research, credit required |

## Not included

The Canon EDSDK is licensed by Canon and cannot be redistributed. It is excluded from this repository and from
the released installer. Users who want Canon camera control must obtain it from Canon themselves.
