# JUGAADTV

A responsive React live-TV player with a Node/Express API. It automatically loads the public IPTV-Org M3U playlist and keeps favorites and recent channels in browser storage.

## Requirements

- Node.js 20.19+ (or 22.12+)
- npm

## Development

```sh
npm install
ADMIN_PASSWORD='choose-a-local-admin-password' npm run dev
```

Open <http://localhost:5173>. Vite serves the React UI and proxies `/api` requests to Express on port 3000. The admin password is optional; without it, admin sign-in is disabled. Both development servers bind to `127.0.0.1` by default. For a trusted network deployment, set `HOST=0.0.0.0`. Stop both development processes with Ctrl+C.

To run only the API server, use `npm run server`. To create and serve the production frontend, run:

```sh
npm run build
NODE_ENV=production ADMIN_PASSWORD='choose-a-local-admin-password' npm start
```

The production app is available at <http://localhost:3000>.

## Deploy on Render

The repository includes a `render.yaml` Blueprint for the Node web service, production build, and `/api/health` check. Push this project to a GitHub repository, then create a new Blueprint in Render from that repository. Render will build and start JUGAADTV and assign its public HTTPS URL. Add a private `ADMIN_PASSWORD` environment variable in Render only if you want to enable the admin login.

## Features

- HLS and browser-native live playback
- Search, country and category filters
- Favorites and watch history stored in the browser
- Opens on Recently watched and resumes the last available channel; first-time visitors get the intro and Colors (576p) as the starter channel
- Separate `/admin` dashboard with an optional password-protected playlist refresh
- Adaptive/manual HLS rendition selection with a lower-quality recovery attempt after a sustained stall
- HTTP 403/404/410 and fatal HLS errors trigger automatic channel failover; a sustained stall gets one lower-quality recovery attempt first
- Responsive black-and-red interface
- A colorful, poster-style Hot on JUGAADTV carousel featuring non-geo-blocked 576p Colors, documentary, and movie streams, with channel logos and one-tap playback
- A dedicated Creator tab and About Me panel featuring Farman Haider, his supplied portrait, LinkedIn portfolio, and contact/support links
- A 5.2-second cinematic train intro inside the player: a locomotive rushes toward the camera over perspective rails, then the JUGAADTV name reveals letter by letter with a polished studio-style light sweep and old-film shutter effect
- An original synthesized steam, rail and vintage-projector shutter sound; the remembered sound toggle, skip control, and reduced-motion support remain available

The channel list loads automatically; there is no playlist upload option. The playlist is an index of third-party public streams. HLS uses the same direct hls.js startup pattern as the working reference; if a provider blocks browser access, playback retries through the API relay, which rewrites HLS manifests so segments stay same-origin. The relay only accepts playlist channels and publicly routable upstream URLs. Individual streams can still be unavailable, geo-restricted, slow, or unsupported by a browser. Auto/HD quality options only appear when the selected HLS stream actually offers those renditions. In Auto mode, a sustained stall triggers one lower-quality/reconnect attempt without changing the selected channel. A definitive HTTP 403/404/410 or fatal HLS network error tries the relay first and then up to three following channels. Decoder/codec failures are reported without changing the selected channel; use the quality selector to retry at a different rendition. Safari uses native HLS when hls.js is unavailable; other browsers use hls.js with its default playback tuning. A manually selected quality is preserved. No player can improve a provider's bitrate, unblock regional restrictions, or add codec support that the browser lacks. Before channel playback or resume, the player runs a skippable, 5.2-second train rush intro; the JUGAADTV name appears letter by letter with a studio-style light sweep after the old-film shutter effect. An original train, steam, and vintage projector shutter sound is generated with Web Audio and can be muted with the top-bar sound toggle. Use only streams you are authorized to watch. Admin access is disabled unless `ADMIN_PASSWORD` is set. Visit `/admin` for the separate admin screen.
