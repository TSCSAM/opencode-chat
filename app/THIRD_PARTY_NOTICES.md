# Third-party notices

## Psiphon tunnel client

This app can run the official Psiphon tunnel client locally to provide regional
egress routes for the relay feature. The unmodified client binaries and the
signed server list are distributed with the app in `server/psiphon/`:

- `psiphon-tunnel-core-windows-i686.exe` (Windows, 32-bit x86)
- `psiphon-tunnel-core-linux-amd64` (Linux, x86-64)
- `psiphon.json`, `server-list.dat`

The Windows client reports:

```
Psiphon Console Client
  Build Date: 2026-11-10T18:30:08+00:00
  Repository: https://github.com/Psiphon-Labs/psiphon-tunnel-core.git
  Revision: 59c68e0e05
```

Psiphon tunnel-core is free software published under the GNU General Public
License, version 3. The complete license text is in `server/psiphon/LICENSE`.
The corresponding source code, build instructions and release history are
available at:

<https://github.com/Psiphon-Labs/psiphon-tunnel-core>

Psiphon is a trademark of Psiphon Inc. This app is an independent project and
is not affiliated with, endorsed by, or sponsored by Psiphon Inc.