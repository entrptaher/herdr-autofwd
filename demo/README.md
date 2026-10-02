# Demo servers

Two throwaway "servers" to try autofwd on: Docker Desktop containers with sshd, the herdr build matching
yours, and the same three web servers each, so they clash on purpose.

```bash
demo/demo.sh up     # build, start, connect; prints what to try
demo/demo.sh down   # remove everything below
```

## What `up` does

- **SSH:** creates the key `~/.ssh/autofwd_demo_ed25519` and appends a marked block to
  `~/.ssh/config` with `Host autofwd-demo` (port 2222) and `Host autofwd-demo-2` (port 2223).
- **Docker Desktop:** starts the containers `autofwd-demo` and `autofwd-demo-2`, on `127.0.0.1` only.
  They restart on their own with Docker Desktop and stay up until `down`.
- **herdr:** links the plugin, (re)starts forwarding with this checkout's code, and saves both
  containers as machines.

## What's inside each

| Port | Owner | What happens |
| --- | --- | --- |
| 3000 | `dev` | forwarded automatically |
| 5173 | `dev`, localhost only | forwarded automatically |
| 9000 | root | not forwarded automatically (another user's); add it with `+` |

Both machines serve 3000 and 5173, so whichever connects second gets **3001** and **5174**. Its rows
show the reason: *localhost:3000 is used by the forward from autofwd-demo (3000)*.

## Things to try

- **Open the panel:** press prefix+f in herdr for the floating Ports panel, or run
  `node src/cli.js ports-ui` in any terminal.
- **See a conflict:** select one of the second machine's rows. The full reason shows above the buttons.
- **Edit a forward:** press `e` (or right-click → Edit…) and set the local port to one that's taken, to
  see the error. Pick a free one and Enter.
- **Forward to another host:** press `+`, choose a machine with ◂ ▸, and type a remote host and port
  that machine can reach.
- **Watch a port appear:** `ssh autofwd-demo python3 -m http.server 8080`. It shows up within a second,
  and Ctrl-C makes it go away.

`down` removes both saved machines, the containers and their image, the SSH block and the key. The
plugin stays linked (`herdr plugin unlink autofwd` removes it), and so does the herdr integration if you
turned it on (press S in the panel to remove it).
