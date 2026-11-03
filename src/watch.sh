# Runs on the SSH machine via `sh -s`, so nothing is installed there. Reports the TCP ports this
# user listens on, the way VS Code Remote-SSH finds them: "=ready" once, then "+PORT NAME" and
# "-PORT" as listeners come and go, "=ui DIR ROWS COLS" when the companion popup (companion/ui.sh)
# asks for the Ports panel, and an empty heartbeat line otherwise.
#
# Each system defines scan (one "PORT [NAME]" line per port, sorted by port), procname PORT (the
# program on a newly seen port; $snap holds the latest scan) and tick (seconds between scans).
uid=$(id -u)
case $(uname -s) in
Linux)
  [ -r /proc/net/tcp ] || { echo "=fatal no /proc/net/tcp on this Linux machine"; exit; }
  tick=0.5
  # LISTEN sockets owned by this user on loopback or all interfaces; system services are skipped.
  scan() {
    awk -v uid="$uid" '
      function hex(s,  i, n) { for (i = 1; i <= length(s); i++) n = n * 16 + index("0123456789ABCDEF", substr(s, i, 1)) - 1; return n }
      FNR > 1 && $4 == "0A" && $8 == uid {
        split($2, a, ":")
        if (a[1] ~ /^0+$/ || a[1] ~ /7F$/ || a[1] == "00000000000000000000000001000000") print hex(a[2])
      }' /proc/net/tcp /proc/net/tcp6 2>/dev/null | sort -un
  }
  procname() { ss -Hltnp "sport = :$1" 2>/dev/null | sed -n 's/.*users:(("\([^"]*\)".*/\1/p' | head -n 1; }
  ;;
Darwin)
  tick=1
  # A Mac usually runs apps that listen too (AirPlay on 5000 and 7000, helpers, launchd agents), so
  # only this user's programs started from a terminal count: the program or a process above it has
  # a controlling terminal. That covers herdr panes and SSH sessions, background jobs an agent starts
  # from a pane, and panes kept alive by a herdr live handoff, whose old server has exited. Apps,
  # launchd agents and brew services have no terminal anywhere above them. ps and lsof -p on just
  # those processes cost about 40 ms a scan; lsof on every process alone costs about 80.
  scan() {
    # tdev, not tt: naming each terminal triples the cost of ps
    pids=$(ps -axo pid=,ppid=,tdev= | awk '
      { up[$1] = $2; tty[$1] = ($3 != "??" && $3 != "-") }
      END { for (p in up) for (q = p; q > 1 && (q in up); q = up[q]) if (tty[q]) { print p; break } }' | paste -sd, -)
    [ -n "$pids" ] || return 0
    # -b and -w: don't stat (or hang on) network volumes such as Time Machine shares.
    lsof +c 0 -b -w -nP -a -p "$pids" -u "$uid" -iTCP -sTCP:LISTEN -Fcn 2>/dev/null | awk '
      /^c/ { c = substr($0, 2) }
      /^n/ {
        host = port = substr($0, 2)
        sub(/:[^:]*$/, "", host)
        sub(/.*:/, "", port)
        if (host == "*" || host ~ /^127\./ || host == "[::1]" || host == "localhost") print port, c
      }' | sort -u -k1,1n
  }
  procname() { printf '%s\n' "$snap" | awk -v p="$1" '$1 == p && NF > 1 { sub(/^[^ ]* /, ""); print; exit }'; }
  ;;
*)
  echo "=fatal autofwd works with Linux and macOS machines, and this one runs $(uname -s)"
  exit
  ;;
esac
echo =ready
prev=
while :; do
  snap=$(scan)
  cur=$(printf '%s\n' "$snap" | awk 'NF { print $1 }' | tr '\n' ' ')
  for r in "$HOME"/.cache/herdr-autofwd/ui.*/req; do
    [ -f "$r" ] && s=$(cat "$r") && rm -f "$r" && echo "=ui ${r%/req} $s"
  done
  if [ "$cur" = "$prev" ]; then
    echo # heartbeat: once SSH is gone this write fails and the loop exits
  else
    for p in $cur; do case " $prev " in *" $p "*) ;; *) echo "+$p $(procname "$p")" ;; esac; done
    for p in $prev; do case " $cur " in *" $p "*) ;; *) echo "-$p" ;; esac; done
    prev=$cur
  fi
  sleep "$tick" 2>/dev/null || sleep 1 # some busybox builds only take whole seconds
done
