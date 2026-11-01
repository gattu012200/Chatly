# Chatly

A real-time messaging web app in the style of WhatsApp Web. One small Node server, a plain HTML/CSS/JS frontend, no build step.

## Run it

Requires Node.js 18 or newer.

```bash
cd chatly
npm install      # installs the single dependency: ws
npm start        # http://localhost:3000
```

Set `PORT=8080 npm start` to use another port.

To try it, open the app in two different browsers (or one normal window and one private window), create two accounts, then start a chat from one using the other's phone number.

To use it from a phone on the same Wi-Fi, open `http://<your-computer-ip>:3000`.

## Features

- Sign up and sign in with phone number and password
- One-to-one chats, started by phone number
- Group chats with a member list
- Real-time delivery over WebSockets, with automatic reconnect
- Message status: sent (✓), delivered (✓✓), read (blue ✓✓)
- "Typing…" indicator, online status, last seen
- Unread badges, chat search, desktop notifications for background tabs
- Reply to a message, with a quote that jumps back to the original
- Delete your own message for everyone
- Send images, files, audio and video (up to 10 MB each); paste images from the clipboard
- Emoji picker, profile name and "about" editing
- Light and dark theme, responsive layout (single-pane on phones)

## Layout

```
server.js        HTTP API, static files, WebSocket server
public/          index.html, style.css, app.js
data/db.json     created automatically; users, chats, messages
uploads/         uploaded files
```

## Before putting it on the internet

This is a solid starting point, not a hardened product.

- Serve it over HTTPS (for example behind Caddy or nginx), otherwise passwords and messages travel in clear text.
- Messages are stored unencrypted in `data/db.json`. WhatsApp's end-to-end encryption is not included.
- Sign-up does not verify phone numbers (no SMS OTP). Add an SMS provider if you need that.
- Storage is a single JSON file, which suits a few hundred users. For more, move to PostgreSQL or SQLite.
- Add rate limiting on `/api/login` and `/api/register`.
- Voice and video calls, status/stories, and push notifications when the browser is closed are not implemented.
