# Bad Bus Dashcam

A phone web app for documenting dangerous bus driving: speeding, running red lights,
using a phone while driving and so on. Every video frame and photo gets a **burned-in overlay** showing:

- date and time (Israel time, with the UTC offset)
- live **speed** in km/h (GPS Doppler speed, or computed from consecutive fixes), plus the max speed
- the road's **speed limit** from OpenStreetMap, when known. The speed turns red when over it.
- **GPS position** (lat/lon), accuracy (±m), heading, altitude and the age of the GPS fix
- a 2‑minute speed graph (landscape)
- bus details: line, operator, number plate, fleet number, direction
- a red banner whenever you log an incident

## Features

| | |
|---|---|
| **Reports** | Everything is grouped into a **Report**, one per bus ride or incident. Tap **＋ New** to start a fresh report (e.g. when you change buses). **🗂 All** lists every report on the phone and lets you open, continue or delete one. |
| **Video** | Records camera + overlay + audio (MP4 on iPhone and recent Chrome, WebM elsewhere). The video is **written to the phone's storage every second while it records**, so a crash or closing the app loses only the last few seconds. |
| **Quick delete** | Start filming as soon as something *might* happen. When you stop, a bar offers **Delete…** or **Keep**. Every delete (video, photo, incident or whole report) asks for confirmation first. |
| **Space left** | A chip at the top of the screen shows about how many **minutes of recording space** are left at the chosen quality (≈ 46 MB/min at 1080p, ≈ 23 MB/min at 720p; once recording it uses the real rate). It turns amber under 30 min and red under 10, and recording stops by itself just before storage is full. |
| **Photos** | Choose a type (number plate, fleet number or line sign, driver ID card, driver, scene or traffic light), and the photo is stamped with time, GPS and bus details. Uses full camera resolution on Android Chrome for sharper plates. |
| **Incident buttons** | Four one-tap buttons: *Speeding, Dangerous driving, Phone while driving, Abusive behaviour*. Each logs the time, location, speed and position in the video. |
| **Auto over-limit** | If speed stays more than 5 km/h over the OSM limit for 5 s or longer, an incident is logged automatically. |
| **Save to phone** | Puts the whole report in **one folder** named like `BadBus-Report-003_2026-11-06_Line-480/`, containing the videos, photos, `report.txt` (the case file), `track.gpx` and `data.json`. See below. |

Nothing is uploaded anywhere. The only network request is the optional speed-limit lookup
to the OpenStreetMap Overpass API, which sends coordinates only.

## Where files are kept

1. **While you record:** in the browser's private storage for this app (it survives closing the app and
   restarting the phone, but you can't see it in the Files or Photos app). The app asks the browser to keep it
   permanently. A recording cut off by a crash is recovered and marked *recovered*.
2. **Save to phone** (in a report) copies it somewhere you can see it:
   - **Android / desktop Chrome:** you pick a folder once (e.g. *Documents*); each report becomes a subfolder in it.
   - **iPhone:** the share sheet opens. Choose **Save to Files** and create a folder with the report's name;
     all the files go into it together. **Save Video** puts a video in Photos instead.
   - **Download .zip** (any phone): one `.zip` that opens as the report folder. In the iPhone Files app, tap it to unzip.
3. After saving, you can delete the report in the app to free up space.

## Running it

The camera only works over **HTTPS**. The easiest way is GitHub Pages:

1. Repo → Settings → Pages → *Deploy from a branch* → pick the branch and `/ (root)`.
2. Open `https://<user>.github.io/bad-bus/` on your phone.
3. Use *Add to Home Screen* so it opens full-screen like an app.

To run locally: `python3 -m http.server 8000` and open `http://localhost:8000`.

## Tips for evidence that holds up

- Start recording **before** the bad driving happens if you can. Short clips are fine.
- **Keep the app in the foreground with the screen on.** Browsers pause drawing in the background,
  which freezes the video.
- Get a clear photo of the **number plate** or the **fleet number** painted on the bus. The
  gov.il form asks for the bus licence number, the line number and the driver's details.
- Hold the phone steady against a window. Speed is most accurate with a clear view of the sky
  (watch the ±m value).
- Use a new report for each bus, so each folder holds one complaint.
- Don't distract or confront the driver.

## Where to complain

- Ministry of Transport online form: [Complaint about conduct in public transportation](https://www.gov.il/he/service/complaint_about_conduct_in_public_transportation).
  You need the place, date, time, bus licence number, line and driver details, plus your full name,
  ID number, address and mobile number. Complaints must be filed **within two months**.
  Anonymous complaints are not handled.
- National Public Transport Authority info line: **\*8787**
- The bus operator's own complaint service
- For traffic offences or violence: the **police**

## Files

`index.html`, `style.css`, `app.js` (capture, overlay, reports UI), `storage.js` (saving, export, zip), `opfs-worker.js` (writes video while recording), `sw.js` (offline cache), `manifest.webmanifest`, `icons/`.
No build step and no dependencies.
