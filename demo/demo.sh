#!/bin/sh
# Two demo machines to try autofwd on: Docker Desktop containers reachable as `ssh autofwd-demo` and
# `ssh autofwd-demo-2`, saved in herdr, with autofwd linked and running. Both serve the same ports, so
# the second machine's forwards show what a port conflict looks like.
# Usage: demo/demo.sh up | down
set -eu
here=$(cd "$(dirname "$0")" && pwd)
root=$(dirname "$here")
export DOCKER_CONTEXT=desktop-linux
machines="autofwd-demo:2222 autofwd-demo-2:2223" # name:local ssh port
key="$HOME/.ssh/autofwd_demo_ed25519"
cfg="$HOME/.ssh/config"
begin="# --- autofwd demo machine (remove with: $here/demo.sh down) ---"
end="# --- end autofwd demo machine ---"

machine_id() { # saved herdr machine id for an SSH target, or ""
  herdr machine list --json | node -e 'let d = ""; process.stdin.on("data", (c) => (d += c)).on("end", () =>
    console.log(JSON.parse(d).find((m) => m.target === process.argv[1])?.id ?? ""))' "$1"
}

remove_ssh_block() { # our block and the one blank line before it
  grep -qF -- "$begin" "$cfg" 2>/dev/null || return 0
  awk -v b="$begin" -v e="$end" '
    skip { if ($0 == e) skip = 0; next }
    $0 == b { skip = 1; blank = 0; next }
    $0 == "" { if (blank) print ""; blank = 1; next }
    { if (blank) print ""; blank = 0; print }
    END { if (blank) print "" }' "$cfg" >"$cfg.autofwd-tmp"
  cat "$cfg.autofwd-tmp" >"$cfg" # keeps the file's permissions
  rm -f "$cfg.autofwd-tmp"
}

up() {
  [ -f "$key" ] || ssh-keygen -q -t ed25519 -N '' -C autofwd-demo -f "$key"
  remove_ssh_block # rewritten each time, so it always lists every demo machine
  {
    printf '\n%s\n' "$begin"
    for m in $machines; do
      printf 'Host %s\n  HostName 127.0.0.1\n  Port %s\n  User dev\n  IdentityFile %s\n  IdentitiesOnly yes\n' "${m%:*}" "${m#*:}" "$key"
      printf '  StrictHostKeyChecking no\n  UserKnownHostsFile /dev/null\n  LogLevel ERROR\n'
    done
    printf '%s\n' "$end"
  } >>"$cfg"
  # The herdr build on the machines matches yours, so `herdr machine add` has nothing to install.
  version=$(herdr --version | awk '{print $2}')
  case $version in *-preview.*) tag="preview-${version#*-preview.}" ;; *) tag="v$version" ;; esac
  echo "building the demo machines (herdr $version)..."
  docker build -q -t autofwd-demo --build-arg HERDR_TAG="$tag" "$here" >/dev/null
  for m in $machines; do
    name=${m%:*}
    if [ -z "$(docker ps -q -f "name=^$name\$")" ]; then
      docker rm -f "$name" >/dev/null 2>&1 || :
      docker run -d --name "$name" --restart unless-stopped -p "127.0.0.1:${m#*:}:22" \
        -e AUTHORIZED_KEY="$(cat "$key.pub")" autofwd-demo >/dev/null
    fi
  done
  for m in $machines; do
    i=0
    until ssh -o BatchMode=yes "${m%:*}" true 2>/dev/null; do
      i=$((i + 1))
      [ "$i" -lt 60 ] || { echo "${m%:*} didn't come up; see: docker logs ${m%:*}" >&2; exit 1; }
      sleep 0.5
    done
  done
  # Re-link every time: herdr keeps the manifest it saw at link time.
  herdr plugin unlink autofwd >/dev/null 2>&1 || :
  herdr plugin link "$root" >/dev/null
  herdr plugin action invoke autofwd.restart >/dev/null # (re)start forwarding with this checkout's code
  for m in $machines; do
    [ -n "$(machine_id "${m%:*}")" ] || herdr machine add "${m%:*}" </dev/null
  done
  cat <<EOF

Ready. Both demo machines run web servers on 3000 and 5173 (forwarded automatically) and a root-owned
one on 9000 (add it with + in the panel). They clash on purpose: whichever connects second gets its
ports moved to 3001 and 5174, and the panel says why.

  Ports panel in this terminal:   node $root/src/cli.js ports-ui
  In herdr:                       press prefix+f (ctrl+b f) for the floating Ports panel
  A forwarded page:               open http://localhost:3000
  A new server to watch appear:   ssh autofwd-demo python3 -m http.server 8080   (Ctrl-C to stop)
  Shell on a demo machine:        ssh autofwd-demo   or   ssh autofwd-demo-2
  Remove the demo:                $here/demo.sh down
EOF
}

down() {
  for m in $machines; do
    id=$(machine_id "${m%:*}")
    [ -z "$id" ] || herdr machine remove "$id" >/dev/null
    docker rm -f "${m%:*}" >/dev/null 2>&1 || :
  done
  docker rmi autofwd-demo >/dev/null 2>&1 || :
  remove_ssh_block
  rm -f "$key" "$key.pub"
  echo "demo removed (the autofwd plugin stays linked; herdr plugin unlink autofwd removes it)"
}

case ${1-} in
up) up ;;
down) down ;;
*) echo "usage: $0 up | down" >&2; exit 2 ;;
esac
