# Runs on the SSH machine via `sh -s`, so nothing is installed there. Reports the TCP ports this
# user listens on, the way VS Code Remote-SSH finds them: "=ready" once, then "+PORT NAME" and
# "-PORT" as listeners come and go, "=ui DIR ROWS COLS" when the companion popup (companion/ui.sh)
# asks for the Ports panel, and an empty heartbeat line otherwise.
[ -r /proc/net/tcp ] || { echo "=fatal needs a Linux machine (no /proc/net/tcp there)"; exit; }
echo =ready
uid=$(id -u) prev=
while :; do
  # LISTEN sockets owned by this user on loopback or all interfaces; system services are skipped.
  cur=$(awk -v uid="$uid" '
    function hex(s,  i, n) { for (i = 1; i <= length(s); i++) n = n * 16 + index("0123456789ABCDEF", substr(s, i, 1)) - 1; return n }
    FNR > 1 && $4 == "0A" && $8 == uid {
      split($2, a, ":")
      if (a[1] ~ /^0+$/ || a[1] ~ /7F$/ || a[1] == "00000000000000000000000001000000") print hex(a[2])
    }' /proc/net/tcp /proc/net/tcp6 2>/dev/null | sort -un | tr '\n' ' ')
  for r in "$HOME"/.cache/herdr-autofwd/ui.*/req; do
    [ -f "$r" ] && s=$(cat "$r") && rm -f "$r" && echo "=ui ${r%/req} $s"
  done
  if [ "$cur" = "$prev" ]; then
    echo # heartbeat: once SSH is gone this write fails and the loop exits
  else
    for p in $cur; do case " $prev " in *" $p "*) ;; *)
      echo "+$p $(ss -Hltnp "sport = :$p" 2>/dev/null | sed -n 's/.*users:(("\([^"]*\)".*/\1/p' | head -n 1)" ;;
    esac; done
    for p in $prev; do case " $cur " in *" $p "*) ;; *) echo "-$p" ;; esac; done
    prev=$cur
  fi
  sleep 0.5 2>/dev/null || sleep 1 # some busybox builds only take whole seconds
done
