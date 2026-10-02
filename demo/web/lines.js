// What the tour says: its subtitles, and the voiceover script. `say` is how the voice should pronounce
// a line; it keeps the same words, one for one, so each subtitle word lights up as it's spoken.
export const LINES = {
  intro: { text: "autofwd: automatic port forwarding for herdr.", say: "Auto-forward: automatic port forwarding for herder." },
  start: { text: "Start a dev server over SSH." },
  local: { text: "It's on your laptop's localhost. No config." },
  open: { text: "Open it like it's local." },
  clash: { text: "Same port on a second server? It takes the next free one." },
  panel: { text: "ctrl+b f opens the Ports panel.", say: "Control-B F opens the Ports panel." },
  refuse: { text: "Pick a taken port, and it says who has it." },
  free: { text: "Pick a free one, and it moves." },
  stop: { text: "Stop the server, and the forward goes away." },
  login: { text: "Logins work too: the OAuth callback reaches the server." },
  outro: { text: "One command to install." },
};
