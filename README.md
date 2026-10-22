# Clock Calendar

Today, drawn as two bands around a clock. The inner band is the morning, the outer band is the afternoon and evening. The band for the half of the day you're in is shown at full strength; the other is dimmed. As time passes, the part of an event that's behind the hand darkens, and the event disappears once it's over. Hover anywhere over the clock to see finished events (darkened); this can be turned off in settings. You can add and move events in the greyed-out past too, e.g. to log something that happened. The clock shows today only.

- Event names are written along their arcs when there's room. Each band has a ruler with hour and 5-minute marks.
- The part of the day that's over is greyed out on the rings.
- **Add an event:** drag a 15m, 30m or 1h pill from the tray under the clock onto a ring. A dashed preview shows exactly where it will land, placed by its edges. Double-click a pill to drop it into the earliest free spot today. Click a pill to choose the colour for new events. You can also double-click an empty spot on a ring (adds 30 minutes in that half hour), or press and drag along an empty ring to "paint" an event.
- **Focus and edit:** click an event to show it in the line under the clock. Double-click it (or press Enter) to name it, recolour it or delete it.
- **Move and resize:** drag an event to move it; it keeps its length and can hop between the AM and PM rings. Hover over an edge and drag to resize. Times snap to 15 minutes, and the arrow keys nudge a focused event by 15 minutes.
- **Remove:** Delete/Backspace on a focused event, or the bin in the editor. An Undo button appears for 5 seconds. Synced events (Google, Apple, …) are read-only here, so they are hidden on this clock instead.
- Until you connect a calendar, the clock shows a demo day made of ordinary events you can move, resize and delete. Connecting a calendar removes it.
- Clock styles (in settings): **Ticking** (default; the second hand steps each second), **Sweep** (the second hand glides), and **Minimal** (no hands, a digital time in the middle).
- Hover over the clock to see the AM/PM labels. The `···` button (bottom right) opens settings.

## Run it

```sh
npm install
npm start
```

Then open http://localhost:4321.

| URL | What it does |
| --- | --- |
| `/` | The clock |
| `/?widget` | Widget mode: no settings button, transparent background |
| `/?at=15:40` | Preview a different time of day |
| `/?style=minimal` | Force a clock style (`ticking`, `sweep`, `minimal`) |

To use it like a desktop widget, open it in Chrome or Edge and choose **Install app** from the menu. It then runs in its own small window that you can resize to a square.

## Online version (GitHub Pages)

https://danny-lesage.github.io/clock-calendar/ is deployed from `public/` on every push to `main`.

Without the server, the app runs entirely in the browser. Google Calendar signs in with a Google popup, and the sign-in is kept in your browser (it lasts about an hour, then a **Reconnect Google** button appears). iCloud and calendar links need the server, so they only work in the version running on your computer.

The Google client ID used online is in `public/config.js` (client IDs aren't secret). Its OAuth client must list `https://danny-lesage.github.io` under **Authorised JavaScript origins**.

## Connect your calendars

Open settings (`···`, bottom right) and pick **Google**, **iCloud** or **Link**.

Google and iCloud sync **both ways**. Events added in Google or Apple Calendar show up on the clock within a minute, and adding, renaming, moving, resizing or deleting an event on the clock changes it there too. **New events go to** (in settings) picks the calendar for events you add here. It defaults to your main Google calendar, or your first iCloud calendar.

Repeating events (a weekly standup, say) are shown but can't be changed from the clock yet. Change them in Google or Apple Calendar.

### Google

The first time, the Google panel walks you through a one-time setup (about 3 minutes): create a Google Cloud project, turn on the Calendar API, set up the consent screen with yourself as a test user, and create an OAuth client with the redirect URI shown (there's a copy button). Paste the client ID and secret, and you're sent to Google to allow access. After that, connecting is one click.

The setup is needed because this app runs on your own computer rather than as a hosted service, so it needs its own Google app ID. The ID is saved in `data/google-client.json`, and your sign-in in `data/google-token.json`. You can also put `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in `.env` instead.

### iCloud

Enter your Apple ID email and an **app-specific password**. Your normal Apple password won't work. Make one at [account.apple.com](https://account.apple.com/account/manage) → Sign-In and Security → App-Specific Passwords. They're saved in `data/apple.json` on this computer only. Remove the account in settings to delete them, and you can revoke the password at account.apple.com at any time.

### Link (read-only)

Paste any `.ics` or `webcal://` link, such as an Outlook, school or team calendar. Links are checked every 5 minutes.

## Files

- `public/clock.js`: draws the bands, the wipe, the arc labels and the hands
- `public/app.js`: keeps the clock ticking, plus the caption and the settings panel
- `public/sources.js`: loads events from calendar links, Google and the demo
- `server.js`: serves the app and downloads calendar links for the browser
- `lib/ics.js`: reads `.ics` calendars, including repeating events and time zones
- `lib/google.js`: Google sign-in and two-way sync
- `lib/apple.js`: iCloud two-way sync (CalDAV)

Run the tests with `npm test`. The iCloud tests run against a small fake CalDAV server.
