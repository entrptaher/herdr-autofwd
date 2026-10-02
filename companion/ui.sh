# The Ports panel's floating window on an SSH machine. The panel runs on your computer (autofwd): this
# leaves a request that autofwd's port watcher reports, then relays keys and screen through two FIFOs that
# autofwd opens over its existing SSH connection.
base="$HOME/.cache/herdr-autofwd"
umask 077
mkdir -p "$base" && d=$(mktemp -d "$base/ui.XXXXXX") || exit 1
saved=$(stty -g)
keys=
trap 'stty "$saved" 2>/dev/null; [ -n "$keys" ] && kill "$keys" 2>/dev/null; rm -rf "$d"' EXIT
trap 'exit 1' INT TERM HUP
mkfifo "$d/in" "$d/out" || exit 1
stty size >"$d/req.tmp" && mv "$d/req.tmp" "$d/req"

i=0
while [ ! -e "$d/attached" ]; do # autofwd answers within about a second
  i=$((i + 1))
  if [ "$i" -gt 50 ]; then
    printf '\n  The Ports panel runs on your computer, and autofwd there is not connected\n'
    printf '  to this machine right now. Open the panel on your computer (prefix+f while\n'
    printf '  viewing Local) to see why; often the SSH key needs ssh-add.\n\n  Press any key to close.'
    stty raw -echo
    dd bs=1 count=1 >/dev/null 2>&1
    exit 1
  fi
  sleep 0.1 2>/dev/null || { sleep 1; i=$((i + 9)); } # some busybox builds only take whole seconds
done

stty raw -echo
exec 3<&0
cat <&3 >"$d/in" & # keys -> your computer
keys=$!
trap 'printf "\033[8;%s;%st" $(stty size) >"$d/in"' WINCH # resize report for the panel
cat "$d/out" &                                             # screen <- your computer; ends when it closes
screen=$!
while kill -0 "$screen" 2>/dev/null; do wait "$screen"; done
