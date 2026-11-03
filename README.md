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
| **Video** | Records camera + overlay + audio (MP4 on iPhone and recent Chrome, WebM elsewhere). |
| **Photos** | Choose a type (number plate, fleet number or line sign, driver ID card, driver, scene or traffic light), and the photo is stamped with time, GPS and bus details. Uses full camera resolution on Android Chrome for sharper plates. |
| **Incident buttons** | One tap logs *Speeding, Red light, Phone while driving, Dangerous overtake, Harsh braking, Skipped stop, Doors open while moving, Rude conduct, Other* with time, location, speed and position in the video. |
| **Auto over-limit** | If speed stays more than 5 km/h over the OSM limit for 5 s or longer, an incident is logged automatically. |
| **Report** | A bilingual (Hebrew/English) complaint text with every incident, Google Maps links, timestamps inside the video, the max speed, and lists of the video and photo files. You can copy it or download it. |
| **Data export** | GPX track (opens in Google Earth or any map app) and a full JSON log of every GPS fix. |
| **Share / save** | Uses the phone's share sheet (WhatsApp, Drive, Files…) or downloads the files. |

Nothing is uploaded anywhere. The only network request is the optional speed-limit lookup
to the OpenStreetMap Overpass API, which sends coordinates only.

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
- **Save or share your files before closing the app.** Recordings are kept in memory only.
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

`index.html`, `style.css`, `app.js` (all logic), `sw.js` (offline cache), `manifest.webmanifest`, `icons/`.
No build step and no dependencies.
