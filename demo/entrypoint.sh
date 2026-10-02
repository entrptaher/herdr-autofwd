# Boots the demo machine: your key, two web servers owned by "dev" (forwarded automatically), one owned
# by root (not forwarded automatically; add it with + in the Ports panel), then sshd.
set -e
install -d -o dev -m 700 /home/dev/.ssh
printf '%s\n' "$AUTHORIZED_KEY" >/home/dev/.ssh/authorized_keys
chown dev /home/dev/.ssh/authorized_keys
chmod 600 /home/dev/.ssh/authorized_keys

site() { # port, title
  mkdir -p "/srv/$1"
  printf '<!doctype html><title>%s</title><body style="font:16px system-ui;margin:3em"><h1>%s</h1><p>Served on port %s inside the autofwd-demo container, forwarded to your computer by autofwd.</p>\n' \
    "$2" "$2" "$1" >"/srv/$1/index.html"
}
site 3000 "Web app"
site 5173 "Vite dev server"
site 9000 "Root-owned service"
chown -R dev /srv/3000 /srv/5173
su dev -s /bin/sh -c 'python3 -m http.server 3000 -d /srv/3000 >/dev/null 2>&1 &
  python3 -m http.server 5173 -d /srv/5173 --bind 127.0.0.1 >/dev/null 2>&1 &'
python3 -m http.server 9000 -d /srv/9000 >/dev/null 2>&1 &
exec /usr/sbin/sshd -D -e
